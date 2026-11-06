/**
 * Relay batches (lld/agentpay.md §7). Pure.
 * - Size: `floor(240 Tgas / NP_GAS_PER_PAYLOAD_TGAS)` payloads (the Verifier simulation batch cap of 64
 *   bounds it too); a payload requeued after a failed batch goes alone (`solo`).
 * - Gas: `n × GAS_PER_PAYLOAD + 20 Tgas`, zero deposit.
 * - Outcome: a payload settled when the transaction's `intents_executed` lists its (signer, nonce).
 */
export const TGAS = 1_000_000_000_000n;
export const BATCH_GAS_BUDGET_TGAS = 240;
export const BATCH_OVERHEAD_TGAS = 20n;
export const MAX_SIGNED_PER_CALL = 64;

export function maxBatch(gasPerPayloadTgas: number): number {
  if (!Number.isInteger(gasPerPayloadTgas) || gasPerPayloadTgas < 1)
    throw new RangeError("gas per payload must be ≥ 1 Tgas");
  return Math.max(1, Math.min(MAX_SIGNED_PER_CALL, Math.floor(BATCH_GAS_BUDGET_TGAS / gasPerPayloadTgas)));
}

export function batchGas(n: number, gasPerPayloadTgas: number): bigint {
  if (n < 1) throw new RangeError("a batch has at least one payload");
  return (BigInt(n) * BigInt(gasPerPayloadTgas) + BATCH_OVERHEAD_TGAS) * TGAS;
}

export interface Queued {
  readonly id: string;
  readonly solo: boolean;
}

/** The next batch from queued payloads in creation order: a solo payload alone, else consecutive non-solo ones. */
export function selectBatch<T extends Queued>(queued: readonly T[], max: number): T[] {
  const first = queued[0];
  if (!first) return [];
  if (first.solo) return [first];
  const out: T[] = [];
  for (const q of queued) {
    if (q.solo || out.length >= max) break;
    out.push(q);
  }
  return out;
}

export interface Executed {
  readonly account_id: string;
  readonly nonce: string;
}

export interface Relayed {
  readonly id: string;
  readonly payer: string;
  readonly nonce: string;
}

/** Splits a batch by the `intents_executed` of its transaction. */
export function matchExecuted<T extends Relayed>(batch: readonly T[], executed: readonly Executed[]) {
  const seen = new Set(executed.map((e) => `${e.account_id}\u0000${e.nonce}`));
  const settled: T[] = [];
  const missing: T[] = [];
  for (const p of batch) (seen.has(`${p.payer}\u0000${p.nonce}`) ? settled : missing).push(p);
  return { settled, missing };
}

/** Queued payloads whose deadline leaves less than `marginMs` cannot be relayed any more. */
export function tooLate(deadline: Date, nowMs: number, marginMs = 2_000): boolean {
  return deadline.getTime() <= nowMs + marginMs;
}
