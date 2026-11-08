/**
 * Configuration (lld/agentpay.md §11, foundations §13). `*_FILE` variables carry secrets; `secret()`
 * marks the schema object it wraps, so every secret gets a fresh schema (never a shared one).
 */
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const http = () => url(["http:", "https:"]);
const bounded = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);
/** A JSON object from the environment (the raw string fails the object schema when it does not parse). */
const json = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }, schema);
const bps = () => z.int().min(0).max(10_000);
const nearAccount = () =>
  z.string().regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "must be a NEAR account id");

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** Settle waiters (`ap:<id>`) and quotas across replicas (optional: in-process without it). */
  valkeyUrl: url(["redis:", "rediss:"]).optional(),
  identityUrl: http(),
  serviceClientSecret: secret(),
  paymentsUrl: http(),
  railsUrl: http(),
  complianceUrl: http(),
  /** Sentinel (`getKillSwitch` at boot, spec 0.2.1). Unset: the kill-switch state waits for an event (live relays refused until then). */
  sentinelUrl: http().optional(),
  /** Test mode (nearpay-sandbox `/sim/intents/*`); without it test-mode payloads are refused. */
  sandboxBaseUrl: http().optional(),
  /** NEAR RPC providers for live mode (simulate, send, status), tried in order. */
  nearRpcUrls: list(http()).default([]),
  intentsContract: nearAccount().default("intents.near"),
  /** Live NearPay fee recipient (owner-provided). Unset: live requirements and relays are refused. */
  treasuryAccount: nearAccount().optional(),
  /** Fee recipient in test mode (sandbox only). */
  testTreasuryAccount: nearAccount().default("treasury.nearpay.near"),
  /** Relayer account that owns the function-call keys (advertised in `/x402/supported`). */
  relayerAccount: nearAccount().optional(),
  gasPerPayloadTgas: bounded(1, 240, 15),
  settleWaitMs: bounded(0, 30_000, 8_000),
  requirementTtlMaxS: bounded(30, 300, 300),
  /** Requirement issuance per merchant per second (§3). */
  requirementRatePerS: bounded(1, 100_000, 200),
  /** Verifies per payer per second (§6 step 6; the account quota comes from the `quotas` table, default 50). */
  payerRatePerS: bounded(1, 10_000, 10),
  /** 32-byte KEK (base64 or hex) for the idempotency store's response encryption. */
  piiKek: secret(),
  // ---- Stage 3: x402 `exact` + `near-intents` (§3.1)
  /**
   * Operation-token keys, a path with `*` in the file name (`/run/secrets/x402_op_key_*`, kid = the `*` part, ≥ 32
   * random bytes each, the newest file signs). Unset: near-intents issuance and quotes are refused.
   */
  x402OperationKeyFiles: z.string().min(1).optional(),
  /** Accepted `slippageTolerance` range, bps (advertised per entry; quote payloads are clamped into it). */
  x402SlippageBps: json(
    z
      .object({ min: bps(), max: bps(), default: bps() })
      .refine((r) => r.min <= r.default && r.default <= r.max, "need min ≤ default ≤ max"),
  ).default({ min: 10, max: 300, default: 50 }),
  /** Quote payloads per second: per account and per `refundTo`. */
  x402QuoteRatePerS: json(
    z.object({ account: z.int().min(1).max(10_000), refund_to: z.int().min(1).max(10_000) }),
  ).default({ account: 5, refund_to: 1 }),
  /** Origins per near-intents issuance (the spec allows at most 20). */
  x402OriginsMax: bounded(1, 20, 20),
};

export const apiShape = { ...shared };
export const batcherShape = {
  ...shared,
  natsUrl: url(["nats:", "tls:"]),
  /** Relayer function-call key files (`ed25519:<base58>` each), a path with `*` in the file name. */
  relayerKeyFiles: z.string().min(1).optional(),
  batchTickMs: bounded(20, 10_000, 150),
};
export const opsShape = { ...shared };
export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type SharedConfig = z.output<z.ZodObject<typeof shared>>;
export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type BatcherConfig = z.output<z.ZodObject<typeof batcherShape>>;

export const readApiConfig = (): ApiConfig => loadConfig(apiShape);
export const readBatcherConfig = (): BatcherConfig => loadConfig(batcherShape);
export const readOpsConfig = (): SharedConfig => loadConfig(opsShape);
