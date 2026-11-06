/**
 * Spec 0.1.5 fields agentpay produces: `SettleResponse.replayed` (CR-15-12), the requirement's
 * `extra.deadline` (CR-15-11) and `AgentPayment.sequence` (CR-15-09).
 */
import { AgentPayment, PaymentRequirements, SettleResponse } from "@nearpay/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import type { Agentpay } from "../../src/app/context.js";
import { paymentRequirements } from "../../src/app/requirements.js";
import { agentPaymentView } from "../../src/app/views.js";
import { report, sameTerms, settleView } from "../../src/app/x402.js";
import { x402Binding } from "../../src/domain/binding/binding.js";
import { agentPaymentRow } from "../support/rows.js";

/** A db stand-in for report()'s conditional update: only the first claim per id returns a row. */
function claimDb() {
  const reported = new Set<string>();
  const calls: string[] = [];
  const db = {
    updateTable: () => {
      let id = "";
      const q = {
        set: () => q,
        where: (col: string, _op: string, v: unknown) => {
          if (col === "id") id = v as string;
          return q;
        },
        returning: () => q,
        executeTakeFirst: async () => {
          calls.push(id);
          if (reported.has(id)) return undefined;
          reported.add(id);
          return { id };
        },
      };
      return q;
    },
  };
  return { ap: { db, now: () => Date.now() } as unknown as Agentpay, calls };
}

describe("settle replayed", () => {
  it("is absent on the first final answer and true on every repeat of it", async () => {
    const { ap } = claimDb();
    const settled = agentPaymentRow();
    const first = SettleResponse.parse(await report(ap, settled));
    expect(first).toMatchObject({ success: true, transaction: settled.tx_hash, amount: "10000" });
    expect(first.replayed).toBeUndefined();
    for (let k = 0; k < 3; k++) {
      const again = SettleResponse.parse(await report(ap, settled));
      expect(again).toEqual({ ...first, replayed: true });
    }
  });

  it("marks a repeated failure too, per payment", async () => {
    const { ap } = claimDb();
    const failed = agentPaymentRow({ status: "failed", error_reason: "insufficient_funds", settled_at: null });
    const other = agentPaymentRow();
    expect((await report(ap, failed)).replayed).toBeUndefined();
    expect((await report(ap, other)).replayed).toBeUndefined();
    expect(await report(ap, failed)).toMatchObject({
      success: false,
      errorReason: "insufficient_funds",
      replayed: true,
    });
  });

  it("never marks a pending answer, and a pending answer does not use up the first delivery", async () => {
    const { ap, calls } = claimDb();
    const queued = agentPaymentRow({ status: "queued", tx_hash: null, block_height: null, settled_at: null });
    for (let k = 0; k < 2; k++) {
      const r = await report(ap, queued);
      expect(r).toMatchObject({ success: false, errorReason: "settlement_pending" });
      expect(r.replayed).toBeUndefined();
    }
    expect(calls).toEqual([]);
    const settled = { ...queued, status: "settled" as const, tx_hash: "8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c" };
    expect((await report(ap, settled)).replayed).toBeUndefined();
    expect((await report(ap, settled)).replayed).toBe(true);
  });

  it("settleView only adds replayed to final outcomes", () => {
    expect(settleView(agentPaymentRow(), true).replayed).toBe(true);
    expect(settleView(agentPaymentRow({ status: "submitted" }), true).replayed).toBeUndefined();
    expect(settleView(agentPaymentRow(), false)).not.toHaveProperty("replayed");
  });
});

describe("requirement deadline", () => {
  const terms = {
    amount: "10000",
    assetId: USDC_NEAR,
    payTo: "merchant.near",
    maxTimeoutS: 120,
    feeTo: "treasury.nearpay.near",
    fee: "30",
    expiresAt: 1_794_000_120,
  };
  const binding = x402Binding({
    account_id: "acct_01jc5xqf6kd9v8z2m3n4p5q6r7",
    resource_url: "https://merchant.example/premium",
    payTo: terms.payTo,
    asset: terms.assetId,
    amount: terms.amount,
    fee: terms.fee,
    nonce16: "00112233445566778899aabbccddeeff",
    expires_at: terms.expiresAt,
  });
  const pr = paymentRequirements({ ...terms, binding });
  const issued = {
    pay_to: terms.payTo,
    asset_id: terms.assetId,
    amount: terms.amount,
    fee_to: terms.feeTo,
    fee_amount: terms.fee,
    max_timeout_s: terms.maxTimeoutS,
    expires_at: new Date(terms.expiresAt * 1000),
  } as never;

  it("equals the binding's expires_at, in RFC 3339", () => {
    expect(PaymentRequirements.parse(pr).extra.deadline).toBe("2026-11-06T21:22:00.000Z");
    expect(Date.parse(pr.extra.deadline as string)).toBe(terms.expiresAt * 1000);
    expect(pr.extra.binding).toBe(binding);
  });

  it("is checked when echoed back; agents on spec 0.1.4 may leave it out", () => {
    expect(sameTerms(issued, pr)).toBe(true);
    const { deadline: _, ...older } = pr.extra;
    expect(sameTerms(issued, { ...pr, extra: older })).toBe(true);
    const later = new Date((terms.expiresAt + 60) * 1000).toISOString();
    expect(sameTerms(issued, { ...pr, extra: { ...pr.extra, deadline: later } })).toBe(false);
  });
});

describe("agent payment sequence", () => {
  it("is the aggregate version and increases with every change", () => {
    const lifecycle = [
      agentPaymentRow({ status: "queued", tx_hash: null, block_height: null, settled_at: null, version: 0 }),
      agentPaymentRow({ status: "submitted", tx_hash: null, block_height: null, settled_at: null, version: 1 }),
      agentPaymentRow({ status: "submitted", block_height: null, settled_at: null, version: 2 }), // tx_hash recorded
      agentPaymentRow({ status: "settled", version: 3 }),
    ];
    const seq = lifecycle.map((r) => AgentPayment.parse(agentPaymentView(r)).sequence as number);
    expect(seq).toEqual([0, 1, 2, 3]);
  });
});
