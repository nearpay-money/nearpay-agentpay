/**
 * x402 facilitator end to end over HTTP (lld/agentpay.md §3, §5–§8): requirements, verify (every
 * invalidReason), settle (batcher, idempotency, settlement_pending, batch split), live mode over the
 * fake NEAR RPC (function-call key, zero deposit, timeouts, rejected nonces), the kill switch, agent
 * payment reads and events.
 */
import { randomUUID } from "node:crypto";
import {
  AgentPayment,
  decodeX402Header,
  encodeX402Header,
  PaymentRequired,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@nearpay/spec";
import { fromUuid, newId } from "@nearpay-internal/ids";
import { createScreening, getKillSwitch } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readKillSwitch } from "../../src/app/kill-switch.js";
import { AgentPaymentList } from "../support/lists.js";
import { evmPayer, type Payer, payer } from "../support/payer.js";
import {
  LIVE_TREASURY,
  type Merchant,
  RELAYER,
  type Stack,
  startStack,
  TEST_TREASURY,
  termsOf,
  USDC_NEAR,
  uuid,
  x402Body,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

async function required(m: Merchant, o: { livemode?: boolean; amount?: string; body?: Record<string, unknown> } = {}) {
  const r = await s.call("POST", "/x402/requirements", {
    token: await s.token(m, { livemode: o.livemode ?? false }),
    body: {
      resource: { url: "https://merchant.example/premium", description: "Premium report" },
      amount: o.amount ?? "10000",
      ...o.body,
    },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { accepts: unknown[]; resource: unknown; x402Version: 2 };
}

function funded(p: Payer, verifier = s.testVerifier, amount = 10_000_000n): Payer {
  verifier.fund(p.account, USDC_NEAR, amount);
  return p;
}

const post = async (m: Merchant, path: string, body: unknown, livemode = false) =>
  s.call("POST", path, { token: await s.token(m, { livemode }), body });

describe("supported and requirements", () => {
  it("advertises exact + intents-transfer on near:mainnet with the relayer account", async () => {
    const r = await s.call("GET", "/x402/supported");
    expect(r.status).toBe(200);
    expect(SupportedResponse.parse(r.body)).toEqual({
      kinds: [
        {
          x402Version: 2,
          scheme: "exact",
          network: "near:mainnet",
          extra: { assetTransferMethod: "intents-transfer" },
        },
      ],
      extensions: [],
      signers: { "near:*": [RELAYER] },
    });
  });

  it("issues single-use requirements bound to the merchant (fee from the schedule, test treasury)", async () => {
    const m = s.merchant({ feeBps: 25 });
    const body = await required(m);
    const pr = PaymentRequired.parse(body);
    const a = pr.accepts[0];
    expect(a).toMatchObject({
      scheme: "exact",
      network: "near:mainnet",
      amount: "10000",
      asset: USDC_NEAR,
      payTo: m.payTo,
      maxTimeoutSeconds: 120,
      extra: {
        assetTransferMethod: "intents-transfer",
        paymentFlow: "authorization",
        fee: { to: TEST_TREASURY, amount: "25" },
        verifyingContract: "intents.near",
      },
    });
    // ready for the PAYMENT-REQUIRED header
    expect(decodeX402Header(encodeX402Header(body))).toEqual(body);
    const again = PaymentRequired.parse(await required(m));
    expect(again.accepts[0]?.extra.binding).not.toBe(a?.extra.binding);
    const row = await s.admin.db
      .selectFrom("issued_requirements")
      .selectAll()
      .where("binding", "=", a?.extra.binding as string)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      account_id: uuid(m.account, "acct"),
      livemode: false,
      consumed_at: null,
      max_timeout_s: 120,
    });
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeGreaterThan(110_000);
    // 0.1.5: the absolute expiry of the requirement is the binding's expires_at
    expect(a?.extra.deadline).toBe(row.expires_at.toISOString());
  });

  it("uses the live treasury and the minimum fee in live mode", async () => {
    const m = s.merchant({ minFeeUsdMicros: 10_000 });
    const pr = PaymentRequired.parse(await required(m, { livemode: true }));
    expect(pr.accepts[0]?.extra.fee).toEqual({ to: LIVE_TREASURY, amount: "10000" });
  });

  it("refuses accounts, destinations, assets and amounts it cannot serve", async () => {
    const notLive = s.merchant({ liveEnabled: false });
    expect(
      (await post(notLive, "/x402/requirements", { resource: { url: "https://m.example/x" }, amount: "1" }, true)).body
        .error.code,
    ).toBe("account_not_live");
    const chain = s.merchant({ type: "chain_address" });
    const r1 = await post(chain, "/x402/requirements", { resource: { url: "https://m.example/x" }, amount: "1000" });
    expect([r1.status, r1.body.error.code]).toEqual([409, "destination_not_intents_account"]);
    const m = s.merchant({ minFeeUsdMicros: 10_000 });
    const r2 = await post(m, "/x402/requirements", {
      resource: { url: "https://m.example/x" },
      amount: "1000",
      pay_to: "someone-else.near",
    });
    expect(r2.body.error.code).toBe("destination_not_intents_account");
    const r3 = await post(m, "/x402/requirements", {
      resource: { url: "https://m.example/x" },
      amount: "1000",
      asset_id: "nep141:wrap.near",
    });
    expect(r3.body.error.code).toBe("destination_not_intents_account");
    const r4 = await post(m, "/x402/requirements", { resource: { url: "https://m.example/x" }, amount: "9999" });
    expect([r4.status, r4.body.error.code]).toEqual([422, "amount_below_minimum"]);
    const r5 = await post(m, "/x402/requirements", {
      resource: { url: "https://m.example/x" },
      amount: "10000",
      max_timeout_s: 20,
    });
    expect(r5.status).toBe(400);
  });

  it("needs a merchant key with agentpay.facilitate", async () => {
    const m = s.merchant();
    const body = { resource: { url: "https://m.example/x" }, amount: "10000" };
    expect((await s.call("POST", "/x402/requirements", { body })).status).toBe(401);
    const rk = await s.token(m, { ptype: "restricted_key", scp: ["checkout_sessions.write"] });
    expect((await s.call("POST", "/x402/requirements", { token: rk, body })).status).toBe(403);
    const ok = await s.token(m, { ptype: "restricted_key", scp: ["agentpay.facilitate"] });
    expect((await s.call("POST", "/x402/requirements", { token: ok, body })).status).toBe(200);
  });
});

describe("verify", () => {
  it("accepts a correct payload for every signing standard", async () => {
    const m = s.merchant();
    for (const [p, standard] of [
      [payer(), "raw_ed25519"],
      [payer(), "nep413"],
      [payer(`agent${randomUUID().slice(0, 6)}.near`), "nep413"],
      [evmPayer(), "erc191"],
    ] as const) {
      funded(p);
      const req = await required(m);
      const r = await post(m, "/x402/verify", x402Body(req, p.sign(termsOf(req), { standard: standard as "nep413" })));
      expect(r.status).toBe(200);
      expect(VerifyResponse.parse(r.body)).toEqual({ isValid: true, payer: p.account });
    }
  });

  it("sends the payment size (amount + fee, integer USD micros) on the payer screen (spec 0.2.1)", async () => {
    const m = s.merchant();
    const p = funded(payer());
    const req = await required(m, { amount: "2500000" });
    const terms = termsOf(req);
    const r = await post(m, "/x402/verify", x402Body(req, p.sign(terms)));
    expect(VerifyResponse.parse(r.body)).toEqual({ isValid: true, payer: p.account });
    const call = s.compliance
      .callsTo(createScreening)
      .filter((c) => (c.body as { subject: string }).subject === p.account);
    expect(call).toHaveLength(1);
    const body = call[0]?.body as { context: string; amount_usd_micros?: number };
    // USDC (6 decimals) at $1: one base unit is one micro-dollar
    expect(body.context).toBe("x402");
    expect(body.amount_usd_micros).toBe(Number(BigInt(terms.amount) + BigInt(terms.fee)));
    expect(Number.isInteger(body.amount_usd_micros)).toBe(true);
  });

  it("returns every invalidReason it can detect", async () => {
    const m = s.merchant();
    const other = s.merchant();
    const p = funded(payer());
    const reason = async (body: unknown, who = m, livemode = false) => {
      const r = await post(who, "/x402/verify", body, livemode);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.isValid).toBe(false);
      return r.body.invalidReason as string;
    };
    const req = await required(m);
    const t = termsOf(req);

    // accepted ≠ paymentRequirements
    const altered = x402Body(req, p.sign(t));
    (altered.paymentPayload.accepted as { amount: string }).amount = "1";
    expect(await reason(altered)).toBe("invalid_payment_requirements");
    // 0.1.5 extra.deadline: an altered one is refused; an agent on 0.1.4 that dropped it is not
    const lateDeadline = x402Body(req, p.sign(t));
    for (const side of [lateDeadline.paymentPayload.accepted, lateDeadline.paymentRequirements])
      (side as { extra: { deadline: string } }).extra.deadline = new Date(Date.now() + 3_600_000).toISOString();
    expect(await reason(lateDeadline)).toBe("invalid_payment_requirements");
    const noDeadline = x402Body(req, p.sign(t));
    for (const side of [noDeadline.paymentPayload.accepted, noDeadline.paymentRequirements])
      delete (side as { extra: { deadline?: string } }).extra.deadline;
    expect((await post(m, "/x402/verify", noDeadline)).body).toEqual({ isValid: true, payer: p.account });
    // the payload names another resource than the requirements were issued for
    const otherResource = x402Body(req, p.sign(t));
    (otherResource.paymentPayload as Record<string, unknown>).resource = { url: "https://merchant.example/other" };
    expect(await reason(otherResource)).toBe("invalid_payment_requirements");
    const sameResource = x402Body(req, p.sign(t));
    (sameResource.paymentPayload as Record<string, unknown>).resource = { url: "https://merchant.example/premium" };
    expect((await post(m, "/x402/verify", sameResource)).body).toEqual({ isValid: true, payer: p.account });
    // terms changed on both sides
    const both = x402Body(req, p.sign(t));
    (both.paymentRequirements as { amount: string }).amount = "1";
    expect(await reason(both)).toBe("invalid_payment_requirements");
    // unknown binding; another account; another mode
    const unknown = x402Body(req, p.sign(t));
    (unknown.paymentRequirements as { extra: { binding: string } }).extra = {
      ...(unknown.paymentRequirements as { extra: { binding: string } }).extra,
      binding: "np1:11111111111111111111111111111111111111111111",
    };
    unknown.paymentPayload.accepted = unknown.paymentRequirements;
    expect(await reason(unknown)).toBe("requirement_unknown");
    expect(await reason(x402Body(req, p.sign(t)), other)).toBe("requirement_unknown");
    expect(await reason(x402Body(req, p.sign(t)), m, true)).toBe("requirement_unknown");
    // payload problems
    expect(await reason(x402Body(req, p.sign({ ...t, payTo: "thief.near" })))).toBe("recipient_mismatch");
    expect(await reason(x402Body(req, p.sign({ ...t, amount: "9999" })))).toBe("amount_mismatch");
    expect(
      await reason(x402Body(req, p.sign({ ...t, binding: "np1:22222222222222222222222222222222222222222222" }))),
    ).toBe("invalid_payload");
    expect(await reason(x402Body(req, p.sign({ ...t, deadline: new Date(Date.now() + 2_000).toISOString() })))).toBe(
      "deadline_invalid",
    );
    expect(await reason(x402Body(req, p.sign({ ...t, deadline: new Date(Date.now() + 600_000).toISOString() })))).toBe(
      "deadline_invalid",
    );
    const forged = p.sign(t) as { signature: string };
    expect(
      await reason(
        x402Body(req, { ...forged, signature: (p.sign({ ...t, amount: "1" }) as { signature: string }).signature }),
      ),
    ).toBe("invalid_signature");
    // Verifier: balance, nonce, key registration
    expect(await reason(x402Body(req, payer().sign(t)))).toBe("insufficient_funds");
    const named = `agent${randomUUID().slice(0, 6)}.near`;
    s.testVerifier.keys.set(named, "ed25519:registered-key");
    expect(await reason(x402Body(req, funded(payer(named)).sign(t)))).toBe("invalid_signature");
    const replay = p.sign(t);
    s.testVerifier.nonces.add(`${p.account}\u0000${JSON.parse((replay as { payload: string }).payload).nonce}`);
    expect(await reason(x402Body(req, replay))).toBe("nonce_used");
    // compliance
    expect(await reason(x402Body(req, funded(payer("sanctioned-agent.near")).sign(t)))).toBe("payer_blocked");
  });

  it("accepts any payload deadline within (now + 5 s, requirement expiry] (agent-signer: now + maxTimeoutSeconds / 2)", async () => {
    const m = s.merchant();
    const p = funded(payer());
    for (const ms of [6_000, 60_000, 119_000]) {
      const req = await required(m);
      const r = await post(
        m,
        "/x402/verify",
        x402Body(req, p.sign({ ...termsOf(req), deadline: new Date(Date.now() + ms).toISOString() })),
      );
      expect(r.body, `deadline now + ${ms} ms`).toEqual({ isValid: true, payer: p.account });
    }
  });

  it("enforces the account quota", async () => {
    const m = s.merchant();
    await s.admin.db
      .insertInto("quotas")
      .values({ account_id: uuid(m.account, "acct"), rps: 1 })
      .execute();
    s.ap.caches.quotas.clear();
    const p = funded(payer());
    const req = await required(m);
    const results: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await post(m, "/x402/verify", x402Body(req, p.sign(termsOf(req))));
      results.push(r.body.isValid ? "valid" : r.body.invalidReason);
    }
    expect(results).toContain("quota_exceeded");
  });

  it("rejects expired requirements", async () => {
    const m = s.merchant();
    const req = await required(m, { body: { max_timeout_s: 30 } });
    await s.admin.db
      .updateTable("issued_requirements")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("binding", "=", termsOf(req).binding)
      .execute();
    const body = x402Body(
      req,
      funded(payer()).sign({ ...termsOf(req), deadline: new Date(Date.now() + 20_000).toISOString() }),
    );
    // the row's expiry was moved behind the issued extra.deadline; an agent that omits it (spec 0.1.4) reaches the expiry check
    for (const side of [body.paymentPayload.accepted, body.paymentRequirements])
      delete (side as { extra: { deadline?: string } }).extra.deadline;
    const r = await post(m, "/x402/verify", body);
    expect(r.body).toMatchObject({ isValid: false, invalidReason: "requirement_expired" });
  });
});

