/** An agent payment row as the database returns it (a settled x402 payment by default). */
import { uuidv7 } from "@nearpay-internal/ids";
import { USDC_NEAR } from "@nearpay-internal/testing";
import type { AgentPaymentRow } from "../../src/app/views.js";

const now = new Date();
export const agentPaymentRow = (o: Partial<AgentPaymentRow> = {}): AgentPaymentRow => ({
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
  refund_id: null,
  created_at: now,
  updated_at: now,
  settled_at: now,
  result_reported_at: null,
  version: 3,
  transfer_method: "intents-transfer",
  origin: null,
  ...o,
});
