/**
 * x402 `exact` + `near-intents` end to end over HTTP (lld/agentpay.md §3.1, §4.1, §5, §8): issuance (entries,
 * bindings, deposit windows, indicative amounts, refusals), quotes (every invalidReason, single use, rails
 * request, refusals and which free the binding, integrity, kill switch, quotas), deposits (token checks) and
 * settles (pending, waiting, success, replayed, deposit_not_found, refunds), and the execution consumer (merchant
 * record only on `settled`, other owners ignored, duplicates/stale events, rails defects, orphan quotes).
 */
import {
  AgentPayment,
  NearIntentsSettleResponse,
  NearIntentsVerifyResponse,
  quotedRequirements,
  X402PaymentRequiredAny,
} from "@nearpay/spec";
import { fromUuid, newId, toUuid } from "@nearpay-internal/ids";
import type { Execution } from "@nearpay-internal/spec";
import { domainEvent } from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeKillSwitch } from "../../src/app/kill-switch.js";
import { mintOperationToken, nearIntentsBinding } from "../../src/domain/near-intents/kit.js";
import { failedExecution, ORIGIN_TX, REFUND_TO, refundedExecution, settledExecution } from "../support/executions.js";
import {
  BASE_USDC,
  BASE_USDC_CONTRACT,
  type Merchant,
  OPERATION_KEY,
  SOL_ASSET,
  type Stack,
  startStack,
  USDC_NEAR,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ autoBatch: false });
});
afterAll(async () => {
  await s?.stop();
});

// biome-ignore lint/suspicious/noExplicitAny: settings are adjusted per test (wait, quotas, keys)
const settings = () => s.ap.settings as any;
beforeEach(() => {
  settings().settleWaitMs = 300;
  settings().quoteRatePerS = { account: 1_000, refund_to: 1_000 };
  s.quotes.fail = null;
  s.quotes.mutate = null;
  s.quotes.memo = null;
});

const RESOURCE = "https://merchant.example/premium";
const OTHER_TX = `0x${"7".repeat(64)}`;

type Required = { accepts: Record<string, unknown>[]; resource: { url: string }; x402Version: 2 };
type Entry = Record<string, unknown> & { network: string; extra: Record<string, unknown> & { binding: string } };

async function issue(m: Merchant, o: { livemode?: boolean; body?: Record<string, unknown> } = {}) {
  return s.call("POST", "/x402/near-intents/requirements", {
    token: await s.token(m, { livemode: o.livemode ?? false }),
    body: {
      resource: { url: RESOURCE, description: "Premium data" },
      amount: "1000000",
      origins: [{ asset_id: BASE_USDC }],
      ...o.body,
    },
  });
}

async function required(m: Merchant, o: { livemode?: boolean; body?: Record<string, unknown> } = {}) {
  const r = await issue(m, o);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Required;
}

const nearEntry = (r: Required, i = 0) =>
  r.accepts.filter((a) => (a.extra as { assetTransferMethod: string }).assetTransferMethod === "near-intents")[
    i
  ] as Entry;

function body(entry: Entry, payload: Record<string, unknown>, o: { url?: string; requirements?: Entry } = {}) {
  return {
    x402Version: 2,
    paymentPayload: {
      x402Version: 2,
      resource: { url: o.url ?? RESOURCE },
      accepted: structuredClone(entry),
      payload,
    },
    paymentRequirements: structuredClone(o.requirements ?? entry),
  };
}

const quotePayload = (refundTo = REFUND_TO, slippage?: number) => ({
  type: "quote",
  refundTo,
  ...(slippage !== undefined ? { slippageTolerance: slippage } : {}),
});

async function post(m: Merchant, path: string, b: unknown, livemode = false) {
  return s.call("POST", path, { token: await s.token(m, { livemode }), body: b });
}

interface Quoted {
  entry: Entry;
  quote: {
    depositAddress: string;
    depositMemo?: string;
    amountIn: string;
    refundDeadline: string;
    operationToken: string;
  };
  execution: Execution;
}

async function quoted(m: Merchant, o: { livemode?: boolean; refundTo?: string } = {}): Promise<Quoted> {
  const entry = nearEntry(await required(m, { livemode: o.livemode }));
  const r = await post(m, "/x402/near-intents/verify", body(entry, quotePayload(o.refundTo)), o.livemode);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.isValid, JSON.stringify(r.body)).toBe(true);
  const execution = [...s.executions.values()].find(
    (x) => (x as { x402_binding?: string }).x402_binding === entry.extra.binding,
  ) as Execution;
  return { entry, quote: r.body.extra, execution };
}

