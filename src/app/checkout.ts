/**
 * Agents paying checkout sessions and the checkout relay (lld/agentpay.md §5, §7):
 *
 * - `agent_pay/requirements`: the client secret is checked by payments (it owns sessions); payments
 *   creates or reuses an `intents_transfer` attempt (`POST /internal/checkout_sessions/{id}/agent_attempts`),
 *   which agentpay remembers by binding so the agent's submission can be matched to it.
 * - `agent_pay` and `POST /internal/relay` (payments, for payer-signed checkout attempts) both end in
 *   `relayCheckout`: the rails execution must be an `intents_transfer` awaiting deposit with the same
 *   binding; the payload must be exactly its two transfers, sign correctly and simulate; then it is
 *   queued for the batcher (idempotent on the payload hash, one live payload per binding).
 *
 * agentpay never marks a checkout payment paid: rails' NEAR indexer settles the execution from the
 * binding memo (single evidence path, INV-2); the agent payment row is the relay record.
 */

import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { verifySigned } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import type { AgentPayRequirements, MultiPayload, PayerAttempt } from "@nearpay-money/spec";
import type { z } from "zod";
import { payloadHash } from "../domain/binding/binding.js";
import { claimedBinding, matchMessage } from "../domain/facilitator-payment/match.js";
import { relayCode } from "../domain/facilitator-payment/reasons.js";
import { type PublicSession, upstreamCode } from "../infra/clients/peers.js";
import type { Agentpay } from "./context.js";
import { transition } from "./ledger.js";
import { killSwitchEngaged, killSwitchError } from "./merchant.js";
import { railUnavailable, simulate, VerifierUnavailable } from "./verifier.js";

export const invalidIntent = (reason: string) => new ApiError("intent_invalid", { params: { reason } });

/** A session as the payer sees it, with the account and mode payments' internal route reports for it. */
export interface PayerView {
  readonly session: PublicSession;
  /** Account uuid and mode of the session (CR-15-15). */
  readonly scope: { readonly account: string; readonly livemode: boolean };
}

const secretRefused = (u: ReturnType<typeof upstreamCode>) => u.status === 401 || u.code === "client_secret_invalid";

/**
 * The session as the payer sees it; payments verifies the client secret (lld/agentpay.md §5). Read only from
 * payments' internal `getPayerCheckoutSession` with agentpay's service token and the forwarded secret (CR-15-15), so
 * the account and mode are always known. There is no fallback to the Stage 1 public route (it carries no account or
 * mode, which skipped the scope checks — audit finding 11): any other answer, `404 resource_missing` included
 * (payments answers `401` for an unknown session), is `503 rail_unavailable` (fail closed).
 */
export async function payerSession(ap: Agentpay, sessionId: string, secret: string | undefined): Promise<PayerView> {
  if (!secret) throw new ApiError("client_secret_invalid");
  try {
    const r = await ap.payments.payerSession(sessionId, secret);
    if (r.session.id !== sessionId) throw railUnavailable("checkout answered for another session");
    return { session: r.session, scope: { account: toUuid(r.account_id, "acct"), livemode: r.livemode } };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const u = upstreamCode(e);
    if (secretRefused(u)) throw new ApiError("client_secret_invalid");
    if (u.status === 404) ap.log.error({ session: sessionId }, "payments answered 404 on getPayerCheckoutSession");
    throw railUnavailable("checkout unavailable");
  }
}

const AGENT_ATTEMPT_ERRORS = new Set([
  "session_not_open",
  "too_many_attempts",
  "attempt_in_flight",
  "destination_not_intents_account",
  "rail_unavailable",
  "client_secret_invalid",
]);

