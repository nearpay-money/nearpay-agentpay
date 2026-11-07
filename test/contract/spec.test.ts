/**
 * Contract (foundations §16): every agentpay route up to Stage 2 is bound (and nothing else); every subject
 * the catalogue routes to agentpay is handled; every subject agentpay produces is emitted; the objects
 * agentpay serves and emits parse with the spec schemas; the x402 shapes round-trip the header codec.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AgentPayment,
  decodeX402Header,
  ERRORS,
  encodeX402Header,
  PaymentRequired,
  PUBLIC_ROUTES,
  SERVICE_CLIENT_SCOPES,
  SettleResponse,
  SupportedResponse,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  getPayerCheckoutSession,
  INTERNAL_ROUTES,
  relaySignedIntent,
  SUBJECTS,
  type Subject,
} from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { agentpayRoutes } from "../../src/api/routes.js";
import { paymentRequirements } from "../../src/app/requirements.js";
import { agentPaymentView } from "../../src/app/views.js";
import { settleView, supported } from "../../src/app/x402.js";
import { agentpayHandlers } from "../../src/consumers/handlers.js";
import { agentPaymentRow } from "../support/rows.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

/** A well-formed raw-ed25519 MultiPayload (shape only). */
const SIGNED = {
  standard: "raw_ed25519",
  payload: "{}",
  public_key: "ed25519:4zvwRjXUKGfvwnParsHAS3HuSVzV5cA4McphgmoCtajS",
  signature: `ed25519:${"1".repeat(64)}`,
};

describe("routes and events", () => {
  it("binds every agentpay route up to Stage 2, and nothing else", () => {
    const bindings = agentpayRoutes({} as never);
    expect(unimplementedRoutes("agentpay", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "agentpay" && r.stage <= 2)
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
