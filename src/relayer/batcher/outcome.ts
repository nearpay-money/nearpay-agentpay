/** Matching a final transaction's `intents_executed` to the payloads of its batch (lld/agentpay.md §7). */

import type { AgentPaymentRow } from "../../app/views.js";
import { matchExecuted } from "../../domain/relay-batch/batch.js";

export interface ExecutedWithHash {
  readonly intent_hash: string;
  readonly account_id: string;
  readonly nonce: string;
}

export function matchExecutedWithHashes(rows: readonly AgentPaymentRow[], executed: readonly ExecutedWithHash[]) {
  const relayed = rows.map((row) => ({ id: row.id, payer: row.payer, nonce: row.nonces[0] ?? "", row }));
  const { settled, missing } = matchExecuted(relayed, executed);
  const hashOf = (p: string, n: string) =>
    executed.find((e) => e.account_id === p && e.nonce === n)?.intent_hash ?? null;
  return {
    settled: settled.map((s) => ({ row: s.row, intentHash: hashOf(s.payer, s.nonce) })),
    missing: missing.map((m) => m.row),
  };
}
