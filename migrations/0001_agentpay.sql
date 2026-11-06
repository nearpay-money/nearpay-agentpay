-- nearpay-agentpay, Stage 1 (lld/agentpay.md §4, §15). Kit tables (outbox, inbox, idempotency_keys, jobs,
-- dead_letters) come from @nearpay-internal/db migrations. Asset amounts are numeric(78,0) base units.

-- x402 requirements issued per 402 response (§3); single use, expire after max_timeout_s.
create table issued_requirements (
  binding text primary key,
  account_id uuid not null,
  livemode boolean not null,
  resource_url text not null,
  resource jsonb not null,                       -- {url, description?, mimeType?} echoed in PAYMENT-REQUIRED
  pay_to text not null,
  asset_id text not null,
  amount numeric(78,0) not null check (amount > 0),
  fee_to text not null,
  fee_amount numeric(78,0) not null check (fee_amount >= 0),
  max_timeout_s integer not null check (max_timeout_s between 30 and 300),
  nonce16 text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_by uuid,                              -- agent payment that consumed it
  created_at timestamptz not null default now());
create index ir_expiry on issued_requirements (expires_at) where consumed_at is null;

-- Checkout agent attempts handed out by `agent_pay/requirements` (payments createAgentAttempt): what an
-- agent's `agent_pay` submission is matched against (binding = the attempt's Intents requirement memo).
create table checkout_requirements (
  binding text primary key,
  account_id uuid not null,
  livemode boolean not null,
  checkout_session_id uuid not null,
  attempt_id uuid not null,
  execution_id text not null,
  payer text not null,
  requirement jsonb not null,                    -- IntentsRequirement as payments returned it
  attestation_ticket text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index cr_session on checkout_requirements (checkout_session_id);

create table agent_payments (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  kind text not null check (kind in ('x402','checkout','refund')),
  binding text not null,
  payer text not null,
  pay_to text not null,
  fee_to text not null,
  payload_hash bytea not null unique,           -- sha256(JCS(MultiPayload)): settle/relay idempotency
  payload jsonb not null,
  standard text not null,
  intent_hashes text[],
  nonces text[] not null,
  deadline timestamptz not null,                -- payload deadline (expired queued payloads fail)
  status text not null check (status in ('verified','queued','submitted','settled','failed')),
  amount numeric(78,0) not null,
  asset_id text not null,
  fee_amount numeric(78,0) not null,
  resource_url text,
  checkout_session_id uuid,
  solo boolean not null default false,          -- requeued after a failed batch: next batch has size 1
  batch_id uuid,
  tx_hash text,
  block_height bigint,
  error_reason text,
  execution_id text,                            -- rails ex_ for checkout/refund kinds
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,
  version integer not null default 0);
create index ap_queue on agent_payments (livemode, created_at) where status = 'queued';
create index ap_account on agent_payments (account_id, livemode, created_at desc);
create index ap_batch on agent_payments (batch_id) where batch_id is not null;
-- one live payload per binding: a second signed payload for the same requirement is refused while the first
-- is queued, submitted or settled (a failed one frees the binding for a retry)
create unique index ap_binding_live on agent_payments (binding) where status in ('verified','queued','submitted','settled');

create table agent_payment_transitions (
  id uuid primary key,
  agent_payment_id uuid not null references agent_payments(id),
  from_state text,
  to_state text not null,
  cause text not null,
  actor text not null,
  evidence jsonb,
  created_at timestamptz not null default now());
create index apt_payment on agent_payment_transitions (agent_payment_id, created_at);

create table relay_batches (
  id uuid primary key,
  livemode boolean not null,
  relayer_key text not null,                    -- public key, or 'sandbox' in test mode
  size smallint not null,
  gas_attached bigint not null,
  tx_hash text,
  tx_nonce bigint,
  status text not null check (status in ('building','submitted','final_ok','final_failed','split')),
  failure text,
  gas_burnt bigint,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  finalized_at timestamptz);
create index rb_pending on relay_batches (created_at) where status in ('building','submitted');

create table relayer_keys (
  public_key text primary key,
  account_id text not null,
  status text not null check (status in ('active','draining','retired')),
  in_flight boolean not null default false,
  last_nonce bigint,
  allowance_yocto numeric(40,0),
  allowance_checked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now());

create table quotas (
  account_id uuid primary key,
  rps integer not null default 50 check (rps > 0),
  daily_count_limit integer);

-- Global kill switch as last announced by sentinel (evt.sentinel.kill_switch.*): live settles stop while engaged.
create table kill_switch (
  id smallint primary key check (id = 1),
  engaged boolean not null,
  reason text not null,
  actor text not null,
  event_version integer not null,
  updated_at timestamptz not null default now());

create function agentpay_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'append-only table %', tg_table_name;
end $$;
create trigger apt_append_only before update or delete on agent_payment_transitions
  for each row execute function agentpay_append_only();