describe("settle (test mode, sandbox Verifier)", () => {
  it("relays, waits for finality, emits the event and consumes the requirement", async () => {
    const m = s.merchant();
    const p = funded(payer());
    const req = await required(m);
    const t = termsOf(req);
    const probe = await s.probe();
    const signed = p.sign(t);
    const r = await post(m, "/x402/settle", x402Body(req, signed));
    expect(r.status).toBe(200);
    const out = SettleResponse.parse(r.body);
    expect(out).toMatchObject({ success: true, network: "near:mainnet", payer: p.account, amount: "10000" });
    expect(out.transaction.length).toBeGreaterThan(8);
    expect(s.testVerifier.balance(m.payTo, USDC_NEAR)).toBe(10_000n);
    expect(s.testVerifier.balance(TEST_TREASURY, USDC_NEAR) >= 30n).toBe(true);

    const e = await probe.next(
      "evt.agentpay.agent_payment.settled",
      (x) => (x.data.object as { binding: string }).binding === t.binding,
    );
    const ap = AgentPayment.parse(e.data.object);
    // 0.1.5: sequence = the aggregate version, on the event object and the API alike
    expect(ap.sequence).toBe(e.aggregate.version);
    const got = await s.call("GET", `/v1/agent_payments/${ap.id}`, { token: await s.token(m) });
    expect(got.body.sequence).toBe(ap.sequence);
    expect(ap).toMatchObject({
      kind: "x402",
      status: "settled",
      payer: p.account,
      pay_to: m.payTo,
      amount: "10000",
      tx_hash: out.transaction,
    });
    expect(e.account_id).toBe(uuid(m.account, "acct"));
    await probe.close();

    // idempotent on the payload hash: a replayed PAYMENT-SIGNATURE gets the same answer, never a second relay,
    // marked `replayed` (0.1.5) so the merchant delivers the resource once
    expect(out.replayed).toBeUndefined();
    const again = await post(m, "/x402/settle", x402Body(req, signed));
    expect(again.body).toEqual({ ...r.body, replayed: true });
    expect((await post(m, "/x402/settle", x402Body(req, signed))).body).toEqual({ ...r.body, replayed: true });
    const rows = await s.admin.db.selectFrom("agent_payments").select("id").where("binding", "=", t.binding).execute();
    expect(rows).toHaveLength(1);
    // single use: another payload for the same requirements
    const second = await post(m, "/x402/settle", x402Body(req, p.sign(t)));
    expect(second.body).toMatchObject({ success: false, errorReason: "requirement_consumed", transaction: "" });
    expect(s.testVerifier.balance(m.payTo, USDC_NEAR)).toBe(10_000n);

    const row = await s.admin.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("binding", "=", t.binding)
      .executeTakeFirstOrThrow();
    const transitions = await s.admin.db
      .selectFrom("agent_payment_transitions")
      .select(["from_state", "to_state"])
      .where("agent_payment_id", "=", row.id)
      .orderBy("created_at")
      .execute();
    expect(transitions.map((x) => `${x.from_state}>${x.to_state}`)).toEqual([
      "null>queued",
      "queued>submitted",
      "submitted>settled",
    ]);
  });

  it("answers settlement_pending while the batcher is behind, then the final outcome", async () => {
    await s.pause();
    try {
      const m = s.merchant();
      const p = funded(payer());
      const req = await required(m);
      const signed = p.sign(termsOf(req));
      const started = Date.now();
      const pending = await post(m, "/x402/settle", x402Body(req, signed));
      expect(pending.body).toMatchObject({ success: false, errorReason: "settlement_pending", transaction: "" });
      expect(pending.body).not.toHaveProperty("replayed");
      expect(Date.now() - started).toBeGreaterThan(7_000);
      const token = await s.token(m);
      const row = await s.admin.db
        .selectFrom("agent_payments")
        .select("id")
        .where("binding", "=", termsOf(req).binding)
        .executeTakeFirstOrThrow();
      const apId = fromUuid("ap", row.id);
      const queuedSeq = (await s.call("GET", `/v1/agent_payments/${apId}`, { token })).body.sequence as number;
      expect(queuedSeq).toBeGreaterThanOrEqual(0);
      await s.tick();
      // the first final answer is the delivery (the earlier one was only pending); the next repeats it
      const done = await post(m, "/x402/settle", x402Body(req, signed));
      expect(done.body).toMatchObject({ success: true, payer: p.account });
      expect(done.body).not.toHaveProperty("replayed");
      expect((await post(m, "/x402/settle", x402Body(req, signed))).body).toEqual({ ...done.body, replayed: true });
      // queued → submitted → tx_hash recorded → settled: the sequence moved with every change
      const settled = await s.call("GET", `/v1/agent_payments/${apId}`, { token });
      expect(settled.body.status).toBe("settled");
      expect(settled.body.sequence).toBe(queuedSeq + 3);
    } finally {
      s.resume();
    }
  });

  it("splits a failing batch and settles the good payloads alone", async () => {
    await s.pause();
    try {
      const m = s.merchant();
      const good = [funded(payer()), funded(payer())];
      const bad = funded(payer());
      const queued: { signed: unknown; req: Awaited<ReturnType<typeof required>> }[] = [];
      for (const p of [good[0], bad, good[1]] as Payer[]) {
        const req = await required(m);
        queued.push({ req, signed: p.sign(termsOf(req)) });
      }
      // queue all three without waiting (settle returns pending at once)
      const fast = { ...s.ap.settings };
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 0;
      for (const q of queued)
        expect((await post(m, "/x402/settle", x402Body(q.req, q.signed))).body.errorReason).toBe("settlement_pending");
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = fast.settleWaitMs;
      // the bad payer spends its balance after the batch simulation: the batch fails on chain
      s.testVerifier.failExecute = (signed) =>
        signed.length > 1 || JSON.stringify(signed).includes(bad.account) ? "insufficient balance or overflow" : null;
      await s.tick(); // batch of 3 fails → split
      const after1 = await s.admin.db
        .selectFrom("agent_payments")
        .select(["status", "solo", "payer"])
        .where(
          "binding",
          "in",
          queued.map((q) => termsOf(q.req).binding),
        )
        .execute();
      expect(after1.every((r) => r.status === "queued" && r.solo)).toBe(true);
      const batches = await s.admin.db
        .selectFrom("relay_batches")
        .select(["status", "size"])
        .where("status", "=", "split")
        .execute();
      expect(batches.some((b) => b.size === 3)).toBe(true);
      await s.tick();
      await s.tick();
      await s.tick();
      const after = await s.admin.db
        .selectFrom("agent_payments")
        .select(["status", "payer", "error_reason"])
        .where(
          "binding",
          "in",
          queued.map((q) => termsOf(q.req).binding),
        )
        .execute();
      const byPayer = Object.fromEntries(after.map((r) => [r.payer, r]));
      expect(byPayer[good[0]?.account as string]?.status).toBe("settled");
      expect(byPayer[good[1]?.account as string]?.status).toBe("settled");
      expect(byPayer[bad.account]).toMatchObject({ status: "failed", error_reason: "insufficient_funds" });
      const failedSettle = await post(m, "/x402/settle", x402Body(queued[1]?.req as never, queued[1]?.signed));
      expect(failedSettle.body).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    } finally {
      s.testVerifier.failExecute = null;
      s.resume();
    }
  });

  it("fails payloads whose deadline passes in the queue", async () => {
    await s.pause();
    try {
      const m = s.merchant();
      const req = await required(m);
      const signed = funded(payer()).sign({ ...termsOf(req), deadline: new Date(Date.now() + 6_500).toISOString() });
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 0;
      expect((await post(m, "/x402/settle", x402Body(req, signed))).body.errorReason).toBe("settlement_pending");
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 8_000;
      await new Promise((r) => setTimeout(r, 5_000));
      await s.tick();
      const r = await post(m, "/x402/settle", x402Body(req, signed));
      expect(r.body).toMatchObject({ success: false, errorReason: "deadline_invalid" });
    } finally {
      (s.ap.settings as { settleWaitMs: number }).settleWaitMs = 8_000;
      s.resume();
    }
  });
});

