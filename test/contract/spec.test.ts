/**
 * Contract (foundations §16): every agentpay route up to Stage 3 is bound (and nothing else); every subject
 * the catalogue routes to agentpay is handled; every subject agentpay produces is emitted; the objects
 * agentpay serves and emits parse with the spec schemas; the x402 shapes round-trip the header codec.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  createExecution,
  getPayerCheckoutSession,
  INTERNAL_ROUTES,
  relaySignedIntent,
  SUBJECTS,
  type Subject,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import {
  AgentPayment,
  decodeX402Header,
  ERRORS,
  encodeX402Header,
  NearIntentsPaymentPayload,
  NearIntentsSettleResponse,
  NearIntentsVerifyResponse,
  PaymentRequired,
  PUBLIC_ROUTES,
  SERVICE_CLIENT_SCOPES,
  SettleResponse,
  SupportedResponse,
  X402PaymentRequiredAny,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
} from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { agentpayRoutes } from "../../src/api/routes.js";
import { paymentRequirements } from "../../src/app/requirements.js";
import { agentPaymentView } from "../../src/app/views.js";
import { settleView, supported } from "../../src/app/x402.js";
import { agentpayHandlers } from "../../src/consumers/handlers.js";
import { agentPaymentRow } from "../support/rows.js";
import { NEAR_INTENTS_VECTORS } from "../support/vectors.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

/** A well-formed raw-ed25519 MultiPayload (shape only). */
const SIGNED = {
  standard: "raw_ed25519",
  payload: "{}",
  public_key: "ed25519:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS",
  signature: `ed25519:${"1".repeat(64)}`,
};

