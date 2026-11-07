/**
 * Refund legs from an Intents account (Stage 2, lld/agentpay.md §5 `kind: refund`, §8; payments §17):
 * `POST /internal/relay` with `kind: refund` relays exactly the payload payments issued for the leg and
 * nothing else (`signed_intent_mismatch`), checked against rails' execution and payments' refund;
 * idempotent on the payload hash; live refund relays stop under the kill switch (test mode does not);
 * the relayed leg is listed to the merchant as a `refund` agent payment (dashboard).
 */

import type { IntentMessage } from "@nearpay/spec";
import { makeNonce } from "@nearpay-internal/intents";
import { getInternalRefund } from "@nearpay-internal/spec";
import { mintServiceToken, mockError } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Signer, signer } from "../support/refund.js";
import { type Merchant, type RefundLeg, type Stack, startStack, USDC_NEAR, uuid } from "../support/stack.js";

let s: Stack;
let m: Merchant;
beforeAll(async () => {
  s = await startStack();
  m = s.merchant();
});
afterAll(async () => {
  await s?.stop();
});

const relay = async (body: unknown, service: "payments" | "rails" = "payments") =>
  s.call("POST", "/internal/relay", { token: await mintServiceToken(service), body });

const bodyOf = (l: RefundLeg, signed: unknown, extra: Record<string, unknown> = {}) => ({
  execution_id: l.execution.id,
  binding: l.transfer.memo,
  signed,
  kind: "refund",
  refund: l.refund,
  ...extra,
});

/** A merchant signer with funds in the Verifier of `livemode`. */
function funded(st: Parameters<typeof signer>[0] = "raw_ed25519", livemode = false): Signer {
  const k = signer(st);
  (livemode ? s.rpc.verifier : s.testVerifier).fund(k.account, USDC_NEAR, 10_000_000n);
  return k;
}

async function settled(id: string) {
  const until = Date.now() + 10_000;
  for (;;) {
    const row = await s.admin.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("id", "=", uuid(id, "ap"))
      .executeTakeFirstOrThrow();
    if (row.status === "settled") return row;
    if (Date.now() > until) throw new Error(`not settled: ${row.status} ${row.error_reason}`);
    await new Promise((x) => setTimeout(x, 100));
  }
}

async function withKillSwitch<T>(fn: () => Promise<T>): Promise<T> {
  await s.admin.db
    .insertInto("kill_switch")
    .values({ id: 1, engaged: true, reason: "drill", actor: "test", event_version: 999 })
    .onConflict((oc) => oc.column("id").doUpdateSet({ engaged: true, event_version: 999 }))
    .execute();
  s.ap.caches.killSwitch.clear();
  try {
    return await fn();
  } finally {
    await s.admin.db.updateTable("kill_switch").set({ engaged: false }).execute();
    s.ap.caches.killSwitch.clear();
  }
}

