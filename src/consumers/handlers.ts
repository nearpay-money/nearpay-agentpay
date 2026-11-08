/**
 * Domain-event consumers (lld/agentpay.md §8), run by `agentpay-batcher`. Each handler records the event
 * in the inbox in the same transaction as its effect (exactly-once effect).
 *
 * | Subject                                  | Effect                                                     |
 * |------------------------------------------|------------------------------------------------------------|
 * | evt.sentinel.kill_switch.engaged         | `kill_switch.engaged = true`: new live settles/relays → 503 |
 * | evt.sentinel.kill_switch.released        | `kill_switch.engaged = false`                              |
 *
 * Stale events (aggregate version ≤ the stored one) are ignored.
 */
import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, inboxHandler, type Kysely } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import type { Tx } from "../app/context.js";
import { storeKillSwitch } from "../app/kill-switch.js";
import type { DB } from "../infra/db/schema.js";

export async function applyKillSwitch(tx: Tx, e: Envelope): Promise<void> {
  const k = e.data.object as unknown as { reason?: unknown; actor?: unknown };
  await storeKillSwitch(tx, {
    engaged: e.subject === "evt.sentinel.kill_switch.engaged",
    reason: String(k.reason ?? ""),
    actor: String(k.actor ?? "sentinel"),
    version: e.aggregate.version,
  });
}

export function agentpayHandlers(db: Kysely<DB>): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(db, fn);
  return {
    "evt.sentinel.kill_switch.engaged": h(applyKillSwitch),
    "evt.sentinel.kill_switch.released": h(applyKillSwitch),
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:agentpay");
