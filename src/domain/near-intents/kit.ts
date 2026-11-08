/**
 * The kit 0.3.0 x402 `near-intents` helpers agentpay uses (lld/agentpay.md §3.1): `nearIntentsBinding`,
 * `mintOperationToken`, `verifyOperationToken`, `jcs` from `@nearpay-internal/intents` (pure). Kept as one import
 * point; `test/unit/near-intents-kit.test.ts` checks them against the spec 0.3.0 vectors
 * (`test-vectors/x402-near-intents.json`).
 */
export {
  jcs,
  mintOperationToken,
  type NearIntentsBindingInput,
  nearIntentsBinding,
  type OperationTokenCheck,
  type OperationTokenInput,
  verifyOperationToken,
} from "@nearpay-internal/intents";
