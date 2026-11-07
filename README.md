# nearpay-agentpay

> x402 v2 facilitator (exact: intents-transfer, near-intents), MPP adapter, batching relayer for signed NEAR Intents with a function-call key pool.

|                                       |                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                     |
| Kind                                  | service                                                                                      |
| Ships as                              | image: ghcr.io/nearpay-money/agentpay · routes /x402/*, /v1/checkout/sessions/{id}/agent_pay |
| Owns                                  | FacilitatorPayment, RelayBatch, RelayerKey                                                   |
| Depends on (published artifacts only) | spec, kit, compliance, payments, intents.near                                                |
| First built in                        | Stage 1 (step 1.2)                                                                           |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/agentpay.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/agentpay.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0009-agent-payments-x402.md`
- `nearpay-brain/architecture/flows.md#7-agent-payment-over-x402-exact--intents-transfer`

## Layout

```
nearpay-agentpay/
├── migrations/                 0001_agentpay.sql (Stage 1 tables), 0002 settle reported, 0003 refund relay
├── src/
│   ├── api/                    spec route bindings
│   ├── app/                    use cases: requirements, x402 verify/settle, checkout agent pay + relay, reads
│   ├── consumers/              evt.sentinel.kill_switch.* consumer
│   ├── domain/                 pure: binding, facilitator-payment (match, fee, lifecycle), relay-batch, quota
│   ├── infra/                  clients (identity, rails, payments, compliance, sandbox), db, NEAR RPC, Valkey
│   ├── relayer/
│   │   ├── batcher/            leader-elected batching relayer
│   │   └── key-pool/           relayer function-call keys
│   ├── workers/                jobs (purges, allowance monitor)
│   ├── mpp/                    Stage 3
│   └── x402/schemes/near-intents/  Stage 3
├── test/
│   ├── contract/  integration/  property/  unit/  support/
└── .github/workflows/
```

## Commands

```sh
pnpm install                 # @nearpay/* from the local registry (nearpay-deploy/scripts/up.sh starts it)
pnpm verify                  # typecheck, lint, unit + property tests (coverage gate), integration, build
pnpm test                    # unit + property only (no Docker)
pnpm test:integration        # Testcontainers (Postgres, NATS, Valkey, nearpay/sandbox:local) + contract tests
node dist/main.js api|batcher|migrate|healthcheck
```

Integration tests need `nearpay/sandbox:local` (built from `nearpay-sandbox`) and, in the cloud workspace,
`TESTCONTAINERS_RYUK_DISABLED=true`. Live mode is tested against a fake NEAR JSON-RPC on 127.0.0.1 with throwaway
keys; tests never reach mainnet.

## Configuration

| Variable                                                                  | Default                 | Meaning                                                                                    |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `NP_DB_URL_FILE`                                                          | —                       | app-role database URL (migrate: migrator role)                                             |
| `NP_IDENTITY_URL`, `NP_PAYMENTS_URL`, `NP_RAILS_URL`, `NP_COMPLIANCE_URL` | —                       | peers (§10 timeouts)                                                                       |
| `NP_SANDBOX_BASE_URL`                                                     | unset                   | test mode Verifier (`/sim/intents/*`); unset refuses test payloads                         |
| `NP_NEAR_RPC_URLS`                                                        | empty                   | live Verifier: simulate, `send_tx`, status (tried in order); empty refuses live payloads   |
| `NP_INTENTS_CONTRACT`                                                     | `intents.near`          | Verifier contract                                                                          |
| `NP_TREASURY_ACCOUNT`                                                     | unset                   | live fee recipient; unset refuses live requirements                                        |
| `NP_TEST_TREASURY_ACCOUNT`                                                | `treasury.nearpay.near` | test fee recipient (sandbox only)                                                          |
| `NP_RELAYER_ACCOUNT`                                                      | unset                   | relayer account (advertised in `/x402/supported`)                                          |
| `NP_RELAYER_KEY_FILES`                                                    | unset                   | batcher: function-call key files, `*` in the file name (e.g. `/run/secrets/relayer_key_*`) |
| `NP_GAS_PER_PAYLOAD_TGAS`                                                 | 15                      | batch size `floor(240 / n)`, gas `k × n + 20` Tgas                                         |
| `NP_SETTLE_WAIT_MS`                                                       | 8000                    | settle waits this long for finality                                                        |
| `NP_REQUIREMENT_TTL_MAX_S`                                                | 300                     | ceiling for `max_timeout_s`                                                                |
| `NP_REQUIREMENT_RATE_PER_S`                                               | 200                     | requirement issuance per merchant per second                                               |
| `NP_PAYER_RATE_PER_S`                                                     | 10                      | verifications per payer per second (account quota: `quotas.rps`, default 50)               |
| `NP_SERVICE_CLIENT_SECRET_FILE`                                           | —                       | client credentials for service tokens                                                      |
| `NP_PII_KEK_FILE`                                                         | —                       | 32-byte KEK for the idempotency store                                                      |
| `NP_VALKEY_URL`                                                           | unset                   | settle waiters (`ap:<id>`) and quotas across replicas; in-process without it               |
| `NP_NATS_URL`                                                             | —                       | batcher: events (kill switch in, agent payments out)                                       |
| `NP_BATCH_TICK_MS`                                                        | 150                     | batcher tick                                                                               |

## Behaviour (Stage 1)

- **Requirements** (`POST /x402/requirements`): one per 402 response, single use. `payTo` is an active Intents-account
  destination (asset default, then account default); fee = `max(ceil(amount × bps), min fee at the asset price, 1)`
  from the account's `intents_transfer` rule, paid by the payer as a second transfer to the treasury; binding =
  `np1:` + base58(sha256(JCS(fields + 16 random bytes))). `extra.deadline` (spec 0.1.5) is the binding's
  `expires_at` in RFC 3339; verify refuses an echoed deadline that differs and accepts one that was left out.
- **Verify** (§6): `accepted` == `paymentRequirements` (JCS) and the forwarded `resource.url` (if any) equals the issued
  one → issued, unconsumed, unexpired requirement of this account and mode → signature (NEP-413, ERC-191, raw ed25519)
  and exactly the two transfers with `memo = binding`, deadline in (now + 5 s, expiry] → `simulate_intents` in the
  payload's mode → payer screening (cached 24 h, fail closed) → quotas → cached 60 s.
- **Settle** (§7): idempotent on the payload hash (a replay gets the same answer, never a second relay); queues the
  payload and consumes the requirement in one transaction, then waits up to 8 s (`settlement_pending` otherwise).
  The first response carrying the final outcome claims it (`agent_payments.result_reported_at`); every later one
  repeats it with `replayed: true` (spec 0.1.5), so the merchant delivers the resource at most once per settlement.
- **AgentPayment.sequence** (spec 0.1.5) is the row's `version`, bumped by every change (status moves and the
  batcher's `tx_hash` write) and carried as `aggregate.version` on the events.
- **Checkout**: `agent_pay/requirements` checks the client secret through payments and returns payments' agent attempt;
  `agent_pay` and `POST /internal/relay` check the payload against the rails execution, simulate and queue it (one live
  payload per binding). Rails' indexer settles the execution from the binding memo; agentpay emits nothing for them.
- **Batcher** (leader): batches per mode, re-simulates and prunes rejected payloads, sends `execute_intents` with a
  function-call key (zero deposit; live) or to the sandbox (test), settles from `intents_executed`, splits failed
  batches into solo retries, polls unconfirmed transactions (never fails them blindly), recovers at restart.
- **Kill switch**: while sentinel's kill switch is engaged, new live settles and relays answer `503 rail_unavailable`;
  test mode and already-queued payloads continue.
- **Events**: `evt.agentpay.agent_payment.settled|failed` for x402 payments, from the outbox.

## Behaviour (Stage 2)

- **Refund legs from an Intents account** (`POST /internal/relay` `kind: refund`, spec 0.2.0): the rails execution
  must be a `refund` leg with `refund.transfer`, awaiting its deposit, memo = binding, belonging to the refund
  (`reference.refund`). payments' refund (`GET /internal/refunds/{id}`) must show that leg's `sign_intent` next
  action, consistent with rails' transfer, and the signed payload must be exactly it (signer, receiver, token, amount,
  memo, deadline, nonce, standard, signed string) — else `422 signed_intent_mismatch`. Then simulate and queue
  (idempotent on the payload hash). Recorded as a `refund` agent payment (`payer` = merchant signer, `pay_to` = receiver,
  no fee, `refund_id`); no events (rails' indexer verifies the payer side). Live refund relays stop under the kill switch.
- **Payer sessions** come from payments' `getPayerCheckoutSession` (CR-15-15; service token + forwarded client
  secret) only; no fallback to the unscoped public route — any other answer, a `404` included, is `503 rail_unavailable`.
- **Live send** uses kit `sendSignedTx` (CR-15-16) on the bytes whose hash was stored first; a send is "rejected"
  only when every RPC provider refused it as invalid, otherwise its status is polled.

## Ops CLI (Stage 1)

`docker compose -p nearpay exec agentpay-api /nodejs/bin/node dist/ops.js <command>`: `payment <ap_…>`, `queue`,
`keys`, `key-status <ed25519:…> <active|draining|retired>`, `kill-switch`.

## Status

Stage 1 implemented (step 1.2): x402 `exact` + `intents-transfer` facilitator, agent payments, checkout agent pay,
`/internal/relay`, the batcher with the relayer key pool, the kill-switch consumer and both produced subjects.
Stage 2 implemented (step 2.2): Intents-account refund relay, kill switch on live refund relays, payer sessions via
payments' internal route, kit `sendSignedTx`; refund legs are listed by `GET /v1/agent_payments?kind=refund`
(dashboard). Stage 3 (`near-intents`, MPP) is not started.

## Built with

Fastify, Kysely, pg, NATS, ioredis (via `@nearpay-internal/*`), `@nearpay-internal/intents` (`@near-js/*`,
`@noble/curves`, `@noble/hashes`, bs58), zod, canonicalize; Vitest, fast-check, Testcontainers, Biome. Code and
documentation are written with AI assistance (Claude) under human direction and review.
