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
import { deadLetterSink, inboxHandler, type Kysely, sql } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import type { Tx } from "../app/context.js";
import type { DB } from "../infra/db/schema.js";

export async function applyKillSwitch(tx: Tx, e: Envelope): Promise<void> {
  const k = e.data.object as unknown as { reason?: unknown; actor?: unknown };
  const engaged = e.subject === "evt.sentinel.kill_switch.engaged";
  const reason = String(k.reason ?? "").slice(0, 500);
  const actor = String(k.actor ?? "sentinel").slice(0, 200);
  await sql`
    insert into kill_switch (id, engaged, reason, actor, event_version, updated_at)
    values (1, ${engaged}, ${reason}, ${actor}, ${e.aggregate.version}, now())
    on conflict (id) do update set engaged = excluded.engaged, reason = excluded.reason, actor = excluded.actor,
      event_version = excluded.event_version, updated_at = now()
    where kill_switch.event_version < excluded.event_version`.execute(tx);
}

export function agentpayHandlers(db: Kysely<DB>): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(db, fn);
  return {
    "evt.sentinel.kill_switch.engaged": h(applyKillSwitch),
    "evt.sentinel.kill_switch.released": h(applyKillSwitch),
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:agentpay");
