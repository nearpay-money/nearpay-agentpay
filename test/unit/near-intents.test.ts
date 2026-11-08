/**
 * near-intents domain rules (lld/agentpay.md §3.1): terms comparison, slippage, token expiry, rails quote
 * failures, execution-event decisions, the merchant record, settle verdicts; operation-token key files.
 */
import { newId } from "@nearpay-internal/ids";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import {
  canMoveOperation,
  clampSlippage,
  comparable,
  containsTx,
  coversAmount,
  decideExecutionEvent,
  executionMatches,
  failureReason,
  hasQuotedOnly,
  isPendingState,
  merchantRecord,
  quoteFailure,
  sameTx,
  TOKEN_GRACE_S,
  tokenExpiry,
  validSlippageRange,
  verdictOf,
} from "../../src/domain/near-intents/rules.js";
import { loadOperationKeys, parseOperationKey } from "../../src/infra/operation-keys.js";
import {
  BASE_USDC,
  DELIVERY_TX,
  DEPOSIT,
  failedExecution,
  ORIGIN_TX,
  quoteExecution,
  REFUND_TO,
  refundedExecution,
  settledExecution,
} from "../support/executions.js";
import { NEAR_INTENTS_VECTORS as V } from "../support/vectors.js";

const account = newId("acct") as `acct_${string}`;
const binding = V.binding.binding;
const quoted = quoteExecution({ account, binding, payTo: "merchant.near", amount: "1000000" });
const req = {
  binding,
  account_id: "x",
  livemode: false,
  pay_to: "merchant.near",
  asset_id: USDC_NEAR,
  amount: "1000000",
};

describe("terms", () => {
  const unquoted = (V.headers.payment_required_unquoted as { accepts: Record<string, unknown>[] }).accepts[0] as never;
  const quotedEntry = (V.headers.payment_required_quoted as { accepts: Record<string, unknown>[] }).accepts[0] as never;
  it("compares entries without indicativeAmount", () => {
    const e = comparable(unquoted) as { extra: Record<string, unknown> };
    expect(e.extra.indicativeAmount).toBeUndefined();
    expect(e.extra.binding).toBe(binding);
  });
  it("detects quoted-only fields", () => {
    expect(hasQuotedOnly(unquoted)).toBe(false);
    expect(hasQuotedOnly(quotedEntry)).toBe(true);
  });
  it("clamps slippage into the range and applies the default", () => {
    const r = { min: 10, max: 300, default: 50 };
    expect(clampSlippage(undefined, r)).toBe(50);
    expect(clampSlippage(0, r)).toBe(10);
    expect(clampSlippage(10_000, r)).toBe(300);
    expect(clampSlippage(120, r)).toBe(120);
    expect(validSlippageRange(r)).toBe(true);
    expect(validSlippageRange({ min: 60, max: 300, default: 50 })).toBe(false);
    expect(validSlippageRange({ min: 10, max: 10_001, default: 50 })).toBe(false);
  });
  it("token expiry is the refund deadline + 24 h, in whole seconds (spec vector)", () => {
    expect(tokenExpiry(Date.parse("2026-11-08T10:32:00.000Z"))).toBe(V.operation_token.input.expiry);
    expect(tokenExpiry(1_999)).toBe(1 + TOKEN_GRACE_S);
  });
  it("compares EVM tx hashes case-insensitively and others exactly", () => {
    expect(sameTx(ORIGIN_TX, ORIGIN_TX.toUpperCase().replace("0X", "0x"))).toBe(true);
    expect(sameTx(DELIVERY_TX, DELIVERY_TX.toLowerCase())).toBe(false);
    expect(containsTx([DELIVERY_TX, ORIGIN_TX], ORIGIN_TX)).toBe(true);
    expect(containsTx([], ORIGIN_TX)).toBe(false);
  });
});

describe("rails quote failures", () => {
  it("maps refusals, 503s and transport failures; frees the binding only when retrying can help", () => {
    expect(quoteFailure(null)).toEqual({ kind: "unavailable", code: "rail_unavailable", release: false });
    expect(quoteFailure("screening_blocked")).toEqual({ kind: "invalid", reason: "payer_blocked", release: false });
    for (const c of ["route_unavailable", "pricing_unavailable"])
      expect(quoteFailure(c)).toEqual({
        kind: "invalid",
        reason: "invalid_exact_near_intents_quote_unavailable",
        release: true,
      });
    for (const c of ["quote_rejected", "deadline_too_short", "asset_unsupported", "quote_integrity_failed"])
      expect(quoteFailure(c)).toEqual({
        kind: "invalid",
        reason: "invalid_exact_near_intents_quote_unavailable",
        release: false,
      });
    expect(quoteFailure("screening_unavailable")).toEqual({
      kind: "unavailable",
      code: "screening_unavailable",
      release: true,
    });
    expect(quoteFailure("rail_unavailable")).toEqual({ kind: "unavailable", code: "rail_unavailable", release: true });
    expect(quoteFailure("idempotency_key_reused")).toEqual({
      kind: "unavailable",
      code: "rail_unavailable",
      release: false,
    });
  });
});