export async function agentPayRequirements(
  ap: Agentpay,
  sessionId: string,
  secret: string | undefined,
  payer: string,
): Promise<z.input<typeof AgentPayRequirements>> {
  const { session: s, scope } = await payerSession(ap, sessionId, secret);
  if (s.status !== "open") throw new ApiError("session_not_open");
  let r: Awaited<ReturnType<Agentpay["payments"]["createAgentAttempt"]>>;
  try {
    r = await ap.payments.createAgentAttempt(sessionId, payer);
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code && AGENT_ATTEMPT_ERRORS.has(u.code))
      throw new ApiError(u.code as "session_not_open", u.message ? { message: u.message } : {});
    throw railUnavailable(u.timeout ? "checkout timeout" : "checkout unavailable");
  }
  // the attempt must belong to the session's account and mode (known from the internal payer route)
  if (toUuid(r.account_id, "acct") !== scope.account || r.livemode !== scope.livemode)
    throw railUnavailable("checkout answered for another account or mode");
  const req = r.intents_requirement;
  const values = {
    account_id: toUuid(r.account_id, "acct"),
    livemode: r.livemode,
    checkout_session_id: toUuid(sessionId, "cs"),
    attempt_id: toUuid(r.attempt_id, "pa"),
    execution_id: r.execution_id,
    payer,
    requirement: JSON.stringify(req),
    attestation_ticket: r.attestation_ticket,
  };
  await ap.db
    .insertInto("checkout_requirements")
    .values({ binding: req.binding, ...values })
    .onConflict((oc) => oc.column("binding").doUpdateSet({ ...values, updated_at: new Date() }))
    .execute();
  return {
    object: "agent_pay_requirements",
    livemode: r.livemode,
    attempt_id: r.attempt_id,
    attestation_ticket: r.attestation_ticket,
    requirement: req,
  };
}

export interface RelayInput {
  readonly executionId: string;
  readonly binding: string;
  readonly signed: MultiPayload;
  /** Checkout session uuid, when known (agent_pay). */
  readonly sessionId?: string | null;
}

export async function execution(ap: Agentpay, id: string): Promise<Execution> {
  try {
    return await ap.rails.getExecution(id);
  } catch (e) {
    const u = upstreamCode(e);
    if (u.status === 404 || u.code === "resource_missing") throw invalidIntent("unknown execution");
    throw railUnavailable("execution lookup unavailable");
  }
}

export const byHash = (ap: Agentpay, hash: Buffer) =>
  ap.db.selectFrom("agent_payments").selectAll().where("payload_hash", "=", hash).executeTakeFirst();

export function isUniqueViolation(e: unknown, constraint: string): boolean {
  const pg = e as { code?: string; constraint?: string };
  return pg?.code === "23505" && pg.constraint === constraint;
}

/** `simulate_intents` for a relay: a short balance is `insufficient_balance`, any other rejection `intent_invalid`. */
export async function simulateForRelay(ap: Agentpay, livemode: boolean, signed: MultiPayload): Promise<void> {
  let sim: Awaited<ReturnType<typeof simulate>>;
  try {
    sim = await simulate(ap, livemode, [signed]);
  } catch (e) {
    if (e instanceof VerifierUnavailable) throw railUnavailable("verifier unavailable");
    throw e;
  }
  if (!sim.ok) {
    const code = relayCode(sim.reason);
    throw code === "insufficient_balance"
      ? new ApiError("insufficient_balance")
      : invalidIntent(sim.reason === "nonce_used" ? "nonce already used" : sim.detail);
  }
}

