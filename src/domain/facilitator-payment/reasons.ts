/**
 * Failure vocabulary (lld/agentpay.md §5–§7). Pure.
 * - Verifier rejections (kit `classifyVerifierError`) are a subset of the x402 `invalidReason` values.
 * - Checkout relays (`/internal/relay`, `agent_pay`) speak the API catalogue: `insufficient_balance`
 *   for a short balance, `intent_invalid` for everything else the payer must re-sign.
 */
import { X402_SETTLE_ERRORS } from "@nearpay-money/spec";

export type VerifierFailure =
  | "insufficient_funds"
  | "invalid_signature"
  | "nonce_used"
  | "deadline_invalid"
  | "invalid_payload";

export type RelayErrorCode = "insufficient_balance" | "intent_invalid";

export function relayCode(f: VerifierFailure | string): RelayErrorCode {
  return f === "insufficient_funds" ? "insufficient_balance" : "intent_invalid";
}

const SETTLE = new Set<string>(X402_SETTLE_ERRORS);
export type SettleError = (typeof X402_SETTLE_ERRORS)[number];

/** The stored failure reason of an agent payment as an x402 `errorReason`. */
export function settleError(reason: string | null): SettleError {
  return reason && SETTLE.has(reason) ? (reason as SettleError) : "unexpected_settle_error";
}
