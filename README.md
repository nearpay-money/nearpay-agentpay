# nearpay-agentpay

> x402 v2 facilitator (exact: intents-transfer, near-intents), MPP adapter, batching relayer for signed NEAR Intents with a function-call key pool.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/agentpay · routes /x402/*, /v1/checkout/sessions/{id}/agent_pay |
| Owns | FacilitatorPayment, RelayBatch, RelayerKey |
| Depends on (published artifacts only) | spec, kit, compliance, payments, intents.near |
| First built in | Stage 1 (step 1.2) |

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
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── binding/
│   │   ├── facilitator-payment/
│   │   └── relay-batch/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── mpp/
│   ├── relayer/
│   │   ├── batcher/
│   │   └── key-pool/
│   ├── workers/
│   └── x402/
│       └── schemes/
│           ├── intents-transfer/
│           └── near-intents/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