describe("routes and events", () => {
  it("binds every agentpay route up to Stage 3, and nothing else", () => {
    const bindings = agentpayRoutes({} as never);
    expect(unimplementedRoutes("agentpay", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "agentpay" && r.stage <= 3)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("relaySignedIntent (spec 0.2.0) takes kind refund with a refund id, and payments' payer route answers with account and mode", () => {
    const body = relaySignedIntent.body as unknown as { safeParse(v: unknown): { success: boolean } };
    const base = { execution_id: `ex_${"0".repeat(26)}`, binding: `np1:${"1".repeat(44)}`, signed: SIGNED };
    expect(body.safeParse({ ...base, kind: "refund", refund: `re_${"0".repeat(26)}` }).success).toBe(true);
    expect(body.safeParse({ ...base, kind: "checkout" }).success).toBe(true);
    expect(body.safeParse(base).success).toBe(true);
    expect(body.safeParse({ ...base, kind: "payout" }).success).toBe(false);
    expect(relaySignedIntent.errors).toEqual(expect.arrayContaining(["intent_invalid", "rail_unavailable"]));
    expect(getPayerCheckoutSession.auth).toEqual(["service:payments.read"]);
    expect(SERVICE_CLIENT_SCOPES.agentpay).toContain("payments.read");
    expect(ERRORS.signed_intent_mismatch.status).toBe(422);
  });

  it("handles every subject the catalogue routes to agentpay", () => {
    const handlers = agentpayHandlers({} as never);
    expect(unhandledSubjects("agentpay", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[]) expect(SUBJECTS[subject].consumers).toContain("agentpay");
  });

  it("emits every subject agentpay produces", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "agentpay" && SUBJECTS[k].stage <= 1,
    );
    expect(produced.sort()).toEqual(["evt.agentpay.agent_payment.failed", "evt.agentpay.agent_payment.settled"]);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

const row = agentPaymentRow;

describe("objects", () => {
  it("agent payments (API and events) parse in every state and kind", () => {
    for (const r of [
      row(),
      row({ status: "queued", tx_hash: null, block_height: null, settled_at: null, batch_id: null }),
      row({ status: "failed", error_reason: "insufficient_funds", settled_at: null }),
      row({
        kind: "checkout",
        checkout_session_id: uuidv7(),
        resource_url: null,
        execution_id: `ex_${"0".repeat(26)}`,
      }),
      // Stage 2: a merchant-signed refund leg (no fee recipient, no fee)
      row({
        kind: "refund",
        payer: "merchant.near",
        pay_to: "payer.near",
        fee_to: null,
        fee_amount: "0",
        resource_url: null,
        execution_id: `ex_${"0".repeat(26)}`,
        refund_id: uuidv7(),
      }),
    ]) {
      const v = agentPaymentView(r);
      // 0.1.5: `sequence` is optional in the schema for 0.1.4 readers, but servers MUST send it
      expect(AgentPayment.parse(v).sequence).toBe(r.version);
      for (const s of ["evt.agentpay.agent_payment.settled", "evt.agentpay.agent_payment.failed"] as const)
        expect(SUBJECTS[s].object.parse(v)).toHaveProperty("sequence", r.version);
    }
  });

  it("settle responses parse for every outcome and travel in PAYMENT-RESPONSE", () => {
    for (const r of [
      row(),
      row({ status: "failed", error_reason: "nonce_used" }),
      row({ status: "failed", error_reason: "something new" }),
      row({ status: "submitted", settled_at: null }),
      row({ status: "queued", tx_hash: null }),
    ]) {
      const v = SettleResponse.parse(settleView(r));
      expect(decodeX402Header(encodeX402Header(v))).toEqual(v);
      expect(v.replayed).toBeUndefined();
      // 0.1.5: a repeated final outcome says so; a pending answer is never a replay
      const again = SettleResponse.parse(settleView(r, true));
      expect(decodeX402Header(encodeX402Header(again))).toEqual(again);
      expect(again.replayed).toBe(r.status === "settled" || r.status === "failed" ? true : undefined);
    }
    expect(SettleResponse.parse(settleView(row({ status: "failed", error_reason: "something new" }))).errorReason).toBe(
      "unexpected_settle_error",
    );
  });

  it("issued requirements parse with the 0.1.5 extra.deadline and travel in PAYMENT-REQUIRED", () => {
    const accepts = paymentRequirements({
      amount: "10000",
      assetId: USDC_NEAR,
      payTo: "merchant.near",
      maxTimeoutS: 120,
      feeTo: "treasury.nearpay.near",
      fee: "30",
      binding: "np1:3yZe7d5Bcv1ZTkNe5U5w4mbR1XK8Wb1pXtZqYfVvR8c1",
      expiresAt: 1_794_000_000,
    });
    const body = PaymentRequired.parse({
      x402Version: 2,
      resource: { url: "https://merchant.example/premium" },
      accepts: [accepts],
    });
    expect(body.accepts[0]?.extra.deadline).toBe("2026-11-06T21:20:00.000Z");
    expect(decodeX402Header(encodeX402Header(body))).toEqual(body);
  });

  it("supported parses with and without a relayer account", () => {
    for (const relayerAccount of ["relayer.nearpay.near", null])
      expect(SupportedResponse.safeParse(supported({ settings: { relayerAccount } } as never)).success).toBe(true);
    expect(PaymentRequired.shape.x402Version.value).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------- Stage 3

describe("near-intents (spec 0.3.0)", () => {
  it("agentpay holds rails.executions.write and consumes its rails execution subjects", () => {
    expect(SERVICE_CLIENT_SCOPES.agentpay).toContain("rails.executions.write");
    expect(createExecution.auth).toEqual(["service:rails.executions.write"]);
    expect(submitExecutionDepositTx.auth).toEqual(["service:rails.executions.write"]);
    const handlers = agentpayHandlers({} as never);
    for (const s of [
      "evt.rails.execution.settled",
      "evt.rails.execution.refunded",
      "evt.rails.execution.failed",
    ] as const)
      expect(handlers[s]).toBeTypeOf("function");
    expect(handlers["evt.rails.execution.held"]).toBeUndefined();
    expect(handlers["evt.rails.execution.updated"]).toBeUndefined();
  });

  it("near-intents agent payments parse (API and events) with transfer_method and origin; older rows say intents-transfer", () => {
    const origin = {
      network: "eip155:8453",
      asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount_in: "1012000",
      refund_to: "0x2527D02599Ba641c19Fea793Cd0f9A6e8457c317",
      deposit_address: "0x76b4c56085ED136a8744D52bE956396624a730E8",
      deposit_memo: null,
      tx_hashes: ["0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a"],
      fee: { amount: "5000", asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near" },
    };
    const r = row({
      transfer_method: "near-intents",
      origin,
      payer: "solver.near",
      fee_to: null,
      fee_amount: "0",
      payload_hash: null,
      payload: null,
      standard: null,
      nonces: null,
      deadline: null,
      batch_id: null,
      execution_id: `ex_${"0".repeat(26)}`,
      version: 1,
    });
    const v = AgentPayment.parse(agentPaymentView(r));
    expect(v.transfer_method).toBe("near-intents");
    expect(v.origin).toEqual(origin);
    expect(v.fee_amount).toBe("0");
    expect(SUBJECTS["evt.agentpay.agent_payment.settled"].object.parse(agentPaymentView(r))).toHaveProperty("origin");
    const old = AgentPayment.parse(agentPaymentView(row()));
    expect(old.transfer_method).toBe("intents-transfer");
    expect(old.origin).toBeNull();
  });

  it("every near-intents header of the spec vectors parses and travels in its header", () => {
    const h = NEAR_INTENTS_VECTORS.headers;
    for (const k of ["payment_required_unquoted", "payment_required_quoted"]) {
      const v = X402PaymentRequiredAny.parse(h[k]);
      expect(decodeX402Header(encodeX402Header(v))).toEqual(v);
    }
    for (const k of ["payment_signature_quote", "payment_signature_deposit"]) NearIntentsPaymentPayload.parse(h[k]);
    NearIntentsVerifyResponse.parse(h.verify_response_quote);
    for (const k of ["payment_response_settled", "payment_response_pending", "payment_response_failed"])
      NearIntentsSettleResponse.parse(h[k]);
    const routes = [x402NearIntentsRequirements, x402NearIntentsVerify, x402NearIntentsSettle];
    expect(routes.map((r) => r.path)).toEqual([
      "/x402/near-intents/requirements",
      "/x402/near-intents/verify",
      "/x402/near-intents/settle",
    ]);
    for (const r of routes) expect(r.idempotent).toBe(false);
  });
});
