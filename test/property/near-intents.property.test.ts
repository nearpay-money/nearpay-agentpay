/**
 * Property tests (foundations §16) for x402 `near-intents` (lld/agentpay.md §3.1): who gets an agent payment
 * (only a settled, agentpay-owned execution with evidence from a sender), the merchant record's money fields, the
 * operation lifecycle under any sequence of execution events, slippage clamping, operation tokens and settle
 * verdicts.
 */
import { newId } from "@nearpay-internal/ids";
import { USDC_NEAR } from "@nearpay-internal/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  mintOperationToken,
  type OperationTokenInput,
  verifyOperationToken,
} from "../../src/domain/near-intents/kit.js";
import {
  canMoveOperation,
  clampSlippage,
  decideExecutionEvent,
  type ExecutionSubject,
  merchantRecord,
  type OperationStatus,
  verdictOf,
} from "../../src/domain/near-intents/rules.js";
import { ORIGIN_TX, quoteExecution, REFUND_TO, settledExecution } from "../support/executions.js";

const SUBJECTS: ExecutionSubject[] = [
  "evt.rails.execution.settled",
  "evt.rails.execution.refunded",
  "evt.rails.execution.failed",
];
const STATES = [
  "quoting",
  "awaiting_deposit",
  "deposit_detected",
  "incomplete_deposit",
  "settling",
  "verifying",
  "succeeded",
  "refunded",
  "failed",
  "expired_unpaid",
  "held",
];
const binding = "np1:FkMXJmBuTZEMpEvn6a6VRVGugj435HBY98sUfKJhinuj";
const base = quoteExecution({
  account: newId("acct") as `acct_${string}`,
  binding,
  payTo: "merchant.near",
  amount: "1000000",
});
const settledBase = settledExecution(base);
const units = fc.bigInt({ min: 1n, max: 10n ** 77n }).map(String);

describe("who gets an agent payment", () => {
  it("only settled events of agentpay executions in `succeeded` with evidence, a sender and an amount", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SUBJECTS),
        fc.constantFrom(...STATES),
        fc.constantFrom("agentpay", "payments", undefined, "other"),
        fc.boolean(),
        fc.option(fc.constantFrom("solver.near", "intents.near", "", "Not A NEAR account"), { nil: null }),
        fc.option(units, { nil: null }),
        (subject, state, owner, withEvidence, sender, settled) => {
          const x = {
            ...settledBase,
            state,
            owner,
            settled_amount: settled,
            evidence: withEvidence ? { ...(settledBase.evidence as object), sender } : null,
          } as never;
          const d = decideExecutionEvent(subject, x);
          const creates = d.kind === "settled";
          expect(creates).toBe(
            owner === "agentpay" &&
              subject === "evt.rails.execution.settled" &&
              state === "succeeded" &&
              withEvidence &&
              !!sender &&
              sender !== "Not A NEAR account" &&
              settled !== null,
          );
          if (owner !== "agentpay") expect(d.kind).toBe("ignore");
          // refunded and failed executions never create a merchant record
          if (subject !== "evt.rails.execution.settled") expect(d.kind === "settled").toBe(false);
        },
      ),
    );
  });

  it("the merchant record carries exactly the settled amount, fee 0 and the evidence sender as payer", () => {
    fc.assert(
      fc.property(units, fc.stringMatching(/^[a-z0-9]{2,20}\.near$/), (settled, sender) => {
        const r = merchantRecord(settledExecution(base, { settled, sender }), {
          binding,
          account_id: "x",
          livemode: false,
          pay_to: "merchant.near",
          asset_id: USDC_NEAR,
          amount: "1000000",
        });
        expect(BigInt(r.amount)).toBe(BigInt(settled));
        expect(r.amount).toBe(settled);
        expect(r.fee_amount).toBe("0");
        expect(r.payer).toBe(sender);
        expect(r.origin.refund_to).toBe(REFUND_TO);
      }),
    );
  });
});

