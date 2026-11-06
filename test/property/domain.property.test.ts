/**
 * Property tests (foundations §16) for the money paths of agentpay: fee arithmetic, batch selection and
 * outcome matching, and the agent payment lifecycle under random batch outcomes.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { x402Binding } from "../../src/domain/binding/binding.js";
import { x402Fee } from "../../src/domain/facilitator-payment/fee.js";
import { type AgentPaymentStatus, canTransition, isTerminal } from "../../src/domain/facilitator-payment/status.js";
import { matchExecuted, maxBatch, selectBatch } from "../../src/domain/relay-batch/batch.js";

const amount = fc.bigInt({ min: 1n, max: 10n ** 30n });
const bps = fc.integer({ min: 0, max: 10_000 });

describe("fee", () => {
  it("covers the bps fee, the minimum and one base unit, and never decreases with the amount", () => {
    fc.assert(
      fc.property(amount, amount, bps, fc.bigInt({ min: 0n, max: 10n ** 24n }), (a, b, p, min) => {
        const f = x402Fee(a, p, min);
        expect(f * 10_000n >= a * BigInt(p)).toBe(true);
        expect(f >= min && f >= 1n).toBe(true);
        expect((f - 1n) * 10_000n < a * BigInt(p) || f === min || f === 1n).toBe(true); // tight: rounds up by < 1
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(x402Fee(lo, p, min) <= x402Fee(hi, p, min)).toBe(true);
      }),
    );
  });
});

describe("bindings", () => {
  it("differ for different nonces (one binding per 402 response)", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (x, y) => {
          const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
          const base = {
            account_id: "acct_01jc5v6w7x8y9z0a1b2c3d4e5f",
            resource_url: "https://merchant.example/x",
            payTo: "merchant.near",
            asset: "nep141:usdc.near",
            amount: "1",
            fee: "1",
            expires_at: 1,
          };
          const a = x402Binding({ ...base, nonce16: hex(x) });
          const b = x402Binding({ ...base, nonce16: hex(y) });
          expect(a === b).toBe(hex(x) === hex(y));
        },
      ),
    );
  });
});

describe("batches", () => {
  const queue = fc.array(fc.record({ id: fc.uuid(), solo: fc.boolean() }), { maxLength: 40 });

  it("are an order-preserving prefix, never above the cap, solo payloads alone", () => {
    fc.assert(
      fc.property(queue, fc.integer({ min: 1, max: 240 }), (q, gpp) => {
        const max = maxBatch(gpp);
        const b = selectBatch(q, max);
        expect(b.length).toBeLessThanOrEqual(max);
        expect(b).toEqual(q.slice(0, b.length));
        if (q.length > 0) expect(b.length).toBeGreaterThan(0);
        if (b.some((x) => x.solo)) expect(b.length).toBe(1);
      }),
    );
  });

  it("outcome matching partitions the batch", () => {
    const item = fc.record({
      id: fc.uuid(),
      payer: fc.constantFrom("a", "b", "c"),
      nonce: fc.constantFrom("1", "2", "3"),
    });
    fc.assert(
      fc.property(
        fc.array(item, { maxLength: 12 }),
        fc.array(fc.record({ account_id: fc.constantFrom("a", "b", "c"), nonce: fc.constantFrom("1", "2", "3") })),
        (batch, executed) => {
          const r = matchExecuted(batch, executed);
          expect(r.settled.length + r.missing.length).toBe(batch.length);
          for (const s of r.settled)
            expect(executed.some((e) => e.account_id === s.payer && e.nonce === s.nonce)).toBe(true);
          for (const m of r.missing)
            expect(executed.some((e) => e.account_id === m.payer && e.nonce === m.nonce)).toBe(false);
        },
      ),
    );
  });
});

/**
 * Model of the batcher's effect on one payload: claim, simulate, send, apply. Whatever the Verifier and
 * the chain answer, a payload settles at most once, only after being submitted, and never leaves a final
 * state; every step is a lifecycle transition the ledger accepts.
 */
describe("lifecycle under random batch outcomes", () => {
  type Step =
    | "claim"
    | "sim_reject"
    | "sim_unavailable"
    | "chain_ok"
    | "chain_fail_multi"
    | "chain_fail_single"
    | "timeout"
    | "expire";
  const step = fc.constantFrom<Step>(
    "claim",
    "sim_reject",
    "sim_unavailable",
    "chain_ok",
    "chain_fail_multi",
    "chain_fail_single",
    "timeout",
    "expire",
  );

  function next(s: AgentPaymentStatus, e: Step): AgentPaymentStatus {
    switch (e) {
      case "claim":
        return s === "queued" ? "submitted" : s;
      case "expire":
        return s === "queued" ? "failed" : s;
      case "sim_reject":
      case "chain_fail_single":
        return s === "submitted" ? "failed" : s;
      case "sim_unavailable":
      case "chain_fail_multi":
        return s === "submitted" ? "queued" : s;
      case "chain_ok":
        return s === "submitted" ? "settled" : s;
      case "timeout":
        return s; // stays submitted until the status poll
    }
  }

  it("never settles twice, never leaves a final state, only takes allowed transitions", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        let s: AgentPaymentStatus = "queued";
        let settledCount = 0;
        let wasSubmitted = false;
        for (const e of steps) {
          const n = next(s, e);
          if (n !== s) {
            expect(canTransition(s, n)).toBe(true);
            expect(isTerminal(s)).toBe(false);
          }
          if (n === "submitted") wasSubmitted = true;
          if (n === "settled" && s !== "settled") {
            settledCount++;
            expect(wasSubmitted).toBe(true);
          }
          s = n;
        }
        expect(settledCount).toBeLessThanOrEqual(1);
      }),
    );
  });
});
