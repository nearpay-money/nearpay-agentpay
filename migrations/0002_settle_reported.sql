-- Spec 0.1.5 `SettleResponse.replayed` (CR-15-12, lld/agentpay.md §7). Settle is idempotent on the payload
-- hash, so one x402 payment's final outcome can be returned to several /x402/settle calls (merchant
-- replicas, retries). The first response that carries the final outcome sets this column with a
-- conditional update (`where result_reported_at is null`); every later response repeats that result with
-- `replayed: true`, so the merchant delivers the resource at most once per settlement. Not part of the
-- AgentPayment object: setting it does not bump `version`.
alter table agent_payments add column result_reported_at timestamptz;
