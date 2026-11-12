/**
 * Process wiring (lld/agentpay.md §2):
 * - `api`      public x402 + `/v1/agent_payments` + checkout agent pay, internal `/internal/relay`
 * - `batcher`  the leader-elected batching relayer, the kill-switch consumer, jobs and the outbox relay
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import { serviceTokenClient } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  type EnvelopeCipher,
  idempotencyStore,
  jobsDue,
  jobWorkerTask,
  leaderTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { agentpayRoutes } from "../api/routes.js";
import type { ApiConfig, BatcherConfig, SharedConfig } from "../config.js";
import { agentpayHandlers, deadLetters } from "../consumers/handlers.js";
import {
  type Compliance,
  complianceClient,
  type Identity,
  identityClient,
  type Payments,
  paymentsClient,
  type Rails,
  railsClient,
  type SandboxVerifier,
  type Sentinel,
  sandboxClient,
  sentinelClient,
} from "../infra/clients/peers.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { type Limiter, limiter } from "../infra/limiter.js";
import { type NearChain, nearChain } from "../infra/near/rpc.js";
import { loadOperationKeys, type OperationKeys } from "../infra/operation-keys.js";
import { type Waiters, waiters } from "../infra/waiters.js";
import { type Batcher, batcher } from "../relayer/batcher/batcher.js";
import { loadKeyFiles, type RelayerKey, registerKeys } from "../relayer/key-pool/keys.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { type Agentpay, agentpayMetrics, newCaches, noMetrics } from "./context.js";
import { killSwitchBootTask } from "./kill-switch.js";

export interface ServiceDeps {
  database?: Database<DB>;
  keys?: KeySource;
  serviceToken?: () => Promise<string>;
  identity?: Identity;
  rails?: Rails;
  payments?: Payments;
  compliance?: Compliance;
  sentinel?: Sentinel | null;
  sandbox?: SandboxVerifier | null;
  chain?: NearChain | null;
  waiters?: Waiters;
  limiter?: Limiter;
  cipher?: EnvelopeCipher;
  /** Operation-token keys (default: loaded from `NP_X402_OPERATION_KEY_FILES`). */
  operationKeys?: OperationKeys | null;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Built {
  ap: Agentpay;
  database: Database<DB>;
}

function build(config: SharedConfig, deps: ServiceDeps, app: string): Built {
  const f = deps.fetch ? { fetch: deps.fetch } : {};
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: `agentpay-${app}` });
  const serviceToken =
    deps.serviceToken ??
    (() => {
      const c = serviceTokenClient({
        identityUrl: config.identityUrl,
        clientId: "agentpay",
        secret: config.serviceClientSecret,
        ...f,
      });
      return () => c.getToken();
    })();
  const peer = { serviceToken, ...f };
  const now = deps.now ?? Date.now;
  const ap: Agentpay = {
    env: config.env,
    db: database.db,
    log: undefined as unknown as Agentpay["log"],
    metrics: noMetrics,
    identity: deps.identity ?? identityClient({ ...peer, baseUrl: config.identityUrl }),
    rails: deps.rails ?? railsClient({ ...peer, baseUrl: config.railsUrl }),
    payments: deps.payments ?? paymentsClient({ ...peer, baseUrl: config.paymentsUrl }),
    compliance: deps.compliance ?? complianceClient({ ...peer, baseUrl: config.complianceUrl }),
    sentinel:
      deps.sentinel !== undefined
        ? deps.sentinel
        : config.sentinelUrl
          ? sentinelClient({ ...peer, baseUrl: config.sentinelUrl })
          : null,
    sandbox:
      deps.sandbox !== undefined
        ? deps.sandbox
        : config.sandboxBaseUrl
          ? sandboxClient({ ...peer, baseUrl: config.sandboxBaseUrl })
          : null,
    chain:
      deps.chain !== undefined
        ? deps.chain
        : config.nearRpcUrls.length
          ? nearChain({ rpcUrls: config.nearRpcUrls, contract: config.intentsContract, ...f })
          : null,
    waiters: deps.waiters ?? waiters(config.valkeyUrl),
    limiter: deps.limiter ?? limiter(config.valkeyUrl, now),
    settings: {
      contract: config.intentsContract,
      treasury: config.treasuryAccount ?? null,
      testTreasury: config.testTreasuryAccount,
      relayerAccount: config.relayerAccount ?? null,
      gasPerPayloadTgas: config.gasPerPayloadTgas,
      settleWaitMs: config.settleWaitMs,
      requirementTtlMaxS: config.requirementTtlMaxS,
      requirementRatePerS: config.requirementRatePerS,
      payerRatePerS: config.payerRatePerS,
      operationKeys:
        deps.operationKeys !== undefined ? deps.operationKeys : loadOperationKeys(config.x402OperationKeyFiles),
      slippage: config.x402SlippageBps,
      quoteRatePerS: config.x402QuoteRatePerS,
      originsMax: config.x402OriginsMax,
    },
    caches: newCaches(now),
    now,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
  };
  return { ap, database };
}