describe("execution events", () => {
  const settled = settledExecution(quoted);
  it("ignores executions of other owners", () => {
    expect(decideExecutionEvent("evt.rails.execution.settled", { ...settled, owner: "payments" })).toEqual({
      kind: "ignore",
    });
    expect(decideExecutionEvent("evt.rails.execution.settled", { ...settled, owner: undefined })).toEqual({
      kind: "ignore",
    });
  });
  it("settled → merchant record; refunded/failed → failure result", () => {
    expect(decideExecutionEvent("evt.rails.execution.settled", settled)).toEqual({ kind: "settled" });
    expect(decideExecutionEvent("evt.rails.execution.refunded", refundedExecution(quoted))).toEqual({
      kind: "failed",
      errorReason: "exact_near_intents_payment_failed",
    });
    expect(
      decideExecutionEvent("evt.rails.execution.refunded", refundedExecution(quoted, "INCOMPLETE_DEPOSIT")),
    ).toEqual({
      kind: "failed",
      errorReason: "exact_near_intents_insufficient_deposit",
    });
    expect(decideExecutionEvent("evt.rails.execution.failed", failedExecution(quoted))).toEqual({
      kind: "failed",
      errorReason: "exact_near_intents_payment_failed",
    });
  });
  it("rails defects: no binding, wrong state, no evidence, no sender, no amount, no deposit", () => {
    const d = (s: Parameters<typeof decideExecutionEvent>[0], x: Parameters<typeof decideExecutionEvent>[1]) =>
      decideExecutionEvent(s, x).kind;
    expect(d("evt.rails.execution.settled", { ...settled, x402_binding: null })).toBe("defect");
    expect(d("evt.rails.execution.settled", quoted)).toBe("defect");
    expect(d("evt.rails.execution.settled", { ...settled, evidence: null })).toBe("defect");
    expect(d("evt.rails.execution.settled", settledExecution(quoted, { sender: null }))).toBe("defect");
    expect(d("evt.rails.execution.settled", { ...settled, settled_amount: null })).toBe("defect");
    expect(d("evt.rails.execution.settled", { ...settled, settled_amount: "0" })).toBe("defect");
    expect(d("evt.rails.execution.settled", { ...settled, deposit: null })).toBe("defect");
    expect(d("evt.rails.execution.refunded", settled)).toBe("defect");
    expect(d("evt.rails.execution.failed", refundedExecution(quoted))).toBe("defect");
  });
  it("failure reasons", () => {
    expect(failureReason("refunded", "Incomplete deposit")).toBe("exact_near_intents_insufficient_deposit");
    expect(failureReason("refunded", null)).toBe("exact_near_intents_payment_failed");
    expect(failureReason("failed", "incomplete")).toBe("exact_near_intents_payment_failed");
  });
  it("the execution must match its requirement", () => {
    expect(executionMatches(settled, req, account)).toBeNull();
    expect(executionMatches(settled, { ...req, binding: "np1:other" }, account)).toBe("binding differs");
    expect(executionMatches(settled, req, newId("acct"))).toBe("account or mode differs");
    expect(executionMatches(settled, { ...req, livemode: true }, account)).toBe("account or mode differs");
    expect(executionMatches(settled, { ...req, asset_id: BASE_USDC }, account)).toBe("settlement asset differs");
    expect(executionMatches(settled, { ...req, pay_to: "other.near" }, account)).toBe("recipient differs");
  });
  it("the merchant record: payer = evidence.sender, fee 0, amount = settled amount, origin from the deposit", () => {
    const r = merchantRecord(settledExecution(quoted, { settled: "1000017" }), req);
    expect(r).toMatchObject({
      payer: "solver.near",
      pay_to: "merchant.near",
      asset_id: USDC_NEAR,
      amount: "1000017",
      fee_amount: "0",
      binding,
      execution_id: quoted.id,
      tx_hash: DELIVERY_TX,
      block_height: 180000123n,
    });
    expect(r.origin).toEqual({
      network: "eip155:8453",
      asset_id: BASE_USDC,
      amount_in: "1012000",
      refund_to: REFUND_TO,
      deposit_address: DEPOSIT,
      deposit_memo: null,
      tx_hashes: [ORIGIN_TX],
      fee: { amount: "5000", asset_id: BASE_USDC },
    });
    const noFee = merchantRecord(
      {
        ...settled,
        observed_fee: null,
        deposited_amount: undefined,
        evidence: { ...(settled.evidence as { tx_hash: string; block_ref: string | null }), block_ref: "abc" },
      },
      req,
    );
    expect(noFee.origin.fee).toBeNull();
    expect(noFee.origin.amount_in).toBeNull();
    expect(noFee.block_height).toBeNull();
    expect(
      merchantRecord(
        {
          ...settled,
          evidence: { ...(settled.evidence as { tx_hash: string; block_ref: string | null }), block_ref: null },
        },
        req,
      ).block_height,
    ).toBeNull();
  });
  it("operations move once: quoted → settled | failed", () => {
    expect(canMoveOperation("quoted", "settled")).toBe(true);
    expect(canMoveOperation("quoted", "failed")).toBe(true);
    expect(canMoveOperation("settled", "failed")).toBe(false);
    expect(canMoveOperation("failed", "settled")).toBe(false);
    expect(canMoveOperation("quoted", "quoted")).toBe(false);
  });
});