describe("operation lifecycle", () => {
  it("records the first terminal event and never changes afterwards, whatever arrives later", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...SUBJECTS), { minLength: 1, maxLength: 8 }), (events) => {
        let status: OperationStatus = "quoted";
        let changes = 0;
        for (const s of events) {
          const to: OperationStatus = s === "evt.rails.execution.settled" ? "settled" : "failed";
          if (canMoveOperation(status, to)) {
            status = to;
            changes++;
          }
        }
        expect(changes).toBe(1);
        expect(status).toBe(events[0] === "evt.rails.execution.settled" ? "settled" : "failed");
      }),
    );
  });
});

describe("slippage", () => {
  it("is always inside the range, the request itself when it is inside, the default when absent", () => {
    const range = fc
      .tuple(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 0, max: 10_000 }),
      )
      .map((t) => t.sort((a, b) => a - b))
      .map(([min, def, max]) => ({ min: min as number, default: def as number, max: max as number }));
    fc.assert(
      fc.property(range, fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: undefined }), (r, req) => {
        const v = clampSlippage(req, r);
        expect(v >= r.min && v <= r.max).toBe(true);
        if (req === undefined) expect(v).toBe(r.default);
        else if (req >= r.min && req <= r.max) expect(v).toBe(req);
      }),
    );
  });
});

describe("operation tokens", () => {
  const addr = fc.stringMatching(/^0x[0-9a-f]{40}$/);
  const input = fc.record({
    v: fc.constant(1 as const),
    binding: fc.constant(binding),
    network: fc.constantFrom("eip155:8453", "eip155:1", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"),
    deposit_address: addr,
    deposit_memo: fc.option(fc.stringMatching(/^[0-9]{1,10}$/), { nil: null }),
    resource_url: fc.constantFrom("https://merchant.example/a", "https://merchant.example/b"),
    destination: fc.record({
      network: fc.constant("near:mainnet"),
      asset: fc.constant(USDC_NEAR),
      amount: units,
      recipient: fc.constant("merchant.near"),
    }),
    expiry: fc.integer({ min: 1_000_000, max: 4_000_000_000 }),
  });
  it("verify(mint) holds before the expiry; the expiry, another key or another deposit address refuse it", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 64 }), input, addr, (key, i, other) => {
        const t = mintOperationToken(key, "k1", i as OperationTokenInput);
        const { expiry, ...rest } = i;
        expect(verifyOperationToken(t, new Map([["k1", key]]), rest, expiry - 1).ok).toBe(true);
        expect(verifyOperationToken(t, new Map([["k1", key]]), rest, expiry)).toEqual({ ok: false, reason: "expired" });
        const flipped = new Uint8Array(key);
        flipped[0] = (flipped[0] as number) ^ 1;
        expect(verifyOperationToken(t, new Map([["k1", flipped]]), rest, 0).ok).toBe(false);
        if (other !== i.deposit_address)
          expect(verifyOperationToken(t, new Map([["k1", key]]), { ...rest, deposit_address: other }, 0).ok).toBe(
            false,
          );
      }),
      { numRuns: 200 },
    );
  });
});

describe("settle verdicts", () => {
  it("success iff the operation settled and the presented tx is one of its deposits", () => {
    const tx = fc.stringMatching(/^0x[0-9a-f]{64}$/);
    fc.assert(
      fc.property(fc.boolean(), fc.array(tx, { maxLength: 4 }), tx, (settled, hashes, presented) => {
        const result = settled
          ? {
              outcome: "settled" as const,
              transaction: "9gnJ1EoQy3yqCDqGKiCGJm6YrwTqwYbL1n9vFhJ3nWVd",
              amount: "1",
              network: "eip155:8453",
              refund_to: REFUND_TO,
              agent_payment: "ap_x",
              tx_hashes: [ORIGIN_TX, ...hashes],
            }
          : {
              outcome: "failed" as const,
              error_reason: "exact_near_intents_payment_failed" as const,
              status: null,
              network: "eip155:8453",
              refund_to: REFUND_TO,
            };
        const v = verdictOf(result, presented.toUpperCase().replace("0X", "0x"));
        const member = presented === ORIGIN_TX || hashes.includes(presented);
        expect(v.kind).toBe(settled ? (member ? "success" : "deposit_not_found") : "failure");
      }),
    );
  });
});
