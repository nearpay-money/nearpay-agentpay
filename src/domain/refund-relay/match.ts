/**
 * Refund legs from an Intents account (lld/agentpay.md §5 `kind: refund`, payments §17 items 2–3). Pure.
 *
 * The merchant signs exactly one Verifier transfer that payments built and issued as the leg's
 * `next_action` (`sign_intent`): `transfer(receiver_id, {token: amount}, memo = binding)` signed by the
 * merchant's Intents account, for `intents.near`, with payments' fresh nonce and deadline. agentpay
 * relays it only if it is exactly that payload, checked against two sources that must agree:
 *
 * - rails' execution (`Execution.refund.transfer`): signer, receiver, token, amount, memo (= binding)
 *   and the latest acceptable deadline — the leg as rails prepared it;
 * - payments' issued payload (`Refund.next_action`, `RefundSignIntent`): the same transfer plus the
 *   nonce, the exact deadline, the accepted standards and the exact strings that were handed out
 *   for signing (NEP-413 `message`, ERC-191 / raw-ed25519 `payload`).
 *
 * Any difference — one field of the message, an extra intent, an extra token, another standard or a
 * byte of the signed string — is `signed_intent_mismatch`; NearPay never relays anything else (INV-1:
 * the relayer only pays gas for a payload its owner signed as issued).
 */
import type { IntentMessage, MultiPayload } from "@nearpay/spec";
import { DEADLINE_MARGIN_MS } from "../facilitator-payment/match.js";

/** `Execution.refund.transfer` (rails). */
export interface RefundTransferTerms {
  readonly signer_id: string;
  readonly receiver_id: string;
  readonly token: string;
  readonly amount: string;
  readonly memo: string;
  /** Latest acceptable payload deadline (RFC 3339). */
  readonly deadline: string;
}

/** The `sign_intent` next action payments issued for the leg (`RefundSignIntent`). */
export interface IssuedRefundPayload {
  readonly signer_id: string;
  readonly transfer: {
    readonly receiver_id: string;
    readonly token: string;
    readonly amount: string;
    readonly memo: string;
  };
  readonly standards: readonly string[];
  readonly nep413: { readonly recipient: string; readonly nonce: string; readonly message: string };
  readonly payload: string;
  readonly message: IntentMessage;
}

/** Why the issued leg itself cannot be relayed (not the merchant's fault: prepare the leg again). */
export type IssuedFailure = "issued_inconsistent";
export type RefundMatchFailure = "signed_intent_mismatch" | "deadline_passed";

export type RefundMatchResult =
  | { ok: true }
  | { ok: false; reason: RefundMatchFailure | IssuedFailure; detail: string };

const fail = (reason: RefundMatchFailure | IssuedFailure, detail: string): RefundMatchResult => ({
  ok: false,
  reason,
  detail,
});

const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

interface TransferLike {
  intent?: unknown;
  receiver_id?: unknown;
  tokens?: unknown;
  memo?: unknown;
  [k: string]: unknown;
}

/** The one transfer of a message, compared field by field; null when it is exactly `t`. */
function transferDiff(m: IntentMessage, t: RefundTransferTerms): string | null {
  if (m.intents.length !== 1) return `the payload must contain exactly one transfer (has ${m.intents.length})`;
  const i = m.intents[0] as TransferLike;
  if (i.intent !== "transfer") return "the intent must be a transfer";
  const extra = Object.keys(i).filter((k) => !["intent", "receiver_id", "tokens", "memo"].includes(k));
  if (extra.length) return `the transfer carries unexpected fields (${extra.join(", ")})`;
  if (i.receiver_id !== t.receiver_id) return "receiver differs";
  const tokens = (i.tokens ?? {}) as Record<string, unknown>;
  const keys = Object.keys(tokens);
  if (keys.length !== 1 || keys[0] !== t.token) return "token differs";
  const v = tokens[t.token];
  if (typeof v !== "string" || !BASE_UNITS.test(v) || v !== t.amount) return "amount differs";
  if (i.memo !== t.memo) return "memo differs";
  return null;
}

