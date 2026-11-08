/**
 * Agentpay's copy of sentinel's kill switch (lld/agentpay.md §8, §"Spec 0.2.1 contract changes"): the
 * `kill_switch` row follows `evt.sentinel.kill_switch.*` (newer `aggregate.version` wins). With no row the state is
 * unknown and live settles/relays are refused (fail closed); agentpay then reads sentinel `getKillSwitch` (at boot,
 * and at most every {@link READ_RETRY_MS} while it stays unknown) and stores it with its `version`, so only later
 * events win. A response without `version` (sentinel 0.2.0) is stored as version 0. Test mode is unaffected.
 */
import { sql } from "@nearpay-internal/db";
import type { Agentpay, KillSwitchKnowledge, Tx } from "./context.js";

export async function killSwitchState(db: Agentpay["db"]): Promise<KillSwitchKnowledge> {
  const row = await db.selectFrom("kill_switch").select("engaged").where("id", "=", 1).executeTakeFirst();
  if (!row) return "unknown";
  return row.engaged ? "engaged" : "released";
}

/** Stores a state (event or read) when newer than the stored one; true when applied. */
export async function storeKillSwitch(
  db: Agentpay["db"] | Tx,
  s: { engaged: boolean; reason: string; actor: string; version: number },
): Promise<boolean> {
  const r = await sql`
    insert into kill_switch (id, engaged, reason, actor, event_version, updated_at)
    values (1, ${s.engaged}, ${s.reason.slice(0, 500)}, ${s.actor.slice(0, 200)}, ${s.version}, now())
    on conflict (id) do update set engaged = excluded.engaged, reason = excluded.reason, actor = excluded.actor,
      event_version = excluded.event_version, updated_at = now()
    where kill_switch.event_version < excluded.event_version`.execute(db);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export const READ_RETRY_MS = 10_000;
const lastRead = new WeakMap<object, number>();

/** Reads sentinel's state when the stored one is unknown. Never throws (a failed read stays unknown). */
export async function readKillSwitch(ap: Agentpay, o: { force?: boolean } = {}): Promise<KillSwitchKnowledge> {
  const cur = await killSwitchState(ap.db);
  if (cur !== "unknown" || !ap.sentinel) return cur;
  const last = lastRead.get(ap);
  if (!o.force && last !== undefined && ap.now() - last < READ_RETRY_MS) return cur;
  lastRead.set(ap, ap.now());
  try {
    const k = await ap.sentinel.killSwitch();
    const applied = await storeKillSwitch(ap.db, {
      engaged: k.engaged,
      reason: `${k.reason} (read from sentinel)`,
      actor: k.actor,
      version: k.version ?? 0,
    });
    if (applied)
      ap.log.warn({ engaged: k.engaged, version: k.version ?? null }, "kill switch state read from sentinel");
  } catch (e) {
    ap.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "kill switch state could not be read from sentinel: live relays stay paused while it is unknown",
    );
  }
  return killSwitchState(ap.db);
}

/** Background task: reads the state at boot and retries while it stays unknown. */
export function killSwitchBootTask(ap: Agentpay, o: { retryMs?: number } = {}) {
  return {
    name: "kill-switch-boot-read",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      const tick = async () => {
        if (stopped) return;
        const st = await readKillSwitch(ap, { force: true }).catch(() => "unknown" as const);
        if (st === "unknown") {
          if (!stopped && ap.sentinel) timer = setTimeout(tick, o.retryMs ?? READ_RETRY_MS);
        } else ap.log.info({ state: st }, "kill switch state known");
      };
      void tick();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}
