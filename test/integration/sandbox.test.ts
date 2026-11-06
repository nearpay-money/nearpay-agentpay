/**
 * Test mode end to end against the real nearpay-sandbox image (lld/agentpay.md §14 "sandbox E2E"):
 * x402 requirements → payer-signed transfer → verify → settle through the simulated Verifier (real
 * signature checks, balances, nonces, named-account key registration) → DIP-4 `transfer` events carry
 * the binding memo for rails' indexer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evmPayer, type Payer, payer } from "../support/payer.js";
import {
  type Merchant,
  type Stack,
  startStack,
  TEST_TREASURY,
  termsOf,
  USDC_NEAR,
  x402Body,
} from "../support/stack.js";

let s: Stack;
let m: Merchant;
beforeAll(async () => {
  s = await startStack({ realSandbox: true });
  m = s.merchant();
});
afterAll(async () => {
  await s?.stop();
});

async function fund(p: Payer, amount: string) {
  const r = await s.realSandbox?.call("POST", "/sim/intents/fund", { account_id: p.account, token: USDC_NEAR, amount });
  expect(r?.status).toBe(200);
}

async function required(amount = "10000") {
  const r = await s.call("POST", "/x402/requirements", {
    token: await s.token(m),
    body: { resource: { url: "https://merchant.example/report" }, amount },
  });
  expect(r.status).toBe(200);
  return r.body as { accepts: unknown[] };
}

const post = async (path: string, body: unknown) => s.call("POST", path, { token: await s.token(m), body });

describe("x402 against the sandbox Verifier", () => {
  it("settles NEP-413, raw ed25519 and ERC-191 payloads and emits the binding memo", async () => {
    for (const [p, standard] of [
      [payer(), "raw_ed25519"],
      [payer(`agent-${Date.now()}.near`), "nep413"],
      [evmPayer(), "erc191"],
    ] as const) {
      await fund(p, "1000000");
      const req = await required();
      const body = x402Body(req, p.sign(termsOf(req), { standard: standard as "nep413" }));
      expect((await post("/x402/verify", body)).body).toEqual({ isValid: true, payer: p.account });
      const r = await post("/x402/settle", body);
      expect(r.body, JSON.stringify(r.body)).toMatchObject({ success: true, payer: p.account, amount: "10000" });
    }
    const events = (await s.realSandbox?.call("GET", "/sim/intents/events?limit=500"))?.body as {
      events: { tx_hash: string; log: string }[];
    };
    const transfers = events.events
      .map(
        (e) =>
          JSON.parse(e.log.slice("EVENT_JSON:".length)) as {
            standard: string;
            event: string;
            data: { receiver_id: string; memo?: string }[];
          },
      )
      .filter((e) => e.standard === "dip4" && e.event === "transfer")
      .flatMap((e) => e.data);
    expect(transfers.filter((t) => t.receiver_id === m.payTo && t.memo?.startsWith("np1:")).length).toBe(3);
    expect(transfers.filter((t) => t.receiver_id === TEST_TREASURY && t.memo?.startsWith("np1:")).length).toBe(3);
  });

  it("reports the Verifier's rejections as invalid reasons", async () => {
    const poor = payer();
    const req = await required();
    expect((await post("/x402/verify", x402Body(req, poor.sign(termsOf(req))))).body).toMatchObject({
      isValid: false,
      invalidReason: "insufficient_funds",
    });
    // a named account whose registered key differs
    const name = `named-${Date.now()}.near`;
    const owner = payer(name);
    await fund(owner, "1000000");
    const r1 = await required();
    expect(
      (await post("/x402/settle", x402Body(r1, owner.sign(termsOf(r1), { standard: "nep413" })))).body.success,
    ).toBe(true);
    const impostor = payer(name);
    const r2 = await required();
    expect(
      (await post("/x402/verify", x402Body(r2, impostor.sign(termsOf(r2), { standard: "nep413" })))).body,
    ).toMatchObject({
      isValid: false,
      invalidReason: "invalid_signature",
    });
  });

  it("splits a batch the Verifier rejects as a whole and settles what it can", async () => {
    await s.pause();
    try {
      const p = payer();
      await fund(p, "15000"); // enough for one payment (10 000 + fee 30), not two
      const reqs = [await required(), await required()];
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 0;
      const bodies = reqs.map((r) => x402Body(r, p.sign(termsOf(r))));
      for (const b of bodies) expect((await post("/x402/settle", b)).body.errorReason).toBe("settlement_pending");
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 8_000;
      for (let i = 0; i < 4; i++) await s.tick();
      const out = await Promise.all(bodies.map(async (b) => (await post("/x402/settle", b)).body));
      expect(out.filter((o) => o.success)).toHaveLength(1);
      expect(out.filter((o) => !o.success)[0]).toMatchObject({ errorReason: "insufficient_funds" });
    } finally {
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 8_000;
      s.resume();
    }
  });
});
