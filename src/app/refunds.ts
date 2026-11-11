/**
 * Refund legs from an Intents account (`POST /internal/relay` `kind: refund`; lld/agentpay.md §5,
 * payments §17 items 2, 3 and 16).
 *
 * Payments prepares the leg (rails `kind: refund` execution with `refund.transfer`), issues the exact
 * Verifier payload for the merchant to sign (`Refund.next_action`, `sign_intent`) and, on `submit_tx`,
 * hands the signed payload to agentpay. agentpay relays it only when:
 *
 *   1. the execution is a refund leg from an Intents account, awaiting its deposit, whose transfer memo
 *      is the binding, and which belongs to the refund payments named (`Execution.reference.refund`);
 *   2. live mode and the kill switch is not engaged (fail closed, §8);
 *   3. the signature verifies;
 *   4. payments' issued payload agrees with rails' execution, and the signed payload is exactly it —
 *      signer, receiver, token, amount, memo, deadline, nonce, standard and the signed string
 *      (`signed_intent_mismatch` otherwise; domain `refund-relay/match.ts`);
 *   5. `simulate_intents` accepts it in the leg's mode (INV-8).
 *
 * It is then queued for the batcher like any other payload (idempotent on the payload hash; one live
 * payload per binding). agentpay never marks a refund succeeded: rails' indexer verifies the
 * payer-side evidence (INV-2); the agent payment row is the relay record. NearPay keys only pay gas
 * (INV-1): the relayer's function-call key submits the payload exactly as the merchant signed it.
 */

import { fromUuid, isId, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { verifySigned } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { MultiPayload } from "@nearpay-money/spec";
import { payloadHash } from "../domain/binding/binding.js";
import { checkIssued, type IssuedRefundPayload, matchRefundPayload } from "../domain/refund-relay/match.js";
import { type InternalRefund, upstreamCode } from "../infra/clients/peers.js";
import { byHash, execution, invalidIntent, isUniqueViolation, simulateForRelay } from "./checkout.js";
import type { Agentpay } from "./context.js";
import { transition } from "./ledger.js";
import { killSwitchEngaged, killSwitchError } from "./merchant.js";
import { railUnavailable } from "./verifier.js";

export interface RefundRelayInput {
  readonly executionId: string;
  readonly binding: string;
  readonly signed: MultiPayload;
  /** payments refund (`re_…`); defaults to the execution's `reference.refund`. */
  readonly refund?: string | undefined;
}

async function refundOf(ap: Agentpay, id: string): Promise<InternalRefund> {
  try {
    return await ap.payments.refund(id);
  } catch (e) {
    const u = upstreamCode(e);
    if (u.status === 404 || u.code === "resource_missing") throw invalidIntent("unknown refund");
    throw railUnavailable("refund lookup unavailable");
  }
}

/** Validates and queues a merchant-signed refund leg; returns the agent payment id (`ap_…`). */
export async function relayRefund(ap: Agentpay, input: RefundRelayInput): Promise<string> {
  const hash = Buffer.from(payloadHash(input.signed));
  const existing = await byHash(ap, hash);
  if (existing) {
    if (existing.execution_id !== input.executionId || existing.kind !== "refund")
      throw invalidIntent("this payload was relayed for another payment");
    return fromUuid("ap", existing.id);
  }

  // 1. the leg as rails prepared it
  const ex = await execution(ap, input.executionId);
  const t = ex.refund?.transfer;
  if (ex.kind !== "refund" || !t) throw invalidIntent("the execution is not a refund leg from an Intents account");
  if (t.memo !== input.binding) throw invalidIntent("the binding does not belong to this execution");
  const refundId = ex.reference?.refund ?? null;
  if (!refundId || (input.refund !== undefined && input.refund !== refundId) || !isId("re", refundId))
    throw invalidIntent("the execution does not belong to this refund");
  if (ex.state !== "awaiting_deposit") throw invalidIntent(`the refund leg is ${ex.state}`);

  // 2. kill switch (live only, fail closed)
  if (ex.livemode && (await killSwitchEngaged(ap))) throw killSwitchError();

  // 3. signature
  const v = verifySigned(input.signed);
  if (!v.ok) throw invalidIntent(v.reason === "invalid_signature" ? "invalid signature" : v.detail);

  // 4. exactly the payload payments issued for this leg, and that payload is rails' leg
  const refund = await refundOf(ap, refundId);
  const next = refund.next_action;
  if (refund.livemode !== ex.livemode || refund.status !== "requires_action" || next?.type !== "sign_intent")
    throw invalidIntent("the refund has no leg awaiting a signed intent");
  const issued: IssuedRefundPayload = next;
  const contract = ap.settings.contract;
  const consistent = checkIssued(issued, t, contract);
  if (!consistent.ok) {
    ap.log.error({ execution: ex.id, refund: refundId, detail: consistent.detail }, "refund leg disagrees with rails");
    throw invalidIntent(`the refund leg does not match its execution (${consistent.detail}); prepare it again`);
  }
  const match = matchRefundPayload(input.signed, v.message, issued, t, contract, ap.now());
  if (!match.ok) {
    if (match.reason === "signed_intent_mismatch")
      throw new ApiError("signed_intent_mismatch", { params: { detail: match.detail } });
    throw invalidIntent(match.detail);
  }

  // 5. the Verifier accepts it in the leg's mode
  await simulateForRelay(ap, ex.livemode, input.signed);

  const m = v.message;
  try {
    const id = await ap.db.transaction().execute(async (tx) => {
      const id = uuidv7();
      const row = await tx
        .insertInto("agent_payments")
        .values({
          id,
          account_id: toUuid(ex.account_id, "acct"),
          livemode: ex.livemode,
          kind: "refund",
          binding: t.memo,
          payer: m.signer_id,
          pay_to: t.receiver_id,
          fee_to: null,
          payload_hash: hash,
          payload: JSON.stringify(input.signed),
          standard: v.standard,
          nonces: [m.nonce],
          deadline: new Date(m.deadline),
          status: "queued",
          amount: t.amount,
          asset_id: t.token,
          fee_amount: "0",
          execution_id: ex.id,
          refund_id: toUuid(refundId, "re"),
        })
        .onConflict((oc) => oc.column("payload_hash").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return null;
      await transition(tx, id, null, "queued", {
        cause: "refund relay",
        actor: "payments",
        evidence: { execution_id: ex.id, refund: refundId, binding: t.memo, signer: m.signer_id, nonce: m.nonce },
      });
      return id;
    });
    if (id) {
      ap.log.info({ agent_payment: fromUuid("ap", id), execution: ex.id, refund: refundId }, "refund payload queued");
      return fromUuid("ap", id);
    }
    const winner = await byHash(ap, hash);
    if (!winner) throw new Error("payload vanished");
    if (winner.execution_id !== input.executionId || winner.kind !== "refund")
      throw invalidIntent("this payload was relayed for another payment");
    return fromUuid("ap", winner.id);
  } catch (e) {
    if (isUniqueViolation(e, "ap_binding_live")) {
      // a concurrent submission of the same payload can trip the binding index before the payload-hash
      // arbiter: that is a replay, answered with the winner (idempotent on the payload hash)
      const winner = await byHash(ap, hash);
      if (winner && winner.execution_id === input.executionId && winner.kind === "refund")
        return fromUuid("ap", winner.id);
      throw invalidIntent("a payload for this refund leg is already being relayed");
    }
    throw e;
  }
}
