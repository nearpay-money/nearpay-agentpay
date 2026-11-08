/**
 * Rails execution events for agentpay-owned executions (lld/agentpay.md §3.1 step 5, §8): cross-chain x402.
 *
 * - `evt.rails.execution.settled` (owner agentpay) → the merchant record: an agent payment created directly in
 *   `settled` (row + transition + outbox `evt.agentpay.agent_payment.settled`, one transaction): kind `x402`,
 *   `transfer_method: near-intents`, `payer` = `evidence.sender`, `amount` = `settled_amount`, `fee_amount` 0 (the
 *   fee is in `origin.fee`); and the operation's final result. Independent of whether the agent ever settles.
 * - `.refunded` / `.failed` → the operation's failure result only; **no** agent payment (nothing reached the
 *   merchant; 1Click refunds `refundTo`).
 * - executions of other owners → acked without effect.
 *
 * Exactly once with the inbox (dedupe by event id, same transaction); stale `aggregate.version`s and repeated
 * terminal events never change a recorded result (operations: `quoted → settled | failed`, both final); one agent
 * payment per execution (unique index). A rails contract defect (no binding, evidence or sender; an execution that
 * does not match its requirement) throws: nak, retried, alert, dead letter after the delivery limit.
 */

import type { Envelope } from "@nearpay-internal/bus";
import { emit } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import type { Logger } from "@nearpay-internal/service";
import { Execution } from "@nearpay-internal/spec";
import {
  canMoveOperation,
  coversAmount,
  decideExecutionEvent,
  type ExecutionSubject,
  executionMatches,
  merchantRecord,
  type OperationResult,
} from "../domain/near-intents/rules.js";
import type { Tx } from "./context.js";
import { FINAL_SUBJECT, transition } from "./ledger.js";
import { agentPaymentView } from "./views.js";

export const EXECUTION_SUBJECTS: readonly ExecutionSubject[] = [
  "evt.rails.execution.settled",
  "evt.rails.execution.refunded",
  "evt.rails.execution.failed",
];

export class ExecutionEventDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionEventDefect";
  }
}

