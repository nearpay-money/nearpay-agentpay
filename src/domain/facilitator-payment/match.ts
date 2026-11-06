/**
 * The signed-message check of the verify algorithm (lld/agentpay.md §6 step 3). Pure.
 *
 * A NearPay `intents-transfer` payload contains exactly two intents, in order:
 *   transfer(receiver_id = payTo,  tokens = {asset: amount},     memo = binding)
 *   transfer(receiver_id = fee_to, tokens = {asset: fee_amount}, memo = binding)
 * signed for `intents.near`, with `deadline` in (now + 5 s, requirement deadline].
 */
import type { IntentMessage } from "@nearpay/spec";

export interface ExpectedTransfer {
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  readonly feeTo: string;
  readonly feeAmount: string;
  readonly binding: string;
  /** Latest acceptable payload deadline (inclusive), epoch ms. */
  readonly deadlineMaxMs: number;
  readonly contract: string;
}

export type MatchFailure = "invalid_payload" | "recipient_mismatch" | "amount_mismatch" | "deadline_invalid";

export type MatchResult = { ok: true } | { ok: false; reason: MatchFailure; detail: string };

/** Payload deadlines must leave at least this long for relaying. */
export const DEADLINE_MARGIN_MS = 5_000;

const fail = (reason: MatchFailure, detail: string): MatchResult => ({ ok: false, reason, detail });

interface TransferLike {
  intent: string;
  receiver_id?: unknown;
  tokens?: unknown;
  memo?: unknown;
}

function checkTransfer(
  i: TransferLike,
  which: "merchant" | "fee",
  receiver: string,
  asset: string,
  amount: string,
  binding: string,
): MatchResult | null {
  if (i.intent !== "transfer") return fail("invalid_payload", `the ${which} intent must be a transfer`);
  if (i.receiver_id !== receiver)
    return fail("recipient_mismatch", `the ${which} transfer must go to ${receiver}, not ${String(i.receiver_id)}`);
  const tokens = (i.tokens ?? {}) as Record<string, unknown>;
  const keys = Object.keys(tokens);
  if (keys.length !== 1 || keys[0] !== asset)
    return fail("amount_mismatch", `the ${which} transfer must move exactly ${asset}`);
  const v = tokens[asset];
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(v) || BigInt(v) !== BigInt(amount))
    return fail("amount_mismatch", `the ${which} transfer must move ${amount} (got ${String(v)})`);
  if (i.memo !== binding) return fail("invalid_payload", `the ${which} transfer memo must be the binding`);
  return null;
}

export function matchMessage(m: IntentMessage, e: ExpectedTransfer, nowMs: number): MatchResult {
  if (m.verifying_contract !== e.contract) return fail("invalid_payload", `verifying_contract must be ${e.contract}`);
  const deadline = Date.parse(m.deadline);
  if (!Number.isFinite(deadline)) return fail("deadline_invalid", "deadline is not a timestamp");
  if (deadline <= nowMs + DEADLINE_MARGIN_MS) return fail("deadline_invalid", "deadline is too close or passed");
  if (deadline > e.deadlineMaxMs) return fail("deadline_invalid", "deadline is later than the requirement allows");
  if (m.intents.length !== 2) return fail("invalid_payload", "the payload must contain exactly two transfers");
  const [first, second] = m.intents as unknown as [TransferLike, TransferLike];
  return (
    checkTransfer(first, "merchant", e.payTo, e.asset, e.amount, e.binding) ??
    checkTransfer(second, "fee", e.feeTo, e.asset, e.feeAmount, e.binding) ?? { ok: true }
  );
}

/** The binding a payload claims (memo of its first intent), if any. */
export function claimedBinding(m: IntentMessage): string | null {
  const memo = (m.intents[0] as TransferLike | undefined)?.memo;
  return typeof memo === "string" ? memo : null;
}
