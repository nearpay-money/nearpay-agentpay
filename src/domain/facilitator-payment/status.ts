/**
 * Agent payment lifecycle (lld/agentpay.md §4, §7). Pure.
 *
 *   queued ──batch──▶ submitted ──final ok──▶ settled
 *     │                 │  └─final failure / split─▶ queued (solo retry)
 *     └─▶ failed ◀──────┘ (Verifier rejected it, deadline passed)
 *
 * `verified` exists in the contract for payloads checked but not yet queued; NearPay inserts payloads
 * as `queued` (settle and relay verify and queue in one step).
 */
export type AgentPaymentStatus = "verified" | "queued" | "submitted" | "settled" | "failed";
export type AgentPaymentKind = "x402" | "checkout" | "refund";

const NEXT: Readonly<Record<AgentPaymentStatus, readonly AgentPaymentStatus[]>> = {
  verified: ["queued", "failed"],
  queued: ["submitted", "failed"],
  submitted: ["settled", "failed", "queued"],
  settled: [],
  failed: [],
};

export const TERMINAL: ReadonlySet<AgentPaymentStatus> = new Set(["settled", "failed"]);

export function canTransition(from: AgentPaymentStatus, to: AgentPaymentStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(s: AgentPaymentStatus): boolean {
  return TERMINAL.has(s);
}
