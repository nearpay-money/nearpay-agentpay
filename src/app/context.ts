/** Dependencies shared by agentpay use cases. */
import type { Kysely, Transaction } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { SettlementContext } from "@nearpay-internal/spec";
import type {
  Compliance,
  Identity,
  InternalAsset,
  Payments,
  Rails,
  SandboxVerifier,
  Screening,
} from "../infra/clients/peers.js";
import type { DB } from "../infra/db/schema.js";
import type { Limiter } from "../infra/limiter.js";
import type { NearChain } from "../infra/near/rpc.js";
import type { Waiters } from "../infra/waiters.js";
import { type TtlCache, ttlCache } from "./cache.js";

export type Tx = Transaction<DB>;
export type Db = Kysely<DB> | Tx;

export interface AgentpayMetrics {
  verify(result: string): void;
  settleLatency(seconds: number): void;
  batch(size: number): void;
  batchFailure(): void;
  allowance(key: string, near: number): void;
}

export const noMetrics: AgentpayMetrics = {
  verify() {},
  settleLatency() {},
  batch() {},
  batchFailure() {},
  allowance() {},
};

/** Mandatory agentpay metrics (lld/agentpay.md §13); `queue_depth` is collected by the batcher. */
export function agentpayMetrics(m: ServiceMetrics): AgentpayMetrics {
  const verify = m.counter("verify_total", "x402 verifications by result (valid or the invalid reason).", ["result"]);
  const settle = m.histogram(
    "settle_latency_seconds",
    "x402 settle call duration.",
    [],
    [0.25, 0.5, 1, 2, 3, 5, 8, 10],
  );
  const size = m.histogram("batch_size", "Payloads per relayed batch.", [], [1, 2, 4, 8, 16]);
  const failures = m.counter("batch_failures_total", "Relayed batches that failed on chain or had to be split.");
  const allowance = m.gauge("relayer_allowance_near", "Remaining allowance of each relayer key, NEAR.", ["key"]);
  return {
    verify: (result) => verify.inc({ result }),
    settleLatency: (s) => settle.observe(s),
    batch: (n) => size.observe(n),
    batchFailure: () => failures.inc(),
    allowance: (key, near) => allowance.set({ key }, near),
  };
}

export interface AgentpaySettings {
  readonly contract: string;
  /** Live fee recipient; null refuses live requirements and relays. */
  readonly treasury: string | null;
  readonly testTreasury: string;
  readonly relayerAccount: string | null;
  readonly gasPerPayloadTgas: number;
  readonly settleWaitMs: number;
  readonly requirementTtlMaxS: number;
  readonly requirementRatePerS: number;
  readonly payerRatePerS: number;
}

export interface VerifiedPayload {
  readonly payer: string;
  readonly binding: string;
}

export interface Caches {
  readonly contexts: TtlCache<SettlementContext>;
  readonly assets: TtlCache<InternalAsset>;
  readonly screenings: TtlCache<Screening>;
  /** Successful verify results by payload hash (§6 step 7: 60 s). */
  readonly verified: TtlCache<VerifiedPayload>;
  readonly quotas: TtlCache<number>;
  readonly killSwitch: TtlCache<boolean>;
}

export function newCaches(now: () => number = Date.now): Caches {
  return {
    contexts: ttlCache(60_000, now),
    assets: ttlCache(5 * 60_000, now),
    screenings: ttlCache(24 * 3_600_000, now),
    verified: ttlCache(60_000, now),
    quotas: ttlCache(60_000, now),
    killSwitch: ttlCache(1_000, now),
  };
}

export interface Agentpay {
  readonly env: string;
  readonly db: Kysely<DB>;
  log: Logger;
  metrics: AgentpayMetrics;
  readonly identity: Identity;
  readonly rails: Rails;
  readonly payments: Payments;
  readonly compliance: Compliance;
  /** Test mode Verifier (nearpay-sandbox); null refuses test-mode payloads. */
  readonly sandbox: SandboxVerifier | null;
  /** Live Verifier over NEAR RPC; null (no RPC URLs) refuses live payloads. */
  readonly chain: NearChain | null;
  readonly waiters: Waiters;
  readonly limiter: Limiter;
  readonly settings: AgentpaySettings;
  readonly caches: Caches;
  readonly now: () => number;
  readonly randomBytes: (n: number) => Uint8Array;
}
