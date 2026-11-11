/** Refund-leg payload rules (lld/agentpay.md §5 `kind: refund`; domain `refund-relay/match.ts`). */

import { verifySigned } from "@nearpay-internal/intents";
import { USDC_NEAR } from "@nearpay-internal/testing";
import type { MultiPayload } from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { checkIssued, matchRefundPayload } from "../../src/domain/refund-relay/match.js";
import { type Leg, leg, signer } from "../support/refund.js";

const C = "intents.near";

function run(signed: MultiPayload, l: Leg, now = Date.now()) {
  const v = verifySigned(signed);
  if (!v.ok) throw new Error(v.detail);
  return matchRefundPayload(signed, v.message, l.nextAction, l.transfer, C, now);
}

describe("checkIssued: payments' issued payload agrees with rails' execution", () => {
  const s = signer();
  const l = leg(s, { token: USDC_NEAR, amount: "2000000" });
  const bad = (patch: Partial<Leg["nextAction"]>, t = l.transfer) => checkIssued({ ...l.nextAction, ...patch }, t, C);

  it("accepts a consistent leg", () => expect(checkIssued(l.nextAction, l.transfer, C)).toEqual({ ok: true }));

  it.each([
    ["another signer", { signer_id: "other.near" }, "signer"],
    ["another message signer", { message: { ...l.message, signer_id: "other.near" } }, "signer"],
    ["another contract", { message: { ...l.message, verifying_contract: "evil.near" as never } }, "intents.near"],
    ["another NEP-413 recipient", { nep413: { ...l.nextAction.nep413, recipient: "evil.near" } }, "intents.near"],
    ["nonces that differ", { nep413: { ...l.nextAction.nep413, nonce: `${"A".repeat(43)}=` } }, "nonces"],
    ["no standard", { standards: [] }, "standard"],
    [
      "two intents",
      { message: { ...l.message, intents: [...l.message.intents, ...l.message.intents] } },
      "exactly one",
    ],
    [
      "a later deadline than rails allows",
      { message: { ...l.message, deadline: new Date(Date.parse(l.message.deadline) + 1).toISOString() } },
      "deadline",
    ],
    ["an unparsable deadline", { message: { ...l.message, deadline: "soon" } }, "deadline"],
  ] as const)("refuses %s", (_n, patch, detail) => {
    expect(bad(patch as never)).toMatchObject({ ok: false, reason: "issued_inconsistent" });
    expect((bad(patch as never) as { detail: string }).detail).toContain(detail);
  });

  it("accepts an issued deadline earlier than rails' latest", () => {
    const early = leg(s, {
      token: USDC_NEAR,
      amount: "1",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      maxDeadline: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(checkIssued(early.nextAction, early.transfer, C)).toEqual({ ok: true });
  });

  it.each(["receiver_id", "token", "amount", "memo"] as const)("refuses an issued transfer whose %s differs", (f) => {
    expect(bad({ transfer: { ...l.nextAction.transfer, [f]: "x" } })).toMatchObject({ reason: "issued_inconsistent" });
  });
});

describe("matchRefundPayload: exactly the issued payload", () => {
  it.each(["raw_ed25519", "nep413", "erc191"] as const)("accepts the issued payload signed with %s", (st) => {
    const s = signer(st);
    const l = leg(s, { token: USDC_NEAR, amount: "2000000" });
    expect(run(s.sign(l.message), l)).toEqual({ ok: true });
  });

  it("refuses a payload whose deadline has passed or is within the relay margin", () => {
    const s = signer();
    const l = leg(s, { token: USDC_NEAR, amount: "5", deadline: new Date(Date.now() + 3_000).toISOString() });
    expect(run(s.sign(l.message), l)).toMatchObject({ ok: false, reason: "deadline_passed" });
  });

  it("refuses NEP-413 envelopes that differ from the issued arguments", () => {
    const s = signer("nep413");
    const l = leg(s, { token: USDC_NEAR, amount: "5" });
    const signed = s.sign(l.message) as Extract<MultiPayload, { standard: "nep413" }>;
    const v = verifySigned(signed);
    if (!v.ok) throw new Error("unsigned");
    const with_ = (p: Partial<typeof signed.payload>) =>
      matchRefundPayload(
        { ...signed, payload: { ...signed.payload, ...p } },
        v.message,
        l.nextAction,
        l.transfer,
        C,
        Date.now(),
      );
    expect(with_({ callbackUrl: "https://x.example" })).toMatchObject({ detail: "NEP-413 callbackUrl was not issued" });
    expect(with_({ callbackUrl: null })).toEqual({ ok: true });
    expect(with_({ nonce: `${"B".repeat(43)}=` })).toMatchObject({ detail: "nonce differs" });
    expect(with_({ recipient: "evil.near" as never })).toMatchObject({ detail: "NEP-413 recipient differs" });
  });

  it("refuses a parsed message for another contract or with a non-string amount", () => {
    const s = signer();
    const l = leg(s, { token: USDC_NEAR, amount: "5" });
    const signed = s.sign(l.message);
    const contract = { ...l.message, verifying_contract: "evil.near" as never };
    expect(matchRefundPayload(signed, contract, l.nextAction, l.transfer, C, Date.now())).toMatchObject({
      detail: "verifying contract differs",
    });
    const numeric = { ...l.message, intents: [{ ...l.message.intents[0], tokens: { [USDC_NEAR]: 5 } }] };
    expect(matchRefundPayload(signed, numeric as never, l.nextAction, l.transfer, C, Date.now())).toMatchObject({
      detail: "amount differs",
    });
    const noTokens = { ...l.message, intents: [{ intent: "transfer", receiver_id: l.transfer.receiver_id }] };
    expect(matchRefundPayload(signed, noTokens as never, l.nextAction, l.transfer, C, Date.now())).toMatchObject({
      detail: "token differs",
    });
  });
});