describe("settle (live mode, NEAR RPC)", () => {
  it("relays with a function-call key (zero deposit, n × 15 + 20 Tgas) and settles from intents_executed", async () => {
    const m = s.merchant();
    const p = funded(payer(), s.rpc.verifier);
    const req = await required(m, { livemode: true });
    const r = await post(m, "/x402/settle", x402Body(req, p.sign(termsOf(req))), true);
    expect(r.body, JSON.stringify({ body: r.body, methods: s.rpc.methods })).toMatchObject({
      success: true,
      payer: p.account,
    });
    const sent = s.rpc.sent.at(-1);
    expect(sent).toMatchObject({ signer: RELAYER, deposit: 0n, gas: 35n * 10n ** 12n, hash: r.body.transaction });
    expect(s.relayerKeys.map((k) => k.publicKey)).toContain(sent?.publicKey);
    expect(s.rpc.verifier.balance(m.payTo, USDC_NEAR)).toBe(10_000n);
    expect(s.testVerifier.balance(m.payTo, USDC_NEAR)).toBe(0n); // INV-8
    const row = await s.admin.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("tx_hash", "=", r.body.transaction)
      .executeTakeFirstOrThrow();
    expect(row.block_height).not.toBeNull();
    const key = await s.admin.db
      .selectFrom("relayer_keys")
      .selectAll()
      .where("public_key", "=", sent?.publicKey as string)
      .executeTakeFirstOrThrow();
    expect(key).toMatchObject({ in_flight: false, last_nonce: sent?.nonce });
  });

  it("polls the status after a send_tx timeout and requeues a transaction rejected for its nonce", async () => {
    const m = s.merchant();
    s.rpc.sendModes.push("timeout");
    const p1 = funded(payer(), s.rpc.verifier);
    const req1 = await required(m, { livemode: true });
    const r1 = await post(m, "/x402/settle", x402Body(req1, p1.sign(termsOf(req1))), true);
    expect(r1.body).toMatchObject({ success: true });
    expect(s.rpc.methods).toContain("EXPERIMENTAL_tx_status");

    s.rpc.sendModes.push("invalid_nonce");
    const p2 = funded(payer(), s.rpc.verifier);
    const req2 = await required(m, { livemode: true });
    const r2 = await post(m, "/x402/settle", x402Body(req2, p2.sign(termsOf(req2))), true);
    expect(r2.body).toMatchObject({ success: true });
    const split = await s.admin.db
      .selectFrom("relay_batches")
      .select("failure")
      .where("status", "=", "split")
      .where("livemode", "=", true)
      .execute();
    expect(split.some((b) => b.failure?.includes("rejected"))).toBe(true);
  });

  it("stops new live settles while the kill switch is engaged (test mode continues)", async () => {
    const m = s.merchant();
    const ks = (subject: string, version: number) => ({
      id: randomUUID(),
      subject,
      occurred_at: new Date().toISOString(),
      account_id: null,
      livemode: null,
      aggregate: { type: "kill_switch", id: newId("ks"), version },
      data: { object: { engaged: subject.endsWith("engaged"), reason: "unknown deposit address", actor: "sentinel" } },
    });
    await s.publishEvent(ks("evt.sentinel.kill_switch.engaged", 1) as never);
    const until = Date.now() + 10_000;
    while (!(await s.admin.db.selectFrom("kill_switch").select("engaged").executeTakeFirst())?.engaged) {
      if (Date.now() > until) throw new Error("kill switch not applied");
      await new Promise((r) => setTimeout(r, 100));
    }
    s.ap.caches.killSwitch.clear();
    const live = await required(m, { livemode: true });
    const blocked = await post(
      m,
      "/x402/settle",
      x402Body(live, funded(payer(), s.rpc.verifier).sign(termsOf(live))),
      true,
    );
    expect([blocked.status, blocked.body.error?.code]).toEqual([503, "rail_unavailable"]);
    const test = await required(m);
    expect((await post(m, "/x402/settle", x402Body(test, funded(payer()).sign(termsOf(test))))).body.success).toBe(
      true,
    );
    // a stale (older) release is ignored, the newer one applies
    await s.publishEvent(ks("evt.sentinel.kill_switch.released", 2) as never);
    while ((await s.admin.db.selectFrom("kill_switch").select("engaged").executeTakeFirst())?.engaged) {
      if (Date.now() > until + 10_000) throw new Error("kill switch not released");
      await new Promise((r) => setTimeout(r, 100));
    }
    await s.publishEvent(ks("evt.sentinel.kill_switch.engaged", 1) as never);
    await new Promise((r) => setTimeout(r, 500));
    expect((await s.admin.db.selectFrom("kill_switch").select("engaged").executeTakeFirst())?.engaged).toBe(false);
    s.ap.caches.killSwitch.clear();
    const ok = await post(m, "/x402/settle", x402Body(live, funded(payer(), s.rpc.verifier).sign(termsOf(live))), true);
    expect(ok.body.success).toBe(true);
  });
});