const depositPayload = (q: Quoted["quote"], txHash = ORIGIN_TX) => ({
  type: "deposit",
  operationToken: q.operationToken,
  depositAddress: q.depositAddress,
  ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
  txHash,
});

async function event(subject: Parameters<typeof domainEvent>[0], x: Execution, version = x.version) {
  const e = domainEvent(subject, x, { accountUuid: toUuid(x.account_id, "acct"), livemode: x.livemode, version });
  await s.publishEvent(e as never);
  return e;
}

async function until<T>(read: () => Promise<T | undefined | null | false>, what: string, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const operation = (binding: string) =>
  s.admin.db.selectFrom("x402_operations").selectAll().where("binding", "=", binding).executeTakeFirst();
const agentPayments = (execution: string) =>
  s.admin.db.selectFrom("agent_payments").selectAll().where("execution_id", "=", execution).execute();

/** Publishes a settled event for the quote and waits until the consumer recorded it. */
async function settle(q: Quoted, o: Parameters<typeof settledExecution>[1] = {}) {
  const x = settledExecution(q.execution, o);
  s.executions.set(x.id, x);
  await event("evt.rails.execution.settled", x);
  await until(async () => (await operation(q.entry.extra.binding))?.result, "settled result");
  return x;
}

// ---------------------------------------------------------------------------------------------- issue

describe("requirements", () => {
  it("issues the intents-transfer entry first, then one unquoted entry per origin with its own binding", async () => {
    const m = s.merchant();
    const before = Date.now();
    const r = await required(m);
    const parsed = X402PaymentRequiredAny.parse(r);
    expect(parsed.accepts).toHaveLength(2);
    expect(r.accepts[0]).toMatchObject({ extra: { assetTransferMethod: "intents-transfer" } });
    const e = nearEntry(r);
    expect(e).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      amount: "",
      asset: BASE_USDC_CONTRACT,
      payTo: "",
      maxTimeoutSeconds: 1800, // the origin chain profile's default
      extra: {
        assetTransferMethod: "near-intents",
        paymentFlow: "upfront",
        destination: { network: "near:mainnet", asset: USDC_NEAR, amount: "1000000", recipient: m.payTo },
        indicativeAmount: "1012000",
        originAssetId: BASE_USDC,
        slippageTolerance: { min: 10, max: 300, default: 50 },
      },
    });
    const deadline = Date.parse(e.extra.deadline as string);
    expect(deadline).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 + 299_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 301_000);
    const row = await s.admin.db
      .selectFrom("issued_requirements")
      .selectAll()
      .where("binding", "=", e.extra.binding)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      method: "near-intents",
      account_id: toUuid(m.account, "acct"),
      livemode: false,
      fee_to: null,
      fee_amount: "0",
      max_timeout_s: 1800,
      origin_network: "eip155:8453",
      origin_asset_id: BASE_USDC,
      origin_asset: BASE_USDC_CONTRACT,
      consumed_at: null,
    });
    expect(row.entry).toEqual(e);
    // the binding is the spec construction over the stored terms
    expect(
      nearIntentsBinding({
        method: "near-intents",
        account_id: m.account,
        resource_url: RESOURCE,
        origin_network: "eip155:8453",
        origin_asset_id: BASE_USDC,
        pay_to: m.payTo,
        asset_id: USDC_NEAR,
        amount: "1000000",
        max_timeout_s: 1800,
        nonce16: row.nonce16,
        expires_at: Math.floor(row.expires_at.getTime() / 1000),
      }),
    ).toBe(e.extra.binding);
  });

  it("without the intents-transfer entry, with explicit windows, a quote window and several origins", async () => {
    const m = s.merchant();
    const r = await required(m, {
      body: {
        include_intents_transfer: false,
        quote_window_s: 60,
        origins: [{ asset_id: BASE_USDC, max_timeout_s: 600 }, { asset_id: USDC_NEAR }],
      },
    });
    expect(r.accepts).toHaveLength(2);
    const [base, near] = [nearEntry(r, 0), nearEntry(r, 1)];
    expect(base.maxTimeoutSeconds).toBe(600);
    expect(near).toMatchObject({ network: "near:mainnet", maxTimeoutSeconds: 600, asset: USDC_NEAR });
    expect(near.extra.indicativeAmount).toBeUndefined();
    expect(base.extra.binding).not.toBe(near.extra.binding);
    expect(Date.parse(base.extra.deadline as string) - Date.now()).toBeLessThanOrEqual(61_000);
  });

  it("refuses unknown origins, duplicates, short windows, a chain without a profile and accounts not live", async () => {
    const m = s.merchant();
    const unknown = await issue(m, { body: { origins: [{ asset_id: BASE_USDC }, { asset_id: "nep141:nope.near" }] } });
    expect([unknown.status, unknown.body.error.code, unknown.body.error.param]).toEqual([
      400,
      "asset_unsupported",
      "origins[1].asset_id",
    ]);
    const noProfile = await issue(m, { body: { origins: [{ asset_id: SOL_ASSET }] } });
    expect([noProfile.status, noProfile.body.error.code]).toEqual([400, "asset_unsupported"]);
    const dup = await issue(m, { body: { origins: [{ asset_id: BASE_USDC }, { asset_id: BASE_USDC }] } });
    expect([dup.status, dup.body.error.code]).toEqual([400, "invalid_request"]);
    const short = await issue(m, { body: { origins: [{ asset_id: BASE_USDC, max_timeout_s: 60 }] } });
    expect([short.status, short.body.error.code, short.body.error.param]).toEqual([
      422,
      "deadline_too_short",
      "origins[0].max_timeout_s",
    ]);
    const zero = await issue(m, { body: { amount: "0", include_intents_transfer: false } });
    expect([zero.status, zero.body.error.code]).toEqual([422, "amount_below_minimum"]);
    // nothing was issued for a refused request (not even the intents-transfer entry)
    const issued = await s.admin.db
      .selectFrom("issued_requirements")
      .select("binding")
      .where("account_id", "=", toUuid(m.account, "acct"))
      .execute();
    expect(issued).toEqual([]);
    const notLive = await issue(s.merchant({ liveEnabled: false }), { livemode: true });
    expect([notLive.status, notLive.body.error.code]).toEqual([403, "account_not_live"]);
    const chain = await issue(s.merchant({ type: "chain_address", payTo: "m.chain" }));
    expect([chain.status, chain.body.error.code]).toEqual([409, "destination_not_intents_account"]);
    const anon = await s.call("POST", "/x402/near-intents/requirements", {
      body: { resource: { url: RESOURCE }, amount: "1", origins: [{ asset_id: BASE_USDC }] },
    });
    expect(anon.status).toBe(401);
  });

  it("refuses issuance without operation-token keys and live issuance while the kill switch is engaged", async () => {
    const keys = settings().operationKeys;
    settings().operationKeys = null;
    try {
      const r = await issue(s.merchant());
      expect([r.status, r.body.error.code]).toEqual([503, "rail_unavailable"]);
    } finally {
      settings().operationKeys = keys;
    }
    await withKillSwitch(async () => {
      const live = await issue(s.merchant(), { livemode: true });
      expect([live.status, live.body.error.code]).toEqual([503, "rail_unavailable"]);
      expect((await issue(s.merchant())).status).toBe(200); // test mode unaffected
    });
  });

  it("an intents-transfer verify never accepts a near-intents binding", async () => {
    const m = s.merchant();
    const r = await required(m);
    const it = structuredClone(r.accepts[0]) as Entry;
    it.extra.binding = nearEntry(r).extra.binding;
    const v = await post(m, "/x402/verify", {
      x402Version: 2,
      paymentPayload: {
        x402Version: 2,
        accepted: it,
        payload: {
          signed: {
            standard: "raw_ed25519",
            payload: "{}",
            public_key: "ed25519:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS",
            signature: `ed25519:${"1".repeat(64)}`,
          },
        },
      },
      paymentRequirements: it,
    });
    expect(v.body).toMatchObject({ isValid: false, invalidReason: "requirement_unknown" });
  });
});

