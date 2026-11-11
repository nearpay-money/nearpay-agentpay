/**
 * Agents paying checkout sessions and the checkout relay (lld/agentpay.md §5, §7): requirements from
 * payments' agent attempts, client-secret checks through payments, `agent_pay`, `POST /internal/relay`
 * (payments' service token only), idempotency, single live payload per binding, and the batcher
 * relaying checkout payloads without emitting agent payment events (rails settles the execution).
 */

import { fromUuid } from "@nearpay-internal/ids";
import { getPayerCheckoutSession } from "@nearpay-internal/spec";
import { mintServiceToken } from "@nearpay-internal/testing";
import { AgentPayRequirements, agentPay as agentPayRoute, getPublicCheckoutSession } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Payer, payer } from "../support/payer.js";
import {
  type Merchant,
  type Session,
  type Stack,
  startStack,
  TEST_TREASURY,
  USDC_NEAR,
  uuid,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack();
});
afterAll(async () => {
  await s?.stop();
});

const publicCalls = () => s.payments.callsTo(getPublicCheckoutSession).length;

const funded = (p: Payer, amount = 10_000_000n) => {
  s.testVerifier.fund(p.account, USDC_NEAR, amount);
  return p;
};

type Requirement = {
  pay_to: string;
  token: string;
  amount: string;
  fee_to: string;
  fee_amount: string;
  binding: string;
  deadline: string;
};
const terms = (r: Requirement) => ({
  payTo: r.pay_to,
  asset: r.token,
  amount: r.amount,
  feeTo: r.fee_to,
  fee: r.fee_amount,
  binding: r.binding,
});

