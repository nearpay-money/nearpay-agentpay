/**
 * Clients for the services agentpay calls (lld/agentpay.md §10), with agentpay's service token. Each
 * call is a spec route, so requests and responses are checked against the contract.
 *
 * | Target                                               | Timeout | Attempts | Breaker |
 * |------------------------------------------------------|---------|----------|---------|
 * | identity settlement context (cached 60 s)            | 1 s     | 2        | yes     |
 * | rails `GET /internal/executions/{id}` (relay check)  | 1 s     | 2        | yes     |
 * | rails `GET /internal/assets/{id}` (fee minimum)      | 1 s     | 2        | yes     |
 * | payments `POST …/agent_attempts` (creates a rails execution) | 8 s | 1 | yes  |
 * | payments `GET /internal/checkout_sessions/{id}/payer` (client secret check, CR-15-15) | 2 s | 2 | yes |
 * | payments `GET …/public` (fallback until payments serves `…/payer`) | 2 s | 2 | yes |
 * | payments `GET /internal/refunds/{id}` (refund relay check) | 1 s | 2 | yes |
 * | compliance `POST /internal/screenings` (cached 24 h) | 1 s     | 1        | yes     |
 * | sandbox `/sim/intents/*` (test mode)                 | 3 s / 10 s | 1     | no      |
 */

import type { getPublicCheckoutSession, RouteBody, RouteResponse } from "@nearpay/spec";
import { HttpError, httpClient, TimeoutError } from "@nearpay-internal/http";
import {
  createAgentAttempt,
  createScreening,
  type Execution,
  getExecution,
  getInternalAsset,
  getInternalRefund,
  getKillSwitch,
  getPayerCheckoutSession,
  getSettlementContext,
  type SettlementContext,
  sandboxExecuteIntents,
  sandboxSimulateIntents,
} from "@nearpay-internal/spec";

const BREAKER = { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 } as const;

export interface PeerOptions {
  readonly serviceToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
}

/** An upstream answered with a NearPay error (4xx/5xx with an envelope) or could not be reached. */
export function upstreamCode(e: unknown): {
  code: string | null;
  status: number | null;
  timeout: boolean;
  message: string | null;
} {
  if (e instanceof HttpError)
    return { code: e.error?.code ?? null, status: e.status, timeout: false, message: e.error?.message ?? null };
  if (e instanceof TimeoutError) return { code: null, status: null, timeout: true, message: null };
  return { code: null, status: null, timeout: false, message: null };
}

export type InternalAsset = RouteResponse<typeof getInternalAsset>;
export type AgentAttempt = RouteResponse<typeof createAgentAttempt>;
export type PublicSession = RouteResponse<typeof getPublicCheckoutSession>;
export type PayerSession = RouteResponse<typeof getPayerCheckoutSession>;
export type InternalRefund = RouteResponse<typeof getInternalRefund>;
export type Screening = RouteResponse<typeof createScreening>;
export type ScreeningBody = RouteBody<typeof createScreening>;
export type SimulateOutput = RouteResponse<typeof sandboxSimulateIntents>;
export type SimExecuteOutput = RouteResponse<typeof sandboxExecuteIntents>;

export interface Identity {
  settlementContext(accountId: string, livemode: boolean): Promise<SettlementContext>;
}

export function identityClient(o: PeerOptions & { baseUrl: string }): Identity {
  const c = httpClient({
    target: "identity",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    settlementContext: (id, lm) =>
      c.call(getSettlementContext, { params: { id }, query: { livemode: lm ? "true" : "false" } }),
  };
}

export interface Rails {
  getExecution(id: string): Promise<Execution>;
  asset(assetId: string, livemode: boolean): Promise<InternalAsset>;
}

export function railsClient(o: PeerOptions & { baseUrl: string }): Rails {
  const c = httpClient({
    target: "rails",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    getExecution: (id) => c.call(getExecution, { params: { id } }),
    asset: (assetId, livemode) =>
      c.call(getInternalAsset, { params: { asset_id: assetId }, query: { livemode: livemode ? "true" : "false" } }),
  };
}

export interface Payments {
  createAgentAttempt(sessionId: string, payerWallet: string): Promise<AgentAttempt>;
  /**
   * The payer view of a session plus its account and mode (`getPayerCheckoutSession`, CR-15-15: service
   * token + the caller's client secret); fails with `client_secret_invalid` unless `secret` is the session's.
   */
  payerSession(sessionId: string, secret: string): Promise<PayerSession>;
  /** The refund as payments holds it (its current leg's issued `next_action`). */
  refund(id: string): Promise<InternalRefund>;
}

export function paymentsClient(o: PeerOptions & { baseUrl: string }): Payments {
  const internal = httpClient({
    target: "payments",
    baseUrl: o.baseUrl,
    timeoutMs: 8_000,
    attempts: 1,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const reads = httpClient({
    target: "payments",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    // CR-15-16: `call` adds the route-declared client-secret header and keeps agentpay's service token
    payerSession: (id, secret) =>
      reads.call(getPayerCheckoutSession, { params: { id }, headers: { "x-nearpay-client-secret": secret } }),
    refund: (id) => reads.call(getInternalRefund, { params: { id }, timeoutMs: 1_000 }),
    createAgentAttempt: (id, payerWallet) =>
      internal.call(createAgentAttempt, { params: { id }, body: { payer_wallet: payerWallet } }),
  };
}

export interface Compliance {
  screen(body: ScreeningBody): Promise<Screening>;
}

export function complianceClient(o: PeerOptions & { baseUrl: string }): Compliance {
  const c = httpClient({
    target: "compliance",
    baseUrl: o.baseUrl,
    timeoutMs: 1_000,
    attempts: 1,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { screen: (body) => c.call(createScreening, { body }) };
}

/** Sentinel `getKillSwitch` (spec 0.2.1, scope `sentinel.read`): read while the stored state is unknown. */
export interface Sentinel {
  killSwitch(): Promise<{ engaged: boolean; reason: string; actor: string; version?: number | undefined }>;
}

export function sentinelClient(o: PeerOptions & { baseUrl: string }): Sentinel {
  const c = httpClient({
    target: "sentinel",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 2,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { killSwitch: () => c.call(getKillSwitch) };
}

/** The simulated Verifier (test mode only; it rejects live-mode calls, INV-8). */
export interface SandboxVerifier {
  simulate(signed: readonly unknown[]): Promise<SimulateOutput>;
  execute(signed: readonly unknown[]): Promise<SimExecuteOutput>;
}

export function sandboxClient(o: PeerOptions & { baseUrl: string }): SandboxVerifier {
  const c = httpClient({
    target: "sandbox",
    baseUrl: o.baseUrl,
    timeoutMs: 3_000,
    attempts: 1,
    breaker: false,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    simulate: (signed) => c.call(sandboxSimulateIntents, { body: { signed } }),
    execute: (signed) => c.call(sandboxExecuteIntents, { body: { signed }, timeoutMs: 10_000 }),
  };
}