/** Applies one execution event inside the consumer's transaction; returns the operation to wake (`xo:<id>`). */
export async function applyExecutionEvent(tx: Tx, e: Envelope, log: Logger | null): Promise<string | null> {
  const subject = e.subject as ExecutionSubject;
  const parsed = Execution.safeParse(e.data.object);
  if (!parsed.success) {
    // an owner other than agentpay is never ours, even when the view does not parse for us
    const owner = (e.data.object as { owner?: unknown } | null)?.owner;
    if (owner !== "agentpay") return null;
    throw defect(log, e, `execution view does not parse: ${parsed.error.message.slice(0, 300)}`);
  }
  const x = parsed.data;
  const decision = decideExecutionEvent(subject, x);
  if (decision.kind === "ignore") return null;
  if (decision.kind === "defect") {
    // a defective event that a later, correct one already superseded is only acked (no endless redelivery)
    const recorded = await tx
      .selectFrom("x402_operations")
      .select("execution_version")
      .where("execution_id", "=", x.id)
      .where("account_id", "=", toUuid(x.account_id, "acct"))
      .where("livemode", "=", x.livemode)
      .executeTakeFirst();
    if (recorded?.execution_version != null && recorded.execution_version >= e.aggregate.version) return null;
    throw defect(log, e, decision.detail);
  }

  const account = toUuid(x.account_id, "acct");
  const binding = x.x402_binding as string;
  const req = await tx
    .selectFrom("issued_requirements")
    .selectAll()
    .where("binding", "=", binding)
    .where("account_id", "=", account)
    .where("livemode", "=", x.livemode)
    .where("method", "=", "near-intents")
    .executeTakeFirst();
  if (!req) throw defect(log, e, "x402_binding names no near-intents requirement of this account and mode");
  const mismatch = executionMatches(x, req, x.account_id);
  if (mismatch) throw defect(log, e, `execution does not match its requirement: ${mismatch}`);

  const op = await tx
    .selectFrom("x402_operations")
    .selectAll()
    .where("execution_id", "=", x.id)
    .where("account_id", "=", account)
    .where("livemode", "=", x.livemode)
    .forUpdate()
    .executeTakeFirst();
  if (op && op.binding !== binding) throw defect(log, e, "operation binding differs from the execution's");
  // stale or repeated: a recorded result is final (rails' terminal states are absorbing)
  if (op && op.execution_version !== null && op.execution_version >= e.aggregate.version) return null;

  let result: OperationResult;
  let agentPayment: string | null = null;
  if (decision.kind === "settled") {
    const rec = merchantRecord(x, req);
    const id = uuidv7();
    const now = new Date();
    const inserted = await tx
      .insertInto("agent_payments")
      .values({
        id,
        account_id: account,
        livemode: x.livemode,
        kind: "x402",
        transfer_method: "near-intents",
        binding: rec.binding,
        payer: rec.payer,
        pay_to: rec.pay_to,
        fee_to: null,
        payload_hash: null,
        payload: null,
        standard: null,
        nonces: null,
        deadline: null,
        status: "settled",
        amount: rec.amount,
        asset_id: rec.asset_id,
        fee_amount: rec.fee_amount,
        resource_url: req.resource_url,
        tx_hash: rec.tx_hash,
        block_height: rec.block_height,
        execution_id: rec.execution_id,
        origin: JSON.stringify(rec.origin),
        settled_at: now,
        version: 1,
      })
      .onConflict((oc) => oc.column("execution_id").where("transfer_method", "=", "near-intents").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) {
      await transition(tx, id, null, "settled", {
        cause: "cross-chain x402 delivery evidenced by rails",
        actor: "consumer",
        evidence: { execution: x.id, event: e.id, tx_hash: rec.tx_hash, sender: rec.payer },
      });
      await emit(tx, {
        subject: FINAL_SUBJECT.settled,
        aggregate: { type: "agent_payment", id: fromUuid("ap", id), version: inserted.version },
        accountId: account,
        livemode: x.livemode,
        data: { object: agentPaymentView(inserted), previous: { status: null } },
      });
      agentPayment = id;
      log?.info({ agent_payment: fromUuid("ap", id), execution: x.id }, "near-intents agent payment settled");
    } else {
      const existing = await tx
        .selectFrom("agent_payments")
        .select("id")
        .where("execution_id", "=", x.id)
        .where("transfer_method", "=", "near-intents")
        .where("account_id", "=", account)
        .where("livemode", "=", x.livemode)
        .executeTakeFirstOrThrow();
      agentPayment = existing.id;
    }
    if (coversAmount(rec.amount, req.amount))
      result = {
        outcome: "settled",
        transaction: rec.tx_hash,
        amount: rec.amount,
        network: rec.origin.network,
        refund_to: rec.origin.refund_to,
        agent_payment: fromUuid("ap", agentPayment),
        tx_hashes: rec.origin.tx_hashes,
      };
    else {
      // rails settles route executions only with evidence of the expected amount: this is a defect upstream. The
      // merchant record above states what arrived; the agent is not told it paid in full.
      log?.error({ execution: x.id, settled: rec.amount, issued: req.amount }, "ALERT near-intents under-delivery");
      result = {
        outcome: "failed",
        error_reason: "exact_near_intents_payment_failed",
        status: x.provider_status,
        network: rec.origin.network,
        refund_to: rec.origin.refund_to,
      };
    }
  } else {
    result = {
      outcome: "failed",
      error_reason: decision.errorReason,
      status: x.provider_status,
      network: x.origin.chain,
      refund_to: x.origin.refund_to,
    };
  }

  if (!op) {
    // no operation row: the quote was never handed out (recording failed after rails created the execution).
    // A settlement still gets its merchant record above; there is nobody to answer.
    log?.warn({ execution: x.id, subject }, "execution event for a quote that was never handed out");
    return null;
  }
  const to = result.outcome === "settled" ? "settled" : "failed";
  if (!canMoveOperation(op.status, to)) {
    if (op.status !== to)
      log?.error(
        { execution: x.id, recorded: op.status, event: subject },
        "ALERT conflicting terminal execution events",
      );
    return null;
  }
  await tx
    .updateTable("x402_operations")
    .set({
      status: to,
      result: JSON.stringify(result),
      execution_version: e.aggregate.version,
      agent_payment_id: agentPayment,
      updated_at: new Date(),
    })
    .where("id", "=", op.id)
    .where("account_id", "=", account)
    .where("livemode", "=", x.livemode)
    .where("status", "=", "quoted")
    .execute();
  return op.id;
}

function defect(log: Logger | null, e: Envelope, detail: string): ExecutionEventDefect {
  log?.error(
    { event: e.id, subject: e.subject, aggregate: e.aggregate.id, detail },
    "ALERT rails execution event defect",
  );
  return new ExecutionEventDefect(detail);
}