describe("POST /internal/relay kind: refund", () => {
  it.each(["raw_ed25519", "nep413", "erc191"] as const)(
    "relays the issued %s payload, records a refund agent payment and emits nothing",
    async (st) => {
      const k = funded(st);
      const l = s.refundLeg(m, k);
      const probe = await s.probe();
      const r = await relay(bodyOf(l, k.sign(l.message)));
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      const row = await settled(r.body.agent_payment_id);
      expect(row).toMatchObject({
        kind: "refund",
        account_id: uuid(m.account, "acct"),
        livemode: false,
        payer: k.account,
        pay_to: l.transfer.receiver_id,
        fee_to: null,
        fee_amount: "0",
        amount: l.transfer.amount,
        asset_id: USDC_NEAR,
        binding: l.transfer.memo,
        execution_id: l.execution.id,
        refund_id: uuid(l.refund, "re"),
        standard: st,
        checkout_session_id: null,
      });
      expect(s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR)).toBe(BigInt(l.transfer.amount));
      // rails' indexer verifies the payer-side evidence (INV-2): agentpay emits nothing for refund legs
      await new Promise((x) => setTimeout(x, 300));
      expect(probe.received.filter((e) => (e.data.object as { id?: string }).id === r.body.agent_payment_id)).toEqual(
        [],
      );
      await probe.close();
      const t = await s.admin.db
        .selectFrom("agent_payment_transitions")
        .selectAll()
        .where("agent_payment_id", "=", row.id)
        .orderBy("created_at")
        .executeTakeFirstOrThrow();
      expect(t).toMatchObject({ from_state: null, to_state: "queued", actor: "payments", cause: "refund relay" });
    },
  );

  it("is idempotent on the payload hash: replays and concurrent submissions give one agent payment", async () => {
    const k = funded();
    const l = s.refundLeg(m, k);
    const body = bodyOf(l, k.sign(l.message));
    const all = await Promise.all(Array.from({ length: 6 }, () => relay(body)));
    for (const r of all) expect(r.status, JSON.stringify(r.body)).toBe(202);
    const ids = new Set(all.map((r) => r.body.agent_payment_id));
    expect(ids.size).toBe(1);
    const id = [...ids][0] as string;
    await settled(id);
    // after settlement a replay still answers the same agent payment, and never relays twice
    const again = await relay(body);
    expect(again.body.agent_payment_id).toBe(id);
    const rows = await s.admin.db
      .selectFrom("agent_payments")
      .select(["id", "status"])
      .where("refund_id", "=", uuid(l.refund, "re"))
      .execute();
    expect(rows).toEqual([{ id: uuid(id, "ap"), status: "settled" }]);
    expect(s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR)).toBe(BigInt(l.transfer.amount));
    // the same payload for another execution is refused
    const other = s.refundLeg(m, k);
    const r = await relay({ ...body, execution_id: other.execution.id });
    expect([r.status, r.body.error.code]).toEqual([400, "intent_invalid"]);
  });

  it("refuses anything but the issued payload with signed_intent_mismatch", async () => {
    const k = funded();
    const l = s.refundLeg(m, k);
    const mutate = (f: (x: IntentMessage) => void) => {
      const x = structuredClone(l.message);
      f(x);
      return k.sign(x);
    };
    const t0 = (x: IntentMessage) => x.intents[0] as Record<string, unknown>;
    const cases: Record<string, unknown> = {
      receiver: mutate((x) => {
        t0(x).receiver_id = "thief.near";
      }),
      amount: mutate((x) => {
        t0(x).tokens = { [USDC_NEAR]: (BigInt(l.transfer.amount) + 1n).toString() };
      }),
      token: mutate((x) => {
        t0(x).tokens = { "nep141:wrap.near": l.transfer.amount };
      }),
      deadline: mutate((x) => {
        x.deadline = new Date(Date.parse(x.deadline) - 1_000).toISOString();
      }),
      nonce: mutate((x) => {
        x.nonce = makeNonce("5a0dbe11");
      }),
      "another signer": (() => {
        const o = funded();
        return o.sign({ ...l.message, signer_id: o.account });
      })(),
      "another standard": signer("nep413").sign(l.message),
    };
    for (const [name, signed] of Object.entries(cases)) {
      const r = await relay(bodyOf(l, signed));
      expect([r.status, r.body.error?.code], name).toEqual([422, "signed_intent_mismatch"]);
    }
    expect(
      await s.admin.db.selectFrom("agent_payments").select("id").where("binding", "=", l.transfer.memo).execute(),
    ).toEqual([]);
    // the issued payload itself still goes through
    expect((await relay(bodyOf(l, k.sign(l.message)))).status).toBe(202);
  });

  it("validates the leg against rails' execution and payments' refund", async () => {
    const k = funded();
    const l = s.refundLeg(m, k);
    const signed = k.sign(l.message);
    const err = async (body: unknown) => {
      const r = await relay(body);
      return [r.status, r.body.error?.code];
    };
    const invalid = [400, "intent_invalid"];
    expect(await err(bodyOf(l, signed, { binding: `np1:${"2".repeat(44)}` }))).toEqual(invalid);
    expect(await err(bodyOf(l, signed, { execution_id: `ex_${"0".repeat(26)}` }))).toEqual(invalid);
    expect(await err(bodyOf(l, signed, { refund: `re_${"0".repeat(26)}` }))).toEqual(invalid);
    // a refund leg is not a checkout attempt, and the other way round
    expect(await err(bodyOf(l, signed, { kind: "checkout", refund: undefined }))).toEqual(invalid);
    expect(await err(bodyOf(l, signed, { kind: undefined, refund: undefined }))).toEqual(invalid);
    expect((await relay(bodyOf(l, signed, { kind: undefined }))).status).toBe(400);
    const ex = l.execution;
    l.execution = { ...ex, kind: "payment" };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    l.execution = { ...ex, refund: { ...(ex.refund as NonNullable<typeof ex.refund>), transfer: null } };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    l.execution = { ...ex, state: "succeeded" };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    l.execution = { ...ex, reference: null };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    // without `refund` in the body, the execution's reference names it
    l.execution = ex;
    const obj = l.object;
    l.object = { ...obj, status: "pending", next_action: null };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    l.object = { ...obj, livemode: true };
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    // payments issued something rails did not prepare: refused, and not as the merchant's mistake
    l.object = {
      ...obj,
      next_action: { ...l.nextAction, transfer: { ...l.nextAction.transfer, amount: "1" } },
    };
    const r = await relay(bodyOf(l, signed));
    expect([r.status, r.body.error.code]).toEqual(invalid);
    expect(r.body.error.message).toMatch(/does not match its execution/);
    l.object = obj;
    s.refunds.delete(l.refund);
    expect(await err(bodyOf(l, signed))).toEqual(invalid);
    s.refunds.set(l.refund, obj);
    // payments unreachable for the refund read: fail closed, payments retries
    s.payments.on(getInternalRefund, async () => mockError("api_error"));
    try {
      expect(await err(bodyOf(l, signed))).toEqual([503, "rail_unavailable"]);
    } finally {
      s.payments.on(getInternalRefund, async (ctx) => {
        const x = s.refunds.get(ctx.params.id);
        if (!x) mockError("resource_missing", { params: { object: "refund", id: ctx.params.id } });
        return x as never;
      });
    }
    // only payments may relay
    expect((await relay(bodyOf(l, signed), "rails")).status).toBe(403);
    expect((await relay(bodyOf(l, signed, { refund: undefined }))).status).toBe(202);
  });

  it("refuses a short balance, a bad signature and an expired leg", async () => {
    const poor = signer();
    const l1 = s.refundLeg(m, poor);
    const r1 = await relay(bodyOf(l1, poor.sign(l1.message)));
    expect([r1.status, r1.body.error.code]).toEqual([402, "insufficient_balance"]);

    const k = funded();
    const l2 = s.refundLeg(m, k);
    const signed = k.sign(l2.message) as { signature: string };
    const forged = { ...signed, signature: signer().sign(l2.message).signature };
    const r2 = await relay(bodyOf(l2, forged));
    expect([r2.status, r2.body.error.code]).toEqual([400, "intent_invalid"]);

    const l3 = s.refundLeg(m, k, { deadline: new Date(Date.now() + 2_000).toISOString() });
    const r3 = await relay(bodyOf(l3, k.sign(l3.message)));
    expect([r3.status, r3.body.error.code]).toEqual([400, "intent_invalid"]);
  });

  it("relays live legs over NEAR RPC; the kill switch stops new live refund relays, not test mode or replays", async () => {
    const k = funded("raw_ed25519", true);
    const l = s.refundLeg(m, k, { livemode: true });
    const body = bodyOf(l, k.sign(l.message));
    const r = await relay(body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const row = await settled(r.body.agent_payment_id);
    expect(row.livemode).toBe(true);
    expect(s.rpc.sent.some((x) => x.hash === row.tx_hash)).toBe(true);
    // live payloads never reach the sandbox Verifier (INV-8)
    expect(s.testVerifier.balance(l.transfer.receiver_id, USDC_NEAR)).toBe(0n);

    await withKillSwitch(async () => {
      const next = s.refundLeg(m, k, { livemode: true });
      const blocked = await relay(bodyOf(next, k.sign(next.message)));
      expect([blocked.status, blocked.body.error.code]).toEqual([503, "rail_unavailable"]);
      // an already relayed payload answers as before (nothing new is relayed)
      expect((await relay(body)).body.agent_payment_id).toBe(r.body.agent_payment_id);
      // test mode is unaffected
      const t = funded();
      const tl = s.refundLeg(m, t);
      expect((await relay(bodyOf(tl, t.sign(tl.message)))).status).toBe(202);
    });
  });

  it("lists relayed legs to the merchant as refund agent payments (dashboard session and secret key)", async () => {
    const mm = s.merchant();
    const k = funded();
    const l = s.refundLeg(mm, k);
    const r = await relay(bodyOf(l, k.sign(l.message)));
    await settled(r.body.agent_payment_id);
    for (const ptype of ["session", "secret_key"] as const) {
      const token = await s.token(mm, { ptype });
      const list = await s.call("GET", "/v1/agent_payments?kind=refund", { token });
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        id: r.body.agent_payment_id,
        object: "agent_payment",
        kind: "refund",
        status: "settled",
        payer: k.account,
        pay_to: l.transfer.receiver_id,
        amount: l.transfer.amount,
        fee_amount: "0",
        checkout_session: null,
        resource_url: null,
      });
      const got = await s.call("GET", `/v1/agent_payments/${r.body.agent_payment_id}`, { token });
      expect(got.body).toEqual(list.body.data[0]);
    }
    // another merchant and the other mode see nothing (INV-8)
    const stranger = await s.token(s.merchant());
    expect((await s.call("GET", `/v1/agent_payments/${r.body.agent_payment_id}`, { token: stranger })).status).toBe(
      404,
    );
    const live = await s.token(mm, { livemode: true });
    expect((await s.call("GET", "/v1/agent_payments?kind=refund", { token: live })).body.data).toEqual([]);
  });
});
