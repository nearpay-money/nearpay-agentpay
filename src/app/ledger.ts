/**
 * Every agent payment change writes the row (optimistic version), a transition row and — for x402
 * payments reaching a final state — its outbox event in ONE transaction (foundations §7, INV-9,
 * lld/agentpay.md §8). Checkout payments emit nothing: rails' indexer settles their execution from the
 * binding memo (single evidence path, §7).
 */
import { emit, type Updateable } from "@nearpay-internal/db";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { canTransition } from "../domain/facilitator-payment/status.js";
import type { AgentPaymentStatus, AgentPaymentsTable } from "../infra/db/schema.js";
import type { Tx } from "./context.js";
import { type AgentPaymentRow, agentPaymentView } from "./views.js";

export interface Meta {
  readonly cause: string;
  readonly actor: string;
  readonly evidence?: unknown;
}

export async function transition(
  tx: Tx,
  id: string,
  from: AgentPaymentStatus | null,
  to: AgentPaymentStatus,
  meta: Meta,
): Promise<void> {
  await tx
    .insertInto("agent_payment_transitions")
    .values({
      id: uuidv7(),
      agent_payment_id: id,
      from_state: from,
      to_state: to,
      cause: meta.cause.slice(0, 500),
      actor: meta.actor,
      evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
    })
    .execute();
}

export const FINAL_SUBJECT = {
  settled: "evt.agentpay.agent_payment.settled",
  failed: "evt.agentpay.agent_payment.failed",
} as const;

/** Moves an agent payment (version-checked); refuses transitions the lifecycle does not allow. */
export async function updatePayment(
  tx: Tx,
  cur: AgentPaymentRow,
  patch: Updateable<AgentPaymentsTable>,
  meta: Meta,
): Promise<AgentPaymentRow> {
  const to = (patch.status ?? cur.status) as AgentPaymentStatus;
  if (to !== cur.status && !canTransition(cur.status, to))
    throw new Error(`agent payment ${cur.id}: ${cur.status} → ${to} is not allowed`);
  const next = await tx
    .updateTable("agent_payments")
    .set({ ...patch, version: cur.version + 1, updated_at: new Date() })
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!next) throw new Error(`agent payment ${cur.id} changed concurrently`);
  if (next.status !== cur.status) {
    await transition(tx, cur.id, cur.status, next.status, meta);
    if (next.kind === "x402" && (next.status === "settled" || next.status === "failed")) {
      await emit(tx, {
        subject: FINAL_SUBJECT[next.status],
        aggregate: { type: "agent_payment", id: fromUuid("ap", next.id), version: next.version },
        accountId: next.account_id,
        livemode: next.livemode,
        data: { object: agentPaymentView(next), previous: { status: cur.status } },
      });
    }
  }
  return next;
}
