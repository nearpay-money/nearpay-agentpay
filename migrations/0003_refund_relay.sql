-- Stage 2 (spec 0.2.0, lld/agentpay.md §5): Intents-account refund legs relayed through `/internal/relay`
-- `kind: refund` are recorded as agent payments of kind `refund`. A refund leg is one merchant-signed
-- transfer and carries no NearPay fee, so it has no fee recipient: `fee_to` becomes nullable (x402 and
-- checkout rows keep setting it). `refund_id` is payments' refund (`re_…`) the leg belongs to.
-- Additive and forward-only: older code never reads `refund_id` and never writes a null `fee_to`.
alter table agent_payments alter column fee_to drop not null;
alter table agent_payments add column refund_id uuid;
create index ap_refund on agent_payments (refund_id) where refund_id is not null;