let ksVersion = 1_000;
async function withKillSwitch(fn: () => Promise<void>) {
  await storeKillSwitch(s.admin.db, { engaged: true, reason: "test", actor: "test", version: ++ksVersion });
  s.ap.caches.killSwitch.clear();
  try {
    await fn();
  } finally {
    await storeKillSwitch(s.admin.db, { engaged: false, reason: "test", actor: "test", version: ++ksVersion });
    s.ap.caches.killSwitch.clear();
  }
}

// ---------------------------------------------------------------------------------------------- quote

describe("quote", () => {
  it("mints a quote: rails execution owned by agentpay, operation recorded with the token's hash only", async () => {
    const m = s.merchant();
    const entry = nearEntry(await required(m));
    const calls = s.quotes.calls.length;
    const r = await post(m, "/x402/near-intents/verify", body(entry, quotePayload(REFUND_TO, 1_000)));
    expect(r.status).toBe(200);
    const v = NearIntentsVerifyResponse.parse(r.body);
    expect(v.isValid).toBe(true);
    const q = v.extra as NonNullable<typeof v.extra>;
    expect(q).toMatchObject({ amountIn: "1012000", minAmountIn: "1007000" });
    expect(q.depositMemo).toBeUndefined();
    // the rails request (rails §20)
    const sent = s.quotes.calls[calls] as Record<string, unknown>;
    expect(sent).toMatchObject({
      idempotency_key: `x402:${entry.extra.binding}`,
      owner: "agentpay",
      x402_binding: entry.extra.binding,
      kind: "payment",
      method: "route_quote",
      account_id: m.account,
      livemode: false,
      origin: { asset_id: BASE_USDC, chain: "eip155:8453", refund_to: REFUND_TO, refund_type: "origin_chain" },
      destination: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: m.payTo },
      pricing: { currency: "asset", asset_id: USDC_NEAR, amount: "1000000" },
      fee: { bearer: "payer" },
      slippage_bps: 300, // clamped into the advertised range
    });
    expect(Date.parse(sent.deadline_cap as string) - Date.now()).toBeLessThanOrEqual(1_800_000);
    // the token: kid.expiry.mac with expiry = refund deadline + 24 h, recomputable with the key
    const [kid, expiry] = q.operationToken.split(".");
    expect(kid).toBe("k1");
    expect(Number(expiry)).toBe(Math.floor(Date.parse(q.refundDeadline) / 1000) + 86_400);
    expect(
      mintOperationToken(OPERATION_KEY, "k1", {
        v: 1,
        binding: entry.extra.binding,
        network: "eip155:8453",
        deposit_address: q.depositAddress,
        deposit_memo: null,
        resource_url: RESOURCE,
        destination: entry.extra.destination as never,
        expiry: Number(expiry),
      }),
    ).toBe(q.operationToken);
    const op = await operation(entry.extra.binding);
    expect(op).toMatchObject({
      status: "quoted",
      network: "eip155:8453",
      deposit_address: q.depositAddress,
      refund_to: REFUND_TO,
      amount_in: "1012000",
      token_kid: "k1",
      result: null,
    });
    expect(JSON.stringify(op)).not.toContain(q.operationToken.split(".")[2]);
    const req = await s.admin.db
      .selectFrom("issued_requirements")
      .select("consumed_at")
      .where("binding", "=", entry.extra.binding)
      .executeTakeFirstOrThrow();
    expect(req.consumed_at).not.toBeNull();
    // the resource server's second 402
    const second = X402PaymentRequiredAny.parse({
      x402Version: 2,
      resource: { url: RESOURCE },
      accepts: [quotedRequirements(entry as never, q)],
    });
    expect(second.accepts[0]).toMatchObject({ amount: "1012000", payTo: q.depositAddress });
    // one quote per entry
    const again = await post(m, "/x402/near-intents/verify", body(entry, quotePayload()));
    expect(again.body).toMatchObject({ isValid: false, invalidReason: "requirement_consumed" });
  });

  it("concurrent quotes of one entry: exactly one wins", async () => {
    const m = s.merchant();
    const entry = nearEntry(await required(m));
    const rs = await Promise.all(
      Array.from({ length: 4 }, () => post(m, "/x402/near-intents/verify", body(entry, quotePayload()))),
    );
    expect(rs.filter((r) => r.body.isValid).length).toBe(1);
    expect(rs.filter((r) => r.body.invalidReason === "requirement_consumed").length).toBe(3);
  });

  it("answers every invalid reason of the terms", async () => {
    const m = s.merchant();
    const other = s.merchant();
    const entry = nearEntry(await required(m));
    const ask = (b: unknown, who = m) => post(who, "/x402/near-intents/verify", b);
    const reason = async (b: unknown, who = m) => (await ask(b, who)).body.invalidReason;

    const v1 = body(entry, quotePayload()) as { x402Version: number };
    v1.x402Version = 1;
    expect((await ask(v1)).status).toBe(400); // literal x402Version in the schema
    const altered = structuredClone(entry);
    (altered.extra.destination as { amount: string }).amount = "1";
    expect(await reason(body(altered, quotePayload()))).toBe("invalid_payment_requirements");
    expect(await reason(body(entry, quotePayload(), { requirements: altered }))).toBe("invalid_payment_requirements");
    expect(await reason(body(entry, quotePayload(), { url: "https://merchant.example/other" }))).toBe(
      "invalid_payment_requirements",
    );
    const withToken = structuredClone(entry);
    withToken.extra.operationToken = `k1.1.${"A".repeat(43)}`;
    expect(await reason(body(withToken, quotePayload()))).toBe("invalid_payment_requirements");
    // indicativeAmount is informational: an echo without it still matches
    const stripped = structuredClone(entry);
    delete stripped.extra.indicativeAmount;
    const unknown = structuredClone(entry);
    unknown.extra.binding = "np1:FkMXJmBuTZEMpEvn6a6VRVGugj435HBY98sUfKJhinuj";
    expect(await reason(body(unknown, quotePayload()))).toBe("requirement_unknown");
    expect(await reason(body(entry, quotePayload()), other)).toBe("requirement_unknown");
    expect((await post(m, "/x402/near-intents/verify", body(entry, quotePayload()), true)).body.invalidReason).toBe(
      "requirement_unknown",
    ); // another mode
    expect(await reason(body(entry, quotePayload("not-an-address")))).toBe("invalid_payload");
    expect(await reason(body(entry, quotePayload("merchant.near")))).toBe("invalid_payload");
    // expired
    await s.admin.db
      .updateTable("issued_requirements")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("binding", "=", entry.extra.binding)
      .execute();
    expect(await reason(body(stripped, quotePayload()))).toBe("requirement_expired");
  });

  it("rails refusals: no quote, payer blocked, 503s; only retryable ones free the binding", async () => {
    const m = s.merchant();
    const cases: [string, number, string | undefined, boolean][] = [
      ["route_unavailable", 200, "invalid_exact_near_intents_quote_unavailable", true],
      ["pricing_unavailable", 200, "invalid_exact_near_intents_quote_unavailable", true],
      ["quote_rejected", 200, "invalid_exact_near_intents_quote_unavailable", false],
      ["deadline_too_short", 200, "invalid_exact_near_intents_quote_unavailable", false],
      ["quote_integrity_failed", 200, "invalid_exact_near_intents_quote_unavailable", false],
      ["screening_blocked", 200, "payer_blocked", false],
      ["screening_unavailable", 503, undefined, true],
      ["rail_unavailable", 503, undefined, true],
      ["internal", 503, undefined, false],
    ];
    for (const [code, status, reason, released] of cases) {
      const entry = nearEntry(await required(m));
      s.quotes.fail = code;
      const r = await post(m, "/x402/near-intents/verify", body(entry, quotePayload()));
      s.quotes.fail = null;
      expect([code, r.status], JSON.stringify(r.body)).toEqual([code, status]);
      if (reason) expect(r.body).toMatchObject({ isValid: false, invalidReason: reason });
      else
        expect(r.body.error.code).toBe(code === "screening_unavailable" ? "screening_unavailable" : "rail_unavailable");
      const retry = await post(m, "/x402/near-intents/verify", body(entry, quotePayload()));
      expect([code, retry.body.isValid ?? false, retry.body.invalidReason]).toEqual(
        released ? [code, true, undefined] : [code, false, "requirement_consumed"],
      );
      expect(await operation(entry.extra.binding)).toEqual(released ? expect.anything() : undefined);
    }
  });

  it("refuses a rails execution that is not the requested quote (integrity, fail closed)", async () => {
    const m = s.merchant();
    const tampered: ((x: Execution) => Execution)[] = [
      (x) => ({ ...x, owner: "payments" }),
      (x) => ({ ...x, owner: undefined }) as Execution,
      (x) => ({ ...x, origin: { ...x.origin, refund_to: "0x0000000000000000000000000000000000000001" } }),
      (x) => ({ ...x, settlement: { ...x.settlement, recipient: "attacker.near" } }),
      (x) => ({ ...x, settlement: { ...x.settlement, amount_base: "1" } }),
      (x) => ({ ...x, deposit: null }),
      (x) => ({ ...x, state: "failed" }),
    ];
    for (const mutate of tampered) {
      const entry = nearEntry(await required(m));
      s.quotes.mutate = mutate;
      const r = await post(m, "/x402/near-intents/verify", body(entry, quotePayload()));
      expect([r.status, r.body.error?.code]).toEqual([503, "rail_unavailable"]);
      expect(await operation(entry.extra.binding)).toBeUndefined();
    }
  });

  it("live quotes stop while the kill switch is engaged; quotas per refund address", async () => {
    const m = s.merchant();
    const live = nearEntry(await required(m, { livemode: true }));
    await withKillSwitch(async () => {
      const r = await post(m, "/x402/near-intents/verify", body(live, quotePayload()), true);
      expect([r.status, r.body.error?.code]).toEqual([503, "rail_unavailable"]);
    });
    const ok = await post(m, "/x402/near-intents/verify", body(live, quotePayload()), true);
    expect(ok.body.isValid, JSON.stringify(ok.body)).toBe(true);

    settings().quoteRatePerS = { account: 1_000, refund_to: 1 };
    const refundTo = "0x1111111111111111111111111111111111111111";
    const entries = [nearEntry(await required(m)), nearEntry(await required(m)), nearEntry(await required(m))];
    const rs = await Promise.all(
      entries.map((e) => post(m, "/x402/near-intents/verify", body(e, quotePayload(refundTo)))),
    );
    expect(rs.some((r) => r.body.invalidReason === "quota_exceeded")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------- deposit + settle

describe("deposit and settle", () => {
  it("verify checks a deposit payload: token, expiry, instrument and terms", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const ask = async (p: Record<string, unknown>, e = q.entry) =>
      (await post(m, "/x402/near-intents/verify", body(e, p))).body;
    expect(await ask(depositPayload(q.quote))).toEqual({ isValid: true, payer: REFUND_TO });
    const [kid, expiry, mac] = q.quote.operationToken.split(".") as [string, string, string];
    const flip = `${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    expect((await ask({ ...depositPayload(q.quote), operationToken: `${kid}.${expiry}.${flip}` })).invalidReason).toBe(
      "invalid_exact_near_intents_token_invalid",
    );
    expect((await ask({ ...depositPayload(q.quote), operationToken: `k9.${expiry}.${mac}` })).invalidReason).toBe(
      "invalid_exact_near_intents_token_invalid",
    );
    expect((await ask({ ...depositPayload(q.quote), operationToken: "not-a-token-at-all" })).invalidReason).toBe(
      "invalid_exact_near_intents_token_invalid",
    );
    expect(
      (await ask({ ...depositPayload(q.quote), depositAddress: "0x76b4c56085ED136a8744D52bE956396624a730E8" }))
        .invalidReason,
    ).toBe("invalid_exact_near_intents_token_invalid");
    expect((await ask({ ...depositPayload(q.quote), depositMemo: "42" })).invalidReason).toBe(
      "invalid_exact_near_intents_token_invalid",
    );
    // a validly minted but expired token is refused before any lookup
    const expired = mintOperationToken(OPERATION_KEY, "k1", {
      v: 1,
      binding: q.entry.extra.binding,
      network: "eip155:8453",
      deposit_address: q.quote.depositAddress,
      deposit_memo: null,
      resource_url: RESOURCE,
      destination: q.entry.extra.destination as never,
      expiry: Math.floor(Date.now() / 1000) - 1,
    });
    expect((await ask({ ...depositPayload(q.quote), operationToken: expired })).invalidReason).toBe(
      "invalid_exact_near_intents_token_expired",
    );
    // the token of one quote does not redeem another quote's entry
    const q2 = await quoted(m);
    expect((await ask(depositPayload(q.quote), q2.entry)).invalidReason).toBe(
      "invalid_exact_near_intents_token_invalid",
    );
    // another merchant cannot redeem it
    expect(
      (await post(s.merchant(), "/x402/near-intents/verify", body(q.entry, depositPayload(q.quote)))).body,
    ).toMatchObject({
      isValid: false,
      invalidReason: "requirement_unknown",
    });
    // a quote payload at settle is invalid
    const st = await post(m, "/x402/near-intents/settle", body(q.entry, quotePayload()));
    expect(st.body).toMatchObject({ success: false, errorReason: "invalid_payload", network: "eip155:8453" });
  });

  it("pending until rails evidence; then success once, replayed afterwards; another tx is deposit_not_found", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const pending = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    expect(NearIntentsSettleResponse.parse(pending.body)).toEqual({
      success: false,
      transaction: ORIGIN_TX,
      network: "eip155:8453",
      payer: REFUND_TO,
      errorReason: "settlement_pending",
      errorMessage: expect.any(String),
      extra: { status: "PENDING_DEPOSIT" },
    });
    // the deposit tx was forwarded to rails
    expect(s.executions.get(q.execution.id)?.deposit_tx_hashes).toContain(ORIGIN_TX);
    expect(await agentPayments(q.execution.id)).toEqual([]);

    const probe = await s.probe();
    const x = await settle(q, { settled: "1000017" });
    const ev = await probe.next(
      "evt.agentpay.agent_payment.settled",
      (e) => (e.data.object as { execution?: unknown; binding: string }).binding === q.entry.extra.binding,
    );
    await probe.close();
    const [row] = await agentPayments(q.execution.id);
    expect(row).toMatchObject({
      kind: "x402",
      transfer_method: "near-intents",
      status: "settled",
      payer: "solver.near",
      pay_to: m.payTo,
      amount: "1000017",
      fee_amount: "0",
      fee_to: null,
      payload_hash: null,
      binding: q.entry.extra.binding,
      resource_url: RESOURCE,
      tx_hash: (x.evidence as { tx_hash: string }).tx_hash,
      block_height: 180000123n,
    });
    const id = fromUuid("ap", (row as { id: string }).id);
    const api = await s.call("GET", `/v1/agent_payments/${id}`, { token: await s.token(m) });
    const ap = AgentPayment.parse(api.body);
    expect(ap).toMatchObject({ transfer_method: "near-intents", fee_amount: "0", payer: "solver.near", sequence: 1 });
    expect(ap.origin).toEqual({
      network: "eip155:8453",
      asset_id: BASE_USDC,
      amount_in: "1012000",
      refund_to: REFUND_TO,
      deposit_address: q.quote.depositAddress,
      deposit_memo: null,
      tx_hashes: [ORIGIN_TX],
      fee: { amount: "5000", asset_id: BASE_USDC },
    });
    expect(AgentPayment.parse(ev.data.object)).toMatchObject({ id, transfer_method: "near-intents" });
    const transitions = await s.admin.db
      .selectFrom("agent_payment_transitions")
      .selectAll()
      .where("agent_payment_id", "=", (row as { id: string }).id)
      .execute();
    expect(transitions.map((t) => [t.from_state, t.to_state])).toEqual([[null, "settled"]]);

    const ok = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    expect(NearIntentsSettleResponse.parse(ok.body)).toEqual({
      success: true,
      transaction: (x.evidence as { tx_hash: string }).tx_hash,
      network: "near:mainnet",
      payer: REFUND_TO,
      amount: "1000017",
      extra: { originNetwork: "eip155:8453", originTxHash: ORIGIN_TX, agentPayment: id },
    });
    const again = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    expect(again.body).toMatchObject({ success: true, replayed: true });
    const other = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote, OTHER_TX)));
    expect(other.body).toMatchObject({
      success: false,
      errorReason: "invalid_exact_near_intents_deposit_not_found",
      transaction: "",
    });
    // verify on a settled operation still says the token is valid (no claim)
    expect((await post(m, "/x402/near-intents/verify", body(q.entry, depositPayload(q.quote)))).body.isValid).toBe(
      true,
    );
  });

  it("a waiting settle answers as soon as the consumer records the settlement", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    settings().settleWaitMs = 8_000;
    const started = Date.now();
    const waiting = post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    await new Promise((r) => setTimeout(r, 400));
    const x = settledExecution(q.execution);
    s.executions.set(x.id, x);
    await event("evt.rails.execution.settled", x);
    const r = await waiting;
    expect(r.body).toMatchObject({ success: true, amount: "1000000" });
    expect(r.body.replayed).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(7_500);
  });

  it("concurrent settles of a settled operation: exactly one first delivery", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    await settle(q);
    const rs = await Promise.all(
      Array.from({ length: 5 }, () => post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)))),
    );
    expect(rs.every((r) => r.body.success === true)).toBe(true);
    expect(rs.filter((r) => r.body.replayed !== true).length).toBe(1);
  });

  it("refunded or failed executions create no agent payment; settle reports the failure", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const x = refundedExecution(q.execution);
    s.executions.set(x.id, x);
    await event("evt.rails.execution.refunded", x);
    await until(async () => (await operation(q.entry.extra.binding))?.result, "refund result");
    expect(await agentPayments(q.execution.id)).toEqual([]);
    const r = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    expect(NearIntentsSettleResponse.parse(r.body)).toEqual({
      success: false,
      transaction: "",
      network: "eip155:8453",
      payer: REFUND_TO,
      errorReason: "exact_near_intents_payment_failed",
      errorMessage: expect.any(String),
      extra: { status: "REFUNDED", refundTo: REFUND_TO },
    });
    expect((await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)))).body.replayed).toBe(
      true,
    );

    const q2 = await quoted(m);
    const x2 = refundedExecution(q2.execution, "INCOMPLETE_DEPOSIT");
    await event("evt.rails.execution.refunded", x2);
    await until(async () => (await operation(q2.entry.extra.binding))?.result, "refund result");
    expect(
      (await post(m, "/x402/near-intents/settle", body(q2.entry, depositPayload(q2.quote)))).body.errorReason,
    ).toBe("exact_near_intents_insufficient_deposit");

    const q3 = await quoted(m);
    await event("evt.rails.execution.failed", failedExecution(q3.execution));
    const op3 = await until(
      async () => (await operation(q3.entry.extra.binding))?.result && operation(q3.entry.extra.binding),
      "failure",
    );
    expect(op3).toMatchObject({ status: "failed", agent_payment_id: null });
    expect(await agentPayments(q3.execution.id)).toEqual([]);
  });

  it("an expired quote without a deposit is deposit_not_found (not recorded)", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    s.executions.set(q.execution.id, { ...q.execution, state: "expired_unpaid", provider_status: "EXPIRED" });
    const r = await post(m, "/x402/near-intents/settle", body(q.entry, depositPayload(q.quote)));
    expect(r.body).toMatchObject({ success: false, errorReason: "invalid_exact_near_intents_deposit_not_found" });
    expect((await operation(q.entry.extra.binding))?.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- consumer

describe("execution consumer", () => {
  it("ignores executions of other owners", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const x = { ...settledExecution(q.execution), owner: "payments" } as Execution;
    const e = await event("evt.rails.execution.settled", x);
    await until(
      async () => s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", e.id).executeTakeFirst(),
      "inbox entry",
    );
    expect(await agentPayments(q.execution.id)).toEqual([]);
    expect((await operation(q.entry.extra.binding))?.status).toBe("quoted");
  });

  it("duplicate settled events give one agent payment; a later terminal event never changes the result", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const x = await settle(q);
    await event("evt.rails.execution.settled", x); // another event id, same version
    await event("evt.rails.execution.settled", { ...x, version: x.version + 1 });
    const late = await event(
      "evt.rails.execution.refunded",
      refundedExecution({ ...q.execution, version: x.version + 5 }),
    );
    await until(
      async () => s.admin.db.selectFrom("inbox").select("event_id").where("event_id", "=", late.id).executeTakeFirst(),
      "late event applied",
    );
    expect(await agentPayments(q.execution.id)).toHaveLength(1);
    expect(await operation(q.entry.extra.binding)).toMatchObject({ status: "settled", execution_version: x.version });
  });

  it("a settled event without evidence.sender is a rails defect: no record until a correct event arrives", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const bad = settledExecution(q.execution, { sender: null });
    await event("evt.rails.execution.settled", bad);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await agentPayments(q.execution.id)).toEqual([]);
    expect((await operation(q.entry.extra.binding))?.status).toBe("quoted");
    await settle(q); // the corrected event (sender set)
    expect(await agentPayments(q.execution.id)).toHaveLength(1);
  });

  it("a settlement of a quote that was never handed out still gets its merchant record", async () => {
    const m = s.merchant();
    const entry = nearEntry(await required(m));
    // rails created the execution, but recording the operation failed (no operation row)
    await s.admin.db
      .updateTable("issued_requirements")
      .set({ consumed_at: new Date() })
      .where("binding", "=", entry.extra.binding)
      .execute();
    const x = settledExecution(
      (await import("../support/executions.js")).quoteExecution({
        account: m.account,
        binding: entry.extra.binding,
        payTo: m.payTo,
        amount: "1000000",
      }),
    );
    await event("evt.rails.execution.settled", x);
    const rows = await until(async () => {
      const r = await agentPayments(x.id);
      return r.length ? r : null;
    }, "orphan merchant record");
    expect(rows[0]).toMatchObject({ transfer_method: "near-intents", payer: "solver.near", amount: "1000000" });
  });

  it("an execution naming another account's binding is refused (no record)", async () => {
    const m = s.merchant();
    const q = await quoted(m);
    const x = { ...settledExecution(q.execution), account_id: s.merchant().account } as Execution;
    await event("evt.rails.execution.settled", x);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(await agentPayments(q.execution.id)).toEqual([]);
    expect(newId("ap")).toMatch(/^ap_/);
  });
});