describe("kill switch read at boot (spec 0.2.1)", () => {
  it("an unknown state refuses live settles until sentinel's state is read; later events still win by version", async () => {
    const m = s.merchant();
    await s.admin.db.deleteFrom("kill_switch").execute();
    s.killSwitch.fail = true;
    s.ap.caches.killSwitch.clear();
    try {
      expect(await readKillSwitch(s.ap, { force: true })).toBe("unknown");
      const live = await required(m, { livemode: true });
      const blocked = await post(
        m,
        "/x402/settle",
        x402Body(live, funded(payer(), s.rpc.verifier).sign(termsOf(live))),
        true,
      );
      expect([blocked.status, blocked.body.error?.code]).toEqual([503, "rail_unavailable"]);
      // test mode is unaffected
      const test = await required(m);
      expect((await post(m, "/x402/settle", x402Body(test, funded(payer()).sign(termsOf(test))))).body.success).toBe(
        true,
      );
      s.killSwitch.fail = false;
      Object.assign(s.killSwitch, { engaged: false, version: 5 });
      expect(await readKillSwitch(s.ap, { force: true })).toBe("released");
      expect(s.sentinel.callsTo(getKillSwitch).length).toBeGreaterThan(0);
      const row = await s.admin.db.selectFrom("kill_switch").selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({ engaged: false, event_version: 5 });
      s.ap.caches.killSwitch.clear();
      const ok = await post(
        m,
        "/x402/settle",
        x402Body(live, funded(payer(), s.rpc.verifier).sign(termsOf(live))),
        true,
      );
      expect(ok.body.success).toBe(true);
      // once known, sentinel is not asked again and its answer would not override the stored state
      Object.assign(s.killSwitch, { engaged: true, version: 6 });
      expect(await readKillSwitch(s.ap, { force: true })).toBe("released");
    } finally {
      Object.assign(s.killSwitch, { engaged: false, version: 0, fail: false });
      s.ap.caches.killSwitch.clear();
    }
  });
});