/** Validates and queues a payer-signed checkout payload; returns the agent payment id (`ap_…`). */
export async function relayCheckout(ap: Agentpay, input: RelayInput): Promise<string> {
  const hash = Buffer.from(payloadHash(input.signed));
  const existing = await byHash(ap, hash);
  if (existing) {
    if (existing.execution_id !== input.executionId || existing.kind !== "checkout")
      throw invalidIntent("this payload was relayed for another payment");
    return fromUuid("ap", existing.id);
  }
  const ex = await execution(ap, input.executionId);
  const req = ex.intents_requirement;
  if (ex.kind !== "payment" || ex.method !== "intents_transfer" || !req || req.binding !== input.binding)
    throw invalidIntent("the binding does not belong to this execution");
  if (ex.state !== "awaiting_deposit") throw invalidIntent(`the payment is ${ex.state}`);
  if (ex.livemode && (await killSwitchEngaged(ap))) throw killSwitchError();

  const v = verifySigned(input.signed);
  if (!v.ok) throw invalidIntent(v.reason === "invalid_signature" ? "invalid signature" : v.detail);
  const match = matchMessage(
    v.message,
    {
      payTo: req.pay_to,
      asset: req.token,
      amount: req.amount,
      feeTo: req.fee_to,
      feeAmount: req.fee_amount,
      binding: req.binding,
      deadlineMaxMs: Date.parse(req.deadline),
      contract: ap.settings.contract,
    },
    ap.now(),
  );
  if (!match.ok) throw invalidIntent(match.detail);

  await simulateForRelay(ap, ex.livemode, input.signed);

  const sessionId =
    input.sessionId ??
    (
      await ap.db
        .selectFrom("checkout_requirements")
        .select("checkout_session_id")
        .where("binding", "=", req.binding)
        .executeTakeFirst()
    )?.checkout_session_id ??
    null;
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
          kind: "checkout",
          binding: req.binding,
          payer: m.signer_id,
          pay_to: req.pay_to,
          fee_to: req.fee_to,
          payload_hash: hash,
          payload: JSON.stringify(input.signed),
          standard: v.standard,
          nonces: [m.nonce],
          deadline: new Date(m.deadline),
          status: "queued",
          amount: req.amount,
          asset_id: req.token,
          fee_amount: req.fee_amount,
          checkout_session_id: sessionId,
          execution_id: ex.id,
        })
        .onConflict((oc) => oc.column("payload_hash").doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!row) return null;
      await transition(tx, id, null, "queued", {
        cause: "checkout relay",
        actor: input.sessionId ? "agent" : "payments",
        evidence: { execution_id: ex.id, binding: req.binding, payer: m.signer_id },
      });
      return id;
    });
    if (id) {
      ap.log.info({ agent_payment: fromUuid("ap", id), execution: ex.id }, "checkout payload queued");
      return fromUuid("ap", id);
    }
    const winner = await byHash(ap, hash);
    if (!winner) throw new Error("payload vanished");
    return fromUuid("ap", winner.id);
  } catch (e) {
    if (isUniqueViolation(e, "ap_binding_live")) {
      // a concurrent submission of the same payload can trip the binding index before the payload-hash
      // arbiter: that is a replay, answered with the winner (idempotent on the payload hash)
      const winner = await byHash(ap, hash);
      if (winner && winner.execution_id === input.executionId && winner.kind === "checkout")
        return fromUuid("ap", winner.id);
      throw invalidIntent("a payment for this requirement is already being relayed");
    }
    throw e;
  }
}

/** The agent's attempt as payments shows it, or (if payments moved on) as agentpay handed it out. */
function attemptView(
  s: PublicSession,
  cr: { attempt_id: string; livemode: boolean; requirement: unknown; attestation_ticket: string },
): z.input<typeof PayerAttempt> {
  const id = fromUuid("pa", cr.attempt_id);
  if (s.attempt && s.attempt.id === id) return s.attempt;
  const req = cr.requirement as z.input<typeof PayerAttempt>["intents_requirement"];
  return {
    id: id as `pa_${string}`,
    object: "payment_attempt",
    livemode: cr.livemode,
    status: "awaiting_deposit",
    method: "intents_transfer",
    visible: true,
    origin_asset_id: (req as { token: string }).token,
    deposit: null,
    intents_requirement: req,
    attestation_ticket: cr.attestation_ticket,
    failure_code: null,
    refunded_amount: null,
  };
}

export async function agentPay(ap: Agentpay, sessionId: string, secret: string | undefined, signed: MultiPayload) {
  const { session: s, scope } = await payerSession(ap, sessionId, secret);
  const v = verifySigned(signed);
  if (!v.ok) throw invalidIntent(v.reason === "invalid_signature" ? "invalid signature" : v.detail);
  const binding = claimedBinding(v.message);
  if (!binding) throw invalidIntent("the payload carries no binding memo");
  const cr = await ap.db
    .selectFrom("checkout_requirements")
    .selectAll()
    .where("binding", "=", binding)
    .where("checkout_session_id", "=", toUuid(sessionId, "cs"))
    .executeTakeFirst();
  if (!cr) throw invalidIntent("unknown requirement for this session; request agent_pay/requirements first");
  if (cr.account_id !== scope.account || cr.livemode !== scope.livemode)
    throw invalidIntent("unknown requirement for this session; request agent_pay/requirements first");
  if (s.status === "complete" || s.status === "expired") throw new ApiError("session_not_open");
  const agentPayment = await relayCheckout(ap, {
    executionId: cr.execution_id,
    binding,
    signed,
    sessionId: cr.checkout_session_id,
  });
  return {
    object: "agent_pay_submission" as const,
    status: "submitted" as const,
    agent_payment: agentPayment as `ap_${string}`,
    attempt: attemptView(s, cr),
  };
}