describe("settle verdicts", () => {
  const ok = {
    outcome: "settled" as const,
    transaction: DELIVERY_TX,
    amount: "1000000",
    network: "eip155:8453",
    refund_to: REFUND_TO,
    agent_payment: newId("ap"),
    tx_hashes: [ORIGIN_TX],
  };
  it("success needs the presented tx among the operation's deposits", () => {
    expect(verdictOf(ok, ORIGIN_TX).kind).toBe("success");
    expect(verdictOf(ok, `0x${"1".repeat(64)}`).kind).toBe("deposit_not_found");
    expect(verdictOf(ok, `0x${"1".repeat(64)}`, [`0x${"1".repeat(64)}`]).kind).toBe("success");
  });
  it("a failure result is a failure whatever tx is presented", () => {
    const failed = {
      outcome: "failed" as const,
      error_reason: "exact_near_intents_payment_failed" as const,
      status: "REFUNDED",
      network: "eip155:8453",
      refund_to: REFUND_TO,
    };
    expect(verdictOf(failed, "anything-at-all").kind).toBe("failure");
  });
  it("pending states and coverage", () => {
    for (const s of ["awaiting_deposit", "deposit_detected", "settling", "verifying", "held", "incomplete_deposit"])
      expect(isPendingState(s)).toBe(true);
    for (const s of ["succeeded", "refunded", "failed", "expired_unpaid"]) expect(isPendingState(s)).toBe(false);
    expect(coversAmount("1000000", "1000000")).toBe(true);
    expect(coversAmount("1000017", "1000000")).toBe(true);
    expect(coversAmount("999999", "1000000")).toBe(false);
  });
});

describe("operation-token key files", () => {
  const fs = (files: Record<string, { body: Buffer; at: number }>) => ({
    list: () => Object.keys(files),
    read: (p: string) => (files[p.split("/").pop() as string] as { body: Buffer }).body,
    mtimeMs: (p: string) => (files[p.split("/").pop() as string] as { at: number }).at,
  });
  const raw = Buffer.alloc(32, 7);
  const hexKey = Buffer.from("ab".repeat(32));
  it("loads every key by kid; the newest file signs (then the greatest kid)", () => {
    const k = loadOperationKeys(
      "/run/secrets/x402_op_key_*",
      fs({
        x402_op_key_k1: { body: raw, at: 1 },
        x402_op_key_k2: { body: hexKey, at: 2 },
        other: { body: raw, at: 9 },
      }),
    );
    expect(k?.signing.kid).toBe("k2");
    expect(Buffer.from(k?.signing.key ?? []).toString("hex")).toBe("ab".repeat(32));
    expect([...(k?.all.keys() ?? [])].sort()).toEqual(["k1", "k2"]);
    const tie = loadOperationKeys("/s/key_*", fs({ key_a: { body: raw, at: 5 }, key_b: { body: raw, at: 5 } }));
    expect(tie?.signing.kid).toBe("b");
  });
  it("unset → null; no match, a bad kid, a short key or a pattern without * → boot error", () => {
    expect(loadOperationKeys(undefined)).toBeNull();
    expect(() => loadOperationKeys("/s/key_*", fs({}))).toThrow(/no x402 operation key files/);
    expect(() => loadOperationKeys("/s/key_*", fs({ key_K1: { body: raw, at: 1 } }))).toThrow(/key id/);
    expect(() => loadOperationKeys("/s/key", fs({}))).toThrow(/needs a \*/);
    expect(() => parseOperationKey(Buffer.alloc(31))).toThrow(/at least 32 bytes/);
    expect(parseOperationKey(Buffer.from(`${"0f".repeat(40)}\n`)).length).toBe(40);
  });
});
