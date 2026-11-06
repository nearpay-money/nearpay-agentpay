/** Merchant scope and the per-account reads every x402 use case shares. */
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import type { ApiError } from "@nearpay-internal/service";
import type { SettlementContext } from "@nearpay-internal/spec";
import type { Agentpay } from "./context.js";
import { railUnavailable } from "./verifier.js";

export interface Merchant {
  /** Account uuid. */
  readonly account: string;
  readonly livemode: boolean;
}

export const acctId = (m: Merchant) => fromUuid("acct", m.account);
export const merchantOf = (acct: string, livemode: boolean): Merchant => ({ account: toUuid(acct, "acct"), livemode });

/** Identity's settlement context, cached 60 s (§10). */
export async function settlementContext(ap: Agentpay, m: Merchant): Promise<SettlementContext> {
  try {
    return await ap.caches.contexts.get(`${m.account}:${m.livemode}`, () =>
      ap.identity.settlementContext(acctId(m), m.livemode),
    );
  } catch (e) {
    ap.log.warn({ err: e instanceof Error ? e.message : String(e) }, "settlement context unavailable");
    throw railUnavailable("account context unavailable");
  }
}

/** Requests per second the account may verify/settle (`quotas.rps`, default 50), cached 60 s. */
export async function accountRps(ap: Agentpay, m: Merchant): Promise<number> {
  return ap.caches.quotas.get(m.account, async () => {
    const q = await ap.db.selectFrom("quotas").select("rps").where("account_id", "=", m.account).executeTakeFirst();
    return q?.rps ?? 50;
  });
}

/** True while sentinel's kill switch is engaged (live settles and relays stop, §8); cached 1 s. */
export async function killSwitchEngaged(ap: Agentpay): Promise<boolean> {
  return ap.caches.killSwitch.get("ks", async () => {
    const k = await ap.db.selectFrom("kill_switch").select("engaged").where("id", "=", 1).executeTakeFirst();
    return k?.engaged ?? false;
  });
}

export function killSwitchError(): ApiError {
  return railUnavailable("live settlement is paused by the kill switch");
}
