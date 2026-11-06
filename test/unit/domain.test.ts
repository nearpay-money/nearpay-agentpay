import { Binding, type IntentMessage } from "@nearpay/spec";
import {
  buildPayload,
  buildTransferIntents,
  fromHex,
  makeNonce,
  signNep413,
  signRawEd25519,
  verifySigned,
} from "@nearpay-internal/intents";
import { describe, expect, it } from "vitest";
import { jcs, jcsEqual, payloadHash, x402Binding } from "../../src/domain/binding/binding.js";
import { MIN_FEE_UNITS, unitsForUsdMicros, x402Fee } from "../../src/domain/facilitator-payment/fee.js";
import { claimedBinding, DEADLINE_MARGIN_MS, matchMessage } from "../../src/domain/facilitator-payment/match.js";
import { relayCode, settleError } from "../../src/domain/facilitator-payment/reasons.js";
import { canTransition, isTerminal } from "../../src/domain/facilitator-payment/status.js";
import { hit } from "../../src/domain/quota/window.js";
import { batchGas, matchExecuted, maxBatch, selectBatch, TGAS, tooLate } from "../../src/domain/relay-batch/batch.js";
import { INTENTS_VECTORS, VECTOR_NOW, VECTOR_REQUIREMENT } from "../support/vectors.js";

const fields = {
  account_id: "acct_01jc5v6w7x8y9z0a1b2c3d4e5f",
  resource_url: "https://merchant.example/premium",
  payTo: "merchant.near",
  asset: VECTOR_REQUIREMENT.asset,
  amount: "10000",
  fee: "25",
  nonce16: "00112233445566778899aabbccddeeff",
  expires_at: 1_793_900_000,
};

describe("x402 binding", () => {
  it("is np1 + base58(sha256(JCS(fields))), deterministic and a valid spec Binding", () => {
    const b = x402Binding(fields);
    expect(Binding.safeParse(b).success).toBe(true);
    expect(x402Binding({ ...fields })).toBe(b);
    // key order of the input object does not matter (JCS)
    const reordered = Object.fromEntries(Object.entries(fields).reverse()) as typeof fields;
    expect(x402Binding(reordered)).toBe(b);
  });

  it("changes when any field changes", () => {
    const b = x402Binding(fields);
    for (const [k, v] of Object.entries({
      account_id: "acct_01jc5v6w7x8y9z0a1b2c3d4e5g",
      resource_url: "https://merchant.example/other",
      payTo: "other.near",
      asset: "nep141:other.near",
      amount: "10001",
      fee: "26",
      nonce16: "ffeeddccbbaa99887766554433221100",
      expires_at: 1_793_900_001,
    }))
      expect(x402Binding({ ...fields, [k]: v })).not.toBe(b);
  });

  it("rejects malformed nonces and expiries", () => {
    expect(() => x402Binding({ ...fields, nonce16: "XYZ" })).toThrow(/nonce16/);
    expect(() => x402Binding({ ...fields, expires_at: 1.5 })).toThrow(/expires_at/);
  });

  it("payload hashes and JCS equality ignore key order", () => {
    const mp = INTENTS_VECTORS.raw_ed25519.multipayload;
    const shuffled = Object.fromEntries(Object.entries(mp).reverse());
    expect(Buffer.from(payloadHash(shuffled)).toString("hex")).toBe(Buffer.from(payloadHash(mp)).toString("hex"));
    expect(jcsEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jcsEqual({ a: 1 }, { a: "1" })).toBe(false);
    expect(() => jcs(undefined)).toThrow();
  });
});

