-- Stage 3 (spec 0.3.0, lld/agentpay.md §3.1, §4.1): cross-chain x402 `exact` + `near-intents`.
-- Additive and forward-only: Stage 1/2 code never reads the new columns, and every existing row keeps
-- satisfying the widened checks (method defaults to 'intents-transfer', transfer_method likewise).

-- One row per issued unquoted near-intents entry (single use: one quote), next to the intents-transfer rows.
alter table issued_requirements
  add column method text not null default 'intents-transfer'
    check (method in ('intents-transfer', 'near-intents')),
  add column origin_network text,                  -- CAIP-2 of the origin chain (accepted.network)
  add column origin_asset_id text,                 -- NEAR Intents id of the origin asset (extra.originAssetId)
  add column origin_asset text,                    -- the entry's `asset` (origin contract address, or the Intents id)
  add column entry jsonb,                          -- the unquoted accepts[] entry exactly as issued (JCS-compared)
  alter column fee_to drop not null;               -- near-intents: NearPay's fee is inside the 1Click quote
-- the intents-transfer window stays 30–300 s; a near-intents deposit window is 60–86 400 s (PR #3370 maxTimeoutSeconds)
alter table issued_requirements drop constraint issued_requirements_max_timeout_s_check;
alter table issued_requirements add constraint issued_requirements_max_timeout_s_check check (
  (method = 'intents-transfer' and max_timeout_s between 30 and 300 and fee_to is not null)
  or (method = 'near-intents' and max_timeout_s between 60 and 86400 and fee_amount = 0
      and origin_network is not null and origin_asset_id is not null and origin_asset is not null and entry is not null));

-- One per minted near-intents quote (the rails execution owned by agentpay). The operation token itself is never
-- stored: only its sha256 (it is a bearer credential returned once, to the quoting request).
create table x402_operations (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  binding text not null unique references issued_requirements (binding),
  execution_id text not null unique,               -- rails ex_ (owner agentpay)
  network text not null,                           -- origin CAIP-2
  deposit_address text not null,
  deposit_memo text,
  refund_to text not null,
  amount_in numeric(78,0) not null check (amount_in > 0),
  refund_deadline timestamptz not null,
  token_sha256 bytea not null,
  token_kid text not null,
  token_expiry timestamptz not null,
  status text not null check (status in ('quoted', 'settled', 'failed')),
  result jsonb,                                    -- the recorded final outcome (never the token)
  result_reported_at timestamptz,                  -- first settle response that carried the result (replayed)
  execution_version integer,                       -- aggregate.version of the rails event that recorded the result
  agent_payment_id uuid,                           -- the merchant record (§3.1 step 5)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'quoted') = (result is null)));
create unique index xo_instrument on x402_operations (network, deposit_address, coalesce(deposit_memo, ''));
create index xo_account on x402_operations (account_id, livemode, created_at desc);
create index xo_purge on x402_operations (token_expiry);

-- near-intents agent payments: kind 'x402', inserted 'settled' from rails' evidence, no signed payload.
alter table agent_payments
  add column transfer_method text not null default 'intents-transfer'
    check (transfer_method in ('intents-transfer', 'near-intents')),
  add column origin jsonb,                         -- AgentPaymentOrigin
  alter column payload_hash drop not null,
  alter column payload drop not null,
  alter column standard drop not null,
  alter column nonces drop not null,
  alter column deadline drop not null;
-- relayed payloads keep every signed-payload column; near-intents rows are x402 records created settled
alter table agent_payments add constraint ap_transfer_method_shape check (
  (transfer_method = 'intents-transfer' and payload_hash is not null and payload is not null and standard is not null
     and nonces is not null and deadline is not null and origin is null)
  or (transfer_method = 'near-intents' and kind = 'x402' and status = 'settled' and execution_id is not null
     and origin is not null and payload_hash is null));
-- one merchant record per rails execution (the settled event and any redelivery race to insert it)
create unique index ap_near_intents_execution on agent_payments (execution_id) where transfer_method = 'near-intents';
