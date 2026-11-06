/**
 * Contract (foundations §16): every Stage-1 agentpay route is bound (and nothing else); every subject
 * the catalogue routes to agentpay is handled; every subject agentpay produces is emitted; the objects
 * agentpay serves and emits parse with the spec schemas; the x402 shapes round-trip the header codec.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AgentPayment,
  decodeX402Header,
  encodeX402Header,
  PaymentRequired,
  PUBLIC_ROUTES,
  SettleResponse,
  SupportedResponse,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { uuidv7 } from "@nearpay-internal/ids";
import { unimplementedRoutes } from "@nearpay-internal/service";
import { INTERNAL_ROUTES, SUBJECTS, type Subject } from "@nearpay-internal/spec";
import { USDC_NEAR } from "@nearpay-internal/testing";
import { describe, expect, it } from "vitest";
import { agentpayRoutes } from "../../src/api/routes.js";
import { type AgentPaymentRow, agentPaymentView } from "../../src/app/views.js";
import { settleView, supported } from "../../src/app/x402.js";
import { agentpayHandlers } from "../../src/consumers/handlers.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage-1 agentpay route, and nothing else", () => {
    const bindings = agentpayRoutes({} as never);
    expect(unimplementedRoutes("agentpay", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "agentpay" && r.stage <= 1)
        .map((r) => r.id)
        .sort(),
    );
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

const now = new Date();
const row = (o: Partial<AgentPaymentRow> = {}): AgentPaymentRow => ({
  id: uuidv7(),
  account_id: uuidv7(),
  livemode: false,
  kind: "x402",
  binding: "np1:3yZe7d5Bcv1ZTkNe5U5w4mbR1XK8Wb1pXtZqYfVvR8c1",
  payer: "agent.near",
  pay_to: "merchant.near",
  fee_to: "treasury.nearpay.near",
  payload_hash: Buffer.alloc(32),
  payload: {},
  standard: "nep413",
  intent_hashes: ["8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c"],
  nonces: ["JSgSs0khI/8D3+uekOiXOHsqE8dftv1+p+W/bj6OA3Q="],
  deadline: now,
  status: "settled",
  amount: "10000",
  asset_id: USDC_NEAR,
  fee_amount: "30",
  resource_url: "https://merchant.example/premium",
  checkout_session_id: null,
  solo: false,
  batch_id: uuidv7(),
  tx_hash: "8Ld3Ap4zR2yK7uR3nVbXq1sH4cW9tE6mP2fJ5gD1aB7c",
  block_height: 180_000_000n,
  error_reason: null,
  execution_id: null,
  created_at: now,
  updated_at: now,
  settled_at: now,
  version: 3,
  ...o,
});

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
    ]) {
      const v = agentPaymentView(r);
      expect(AgentPayment.safeParse(v).success).toBe(true);
      for (const s of ["evt.agentpay.agent_payment.settled", "evt.agentpay.agent_payment.failed"] as const)
        expect(SUBJECTS[s].object.safeParse(v).success).toBe(true);
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
    }
    expect(SettleResponse.parse(settleView(row({ status: "failed", error_reason: "something new" }))).errorReason).toBe(
      "unexpected_settle_error",
    );
  });

  it("supported parses with and without a relayer account", () => {
    for (const relayerAccount of ["relayer.nearpay.near", null])
      expect(SupportedResponse.safeParse(supported({ settings: { relayerAccount } } as never)).success).toBe(true);
    expect(PaymentRequired.shape.x402Version.value).toBe(2);
  });
});
