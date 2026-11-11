/**
 * Property tests for the refund-leg payload check (lld/agentpay.md §5 `kind: refund`): the signed
 * payload must be exactly the one payments issued for the leg. Every single-field mutation — re-signed
 * with a valid signature, so only the equality check stands between it and the relayer — is refused.
 */

import { makeNonce, verifySigned } from "@nearpay-internal/intents";
import { USDC_NEAR } from "@nearpay-internal/testing";
import type { IntentMessage, MultiPayload } from "@nearpay-money/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkIssued, matchRefundPayload } from "../../src/domain/refund-relay/match.js";
import { type Leg, leg, type Standard, signer } from "../support/refund.js";

const CONTRACT = "intents.near";
const NOW = Date.now();

function check(s: MultiPayload, l: Leg) {
  const v = verifySigned(s);
  if (!v.ok) return { verified: false as const, reason: v.reason };
  return { verified: true as const, ...matchRefundPayload(s, v.message, l.nextAction, l.transfer, CONTRACT, NOW) };
}

const standardArb = fc.constantFrom<Standard>("raw_ed25519", "nep413", "erc191");
const seedArb = fc.uint8Array({ minLength: 32, maxLength: 32 }).filter((b) => b.some((x) => x !== 0));
const amountArb = fc.bigInt({ min: 1n, max: 10n ** 30n }).map(String);
const legArb = fc.record({
  standard: standardArb,
  seed: seedArb,
  amount: amountArb,
  minutes: fc.integer({ min: 1, max: 60 }),
});

function build(p: { standard: Standard; seed: Uint8Array; amount: string; minutes: number }) {
  const s = signer(p.standard, p.seed);
  const l = leg(s, {
    token: USDC_NEAR,
    amount: p.amount,
    deadline: new Date(NOW + p.minutes * 60_000).toISOString(),
  });
  return { s, l };
}

type Mutation = (m: IntentMessage) => { message: IntentMessage };

const transfer0 = (m: IntentMessage) => m.intents[0] as Record<string, unknown>;

/** Single-field mutations of the issued message; each is re-signed (validly) by the merchant's key. */
const MUTATIONS: Record<string, Mutation> = {
  receiver: (m) => {
    transfer0(m).receiver_id = "attacker.near";
    return { message: m };
  },
  token: (m) => {
    const t = transfer0(m);
    t.tokens = { "nep141:wrap.near": Object.values(t.tokens as object)[0] };
    return { message: m };
  },
  "amount +1": (m) => {
    const t = transfer0(m);
    const [k, v] = Object.entries(t.tokens as Record<string, string>)[0] as [string, string];
    t.tokens = { [k]: (BigInt(v) + 1n).toString() };
    return { message: m };
  },
  "amount -1": (m) => {
    const t = transfer0(m);
    const [k, v] = Object.entries(t.tokens as Record<string, string>)[0] as [string, string];
    t.tokens = { [k]: (BigInt(v) - 1n).toString() };
    return { message: m };
  },
  "second token": (m) => {
    const t = transfer0(m);
    t.tokens = { ...(t.tokens as object), "nep141:wrap.near": "1" };
    return { message: m };
  },
  memo: (m) => {
    transfer0(m).memo = "np1:11111111111111111111111111111111111111111111";
    return { message: m };
  },
  "no memo": (m) => {
    delete transfer0(m).memo;
    return { message: m };
  },
  "extra transfer field": (m) => {
    transfer0(m).msg = "x";
    return { message: m };
  },
  "deadline +1 ms": (m) => {
    m.deadline = new Date(Date.parse(m.deadline) + 1).toISOString();
    return { message: m };
  },
  "deadline -1 s": (m) => {
    m.deadline = new Date(Date.parse(m.deadline) - 1_000).toISOString();
    return { message: m };
  },
  nonce: (m) => {
    m.nonce = makeNonce("5a0dbe11");
    return { message: m };
  },
  "second intent": (m) => {
    m.intents = [...m.intents, { ...transfer0(m), receiver_id: "attacker.near" } as never];
    return { message: m };
  },
  "other intent kind": (m) => {
    transfer0(m).intent = "ft_withdraw";
    return { message: m };
  },
  "re-serialised (same fields)": (m) => {
    // the same transfer with its keys in another order: equal when parsed, but not the issued string
    const t = transfer0(m);
    m.intents = [{ memo: t.memo, tokens: t.tokens, receiver_id: t.receiver_id, intent: t.intent } as never];
    return { message: m };
  },
};

describe("refund-leg payload equality (property)", () => {
  it("accepts exactly the issued payload, for every standard", () => {
    fc.assert(
      fc.property(legArb, (p) => {
        const { s, l } = build(p);
        expect(checkIssued(l.nextAction, l.transfer, CONTRACT)).toEqual({ ok: true });
        expect(check(s.sign(l.message), l)).toEqual({ verified: true, ok: true });
      }),
      { numRuns: 60 },
    );
  });

  it("refuses every single-field mutation, even validly re-signed by the merchant", () => {
    fc.assert(
      fc.property(legArb, fc.constantFrom(...Object.keys(MUTATIONS)), (p, name) => {
        const { s, l } = build(p);
        const signed = s.sign((MUTATIONS[name] as Mutation)(structuredClone(l.message)).message);
        const r = check(signed, l);
        // the signature is valid: only the equality check refuses it
        expect(r, name).toMatchObject({ verified: true, ok: false, reason: "signed_intent_mismatch" });
      }),
      { numRuns: 300 },
    );
  });

  it("refuses the issued message signed by another key, or with a standard that was not issued", () => {
    fc.assert(
      fc.property(legArb, seedArb, standardArb, (p, otherSeed, otherStandard) => {
        const { s, l } = build(p);
        const other = signer(p.standard, otherSeed);
        // another account signs the same transfer as itself
        const r1 = check(other.sign({ ...l.message, signer_id: other.account }), l);
        expect(r1).toMatchObject({ verified: true, ok: false, reason: "signed_intent_mismatch" });
        // the merchant's own key, another standard (ed25519 keys only: an EVM key has one standard)
        if (otherStandard !== p.standard && p.standard !== "erc191" && otherStandard !== "erc191") {
          const r2 = check(signer(otherStandard, p.seed).sign(l.message), l);
          expect(r2).toMatchObject({ verified: true, ok: false, reason: "signed_intent_mismatch" });
        }
        void s;
      }),
      { numRuns: 60 },
    );
  });

  it("refuses an issued payload that disagrees with rails' execution in any transfer field", () => {
    const fields = ["signer_id", "receiver_id", "token", "amount", "memo"] as const;
    fc.assert(
      fc.property(legArb, fc.constantFrom(...fields), (p, f) => {
        const { l } = build(p);
        const t = {
          ...l.transfer,
          [f]: f === "amount" ? (BigInt(l.transfer.amount) + 1n).toString() : `${l.transfer[f]}x`,
        };
        expect(checkIssued(l.nextAction, t, CONTRACT)).toMatchObject({ ok: false, reason: "issued_inconsistent" });
      }),
      { numRuns: 100 },
    );
  });
});
