/**
 * `exact` + `near-intents` rules (lld/agentpay.md §3.1). Pure: no I/O, bigint money.
 *
 * - entry terms: the echoed unquoted entry must be the issued one (JCS), without quoted-only fields;
 *   `extra.indicativeAmount` is informational and not compared.
 * - slippage: a quote payload's `slippageTolerance` is clamped into the issued range (default when absent).
 * - operation token expiry: refund deadline + 24 h (rails tracks expired executions 24 h).
 * - rails quote failures: which refusals are `invalid_exact_near_intents_quote_unavailable`, which free the
 *   binding for another quote, which are 503s.
 * - operations: `quoted → settled | failed`, both final; only an execution event moves it.
 * - merchant record: an agent payment exists only for a **settled** execution (evidence + sender); refunded and
 *   failed executions create none (nothing reached the merchant).
 * - settle answers: success needs a recorded settlement and the presented deposit tx among the operation's.
 */
import { NearAccountId, QUOTED_ONLY_EXTRA } from "@nearpay-money/spec";

// ---------------------------------------------------------------------------------------------- terms

export interface SlippageRange {
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

/** True when the range is usable: integers 0 ≤ min ≤ default ≤ max ≤ 10 000. */
export function validSlippageRange(r: SlippageRange): boolean {
  return (
    [r.min, r.max, r.default].every((v) => Number.isInteger(v) && v >= 0 && v <= 10_000) &&
    r.min <= r.default &&
    r.default <= r.max
  );
}

/** `clamp(slippageTolerance ?? default, min, max)` in bps. */
export function clampSlippage(requested: number | undefined, r: SlippageRange): number {
  const v = requested ?? r.default;
  return Math.min(r.max, Math.max(r.min, v));
}

/** Seconds a token outlives the refund deadline (rails keeps tracking an expired execution 24 h). */
export const TOKEN_GRACE_S = 86_400;

/** Token expiry (unix seconds) for a refund deadline: whole seconds of the deadline + 24 h. */
export function tokenExpiry(refundDeadlineMs: number): number {
  return Math.floor(refundDeadlineMs / 1000) + TOKEN_GRACE_S;
}

type Entry = { readonly extra: Readonly<Record<string, unknown>> } & Readonly<Record<string, unknown>>;

/** The entry without its informational `extra.indicativeAmount` (the comparison form of an unquoted entry). */
export function comparable(entry: Entry): Record<string, unknown> {
  const { indicativeAmount: _drop, ...extra } = entry.extra;
  return { ...entry, extra };
}

/** True when an entry carries a quoted-only field (`operationToken`, `refundDeadline`, `depositMemo`, `minAmountIn`). */
export function hasQuotedOnly(entry: Entry): boolean {
  return QUOTED_ONLY_EXTRA.some((k) => entry.extra[k] !== undefined);
}

/**
 * Deposit transactions compare case-insensitively when they are `0x` hex (EVM), exactly otherwise (base58 and
 * other case-sensitive encodings).
 */
export function sameTx(a: string, b: string): boolean {
  const hex = /^0x[0-9a-fA-F]+$/;
  return hex.test(a) && hex.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function containsTx(list: readonly string[], tx: string): boolean {
  return list.some((t) => sameTx(t, tx));
}

// ---------------------------------------------------------------------------------------------- quote failures

export type QuoteFailure =
  /** `isValid: false`; `release` frees the binding so the same entry can be quoted again. */
  | {
      readonly kind: "invalid";
      readonly reason: "invalid_exact_near_intents_quote_unavailable" | "payer_blocked";
      readonly release: boolean;
    }
  /** HTTP 503 `rail_unavailable` / `screening_unavailable`; `release` only when rails provably created nothing. */
  | {
      readonly kind: "unavailable";
      readonly code: "rail_unavailable" | "screening_unavailable";
      readonly release: boolean;
    };

/** Rails refusals that mean "no quote for these terms" (rails code goes into `invalidMessage`). */
export const QUOTE_UNAVAILABLE_CODES = [
  "route_unavailable",
  "quote_rejected",
  "pricing_unavailable",
  "deadline_too_short",
  "asset_unsupported",
  "quote_integrity_failed",
] as const;

/** Of those, the ones worth another quote of the same entry later (the binding is released). */
export const RETRYABLE_QUOTE_CODES = ["route_unavailable", "pricing_unavailable"] as const;

/**
 * Maps a failed rails `createExecution` call. `code` is rails' error code when it answered with an error
 * envelope (rails creates no execution then: it replays an existing one before anything else), null for a
 * timeout or transport failure (an execution may exist: the binding stays consumed, fail closed).
 */
export function quoteFailure(code: string | null): QuoteFailure {
  if (code === null) return { kind: "unavailable", code: "rail_unavailable", release: false };
  if (code === "screening_blocked") return { kind: "invalid", reason: "payer_blocked", release: false };
  if ((QUOTE_UNAVAILABLE_CODES as readonly string[]).includes(code))
    return {
      kind: "invalid",
      reason: "invalid_exact_near_intents_quote_unavailable",
      release: (RETRYABLE_QUOTE_CODES as readonly string[]).includes(code),
    };
  if (code === "screening_unavailable") return { kind: "unavailable", code: "screening_unavailable", release: true };
  if (code === "rail_unavailable") return { kind: "unavailable", code: "rail_unavailable", release: true };
  // anything else (an unexpected rails answer): fail closed and keep the binding
  return { kind: "unavailable", code: "rail_unavailable", release: false };
}

// ---------------------------------------------------------------------------------------------- operations

export type OperationStatus = "quoted" | "settled" | "failed";
export type ExecutionSubject =
  | "evt.rails.execution.settled"
  | "evt.rails.execution.refunded"
  | "evt.rails.execution.failed";

/** `quoted → settled | failed`; final states never change (rails' terminal states are absorbing). */
export function canMoveOperation(from: OperationStatus, to: OperationStatus): boolean {
  return from === "quoted" && (to === "settled" || to === "failed");
}

/** The minimal execution view the rules read (spec `Execution`). */
export interface ExecutionFacts {
  readonly id: string;
  readonly account_id: string;
  readonly livemode: boolean;
  readonly owner?: string | undefined;
  readonly x402_binding?: string | null | undefined;
  readonly method: string;
  readonly state: string;
  readonly provider_status: string | null;
  readonly origin: { readonly asset_id: string; readonly chain: string; readonly refund_to: string };
  readonly settlement: { readonly asset_id: string; readonly recipient: string };
  readonly deposit: { readonly address: string; readonly memo: string | null } | null;
  readonly deposit_tx_hashes: readonly string[];
  readonly settled_amount: string | null;
  readonly refund_reason: string | null;
  readonly evidence: {
    readonly tx_hash: string;
    readonly block_ref: string | null;
    readonly sender?: string | null | undefined;
  } | null;
  readonly observed_fee?: { readonly amount: string; readonly asset_id: string } | null | undefined;
  readonly deposited_amount?: string | null | undefined;
}

/** The issued requirement an execution's binding points to. */
export interface IssuedFacts {
  readonly binding: string;
  readonly account_id: string;
  readonly livemode: boolean;
  readonly pay_to: string;
  readonly asset_id: string;
  readonly amount: string;
}

export type EventDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "settled" }
  | { readonly kind: "failed"; readonly errorReason: FailureReason }
  /** A rails contract defect: nak (retried), alert. */
  | { readonly kind: "defect"; readonly detail: string };

export type FailureReason = "exact_near_intents_insufficient_deposit" | "exact_near_intents_payment_failed";

/** Refunded because the deposit was incomplete → insufficient deposit; any other refund or failure → payment failed. */
export function failureReason(state: string, refundReason: string | null): FailureReason {
  if (state === "refunded" && refundReason !== null && /incomplete|insufficient/i.test(refundReason))
    return "exact_near_intents_insufficient_deposit";
  return "exact_near_intents_payment_failed";
}

/** What a consumed execution event does (§8): only agentpay-owned executions; settled → merchant record. */
export function decideExecutionEvent(subject: ExecutionSubject, x: ExecutionFacts): EventDecision {
  if (x.owner !== "agentpay") return { kind: "ignore" };
  if (!x.x402_binding) return { kind: "defect", detail: "agentpay execution without x402_binding" };
  if (subject === "evt.rails.execution.settled") {
    if (x.state !== "succeeded") return { kind: "defect", detail: `settled event in state ${x.state}` };
    if (!x.evidence) return { kind: "defect", detail: "settled execution without evidence" };
    if (!x.evidence.sender) return { kind: "defect", detail: "settled execution without evidence.sender" };
    // the agent payment's `payer` is a NEAR account (the Intents account that delivered)
    if (!NearAccountId.safeParse(x.evidence.sender).success)
      return { kind: "defect", detail: "evidence.sender is not a NEAR account" };
    if (x.settled_amount === null || BigInt(x.settled_amount) <= 0n)
      return { kind: "defect", detail: "settled execution without a settled amount" };
    if (!x.deposit) return { kind: "defect", detail: "settled route execution without deposit instructions" };
    return { kind: "settled" };
  }
  const expected = subject === "evt.rails.execution.refunded" ? "refunded" : "failed";
  if (x.state !== expected) return { kind: "defect", detail: `${subject} in state ${x.state}` };
  return { kind: "failed", errorReason: failureReason(x.state, x.refund_reason) };
}

/** The execution must belong to the requirement it names (account, mode, merchant, asset). */
export function executionMatches(x: ExecutionFacts, req: IssuedFacts, acctId: string): string | null {
  if (x.x402_binding !== req.binding) return "binding differs";
  if (x.account_id !== acctId || x.livemode !== req.livemode) return "account or mode differs";
  if (x.settlement.asset_id !== req.asset_id) return "settlement asset differs";
  if (x.settlement.recipient !== req.pay_to) return "recipient differs";
  return null;
}

/** The agent payment fields of a settled near-intents execution (§3.1 step 5). */
export interface MerchantRecord {
  readonly payer: string;
  readonly pay_to: string;
  readonly asset_id: string;
  readonly amount: string;
  readonly fee_amount: "0";
  readonly binding: string;
  readonly execution_id: string;
  readonly tx_hash: string;
  /** Evidence `block_ref` when it is a height (a hash gives null). */
  readonly block_height: bigint | null;
  readonly origin: {
    network: string;
    asset_id: string;
    amount_in: string | null;
    refund_to: string;
    deposit_address: string;
    deposit_memo: string | null;
    tx_hashes: string[];
    fee: { amount: string; asset_id: string } | null;
  };
}

/** Only for a `settled` decision (evidence, sender, amount and deposit present). */
export function merchantRecord(x: ExecutionFacts, req: IssuedFacts): MerchantRecord {
  const ev = x.evidence as NonNullable<ExecutionFacts["evidence"]>;
  const dep = x.deposit as NonNullable<ExecutionFacts["deposit"]>;
  return {
    payer: ev.sender as string,
    pay_to: req.pay_to,
    asset_id: x.settlement.asset_id,
    amount: BigInt(x.settled_amount as string).toString(),
    fee_amount: "0",
    binding: req.binding,
    execution_id: x.id,
    tx_hash: ev.tx_hash,
    block_height: ev.block_ref !== null && /^[0-9]{1,19}$/.test(ev.block_ref) ? BigInt(ev.block_ref) : null,
    origin: {
      network: x.origin.chain,
      asset_id: x.origin.asset_id,
      amount_in: x.deposited_amount ?? null,
      refund_to: x.origin.refund_to,
      deposit_address: dep.address,
      deposit_memo: dep.memo,
      tx_hashes: [...x.deposit_tx_hashes],
      fee: x.observed_fee ? { amount: x.observed_fee.amount, asset_id: x.observed_fee.asset_id } : null,
    },
  };
}

// ---------------------------------------------------------------------------------------------- results

/** The recorded final outcome of an operation (`x402_operations.result`; never the token). */
export type OperationResult =
  | {
      readonly outcome: "settled";
      /** Delivery tx on near:mainnet (the evidence). */
      readonly transaction: string;
      readonly amount: string;
      readonly network: string;
      readonly refund_to: string;
      readonly agent_payment: string;
      readonly tx_hashes: readonly string[];
    }
  | {
      readonly outcome: "failed";
      readonly error_reason: FailureReason;
      readonly status: string | null;
      readonly network: string;
      readonly refund_to: string;
    };

/** True when the delivered amount covers the issued one (EXACT_OUTPUT: rails may add a small amount tag). */
export function coversAmount(settled: string, issued: string): boolean {
  return BigInt(settled) >= BigInt(issued);
}

export type SettleVerdict =
  | { readonly kind: "success"; readonly result: Extract<OperationResult, { outcome: "settled" }> }
  | { readonly kind: "failure"; readonly result: Extract<OperationResult, { outcome: "failed" }> }
  /** The operation settled, but not with the presented tx (the client may present another tx of the operation). */
  | { readonly kind: "deposit_not_found" };

/** The answer a recorded result gives to a settle call presenting `txHash`. */
export function verdictOf(
  result: OperationResult,
  txHash: string,
  liveTxHashes: readonly string[] = [],
): SettleVerdict {
  if (result.outcome === "failed") return { kind: "failure", result };
  return containsTx(result.tx_hashes, txHash) || containsTx(liveTxHashes, txHash)
    ? { kind: "success", result }
    : { kind: "deposit_not_found" };
}

/** Rails states before a final one: the settle answer is `settlement_pending` (never recorded, never claimed). */
export function isPendingState(state: string): boolean {
  return !["succeeded", "refunded", "failed", "expired_unpaid"].includes(state);
}