describe("signed message check (spec test vectors)", () => {
  for (const std of ["nep413", "erc191", "raw_ed25519"] as const) {
    it(`${std}: the vector verifies and pays exactly the requirement`, () => {
      const v = verifySigned(INTENTS_VECTORS[std].multipayload);
      expect(v.ok).toBe(true);
      if (!v.ok) return;
      expect(v.implicitMatch).toBe(true);
      expect(matchMessage(v.message, VECTOR_REQUIREMENT, VECTOR_NOW)).toEqual({ ok: true });
      expect(claimedBinding(v.message)).toBe(INTENTS_VECTORS.binding);
    });
  }

  it("a tampered vector fails the signature check", () => {
    const mp = INTENTS_VECTORS.raw_ed25519.multipayload as { payload: string };
    const tampered = { ...mp, payload: mp.payload.replace("2000000", "2000001") };
    const v = verifySigned(tampered);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("invalid_signature");
  });

  const message = (): IntentMessage => {
    const v = verifySigned(INTENTS_VECTORS.raw_ed25519.multipayload);
    if (!v.ok) throw new Error("vector");
    return structuredClone(v.message);
  };
  const intents = (m: IntentMessage) => m.intents as unknown as Record<string, unknown>[];

  it("maps every mismatch to its invalid reason", () => {
    const r = (m: IntentMessage, now = VECTOR_NOW) => {
      const out = matchMessage(m, VECTOR_REQUIREMENT, now);
      return out.ok ? "ok" : out.reason;
    };
    let m = message();
    (intents(m)[0] as { receiver_id: string }).receiver_id = "thief.near";
    expect(r(m)).toBe("recipient_mismatch");
    m = message();
    (intents(m)[1] as { receiver_id: string }).receiver_id = "thief.near";
    expect(r(m)).toBe("recipient_mismatch");
    m = message();
    intents(m)[0] = { ...intents(m)[0], tokens: { [VECTOR_REQUIREMENT.asset]: "1999999" } };
    expect(r(m)).toBe("amount_mismatch");
    m = message();
    intents(m)[1] = { ...intents(m)[1], tokens: { [VECTOR_REQUIREMENT.asset]: "1" } };
    expect(r(m)).toBe("amount_mismatch");
    m = message();
    intents(m)[0] = { ...intents(m)[0], tokens: { "nep141:wrap.near": "2000000" } };
    expect(r(m)).toBe("amount_mismatch");
    m = message();
    intents(m)[0] = { ...intents(m)[0], tokens: { [VECTOR_REQUIREMENT.asset]: "2000000", "nep141:wrap.near": "1" } };
    expect(r(m)).toBe("amount_mismatch");
    m = message();
    intents(m)[0] = { ...intents(m)[0], tokens: { [VECTOR_REQUIREMENT.asset]: "02000000" } };
    expect(r(m)).toBe("amount_mismatch");
    m = message();
    intents(m)[0] = { ...intents(m)[0], memo: "np1:other" };
    expect(r(m)).toBe("invalid_payload");
    m = message();
    m.intents = [m.intents[0] as IntentMessage["intents"][number]];
    expect(r(m)).toBe("invalid_payload");
    m = message();
    intents(m)[0] = { intent: "token_diff", diff: {} };
    expect(r(m)).toBe("invalid_payload");
    m = message();
    (m as { verifying_contract: string }).verifying_contract = "evil.near";
    expect(r(m)).toBe("invalid_payload");
    // deadline: must be after now + 5 s and not after the requirement deadline
    expect(r(message(), VECTOR_REQUIREMENT.deadlineMaxMs - DEADLINE_MARGIN_MS)).toBe("deadline_invalid");
    expect(r(message(), VECTOR_REQUIREMENT.deadlineMaxMs - DEADLINE_MARGIN_MS - 1)).toBe("ok");
    expect(
      matchMessage(message(), { ...VECTOR_REQUIREMENT, deadlineMaxMs: VECTOR_NOW + 60_000 }, VECTOR_NOW),
    ).toMatchObject({
      ok: false,
      reason: "deadline_invalid",
    });
    m = message();
    m.deadline = "not a time";
    expect(r(m)).toBe("deadline_invalid");
  });

  it("NEP-413 with a named account verifies locally (key registration is the Verifier's check)", () => {
    const seed = fromHex("11".repeat(32));
    const req = {
      pay_to: "merchant.near",
      token: VECTOR_REQUIREMENT.asset,
      amount: "2000000",
      fee_to: "treasury.nearpay.near",
      fee_amount: "6000",
      binding: INTENTS_VECTORS.binding,
      deadline: "2026-11-05T10:02:00.000Z",
    };
    const msg = buildPayload({
      signerId: "agent.near",
      deadline: req.deadline,
      nonce: makeNonce(INTENTS_VECTORS.salt_hex, () => new Uint8Array(28).fill(7)),
      intents: buildTransferIntents(req as never),
    });
    for (const signed of [signNep413(msg, seed), signRawEd25519(msg, seed)]) {
      const v = verifySigned(signed);
      expect(v.ok).toBe(true);
      if (!v.ok) continue;
      expect(v.implicitMatch).toBe(false);
      expect(v.message.signer_id).toBe("agent.near");
      expect(matchMessage(v.message, VECTOR_REQUIREMENT, VECTOR_NOW)).toEqual({ ok: true });
    }
  });

  it("claims no binding without a memo", () => {
    const m = message();
    intents(m)[0] = { intent: "transfer", receiver_id: "merchant.near", tokens: {} };
    expect(claimedBinding(m)).toBeNull();
  });
});

