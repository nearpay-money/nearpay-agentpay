/**
 * Request quotas (lld/agentpay.md §6 step 6, §3 issuance rate): a one-second fixed window per key,
 * shared through Valkey (`INCR` + `EXPIRE`) when available, in-process otherwise. Pure part.
 */
export interface Window {
  readonly second: number;
  readonly count: number;
}

/** Counts one request at `nowMs`; allowed while the window's count stays within `limit`. */
export function hit(w: Window | undefined, nowMs: number, limit: number): { ok: boolean; window: Window } {
  const second = Math.floor(nowMs / 1000);
  const count = w && w.second === second ? w.count + 1 : 1;
  return { ok: count <= limit, window: { second, count } };
}