describe("agent payments", () => {
  it("lists and retrieves the merchant's payments only, by mode and kind", async () => {
    const m = s.merchant();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const req = await required(m);
      const r = await post(m, "/x402/settle", x402Body(req, funded(payer()).sign(termsOf(req))));
      expect(r.body.success).toBe(true);
      const row = await s.admin.db
        .selectFrom("agent_payments")
        .select("id")
        .where("binding", "=", termsOf(req).binding)
        .executeTakeFirstOrThrow();
      ids.unshift(fromUuid("ap", row.id));
    }
    const token = await s.token(m);
    const page1 = await s.call("GET", "/v1/agent_payments?limit=2", { token });
    expect(page1.status).toBe(200);
    const list = AgentPaymentList.parse(page1.body);
    expect(list.data.map((x) => x.id)).toEqual(ids.slice(0, 2));
    expect(list.has_more).toBe(true);
    const page2 = await s.call("GET", `/v1/agent_payments?limit=2&starting_after=${ids[1]}`, { token });
    expect(page2.body.data.map((x: { id: string }) => x.id)).toEqual([ids[2]]);
    expect((await s.call("GET", "/v1/agent_payments?kind=checkout", { token })).body.data).toEqual([]);
    expect(
      (await s.call("GET", "/v1/agent_payments", { token: await s.token(m, { livemode: true }) })).body.data,
    ).toEqual([]);
    const one = await s.call("GET", `/v1/agent_payments/${ids[0]}`, { token });
    expect(AgentPayment.parse(one.body)).toMatchObject({
      id: ids[0],
      status: "settled",
      kind: "x402",
      resource_url: "https://merchant.example/premium",
    });
    const stranger = s.merchant();
    expect((await s.call("GET", `/v1/agent_payments/${ids[0]}`, { token: await s.token(stranger) })).status).toBe(404);
    expect((await s.call("GET", "/v1/agent_payments?starting_after=nope", { token })).status).toBe(400);
  });
});
