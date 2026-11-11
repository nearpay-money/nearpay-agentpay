/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (migrator owns the
 * database, the app role has DML only); the real `api` and `batcher` from the factories `main.ts`
 * uses; identity, rails, payments, compliance and the sandbox mocked from the spec (`mockPeer`, every
 * call checked against the contract), the sandbox Verifier and live NEAR RPC backed by an in-memory
 * Verifier (fake JSON-RPC on 127.0.0.1: tests never reach mainnet); NATS and Valkey.
 */
import { randomBytes } from "node:crypto";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { nearPublicKey } from "@nearpay-internal/intents";
import type { Service } from "@nearpay-internal/service";
import {
  createAgentAttempt,
  createExecution,
  createScreening,
  type Execution,
  getExecution,
  getInternalAsset,
  getInternalRefund,
  getKillSwitch,
  getPayerCheckoutSession,
  getSettlementContext,
  INTERNAL_ROUTES,
  listChainProfiles,
  listInternalOptions,
  sandboxExecuteIntents,
  sandboxSimulateIntents,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";
import {
  account,
  type EventProbe,
  eventProbe,
  execution,
  internalSettlementDestination,
  type MockPeer,
  mintTestToken,
  mockError,
  mockPeer,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  startValkey,
  testKeySource,
  testServiceToken,
  USDC_NEAR,
} from "@nearpay-internal/testing";
import { getPublicCheckoutSession, PUBLIC_ROUTES } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import type { Agentpay } from "../../src/app/context.js";
import { readKillSwitch } from "../../src/app/kill-switch.js";
import { type BatcherDeps, createApi, createBatcher, type ServiceDeps } from "../../src/app/services.js";
import type { BatcherConfig } from "../../src/config.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import type { Batcher } from "../../src/relayer/batcher/batcher.js";
import type { RelayerKey } from "../../src/relayer/key-pool/keys.js";
import { BASE_USDC, quoteExecution } from "./executions.js";
import { type FakeRpc, startFakeRpc } from "./near-rpc.js";
import { leg as buildLeg, type Leg, type LegOptions, type Signer } from "./refund.js";
import { type RealSandbox, startSandbox } from "./sandbox.js";
import { NEAR_INTENTS_VECTORS } from "./vectors.js";
import { FakeVerifier, Rejection } from "./verifier.js";

export { BASE_USDC, USDC_NEAR };
/** Base USDC contract (the origin entry's `asset`). */
export const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** The spec vector's TEST-ONLY operation-token key (kid `k1`). */
export const OPERATION_KEY = new Uint8Array(Buffer.from(NEAR_INTENTS_VECTORS.operation_token.key_hex, "hex"));

/** How the rails mock answers `createExecution` (near-intents quotes). */
export interface QuoteControl {
  /** Answer with this rails error code instead of quoting (`internal` → a plain 500). */
  fail: string | null;
  /** Rewrites the execution rails returns (integrity tests). */
  mutate: ((x: Execution) => Execution) | null;
  /** Bodies rails received. */
  readonly calls: Record<string, unknown>[];
  /** Deposit memo for the next quotes (origins that need one). */
  memo: string | null;
}
export const TEST_TREASURY = "treasury.nearpay.near";
export const LIVE_TREASURY = "treasury.nearpay-live.near";
export const RELAYER = "relayer.nearpay.near";
/** A native origin coin without a contract (the entry's `asset` is its Intents id). */
export const SOL_ASSET = "nep141:sol.omft.near";

export interface Merchant {
  readonly account: `acct_${string}`;
  readonly payTo: string;
}

export interface MerchantOptions {
  liveEnabled?: boolean;
  type?: "intents_account" | "chain_address";
  payTo?: string;
  minFeeUsdMicros?: number;
  feeBps?: number;
}

export interface Session {
  readonly id: `cs_${string}`;
  /** The session's payment intent (`PublicCheckoutSession.payment_intent`, spec 0.1.5). */
  readonly paymentIntent: `pi_${string}`;
  readonly secret: string;
  status: "open" | "expiring" | "complete" | "expired";
  readonly merchant: Merchant;
  readonly livemode: boolean;
  attempt: Record<string, unknown> | null;
}

/** A refund leg from an Intents account: rails' execution and payments' refund (mutable for tests). */
export interface RefundLeg extends Leg {
  readonly refund: `re_${string}`;
  execution: Execution;
  /** payments' `Refund` as `getInternalRefund` returns it. */
  object: Record<string, unknown>;
}

export interface Stack {
  readonly pg: Started;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly ap: Agentpay;
  readonly url: string;
  readonly batcher: { service: Service; ap: Agentpay; batcher: Batcher };
  readonly identity: MockPeer;
  readonly rails: MockPeer;
  readonly payments: MockPeer;
  readonly compliance: MockPeer;
  /** Sentinel mock answering `getKillSwitch` (spec 0.2.1) with {@link Stack.killSwitch}. */
  readonly sentinel: MockPeer;
  readonly killSwitch: { engaged: boolean; version: number; fail: boolean };
  readonly sandbox: MockPeer;
  /** Sandbox (test mode) Verifier. */
  readonly testVerifier: FakeVerifier;
  /** Fake NEAR RPC (live mode) and its Verifier. */
  readonly rpc: FakeRpc;
  readonly relayerKeys: readonly RelayerKey[];
  /** The real sandbox, when started with `realSandbox`. */
  readonly realSandbox: RealSandbox | null;
  readonly executions: Map<string, Execution>;
  /** near-intents quotes (rails `createExecution`). */
  readonly quotes: QuoteControl;
  readonly sessions: Map<string, Session>;
  readonly refunds: Map<string, Record<string, unknown>>;
  /** payments serves `getPayerCheckoutSession` (CR-15-15); false answers like a payments without the route. */
  payerRoute: boolean;
  merchant(o?: MerchantOptions): Merchant;
  /** Prepares a refund leg signed by `signer` (the merchant's Intents account) as rails and payments would. */
  refundLeg(m: Merchant, signer: Signer, o?: Partial<LegOptions> & { livemode?: boolean }): RefundLeg;
  token(
    m: Merchant,
    o?: { livemode?: boolean; ptype?: "secret_key" | "restricted_key" | "session"; scp?: string[] },
  ): Promise<string>;
  call(
    method: "GET" | "POST",
    path: string,
    o?: { body?: unknown; token?: string | null; secret?: string; headers?: Record<string, string> },
    // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
  ): Promise<{ status: number; body: any; headers: Headers }>;
  session(m: Merchant, o?: { livemode?: boolean; status?: Session["status"] }): Session;
  /** One batcher round, waiting for the batches it started. */
  tick(): Promise<void>;
  /** Runs the batcher every 50 ms until `pause()`. */
  resume(): void;
  pause(): Promise<void>;
  publishEvent(e: Envelope): Promise<void>;
  probe(filter?: string): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  config?: Partial<BatcherConfig>;
  deps?: Partial<ServiceDeps>;
  batcherDeps?: Partial<BatcherDeps>;
  /** Start with the batcher loop running (default true). */
  autoBatch?: boolean;
  /** Run the real nearpay-sandbox image as the test-mode Verifier instead of the mock. */
  realSandbox?: boolean;
  /** Leave the kill-switch state unknown at start (tests of the boot read). */
  killSwitchUnknown?: boolean;
}

export function relayerKey(): RelayerKey {
  const seed = new Uint8Array(randomBytes(32));
  const pub = ed25519.getPublicKey(seed);
  return { publicKey: nearPublicKey(pub), secretKey: `ed25519:${bs58.encode(new Uint8Array([...seed, ...pub]))}` };
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats, valkey] = await Promise.all([startPostgres({ database: "postgres" }), startNats(), startValkey()]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "agentpay");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const admin = createDb<DB>({ url: appUrl, applicationName: "agentpay-test" });

  // ---- identity: settlement contexts
  const merchants = new Map<string, Required<MerchantOptions> & { sd: string }>();
  const identity = await mockPeer({ service: "identity", routes: INTERNAL_ROUTES });
  identity.on(getSettlementContext, async (ctx) => {
    const m = merchants.get(ctx.params.id);
    if (!m) throw new Error(`unknown account ${ctx.params.id}`);
    const lm = ctx.query.livemode as unknown as boolean;
    const d = internalSettlementDestination({
      id: m.sd as `sd_${string}`,
      account: ctx.params.id as `acct_${string}`,
      livemode: lm,
      asset_id: USDC_NEAR,
      type: m.type,
      chain: "near:mainnet",
      address: m.payTo,
      address_norm: m.payTo,
      status: "active",
      verification: "test",
      is_default: true,
    });
    return {
      account: account({ id: ctx.params.id as `acct_${string}`, live_enabled: m.liveEnabled }),
      fee_schedule: {
        id: newId("fs"),
        name: "standard",
        rules: {
          same_asset: { total_bps: 30, min_fee_usd_micros: 0 },
          stable_pair: { total_bps: 50, min_fee_usd_micros: 0 },
          volatile: { total_bps: 100, min_fee_usd_micros: 0 },
          intents_transfer: { total_bps: m.feeBps, min_fee_usd_micros: m.minFeeUsdMicros },
        },
        provider_split: { oneclick: { share_bps: 5000, floor_bps: 20, stable_floor_bps: 1 } },
      },
      destinations: [d],
      defaults: { "*": m.sd },
      context_version: new Date().toISOString(),
    } as never;
  });

  // ---- rails: assets and executions
  const executions = new Map<string, Execution>();
  const rails = await mockPeer({ service: "rails", routes: INTERNAL_ROUTES });
  rails.on(getInternalAsset, async (ctx) => {
    if (ctx.params.asset_id === BASE_USDC)
      return {
        asset_id: BASE_USDC,
        chain: "eip155:8453",
        blockchain: "base",
        symbol: "USDC",
        decimals: 6,
        family: "USDC",
        is_usd_stable: true,
        price_usd: "1",
        price_ok: true,
        as_of: new Date().toISOString(),
        token: { standard: "erc20", address: BASE_USDC_CONTRACT },
      } as never;
    if (ctx.params.asset_id === SOL_ASSET)
      return {
        asset_id: SOL_ASSET,
        chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        blockchain: "sol",
        symbol: "SOL",
        decimals: 9,
        family: "SOL",
        is_usd_stable: false,
        price_usd: "150",
        price_ok: true,
        as_of: new Date().toISOString(),
        token: { standard: "native", address: null },
      } as never;
    if (ctx.params.asset_id !== USDC_NEAR)
      mockError("asset_unsupported", { params: { asset_id: ctx.params.asset_id } });
    return {
      asset_id: USDC_NEAR,
      chain: "near:mainnet",
      blockchain: "near",
      symbol: "USDC",
      decimals: 6,
      family: "USDC",
      is_usd_stable: true,
      price_usd: "1",
      price_ok: true,
      as_of: new Date().toISOString(),
    };
  });
  rails.on(
    listChainProfiles,
    async () =>
      ({
        profiles: [
          {
            chain: "eip155:8453",
            blockchain: "base",
            family: "evm",
            tier: "A",
            min_deadline_s: 120,
            default_deadline_s: 1800,
            finality: "12 blocks",
            verification_timeout_s: 600,
            memo_mode: "none",
            explorer_tx_url: "https://basescan.org/tx/{tx}",
          },
          {
            chain: "near:mainnet",
            blockchain: "near",
            family: "near",
            tier: "A",
            min_deadline_s: 60,
            default_deadline_s: 600,
            finality: "final",
            verification_timeout_s: 300,
            memo_mode: "none",
            explorer_tx_url: "https://nearblocks.io/txns/{tx}",
          },
        ],
      }) as never,
  );
  rails.on(
    listInternalOptions,
    async (ctx) =>
      ({
        options: [
          {
            method: "route_quote",
            origin_asset_id: BASE_USDC,
            chain: "eip155:8453",
            symbol: "USDC",
            decimals: 6,
            estimated_amount_in: ((BigInt(ctx.query.amount_out) * 1012n) / 1000n).toString(),
            route_class: "stable_pair",
            applied_fee_bps: 50,
            min_deadline_s: 120,
            available: true,
            reason: null,
          },
        ],
      }) as never,
  );
  const quotes: QuoteControl = { fail: null, mutate: null, calls: [], memo: null };
  rails.on(createExecution, async (ctx) => {
    const b = ctx.body as unknown as Record<string, never> & {
      idempotency_key: string;
      x402_binding: string;
      account_id: `acct_${string}`;
      livemode: boolean;
      origin: { asset_id: string; chain: string; refund_to: string };
      destination: { address: string };
      pricing: { amount: string };
      deadline_cap: string;
    };
    quotes.calls.push(structuredClone(b));
    if (quotes.fail === "internal") throw new Error("rails exploded");
    if (quotes.fail)
      mockError(quotes.fail as never, { params: { chain: b.origin.chain, asset_id: b.origin.asset_id } as never });
    const existing = [...executions.values()].find(
      (x) => (x as { x402_binding?: string }).x402_binding === b.x402_binding,
    );
    if (existing) return existing;
    const deadline = new Date(Math.floor(Math.min(Date.parse(b.deadline_cap), Date.now() + 1_800_000) / 1000) * 1000);
    let x = quoteExecution({
      account: b.account_id,
      livemode: b.livemode,
      binding: b.x402_binding,
      payTo: b.destination.address,
      amount: b.pricing.amount,
      refundTo: b.origin.refund_to,
      network: b.origin.chain,
      originAsset: b.origin.asset_id,
      depositAddress: `0x${randomBytes(20).toString("hex")}`,
      depositMemo: quotes.memo,
      deadline: deadline.toISOString(),
    });
    if (quotes.mutate) x = quotes.mutate(x);
    executions.set(x.id, x);
    return x;
  });
  rails.on(submitExecutionDepositTx, async (ctx) => {
    const x = executions.get(ctx.params.id);
    if (!x) mockError("resource_missing", { params: { object: "execution", id: ctx.params.id } });
    const ex = x as Execution;
    if (["succeeded", "refunded", "failed"].includes(ex.state)) mockError("state_conflict");
    if (!ex.deposit_tx_hashes.includes(ctx.body.tx_hash))
      executions.set(ex.id, { ...ex, deposit_tx_hashes: [...ex.deposit_tx_hashes, ctx.body.tx_hash] });
    return undefined as never;
  });
  rails.on(getExecution, async (ctx) => {
    const x = executions.get(ctx.params.id);
    if (!x) mockError("resource_missing", { params: { object: "execution", id: ctx.params.id } });
    return x as Execution;
  });

  // ---- payments: payer session reads (client secret) and agent attempts
  const sessions = new Map<string, Session>();
  const payments = await mockPeer({ service: "payments", routes: [...PUBLIC_ROUTES, ...INTERNAL_ROUTES] });
  const refunds = new Map<string, Record<string, unknown>>();
  const state = { payerRoute: true };
  const payerView = (id: string, secret: string | undefined): Session => {
    const s = sessions.get(id);
    if (!s || s.secret !== secret) mockError("client_secret_invalid");
    return s as Session;
  };
  payments.on(getPayerCheckoutSession, async (ctx) => {
    if (!state.payerRoute)
      mockError("resource_missing", { message: `Unrecognized request URL (GET ${ctx.params.id}).` });
    const ss = payerView(ctx.params.id, ctx.headers["x-nearpay-client-secret"] as string | undefined);
    return { account_id: ss.merchant.account, livemode: ss.livemode, session: publicSession(ss) } as never;
  });
  payments.on(getInternalRefund, async (ctx) => {
    const r = refunds.get(ctx.params.id);
    if (!r) mockError("resource_missing", { params: { object: "refund", id: ctx.params.id } });
    return r as never;
  });
  payments.on(getPublicCheckoutSession, async (ctx) =>
    publicSession(payerView(ctx.params.id, ctx.headers["x-nearpay-client-secret"] as string | undefined)),
  );
  function publicSession(ss: Session) {
    return {
      id: ss.id,
      object: "checkout_session",
      livemode: ss.livemode,
      status: ss.status,
      payment_intent: ss.paymentIntent,
      intent_status: "requires_payment",
      amount: 200,
      currency: "usd",
      asset_id: null,
      display: { merchant_name_unverified: "Acme Coffee", description: "Flat white" },
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      settlement: { asset_id: USDC_NEAR, chain: "near:mainnet", type: "intents_account" },
      ui_mode: "hosted",
      allowed_origins: [],
      success_url: "https://shop.example/thanks",
      cancel_url: null,
      attempt: ss.attempt as never,
    } as never;
  }
  payments.on(createAgentAttempt, async (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s) mockError("resource_missing", { params: { object: "checkout_session", id: ctx.params.id } });
    const ss = s as Session;
    if (ss.status !== "open") mockError("session_not_open");
    if (ss.merchant.payTo.endsWith(".chain"))
      mockError("destination_not_intents_account", { params: { asset_id: USDC_NEAR } });
    const binding = `np1:${bs58.encode(randomBytes(32))}`;
    const requirement = {
      pay_to: ss.merchant.payTo,
      token: USDC_NEAR,
      amount: "2000000",
      fee_to: ss.livemode ? LIVE_TREASURY : TEST_TREASURY,
      fee_amount: "6000",
      binding,
      deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const x = execution({
      account_id: ss.merchant.account,
      livemode: ss.livemode,
      method: "intents_transfer",
      provider: "direct_intents",
      route_class: "intents_transfer",
      provider_status: null,
      deposit: null,
      intents_requirement: requirement,
      origin: { asset_id: USDC_NEAR, chain: "near:mainnet", refund_to: ctx.body.payer_wallet, refund_type: "intents" },
    } as never);
    executions.set(x.id, x);
    const attemptId = newId("pa");
    const ticket = `${Buffer.from("{}").toString("base64url")}.${randomBytes(64).toString("base64url")}`;
    ss.attempt = {
      id: attemptId,
      object: "payment_attempt",
      livemode: ss.livemode,
      status: "awaiting_deposit",
      method: "intents_transfer",
      visible: true,
      origin_asset_id: USDC_NEAR,
      deposit: null,
      intents_requirement: requirement,
      attestation_ticket: ticket,
      failure_code: null,
      refunded_amount: null,
    };
    return {
      attempt_id: attemptId,
      execution_id: x.id,
      account_id: ss.merchant.account,
      livemode: ss.livemode,
      intents_requirement: requirement,
      attestation_ticket: ticket,
    };
  });

  // ---- compliance: screening (`sanctioned` accounts are blocked)
  const compliance = await mockPeer({ service: "compliance", routes: INTERNAL_ROUTES });
  compliance.on(createScreening, async (ctx) => ({
    screening_id: newId("scr"),
    decision: ctx.body.subject.includes("sanctioned") ? ("block" as const) : ("allow" as const),
    risk: null,
    reasons: [],
    cached: false,
    post_screen_required: false,
  }));

  // ---- sentinel: kill-switch state (spec 0.2.1 getKillSwitch)
  const killSwitch = { engaged: false, version: 0, fail: false };
  const sentinel = await mockPeer({ service: "sentinel", routes: INTERNAL_ROUTES });
  sentinel.on(getKillSwitch, async () => {
    if (killSwitch.fail) mockError("rail_unavailable");
    return {
      engaged: killSwitch.engaged,
      reason: "test",
      actor: "sentinel",
      updated_at: new Date().toISOString(),
      version: killSwitch.version,
    };
  });

  // ---- sandbox: simulated Verifier (test mode)
  const testVerifier = new FakeVerifier();
  const sandbox = await mockPeer({ service: "sandbox", routes: INTERNAL_ROUTES });
  const reject = (e: unknown): never => {
    if (e instanceof Rejection)
      e.kind === "insufficient"
        ? mockError("insufficient_balance", { message: `Smart contract panicked: ${e.message}` })
        : mockError("intent_invalid", { params: { reason: e.message } });
    throw e;
  };
  let block = 1_000;
  sandbox.on(sandboxSimulateIntents, async (ctx) => {
    try {
      const executed = testVerifier.run(ctx.body.signed, false);
      return {
        intents_executed: executed as never,
        logs: [],
        min_deadline: new Date().toISOString(),
        state: { fee: 0, current_salt: "5a0dbe11" },
      };
    } catch (e) {
      return reject(e);
    }
  });
  sandbox.on(sandboxExecuteIntents, async (ctx) => {
    const tx = bs58.encode(randomBytes(32));
    block++;
    const injected = testVerifier.failExecute?.(ctx.body.signed) ?? null;
    if (injected)
      return {
        tx_hash: tx,
        block_height: block,
        status: "failure" as const,
        failure: `Smart contract panicked: ${injected}`,
        intents_executed: [],
      };
    try {
      const executed = testVerifier.run(ctx.body.signed, true);
      return {
        tx_hash: tx,
        block_height: block,
        status: "success" as const,
        failure: null,
        intents_executed: executed as never,
      };
    } catch (e) {
      return {
        tx_hash: tx,
        block_height: block,
        status: "failure" as const,
        failure: `Smart contract panicked: ${(e as Error).message}`,
        intents_executed: [],
      };
    }
  });

  const real = o.realSandbox ? await startSandbox(pg.url) : null;
  const rpc = await startFakeRpc();
  const keys = [relayerKey(), relayerKey()];

  const config: BatcherConfig = {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    valkeyUrl: valkey.url,
    identityUrl: identity.url,
    serviceClientSecret: "unused",
    paymentsUrl: payments.url,
    railsUrl: rails.url,
    complianceUrl: compliance.url,
    sentinelUrl: sentinel.url,
    sandboxBaseUrl: real?.url ?? sandbox.url,
    nearRpcUrls: [rpc.url],
    intentsContract: "intents.near",
    treasuryAccount: LIVE_TREASURY,
    testTreasuryAccount: TEST_TREASURY,
    relayerAccount: RELAYER,
    gasPerPayloadTgas: 15,
    settleWaitMs: 8_000,
    requirementTtlMaxS: 300,
    requirementRatePerS: 200,
    payerRatePerS: 10,
    x402SlippageBps: { min: 10, max: 300, default: 50 },
    x402QuoteRatePerS: { account: 50, refund_to: 20 },
    x402OriginsMax: 20,
    piiKek: randomBytes(32).toString("base64"),
    natsUrl: nats.url,
    batchTickMs: 50,
    ...(o.config as object),
  } as BatcherConfig;
  const deps: ServiceDeps = {
    keys: testKeySource(),
    serviceToken: testServiceToken("agentpay"),
    operationKeys: { signing: { kid: "k1", key: OPERATION_KEY }, all: new Map([["k1", OPERATION_KEY]]) },
    ...o.deps,
  };
  const { service: api, ap } = createApi(config, {
    ...deps,
    database: createDb<DB>({ url: appUrl, applicationName: "agentpay-api-test" }),
  });
  const { port } = await api.start();
  // the boot read runs in the background; make the state known before any live test (spec 0.2.1)
  if (o.killSwitchUnknown !== true) await readKillSwitch(ap, { force: true });
  const b = await createBatcher(config, {
    ...deps,
    database: createDb<DB>({ url: appUrl, applicationName: "agentpay-batcher-test" }),
    relayerKeys: keys,
    manualTicks: true,
    tickMs: 50,
    ...o.batcherDeps,
  });
  await b.service.start();
  await b.batcher.recover();
  const bus: Bus = await connectBus({ url: nats.url, name: "agentpay-test-publisher" });
  const url = `http://127.0.0.1:${port}`;

  let loop: { stop: boolean; done: Promise<void> } | null = null;
  const tick = async () => {
    await b.batcher.tick();
    await b.batcher.drain();
  };
  const stack: Stack = {
    pg,
    admin,
    api,
    ap,
    url,
    batcher: b,
    identity,
    rails,
    payments,
    compliance,
    sentinel,
    killSwitch,
    sandbox,
    testVerifier,
    rpc,
    relayerKeys: keys,
    realSandbox: real,
    executions,
    quotes,
    sessions,
    refunds,
    get payerRoute() {
      return state.payerRoute;
    },
    set payerRoute(v: boolean) {
      state.payerRoute = v;
    },
    refundLeg(m, signer, o = {}) {
      const livemode = o.livemode ?? false;
      const l = buildLeg(signer, { token: USDC_NEAR, amount: "1500000", ...o });
      const refund = newId("re") as `re_${string}`;
      const pi = newId("pi");
      const x = execution({
        account_id: m.account,
        livemode,
        kind: "refund",
        method: "intents_transfer",
        provider: "direct_intents",
        route_class: "intents_transfer",
        provider_status: null,
        deposit: null,
        intents_requirement: null,
        origin: { asset_id: USDC_NEAR, chain: "near:mainnet", refund_to: signer.account, refund_type: "intents" },
        settlement: {
          asset_id: USDC_NEAR,
          amount_base: l.transfer.amount,
          tag: "0",
          expected: l.transfer.amount,
          recipient: l.transfer.receiver_id,
          recipient_type: "intents",
          chain: "near:mainnet",
        },
        reference: { payment_intent: pi, payment_attempt: null, refund, refund_leg: 1 },
        refund: {
          swap_type: null,
          amount: l.transfer.amount,
          amount_out_expected: l.transfer.amount,
          min_amount_out: null,
          token: null,
          transfer: l.transfer,
        },
      } as never);
      executions.set(x.id, x);
      const now = Math.floor(Date.now() / 1000);
      const object: Record<string, unknown> = {
        id: refund,
        object: "refund",
        created: now,
        livemode,
        status: "requires_action",
        payment_intent: pi,
        payment_attempt: newId("pa"),
        amount: l.transfer.amount,
        asset_id: USDC_NEAR,
        decimals: 6,
        fee_mode: "payer_absorbs",
        reason: "requested_by_customer",
        method: "intents_transfer",
        recipient: {
          address: l.transfer.receiver_id,
          asset_id: USDC_NEAR,
          chain: "near:mainnet",
          type: "intents",
          overridden: false,
        },
        next_action: l.nextAction,
        legs: [
          {
            number: 1,
            status: "awaiting_signature",
            method: "intents_transfer",
            swap_type: null,
            amount: l.transfer.amount,
            amount_out_expected: l.transfer.amount,
            deadline: l.nextAction.deadline,
            submitted_tx: null,
            duplicate: false,
            evidence: null,
            failure_code: null,
            created: now,
          },
        ],
        amount_received: null,
        evidence: null,
        extra_amount_sent: "0",
        source: "api",
        failure_code: null,
        succeeded_at: null,
        canceled_at: null,
        sequence: 1,
        metadata: {},
      };
      refunds.set(refund, object);
      const rl: RefundLeg = {
        ...l,
        refund,
        get execution() {
          return executions.get(x.id) as Execution;
        },
        set execution(v: Execution) {
          executions.set(x.id, v);
        },
        get object() {
          return refunds.get(refund) as Record<string, unknown>;
        },
        set object(v: Record<string, unknown>) {
          refunds.set(refund, v);
        },
      };
      return rl;
    },
    merchant(m = {}) {
      const acct = newId("acct");
      const payTo = m.payTo ?? `m${randomBytes(4).toString("hex")}.near`;
      merchants.set(acct, {
        liveEnabled: m.liveEnabled ?? true,
        type: m.type ?? "intents_account",
        payTo,
        minFeeUsdMicros: m.minFeeUsdMicros ?? 0,
        feeBps: m.feeBps ?? 30,
        sd: newId("sd"),
      });
      return { account: acct, payTo };
    },
    token: (m, t = {}) =>
      mintTestToken({
        sub: newId("key"),
        acct: m.account,
        lm: t.livemode ?? false,
        ptype: t.ptype ?? "secret_key",
        scp: t.scp ?? [],
      } as never),
    async call(method, path, c = {}) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(c.token ? { "x-nearpay-token": c.token } : {}),
          ...(c.secret ? { "x-nearpay-client-secret": c.secret } : {}),
          ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
          ...c.headers,
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
      return { status: res.status, body: body as any, headers: res.headers };
    },
    session(m, s = {}) {
      const id = newId("cs");
      const tail = randomBytes(24)
        .toString("base64")
        .replace(/[^A-Za-z0-9]/g, "")
        .padEnd(32, "x")
        .slice(0, 32);
      const session: Session = {
        id,
        paymentIntent: newId("pi") as `pi_${string}`,
        secret: `${id}_secret_${tail}`,
        status: s.status ?? "open",
        merchant: m,
        livemode: s.livemode ?? false,
        attempt: null,
      };
      sessions.set(id, session);
      return session;
    },
    tick,
    resume() {
      if (loop) return;
      const l = { stop: false, done: Promise.resolve() };
      l.done = (async () => {
        while (!l.stop) {
          await tick().catch(() => {});
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      loop = l;
    },
    async pause() {
      if (!loop) return;
      loop.stop = true;
      await loop.done;
      loop = null;
    },
    async publishEvent(e) {
      await publish(bus, e.subject, e, e.id);
    },
    probe: (filter = "evt.agentpay.>") => eventProbe(nats.url, filter),
    async stop() {
      await stack.pause();
      await b.service.stop().catch(() => {});
      await api.stop().catch(() => {});
      await bus.close().catch(() => {});
      for (const m of [identity, rails, payments, compliance, sentinel, sandbox]) await m.stop().catch(() => {});
      await rpc.stop();
      await real?.stop();
      await admin.close();
      await valkey.stop().catch(() => {});
      await nats.stop().catch(() => {});
      await pg.stop().catch(() => {});
    },
  };
  if (o.autoBatch !== false) stack.resume();
  return stack;
}

/** The uuid of a public id, for direct table reads. */
export const uuid = (id: string, prefix: Parameters<typeof toUuid>[1]) => toUuid(id, prefix);

/** Settle/verify body for issued requirements and a signed payload. */
export function x402Body(required: { accepts: unknown[] }, signed: unknown) {
  const accepted = required.accepts[0] as Record<string, unknown>;
  return {
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: structuredClone(accepted), payload: { signed } },
    paymentRequirements: structuredClone(accepted),
  };
}

/** Terms of an issued requirement (`accepts[0]`), for `payer.sign`. */
export function termsOf(required: { accepts: unknown[] }) {
  const a = required.accepts[0] as {
    payTo: string;
    asset: string;
    amount: string;
    extra: { fee: { to: string; amount: string }; binding: string };
  };
  return {
    payTo: a.payTo,
    asset: a.asset,
    amount: a.amount,
    feeTo: a.extra.fee.to,
    fee: a.extra.fee.amount,
    binding: a.extra.binding,
  };
}