/**
 * The issued payload agrees with rails' execution: same signer and transfer, a self-consistent parsed
 * message, a deadline within the execution's, and a nonce that is the one in the NEP-413 arguments.
 */
export function checkIssued(issued: IssuedRefundPayload, t: RefundTransferTerms, contract: string): RefundMatchResult {
  if (issued.signer_id !== t.signer_id || issued.message.signer_id !== t.signer_id)
    return fail("issued_inconsistent", "the issued signer is not the execution's");
  const it = issued.transfer;
  if (it.receiver_id !== t.receiver_id || it.token !== t.token || it.amount !== t.amount || it.memo !== t.memo)
    return fail("issued_inconsistent", "the issued transfer is not the execution's");
  if (issued.message.verifying_contract !== contract || issued.nep413.recipient !== contract)
    return fail("issued_inconsistent", `the issued payload is not for ${contract}`);
  if (issued.message.nonce !== issued.nep413.nonce) return fail("issued_inconsistent", "the issued nonces differ");
  const d = transferDiff(issued.message, t);
  if (d) return fail("issued_inconsistent", `issued message: ${d}`);
  const deadline = Date.parse(issued.message.deadline);
  const max = Date.parse(t.deadline);
  if (!Number.isFinite(deadline) || !Number.isFinite(max) || deadline > max)
    return fail("issued_inconsistent", "the issued deadline is later than the execution allows");
  if (issued.standards.length === 0) return fail("issued_inconsistent", "no signing standard was issued");
  return { ok: true };
}

/** The exact string the signer signed (NEP-413 `message`, or the ERC-191 / raw-ed25519 payload). */
function signedString(p: MultiPayload): string {
  return p.standard === "nep413" ? p.payload.message : p.payload;
}

/**
 * The signed payload is exactly the issued one. `message` is the signature-verified, parsed message of
 * `signed` (kit `verifySigned`: for NEP-413 rebuilt with its nonce and recipient). Call `checkIssued`
 * first; the result only holds for an issued payload that passed it.
 */
export function matchRefundPayload(
  signed: MultiPayload,
  message: IntentMessage,
  issued: IssuedRefundPayload,
  t: RefundTransferTerms,
  contract: string,
  nowMs: number,
): RefundMatchResult {
  if (!issued.standards.includes(signed.standard))
    return fail("signed_intent_mismatch", `standard ${signed.standard} was not issued`);
  if (message.signer_id !== t.signer_id) return fail("signed_intent_mismatch", "signer differs");
  if (message.verifying_contract !== contract) return fail("signed_intent_mismatch", "verifying contract differs");
  if (message.nonce !== issued.message.nonce) return fail("signed_intent_mismatch", "nonce differs");
  if (message.deadline !== issued.message.deadline) return fail("signed_intent_mismatch", "deadline differs");
  const d = transferDiff(message, t);
  if (d) return fail("signed_intent_mismatch", d);
  if (signed.standard === "nep413") {
    if (signed.payload.recipient !== issued.nep413.recipient)
      return fail("signed_intent_mismatch", "NEP-413 recipient differs");
    if (signed.payload.nonce !== issued.nep413.nonce) return fail("signed_intent_mismatch", "nonce differs");
    if (signed.payload.callbackUrl != null) return fail("signed_intent_mismatch", "NEP-413 callbackUrl was not issued");
    if (signedString(signed) !== issued.nep413.message)
      return fail("signed_intent_mismatch", "the signed message is not the issued one");
  } else if (signedString(signed) !== issued.payload)
    return fail("signed_intent_mismatch", "the signed payload is not the issued one");
  const deadline = Date.parse(message.deadline);
  if (!Number.isFinite(deadline) || deadline <= nowMs + DEADLINE_MARGIN_MS)
    return fail("deadline_passed", "the payload deadline has passed or is too close; prepare the refund again");
  return { ok: true };
}
