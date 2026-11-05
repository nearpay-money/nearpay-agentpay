# nearpay-agentpay

> x402 v2 facilitator (exact: intents-transfer, near-intents), MPP adapter, batching relayer for signed NEAR Intents with a function-call key pool.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/agentpay · routes /x402/*, /v1/checkout/sessions/{id}/agent_pay |
| Owns | FacilitatorPayment, RelayBatch, RelayerKey |
| Depends on (published artifacts only) | spec, kit, compliance, payments, intents.near |
| Roadmap phase | P2 Refunds, billing, agents |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

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

Scaffold only. Implementation starts in phase **P2 Refunds, billing, agents** (`nearpay-brain/roadmap/roadmap.md`).