async function requirements(cs: Session, p: Payer) {
  const r = await s.call("POST", `/v1/checkout/sessions/${cs.id}/agent_pay/requirements`, {
    secret: cs.secret,
    body: { payer: p.account },
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return AgentPayRequirements.parse(r.body);
}

describe("agent_pay", () => {
  let m: Merchant;
  beforeAll(() => {
    m = s.merchant();
  });

  it("hands out payments' attempt and relays the agent's signed transfer", async () => {
    const cs = s.session(m);
    const p = funded(payer());
    const req = await requirements(cs, p);
    expect(req).toMatchObject({
      object: "agent_pay_requirements",
      livemode: false,
      requirement: { pay_to: m.payTo, fee_to: TEST_TREASURY },
    });
    expect(s.payments.callsTo({ id: "createAgentAttempt" } as never).length).toBeGreaterThan(0);
    const probe = await s.probe();
    const r = await s.call("POST", `/v1/checkout/sessions/${cs.id}/agent_pay`, {
      secret: cs.secret,
      body: { signed: p.sign(terms(req.requirement)) },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const sub = agentPayRoute.response?.parse(r.body);
    expect(sub).toMatchObject({
      object: "agent_pay_submission",
      status: "submitted",
      attempt: { id: req.attempt_id, method: "intents_transfer" },
    });

    const until = Date.now() + 10_000;
    let row = await s.admin.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("id", "=", uuid(r.body.agent_payment, "ap"))
      .executeTakeFirstOrThrow();
    while (row.status !== "settled" && Date.now() < until) {
      await new Promise((x) => setTimeout(x, 100));
      row = await s.admin.db
        .selectFrom("agent_payments")
        .selectAll()
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
    }
    expect(row).toMatchObject({
      kind: "checkout",
      status: "settled",
      checkout_session_id: uuid(cs.id, "cs"),
      pay_to: m.payTo,
    });
    expect(row.execution_id).toMatch(/^ex_/);
    expect(s.testVerifier.balance(m.payTo, USDC_NEAR)).toBe(2_000_000n);
    // checkout payments are settled by rails' indexer, not by agentpay events
    await new Promise((x) => setTimeout(x, 300));
    expect(probe.received.filter((e) => (e.data.object as { id?: string }).id === r.body.agent_payment)).toEqual([]);
    await probe.close();
    // the merchant sees it as a checkout agent payment
    const got = await s.call("GET", `/v1/agent_payments/${r.body.agent_payment}`, { token: await s.token(m) });
    expect(got.body).toMatchObject({ kind: "checkout", checkout_session: cs.id, resource_url: null });
  });

  it("checks the client secret and the session through payments", async () => {
    const cs = s.session(m);
    const p = payer();
    const wrong = `${cs.id}_secret_${"Z".repeat(32)}`;
    const r1 = await s.call("POST", `/v1/checkout/sessions/${cs.id}/agent_pay/requirements`, {
      secret: wrong,
      body: { payer: p.account },
    });
    expect([r1.status, r1.body.error.code]).toEqual([401, "client_secret_invalid"]);
    const r2 = await s.call("POST", `/v1/checkout/sessions/${cs.id}/agent_pay/requirements`, {
      body: { payer: p.account },
    });
    expect(r2.status).toBe(400); // the header is required by the contract
    const closed = s.session(m, { status: "complete" });
    const r3 = await s.call("POST", `/v1/checkout/sessions/${closed.id}/agent_pay/requirements`, {
      secret: closed.secret,
      body: { payer: p.account },
    });
    expect([r3.status, r3.body.error.code]).toEqual([409, "session_not_open"]);
    const chain = s.session(s.merchant({ payTo: "acme.chain" }));
    const r4 = await s.call("POST", `/v1/checkout/sessions/${chain.id}/agent_pay/requirements`, {
      secret: chain.secret,
      body: { payer: p.account },
    });
    expect(r4.body.error.code).toBe("destination_not_intents_account");
  });

  it("reads the payer session through payments' internal route only", async () => {
    const cs = s.session(m);
    const p = payer();
    const before = { internal: s.payments.callsTo(getPayerCheckoutSession).length, pub: publicCalls() };
    await requirements(cs, p);
    const internal = s.payments.callsTo(getPayerCheckoutSession).slice(before.internal);
    expect(internal.length).toBe(1);
    // service token (payments.read) plus the payer's forwarded client secret (CR-15-15)
    expect(internal[0]?.headers["x-nearpay-client-secret"]).toBe(cs.secret);
    expect(internal[0]?.principal).toMatchObject({ ptype: "service", sub: "agentpay" });
    expect(publicCalls()).toBe(before.pub);
  });

  it("a 404 from the internal payer route is an error, never a fallback to the unscoped public route (audit finding 11)", async () => {
    const p = funded(payer());
    const cs = s.session(m);
    const req = await requirements(cs, p);
    const before = publicCalls();
    // payments answers 404 resource_missing (e.g. an older payments without getPayerCheckoutSession)
    s.payerRoute = false;
    try {
      const cs2 = s.session(m);
      const r = await s.call("POST", `/v1/checkout/sessions/${cs2.id}/agent_pay/requirements`, {
        secret: cs2.secret,
        body: { payer: p.account },
      });
      expect([r.status, r.body.error.code]).toEqual([503, "rail_unavailable"]);
      const pay = await s.call("POST", `/v1/checkout/sessions/${cs.id}/agent_pay`, {
        secret: cs.secret,
        body: { signed: p.sign(terms(req.requirement)) },
      });
      expect([pay.status, pay.body.error.code]).toEqual([503, "rail_unavailable"]);
      // the public route (no account/mode scope) is never consulted
      expect(publicCalls()).toBe(before);
    } finally {
      s.payerRoute = true;
    }
  });

  it("refuses payloads that do not match a requirement handed out for this session", async () => {
    const cs = s.session(m);
    const other = s.session(m);
    const p = funded(payer());
    const req = await requirements(cs, p);
    const post = (session: Session, signed: unknown) =>
      s.call("POST", `/v1/checkout/sessions/${session.id}/agent_pay`, { secret: session.secret, body: { signed } });
    const r1 = await post(other, p.sign(terms(req.requirement)));
    expect([r1.status, r1.body.error.code]).toEqual([400, "intent_invalid"]);
    const r2 = await post(cs, p.sign({ ...terms(req.requirement), amount: "1" }));
    expect(r2.body.error.code).toBe("intent_invalid");
    const r3 = await post(cs, payer().sign(terms(req.requirement)));
    expect([r3.status, r3.body.error.code]).toEqual([402, "insufficient_balance"]);
    const r4 = await post(cs, p.sign({ ...terms(req.requirement), binding: `np1:${"1".repeat(44)}` }));
    expect(r4.body.error.code).toBe("intent_invalid");
  });
});

describe("POST /internal/relay", () => {
  async function attempt(livemode = false) {
    const m = s.merchant();
    const cs = s.session(m, { livemode });
    const p = livemode ? payer() : funded(payer());
    if (livemode) s.rpc.verifier.fund(p.account, USDC_NEAR, 10_000_000n);
    const req = await requirements(cs, p);
    const ex = [...s.executions.values()].find((x) => x.intents_requirement?.binding === req.requirement.binding);
    if (!ex) throw new Error("no execution");
    return { m, cs, p, req, ex };
  }
  const relay = async (body: unknown, service: "payments" | "rails" = "payments") =>
    s.call("POST", "/internal/relay", { token: await mintServiceToken(service), body });

  it("queues payments' payer-signed payload once (idempotent on the payload hash)", async () => {
    const { p, req, ex } = await attempt();
    const signed = p.sign(terms(req.requirement), { standard: "nep413" });
    const body = { execution_id: ex.id, binding: req.requirement.binding, signed };
    const r1 = await relay(body);
    expect(r1.status, JSON.stringify(r1.body)).toBe(202);
    expect(r1.body.agent_payment_id).toMatch(/^ap_/);
    const r2 = await relay(body);
    expect(r2.body).toEqual(r1.body);
    // a second, different payload for the same requirement is refused while the first is live
    const r3 = await relay({ ...body, signed: p.sign(terms(req.requirement)) });
    expect([r3.status, r3.body.error.code]).toEqual([400, "intent_invalid"]);
    expect(r3.body.error.message).toMatch(/already/);
  });

  it("validates against the rails execution", async () => {
    const { p, req, ex } = await attempt();
    const signed = p.sign(terms(req.requirement));
    const code = async (body: unknown) => (await relay(body)).body.error?.code;
    expect(await code({ execution_id: ex.id, binding: `np1:${"2".repeat(44)}`, signed })).toBe("intent_invalid");
    expect(await code({ execution_id: `ex_${"0".repeat(26)}`, binding: req.requirement.binding, signed })).toBe(
      "intent_invalid",
    );
    s.executions.set(ex.id, { ...ex, state: "failed" });
    expect(await code({ execution_id: ex.id, binding: req.requirement.binding, signed })).toBe("intent_invalid");
    s.executions.set(ex.id, ex);
    expect(
      await code({
        execution_id: ex.id,
        binding: req.requirement.binding,
        signed: p.sign({ ...terms(req.requirement), payTo: "thief.near" }),
      }),
    ).toBe("intent_invalid");
    expect((await relay({ execution_id: ex.id, binding: req.requirement.binding, signed }, "rails")).status).toBe(403);
    expect(
      (
        await s.call("POST", "/internal/relay", {
          body: { execution_id: ex.id, binding: req.requirement.binding, signed },
        })
      ).status,
    ).toBe(401);
  });

  it("relays live checkout payloads over NEAR RPC (and refuses them under the kill switch)", async () => {
    const { p, req, ex } = await attempt(true);
    const r = await relay({
      execution_id: ex.id,
      binding: req.requirement.binding,
      signed: p.sign(terms(req.requirement)),
    });
    expect(r.status).toBe(202);
    const until = Date.now() + 10_000;
    for (;;) {
      const row = await s.admin.db
        .selectFrom("agent_payments")
        .select(["status", "tx_hash"])
        .where("id", "=", uuid(r.body.agent_payment_id, "ap"))
        .executeTakeFirstOrThrow();
      if (row.status === "settled") {
        expect(s.rpc.sent.some((x) => x.hash === row.tx_hash)).toBe(true);
        break;
      }
      if (Date.now() > until) throw new Error(`not settled: ${row.status}`);
      await new Promise((x) => setTimeout(x, 100));
    }
    await s.admin.db
      .insertInto("kill_switch")
      .values({ id: 1, engaged: true, reason: "drill", actor: "test", event_version: 999 })
      .onConflict((oc) => oc.column("id").doUpdateSet({ engaged: true, event_version: 999 }))
      .execute();
    s.ap.caches.killSwitch.clear();
    try {
      const next = await attempt(true);
      const blocked = await relay({
        execution_id: next.ex.id,
        binding: next.req.requirement.binding,
        signed: next.p.sign(terms(next.req.requirement)),
      });
      expect([blocked.status, blocked.body.error.code]).toEqual([503, "rail_unavailable"]);
    } finally {
      await s.admin.db.updateTable("kill_switch").set({ engaged: false }).execute();
      s.ap.caches.killSwitch.clear();
    }
  });

  it("records who relayed (payments vs agent) in the transitions", async () => {
    const { p, req, ex } = await attempt();
    const r = await relay({
      execution_id: ex.id,
      binding: req.requirement.binding,
      signed: p.sign(terms(req.requirement)),
    });
    const t = await s.admin.db
      .selectFrom("agent_payment_transitions")
      .selectAll()
      .where("agent_payment_id", "=", uuid(r.body.agent_payment_id, "ap"))
      .orderBy("created_at")
      .executeTakeFirstOrThrow();
    expect(t).toMatchObject({ from_state: null, to_state: "queued", actor: "payments", cause: "checkout relay" });
    expect(fromUuid("ap", t.agent_payment_id)).toBe(r.body.agent_payment_id);
  });
});