describe("agent payment lifecycle", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("queued", "submitted")).toBe(true);
    expect(canTransition("queued", "failed")).toBe(true);
    expect(canTransition("submitted", "settled")).toBe(true);
    expect(canTransition("submitted", "queued")).toBe(true);
    expect(canTransition("submitted", "failed")).toBe(true);
    expect(canTransition("verified", "queued")).toBe(true);
    expect(canTransition("queued", "settled")).toBe(false);
    expect(canTransition("settled", "failed")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(false);
    expect(isTerminal("settled")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("submitted")).toBe(false);
  });

  it("speaks the relay and settle vocabularies", () => {
    expect(relayCode("insufficient_funds")).toBe("insufficient_balance");
    for (const r of ["invalid_signature", "nonce_used", "deadline_invalid", "invalid_payload"])
      expect(relayCode(r)).toBe("intent_invalid");
    expect(settleError("nonce_used")).toBe("nonce_used");
    expect(settleError("insufficient_funds")).toBe("insufficient_funds");
    expect(settleError("weird")).toBe("unexpected_settle_error");
    expect(settleError(null)).toBe("unexpected_settle_error");
  });
});

describe("fees", () => {
  const usdc = { decimals: 6, price_usd: "1", is_usd_stable: true };
  it("converts the USD minimum at the asset price, rounding up", () => {
    expect(unitsForUsdMicros(0n, usdc)).toBe(0n);
    expect(unitsForUsdMicros(10_000n, usdc)).toBe(10_000n); // $0.01 = 10 000 base units of a 6-decimal stable
    expect(unitsForUsdMicros(10_000n, { ...usdc, price_usd: "0.9998" })).toBe(10_003n);
    expect(unitsForUsdMicros(10_000n, { decimals: 24, price_usd: "3.5", is_usd_stable: false })).toBe(
      2_857_142_857_142_857_142_858n,
    );
    expect(unitsForUsdMicros(10_000n, { ...usdc, price_usd: null })).toBe(10_000n); // par for stables
    expect(unitsForUsdMicros(10_000n, { decimals: 24, price_usd: null, is_usd_stable: false })).toBeNull();
    expect(unitsForUsdMicros(10_000n, { ...usdc, price_usd: "abc" })).toBeNull();
    expect(unitsForUsdMicros(10_000n, { ...usdc, price_usd: "0" })).toBeNull();
  });

  it("is max(bps fee rounded up, minimum, 1 base unit)", () => {
    expect(x402Fee(10_000n, 25, 0n)).toBe(25n);
    expect(x402Fee(10_001n, 25, 0n)).toBe(26n);
    expect(x402Fee(10_000n, 25, 100n)).toBe(100n);
    expect(x402Fee(10n, 0, 0n)).toBe(MIN_FEE_UNITS);
  });
});

describe("relay batches", () => {
  it("sizes batches from the gas budget", () => {
    expect(maxBatch(15)).toBe(16);
    expect(maxBatch(240)).toBe(1);
    expect(maxBatch(1)).toBe(64);
    expect(() => maxBatch(0)).toThrow();
    expect(batchGas(1, 15)).toBe(35n * TGAS);
    expect(batchGas(16, 15)).toBe(260n * TGAS);
    expect(() => batchGas(0, 15)).toThrow();
  });

  it("selects consecutive non-solo payloads, a solo payload alone", () => {
    const q = (id: string, solo = false) => ({ id, solo });
    expect(selectBatch([], 4)).toEqual([]);
    expect(selectBatch([q("a", true), q("b")], 4).map((x) => x.id)).toEqual(["a"]);
    expect(selectBatch([q("a"), q("b"), q("c", true), q("d")], 4).map((x) => x.id)).toEqual(["a", "b"]);
    expect(selectBatch([q("a"), q("b"), q("c")], 2).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("matches intents_executed by (signer, nonce)", () => {
    const batch = [
      { id: "1", payer: "a.near", nonce: "n1" },
      { id: "2", payer: "b.near", nonce: "n2" },
    ];
    const r = matchExecuted(batch, [
      { account_id: "a.near", nonce: "n1" },
      { account_id: "b.near", nonce: "other" },
    ]);
    expect(r.settled.map((x) => x.id)).toEqual(["1"]);
    expect(r.missing.map((x) => x.id)).toEqual(["2"]);
  });

  it("refuses payloads too close to their deadline", () => {
    expect(tooLate(new Date(10_000), 8_000)).toBe(true);
    expect(tooLate(new Date(10_001), 8_000)).toBe(false);
    expect(tooLate(new Date(10_001), 8_000, 0)).toBe(false);
  });
});

describe("quota windows", () => {
  it("counts per second", () => {
    let w = hit(undefined, 1_000, 2);
    expect(w.ok).toBe(true);
    w = hit(w.window, 1_500, 2);
    expect(w.ok).toBe(true);
    w = hit(w.window, 1_900, 2);
    expect(w.ok).toBe(false);
    w = hit(w.window, 2_000, 2);
    expect(w).toEqual({ ok: true, window: { second: 2, count: 1 } });
  });
});