function readiness(b: Built) {
  return {
    db: () => sql`select 1`.execute(b.database.db),
    migrations: async () => {
      const s = await migrationStatus(b.database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

function attach(b: Built, service: Service, deps: ServiceDeps) {
  b.ap.log = service.log;
  b.ap.metrics = agentpayMetrics(service.metrics);
  service.onShutdown(async () => {
    if (!deps.waiters) await b.ap.waiters.close();
    if (!deps.limiter) await b.ap.limiter.close();
    if (!deps.database) await b.database.close();
  });
}

/** The agentpay context for the ops CLI (no listener, no background tasks). */
export function createOpsContext(
  config: SharedConfig,
  log: Agentpay["log"],
  deps: ServiceDeps = {},
): { ap: Agentpay; close(): Promise<void> } {
  const b = build(config, { waiters: waiters(undefined), limiter: limiter(undefined), ...deps }, "ops");
  b.ap.log = log;
  return {
    ap: b.ap,
    async close() {
      await b.ap.waiters.close();
      if (!deps.database) await b.database.close();
    },
  };
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; ap: Agentpay } {
  const b = build(config, deps, "api");
  const service = createService({
    name: "agentpay",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: agentpayRoutes(b.ap),
    idempotency: idempotencyStore(b.database.db, deps.cipher ?? createEnvelopeCipher(parseKek(config.piiKek))),
    readiness: readiness(b),
  });
  attach(b, service, deps);
  // spec 0.2.1: learn sentinel's kill-switch state at boot (live relays are refused while it is unknown)
  service.addBackground(killSwitchBootTask(b.ap));
  return { service, ap: b.ap };
}

export interface BatcherDeps extends ServiceDeps {
  bus?: Bus;
  relayerKeys?: readonly RelayerKey[];
  tickMs?: number;
  /** Skip the leader-elected relay loop (tests drive `batcher.tick()` themselves). */
  manualTicks?: boolean;
}

export async function createBatcher(
  config: BatcherConfig,
  deps: BatcherDeps = {},
): Promise<{ service: Service; ap: Agentpay; batcher: Batcher }> {
  const b = build(config, deps, "batcher");
  const ap = b.ap;
  const service = createService({ name: "agentpay", config, readiness: readiness(b) });
  attach(b, service, deps);
  const db = b.database;

  const keys = deps.relayerKeys ?? loadKeyFiles(config.relayerKeyFiles);
  if (keys.length && !config.relayerAccount) throw new Error("NP_RELAYER_ACCOUNT is required with relayer keys");
  if (config.relayerAccount) await registerKeys(db.db, config.relayerAccount, keys);
  if (config.env === "server" && (!keys.length || !ap.chain || !config.treasuryAccount))
    service.log.warn("live relaying is not configured (relayer keys, NEAR RPC or treasury missing)");
  const relay = batcher(ap, {
    keys: new Map(keys.map((k) => [k.publicKey, k])),
    relayerAccount: config.relayerAccount ?? null,
  });

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `agentpay-batcher@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.agentpay]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = agentpayHandlers(db.db, { waiters: ap.waiters, log: service.log });
  const durables = durablesOf("agentpay", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectOutboxLag(() => outboxLagSeconds(db.db));
  service.metrics.collectJobsDue(() => jobsDue(db.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(db.db));
  service.metrics.gauge("queue_depth", "Agent payments waiting to be relayed, by mode.", ["livemode"], async (g) => {
    const rows = await db.db
      .selectFrom("agent_payments")
      .select(["livemode", sql<string>`count(*)`.as("n")])
      .where("status", "=", "queued")
      .groupBy("livemode")
      .execute();
    g.reset();
    for (const r of rows) g.set({ livemode: String(r.livemode) }, Number(r.n));
  });

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: db.db,
      pool: db.pool,
      publish: (sub, e, mid) => publish(bus, sub, e, mid).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "agentpay", handlers, onDeadLetter: deadLetters(db.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: db.db,
      workerId: `agentpay-batcher@${hostname()}:${process.pid}`,
      handlers: jobHandlers(ap, relay),
      onError: (e, job) => service.log.warn({ err: e instanceof Error ? e.message : String(e), job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "ALERT job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: db.db,
      pool: db.pool,
      name: "agentpay:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  if (!deps.manualTicks) {
    const tickMs = deps.tickMs ?? config.batchTickMs;
    service.addBackground(
      leaderTask({
        pool: db.pool,
        name: "agentpay:batcher",
        onError,
        // kit 0.6.0 liveness from the run loop: a tick that never settles fails /healthz while this replica leads
        // (a tick only polls and claims; batches are sent beside it, each send_tx bounded by its 10 s timeout)
        livenessFrom: "run",
        maxSilenceMs: 120_000,
        run: async (signal, beat) => {
          await relay.recover();
          while (!signal.aborted) {
            try {
              await relay.tick();
            } catch (e) {
              onError(e);
            }
            beat();
            await new Promise<void>((r) => {
              const t = setTimeout(r, tickMs);
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  r();
                },
                { once: true },
              );
            });
          }
          await relay.drain();
        },
      }),
    );
  }
  if (!deps.bus) service.onShutdown(() => bus.close());
  return { service, ap, batcher: relay };
}
