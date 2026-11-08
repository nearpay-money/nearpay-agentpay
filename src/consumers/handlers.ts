/**
 * Domain-event consumers (lld/agentpay.md §8), run by `agentpay-batcher`. Each handler records the event
 * in the inbox in the same transaction as its effect (exactly-once effect).
 *
 * | Subject                                  | Effect                                                     |
 * |------------------------------------------|------------------------------------------------------------|
 * | evt.sentinel.kill_switch.engaged         | `kill_switch.engaged = true`: new live settles/relays → 503 |
 * | evt.sentinel.kill_switch.released        | `kill_switch.engaged = false`                              |
 * | evt.rails.execution.settled (owner agentpay) | near-intents agent payment (settled) + operation result (§3.1 step 5) |
 * | evt.rails.execution.{refunded,failed} (owner agentpay) | operation failure result; no agent payment     |
 *
 * Executions of other owners are acked without effect. After the commit an operation's waiters (`xo:<id>`) are
 * woken so a waiting `/x402/near-intents/settle` answers at once.
 *
 * Stale events (aggregate version ≤ the stored one) are ignored.
 */
import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, inboxHandler, type Kysely } from "@nearpay-internal/db";
import type { Logger } from "@nearpay-internal/service";
import type { Subject } from "@nearpay-internal/spec";
import type { Tx } from "../app/context.js";
import { storeKillSwitch } from "../app/kill-switch.js";
import { applyExecutionEvent, EXECUTION_SUBJECTS } from "../app/near-intents-events.js";
import type { DB } from "../infra/db/schema.js";
import type { Waiters } from "../infra/waiters.js";

export async function applyKillSwitch(tx: Tx, e: Envelope): Promise<void> {
  const k = e.data.object as unknown as { reason?: unknown; actor?: unknown };
  await storeKillSwitch(tx, {
    engaged: e.subject === "evt.sentinel.kill_switch.engaged",
    reason: String(k.reason ?? ""),
    actor: String(k.actor ?? "sentinel"),
    version: e.aggregate.version,
  });
}

export interface HandlerDeps {
  readonly waiters?: Waiters;
  readonly log?: Logger;
}

export function agentpayHandlers(db: Kysely<DB>, deps: HandlerDeps = {}): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(db, fn);
  const execution: EventHandler = async (e) => {
    let wake: string | null = null;
    await inboxHandler(db, async (tx, env) => {
      wake = await applyExecutionEvent(tx, env, deps.log ?? null);
    })(e);
    if (wake) await deps.waiters?.publish(wake, "xo");
  };
  return {
    "evt.sentinel.kill_switch.engaged": h(applyKillSwitch),
    "evt.sentinel.kill_switch.released": h(applyKillSwitch),
    ...Object.fromEntries(EXECUTION_SUBJECTS.map((s) => [s, execution])),
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:agentpay");
