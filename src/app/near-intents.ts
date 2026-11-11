/**
 * x402 `exact` + `near-intents` (lld/agentpay.md §3.1, §5): `/x402/near-intents/{requirements,verify,settle}`.
 *
 * Issue — the `intents-transfer` entry first (optional, §3) and one **unquoted** entry per origin, each with its own
 *   single-use binding (`issued_requirements`, `method = near-intents`, entry stored as issued).
 * Quote (verify, `quote` payload) — the echoed entry is the issued one; the binding is claimed (one quote per
 *   entry); rails creates the route execution (owner agentpay, 1Click `EXACT_OUTPUT` into the merchant's Intents
 *   account, `refundTo` screened by rails); an operation row records the instrument and the token's hash; the
 *   answer carries the quote and the operation token (returned only here, never stored or logged).
 * Deposit (verify checks / settle redeems) — token expiry (no lookup), terms, MAC over the recomputed input, the
 *   operation by instrument; settle forwards the deposit tx to rails, then waits for the result the execution
 *   consumer records (§8) and answers with it — the first final response claims it, later ones are `replayed`.
 *   `settlement_pending` is never recorded and never claims.
 *
 * Non-custodial (INV-1): NearPay never holds the deposit. Success only from rails' evidence (INV-2): the result is
 * written by the consumer of `evt.rails.execution.settled`, never from a provider status read here.
 */
import { createHash } from "node:crypto";
import { validateAddress } from "@nearpay-internal/chains";
import { uuidv7 } from "@nearpay-internal/ids";
import { hex } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import type {
  NearIntentsPaymentRequirements,
  NearIntentsSettleResponse,
  NearIntentsVerifyRequest,
  NearIntentsVerifyResponse,
  X402PaymentRequiredAny,
  x402NearIntentsRequirements,
} from "@nearpay-money/spec";
import {
  parseOperationToken,
  X402_NEAR_INTENTS_FLOW,
  X402_NEAR_INTENTS_METHOD,
  X402_NETWORK,
  X402_SCHEME,
  X402_VERSION,
} from "@nearpay-money/spec";
import type { Insertable } from "kysely";
import type { z } from "zod";
import { jcsEqual } from "../domain/binding/binding.js";
import { mintOperationToken, nearIntentsBinding, verifyOperationToken } from "../domain/near-intents/kit.js";
import {
  clampSlippage,
  comparable,
  hasQuotedOnly,
  isPendingState,
  type OperationResult,
  quoteFailure,
  type SettleVerdict,
  tokenExpiry,
  verdictOf,
} from "../domain/near-intents/rules.js";
import { type ChainProfile, upstreamCode } from "../infra/clients/peers.js";
import type { IssuedRequirementsTable } from "../infra/db/schema.js";
import type { Agentpay } from "./context.js";
import { acctId, killSwitchEngaged, killSwitchError, type Merchant, settlementContext } from "./merchant.js";
import { assetInfo, issueIntentsTransfer, resolveDestination, resourceJson } from "./requirements.js";
import { railUnavailable } from "./verifier.js";

type IssueBody = z.output<NonNullable<(typeof x402NearIntentsRequirements)["body"]>>;
type Body = z.output<typeof NearIntentsVerifyRequest>;
type VerifyOut = z.input<typeof NearIntentsVerifyResponse>;
type SettleOut = z.input<typeof NearIntentsSettleResponse>;
type InvalidReason = NonNullable<z.output<typeof NearIntentsVerifyResponse>["invalidReason"]>;
type Entry = NearIntentsPaymentRequirements;

const HOUR_S = 3_600;

// ---------------------------------------------------------------------------------------------- issue

async function chainProfiles(ap: Agentpay): Promise<readonly ChainProfile[]> {
  try {
    return await ap.caches.chainProfiles.get("profiles", () => ap.rails.chainProfiles());
  } catch (e) {
    ap.log.warn({ err: e instanceof Error ? e.message : String(e) }, "chain profiles unavailable");
    throw railUnavailable("chain profiles unavailable");
  }
}

/** Indicative deposit amounts per origin asset (rails options; best effort — never fails issuance). */
async function indicative(
  ap: Agentpay,
  assetId: string,
  amount: string,
  livemode: boolean,
): Promise<Map<string, string>> {
  try {
    const options = await ap.rails.options({ destination_asset: assetId, amount_out: amount, livemode });
    const out = new Map<string, string>();
    for (const o of options)
      if (o.method === "route_quote" && o.available && o.estimated_amount_in)
        out.set(o.origin_asset_id, o.estimated_amount_in);
    return out;
  } catch (e) {
    ap.log.debug({ err: e instanceof Error ? e.message : String(e) }, "indicative amounts unavailable");
    return new Map();
  }
}

export async function issueNearIntents(
  ap: Agentpay,
  m: Merchant,
  body: IssueBody,
): Promise<z.input<typeof X402PaymentRequiredAny>> {
  if (!(await ap.limiter.take(`req:${m.account}:${m.livemode}`, ap.settings.requirementRatePerS)))
    throw new ApiError("rate_limited", { headers: { "Retry-After": "1" } });
  if (!ap.settings.operationKeys) throw railUnavailable("cross-chain x402 is not configured");
  if (body.origins.length > ap.settings.originsMax)
    throw ApiError.invalid(`at most ${ap.settings.originsMax} origins`, "origins");
  const seen = new Set<string>();
  for (const [i, o] of body.origins.entries()) {
    if (seen.has(o.asset_id)) throw ApiError.invalid("origins must be distinct", `origins[${i}].asset_id`);
    seen.add(o.asset_id);
  }
  if (body.include_intents_transfer && body.max_timeout_s > ap.settings.requirementTtlMaxS)
    throw ApiError.invalid(`max_timeout_s must be at most ${ap.settings.requirementTtlMaxS}`, "max_timeout_s");
  const ctx = await settlementContext(ap, m);
  if (m.livemode && !ctx.account.live_enabled)
    throw new ApiError("account_not_live", { params: { missing: "live mode" } });
  if (m.livemode && (await killSwitchEngaged(ap))) throw killSwitchError();

  const dest = resolveDestination(ctx, body.pay_to, body.asset_id);
  const assetId = body.asset_id ?? dest.asset_id;
  await assetInfo(ap, assetId, m.livemode); // the destination asset is in the mode's registry
  const amount = BigInt(body.amount);
  if (amount < 1n)
    throw new ApiError("amount_below_minimum", { params: { minimum: `1 base unit of ${assetId}` }, param: "amount" });
  const resource = resourceJson(body.resource);
  const payTo = dest.address;

  const entries: Entry[] = [];
  const profiles = await chainProfiles(ap);
  const estimates = await indicative(ap, assetId, amount.toString(), m.livemode);
  const nowS = Math.floor(ap.now() / 1000);
  const expiresAt = nowS + body.quote_window_s;
  const rows: Insertable<IssuedRequirementsTable>[] = [];
  for (const [i, o] of body.origins.entries()) {
    const param = `origins[${i}].asset_id`;
    let origin: Awaited<ReturnType<typeof assetInfo>>;
    try {
      origin = await assetInfo(ap, o.asset_id, m.livemode);
    } catch (e) {
      if (e instanceof ApiError && e.code === "asset_unsupported")
        throw new ApiError("asset_unsupported", { params: { asset_id: o.asset_id }, param });
      throw e;
    }
    const profile = profiles.find((p) => p.chain === origin.chain);
    if (!profile) throw new ApiError("asset_unsupported", { params: { asset_id: o.asset_id }, param });
    const maxTimeout = o.max_timeout_s ?? Math.min(86_400, Math.max(60, profile.default_deadline_s));
    if (maxTimeout < profile.min_deadline_s)
      throw new ApiError("deadline_too_short", {
        params: { chain: origin.chain },
        param: `origins[${i}].max_timeout_s`,
      });
    const asset = origin.token?.address ?? o.asset_id;
    const nonce16 = hex(ap.randomBytes(16));
    const binding = nearIntentsBinding({
      method: X402_NEAR_INTENTS_METHOD,
      account_id: acctId(m),
      resource_url: resource.url,
      origin_network: origin.chain,
      origin_asset_id: o.asset_id,
      pay_to: payTo,
      asset_id: assetId,
      amount: amount.toString(),
      max_timeout_s: maxTimeout,
      nonce16,
      expires_at: expiresAt,
    });
    const estimate = estimates.get(o.asset_id);
    const entry: Entry = {
      scheme: X402_SCHEME,
      network: origin.chain,
      amount: "",
      asset,
      payTo: "",
      maxTimeoutSeconds: maxTimeout,
      extra: {
        assetTransferMethod: X402_NEAR_INTENTS_METHOD,
        paymentFlow: X402_NEAR_INTENTS_FLOW,
        destination: { network: X402_NETWORK, asset: assetId, amount: amount.toString(), recipient: payTo },
        ...(estimate !== undefined ? { indicativeAmount: estimate } : {}),
        binding: binding as Entry["extra"]["binding"],
        deadline: new Date(expiresAt * 1000).toISOString(),
        originAssetId: o.asset_id,
        slippageTolerance: { ...ap.settings.slippage },
      },
    };
    entries.push(entry);
    rows.push({
      binding,
      method: "near-intents",
      account_id: m.account,
      livemode: m.livemode,
      resource_url: resource.url,
      resource: JSON.stringify(resource),
      pay_to: payTo,
      asset_id: assetId,
      amount: amount.toString(),
      fee_to: null,
      fee_amount: "0",
      max_timeout_s: maxTimeout,
      nonce16,
      expires_at: new Date(expiresAt * 1000),
      origin_network: origin.chain,
      origin_asset_id: o.asset_id,
      origin_asset: asset,
      entry: JSON.stringify(entry),
    });
  }
  // every origin is valid: now issue (the intents-transfer entry first, §3.1 step 1)
  const accepts: Array<z.input<typeof X402PaymentRequiredAny>["accepts"][number]> = [];
  if (body.include_intents_transfer)
    accepts.push(
      await issueIntentsTransfer(ap, m, ctx, {
        resource,
        amount: body.amount,
        asset_id: assetId,
        pay_to: payTo,
        max_timeout_s: body.max_timeout_s,
      }),
    );
  await ap.db.insertInto("issued_requirements").values(rows).execute();
  accepts.push(...entries);
  return { x402Version: X402_VERSION, resource: { ...resource }, accepts };
}

// ---------------------------------------------------------------------------------------------- shared checks

type RequirementRow = NonNullable<Awaited<ReturnType<typeof loadRequirement>>>;

/** An issued near-intents requirement of this merchant and mode (INV-8). */
async function loadRequirement(ap: Agentpay, m: Merchant, binding: string) {
  return ap.db
    .selectFrom("issued_requirements")
    .selectAll()
    .where("binding", "=", binding)
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("method", "=", "near-intents")
    .executeTakeFirst();
}

interface Bad {
  readonly ok: false;
  readonly reason: InvalidReason;
  readonly message: string;
}
const bad = (reason: InvalidReason, message: string): Bad => ({ ok: false, reason, message });

/** Version and the echoed entries (no DB): `accepted` and `paymentRequirements` are the same unquoted entry. */
function checkShape(body: Body): Bad | null {
  if (body.x402Version !== X402_VERSION || body.paymentPayload.x402Version !== X402_VERSION)
    return bad("invalid_x402_version", "x402Version must be 2");
  const pr = body.paymentRequirements;
  const accepted = body.paymentPayload.accepted;
  if (pr.scheme !== X402_SCHEME || accepted.scheme !== X402_SCHEME)
    return bad("invalid_scheme", "scheme must be exact");
  if (hasQuotedOnly(pr) || hasQuotedOnly(accepted))
    return bad("invalid_payment_requirements", "send the unquoted entry (without the quote fields)");
  if (!accepted.extra.binding) return bad("invalid_payment_requirements", "the entry carries no binding");
  if (!jcsEqual(comparable(accepted), comparable(pr)))
    return bad("invalid_payment_requirements", "accepted does not equal paymentRequirements");
  return null;
}

/** The issued entry, as issued (terms, resource). */
async function checkIssued(ap: Agentpay, m: Merchant, body: Body): Promise<Bad | { ok: true; req: RequirementRow }> {
  const accepted = body.paymentPayload.accepted;
  const req = await loadRequirement(ap, m, accepted.extra.binding as string);
  if (!req) return bad("requirement_unknown", "these requirements were not issued to this account and mode");
  if (!jcsEqual(comparable(req.entry as Entry), comparable(accepted)))
    return bad("invalid_payment_requirements", "the requirements were altered");
  if (body.paymentPayload.resource.url !== req.resource_url)
    return bad("invalid_payment_requirements", "the payload is for another resource");
  return { ok: true, req };
}

// ---------------------------------------------------------------------------------------------- quote

type QuotePayload = Extract<Body["paymentPayload"]["payload"], { type: "quote" }>;

async function quote(ap: Agentpay, m: Merchant, body: Body, payload: QuotePayload): Promise<VerifyOut> {
  const shape = checkShape(body);
  if (shape) return invalidOut(shape);
  const issued = await checkIssued(ap, m, body);
  if (!issued.ok) return invalidOut(issued);
  const req = issued.req;
  const entry = req.entry as Entry;
  if (req.consumed_at) return invalidOut(bad("requirement_consumed", "this entry was already quoted"));
  if (req.expires_at.getTime() <= ap.now())
    return invalidOut(bad("requirement_expired", "this entry can no longer be quoted"));
  const network = entry.network;
  const refund = validateAddress(network, payload.refundTo);
  if (!refund.ok)
    return invalidOut(bad("invalid_payload", `refundTo is not an address on ${network}: ${refund.reason}`));

  const rate = ap.settings.quoteRatePerS;
  if (!(await ap.limiter.take(`xq:acct:${m.account}:${m.livemode}`, rate.account)))
    return invalidOut(bad("quota_exceeded", "the account's quote quota is exhausted"));
  if (!(await ap.limiter.take(`xq:refund:${m.livemode}:${network}:${refund.normalized}`, rate.refund_to)))
    return invalidOut(bad("quota_exceeded", "the refund address's quote quota is exhausted"));
  if (m.livemode && (await killSwitchEngaged(ap))) throw killSwitchError();
  const keys = ap.settings.operationKeys;
  if (!keys) throw railUnavailable("cross-chain x402 is not configured");
  const ctx = await settlementContext(ap, m);

  // one quote per entry: a concurrent second quote loses here
  const claimedAt = new Date(ap.now());
  const claimed = await ap.db
    .updateTable("issued_requirements")
    .set({ consumed_at: claimedAt })
    .where("binding", "=", req.binding)
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", claimedAt)
    .returning("binding")
    .executeTakeFirst();
  if (!claimed) return invalidOut(bad("requirement_consumed", "this entry was already quoted"));
  const release = () =>
    ap.db
      .updateTable("issued_requirements")
      .set({ consumed_at: null })
      .where("binding", "=", req.binding)
      .where("account_id", "=", m.account)
      .where("livemode", "=", m.livemode)
      .where("consumed_at", "=", claimedAt)
      .execute();

  const slippage = clampSlippage(payload.slippageTolerance, entry.extra.slippageTolerance ?? ap.settings.slippage);
  let x: Execution;
  try {
    x = await ap.rails.createExecution({
      idempotency_key: `x402:${req.binding}`,
      owner: "agentpay",
      x402_binding: req.binding as never,
      kind: "payment",
      method: "route_quote",
      account_id: acctId(m) as never,
      livemode: m.livemode,
      origin: {
        asset_id: req.origin_asset_id as string,
        chain: network,
        refund_to: payload.refundTo,
        refund_type: "origin_chain",
      },
      destination: { asset_id: req.asset_id, type: "intents_account", chain: X402_NETWORK, address: req.pay_to },
      pricing: { currency: "asset", asset_id: req.asset_id, amount: req.amount },
      fee: { schedule: ctx.fee_schedule as never, bearer: "payer" },
      deadline_cap: new Date(ap.now() + req.max_timeout_s * 1000).toISOString(),
      slippage_bps: slippage,
    });
  } catch (e) {
    const u = upstreamCode(e);
    const f = quoteFailure(u.status !== null ? (u.code ?? "unknown") : null);
    if (f.release) await release();
    ap.log.warn({ code: u.code, timeout: u.timeout, released: f.release }, "near-intents quote refused by rails");
    if (f.kind === "invalid")
      return invalidOut(bad(f.reason, `${u.code ?? "refused"}${u.message ? `: ${u.message}` : ""}`));
    if (f.code === "screening_unavailable") throw new ApiError("screening_unavailable");
    throw railUnavailable("route quotes are unavailable");
  }

  const defect = quoteDefect(x, req, m, payload.refundTo, network);
  if (defect) {
    ap.log.error({ execution: x.id, defect }, "ALERT near-intents quote: rails execution does not match the request");
    throw railUnavailable("route quote integrity");
  }
  const dep = x.deposit as NonNullable<Execution["deposit"]>;
  const refundDeadlineMs = Date.parse(x.deadline);
  const expiry = tokenExpiry(refundDeadlineMs);
  const token = mintOperationToken(keys.signing.key, keys.signing.kid, {
    v: 1,
    binding: req.binding,
    network,
    deposit_address: dep.address,
    deposit_memo: dep.memo,
    resource_url: req.resource_url,
    destination: entry.extra.destination,
    expiry,
  });
  try {
    await ap.db
      .insertInto("x402_operations")
      .values({
        id: uuidv7(),
        account_id: m.account,
        livemode: m.livemode,
        binding: req.binding,
        execution_id: x.id,
        network,
        deposit_address: dep.address,
        deposit_memo: dep.memo,
        refund_to: payload.refundTo,
        amount_in: dep.amount_in,
        refund_deadline: new Date(refundDeadlineMs),
        token_sha256: sha256(token),
        token_kid: keys.signing.kid,
        token_expiry: new Date(expiry * 1000),
        status: "quoted",
      })
      .execute();
  } catch (e) {
    ap.log.error(
      { execution: x.id, err: e instanceof Error ? e.message : String(e) },
      "ALERT near-intents quote could not be recorded (deposit instrument or execution already known)",
    );
    throw railUnavailable("route quote could not be recorded");
  }
  ap.metrics.verify("quoted");
  ap.log.info({ execution: x.id, binding: req.binding, network }, "near-intents quote minted");
  return {
    isValid: true,
    extra: {
      depositAddress: dep.address,
      ...(dep.memo !== null ? { depositMemo: dep.memo } : {}),
      amountIn: dep.amount_in,
      minAmountIn: dep.min_amount_in,
      refundDeadline: new Date(refundDeadlineMs).toISOString(),
      operationToken: token,
    },
  };
}

/** Rails' execution must be exactly the requested quote (owner, binding, account, mode, origin, merchant side). */
export function quoteDefect(
  x: Execution,
  req: RequirementRow,
  m: Merchant,
  refundTo: string,
  network: string,
): string | null {
  if (x.owner !== "agentpay") return `owner ${x.owner ?? "(absent)"}`;
  if (x.x402_binding !== req.binding) return "x402_binding differs";
  if (x.account_id !== acctId(m) || x.livemode !== m.livemode) return "account or mode differs";
  if (x.kind !== "payment" || x.method !== "route_quote") return `kind/method ${x.kind}/${x.method}`;
  if (x.state !== "awaiting_deposit") return `state ${x.state}`;
  if (!x.deposit) return "no deposit instructions";
  if (x.deposit.chain !== network || x.origin.chain !== network) return "origin chain differs";
  if (x.origin.asset_id !== req.origin_asset_id) return "origin asset differs";
  if (x.origin.refund_to !== refundTo) return "refund address differs";
  if (x.settlement.asset_id !== req.asset_id || x.settlement.recipient !== req.pay_to) return "merchant side differs";
  if (BigInt(x.settlement.amount_base) !== BigInt(req.amount)) return "settlement amount differs";
  if (BigInt(x.deposit.amount_in) <= 0n) return "empty deposit amount";
  if (!Number.isFinite(Date.parse(x.deadline))) return "no deadline";
  return null;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

function invalidOut(b: Bad): VerifyOut {
  return { isValid: false, invalidReason: b.reason, invalidMessage: b.message };
}

// ---------------------------------------------------------------------------------------------- deposit

type DepositPayload = Extract<Body["paymentPayload"]["payload"], { type: "deposit" }>;
type OperationRow = NonNullable<Awaited<ReturnType<typeof loadOperation>>>;

async function loadOperation(ap: Agentpay, m: Merchant, network: string, address: string, memo: string | null) {
  let q = ap.db
    .selectFrom("x402_operations")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode)
    .where("network", "=", network)
    .where("deposit_address", "=", address);
  q = memo === null ? q.where("deposit_memo", "is", null) : q.where("deposit_memo", "=", memo);
  return q.executeTakeFirst();
}

/** §3.1 step 4 a–b: shape, token expiry (before any lookup), issued terms, MAC, the operation of the instrument. */
async function checkDeposit(
  ap: Agentpay,
  m: Merchant,
  body: Body,
  payload: DepositPayload,
): Promise<Bad | { ok: true; op: OperationRow }> {
  const shape = checkShape(body);
  if (shape) return shape;
  const parsed = parseOperationToken(payload.operationToken);
  if (!parsed) return bad("invalid_exact_near_intents_token_invalid", "the operation token is malformed");
  const nowS = Math.floor(ap.now() / 1000);
  if (parsed.expiry <= nowS) return bad("invalid_exact_near_intents_token_expired", "the operation token expired");
  const issued = await checkIssued(ap, m, body);
  if (!issued.ok) return issued;
  const req = issued.req;
  const keys = ap.settings.operationKeys;
  if (!keys) throw railUnavailable("cross-chain x402 is not configured");
  const memo = payload.depositMemo ?? null;
  const check = verifyOperationToken(
    payload.operationToken,
    keys.all,
    {
      v: 1,
      binding: req.binding,
      network: body.paymentPayload.accepted.network,
      deposit_address: payload.depositAddress,
      deposit_memo: memo,
      resource_url: body.paymentPayload.resource.url,
      destination: (req.entry as Entry).extra.destination,
    },
    nowS,
  );
  if (!check.ok)
    return check.reason === "expired"
      ? bad("invalid_exact_near_intents_token_expired", "the operation token expired")
      : bad("invalid_exact_near_intents_token_invalid", "the operation token does not authorise this deposit");
  const op = await loadOperation(ap, m, body.paymentPayload.accepted.network, payload.depositAddress, memo);
  if (!op || op.binding !== req.binding || !op.token_sha256.equals(sha256(payload.operationToken)))
    return bad("invalid_exact_near_intents_token_invalid", "the operation token does not authorise this deposit");
  return { ok: true, op };
}

export async function verifyNearIntents(ap: Agentpay, m: Merchant, body: Body): Promise<VerifyOut> {
  const payload = body.paymentPayload.payload;
  if (payload.type === "quote") {
    const r = await quote(ap, m, body, payload);
    if (!r.isValid) ap.metrics.verify(r.invalidReason ?? "invalid");
    return r;
  }
  const c = await checkDeposit(ap, m, body, payload);
  ap.metrics.verify(c.ok ? "valid" : c.reason);
  return c.ok ? { isValid: true, payer: c.op.refund_to } : invalidOut(c);
}

// ---------------------------------------------------------------------------------------------- settle

/** Waits until the operation has a recorded result or `waitMs` passed (Valkey `xo:<id>` + 250 ms re-reads). */
async function awaitResult(ap: Agentpay, op: OperationRow, waitMs: number): Promise<OperationRow> {
  const read = () =>
    ap.db
      .selectFrom("x402_operations")
      .selectAll()
      .where("id", "=", op.id)
      .where("account_id", "=", op.account_id)
      .where("livemode", "=", op.livemode)
      .executeTakeFirstOrThrow();
  let row = await read();
  if (row.result !== null || waitMs <= 0) return row;
  const until = ap.now() + waitMs;
  let wake: (() => void) | null = null;
  const unsubscribe = ap.waiters.subscribe(op.id, () => wake?.(), "xo");
  try {
    while (row.result === null && ap.now() < until) {
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(250, Math.max(0, until - ap.now())));
        wake = () => {
          clearTimeout(t);
          r();
        };
      });
      row = await read();
    }
    return row;
  } finally {
    unsubscribe();
  }
}

/** The settle answer for a verdict; final results are claimed by the first response that carries them. */
async function answer(ap: Agentpay, op: OperationRow, v: SettleVerdict, txHash: string): Promise<SettleOut> {
  if (v.kind === "deposit_not_found")
    return {
      success: false,
      transaction: "",
      network: op.network,
      payer: op.refund_to,
      errorReason: "invalid_exact_near_intents_deposit_not_found",
      errorMessage: "this transaction is not a deposit of the operation",
    };
  const claimed = await ap.db
    .updateTable("x402_operations")
    .set({ result_reported_at: new Date(ap.now()) })
    .where("id", "=", op.id)
    .where("account_id", "=", op.account_id)
    .where("livemode", "=", op.livemode)
    .where("result_reported_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  const again = claimed ? {} : { replayed: true };
  if (v.kind === "success")
    return {
      success: true,
      transaction: v.result.transaction,
      network: X402_NETWORK,
      payer: v.result.refund_to,
      amount: v.result.amount,
      ...again,
      extra: {
        originNetwork: v.result.network,
        originTxHash: txHash,
        agentPayment: v.result.agent_payment as `ap_${string}`,
      },
    };
  return {
    success: false,
    transaction: "",
    network: v.result.network,
    payer: v.result.refund_to,
    errorReason: v.result.error_reason,
    errorMessage:
      v.result.error_reason === "exact_near_intents_insufficient_deposit"
        ? "the deposit was incomplete and is refunded to refundTo"
        : "the payment did not reach the merchant; the deposit is refunded to refundTo",
    ...again,
    extra: { ...(v.result.status ? { status: v.result.status.slice(0, 64) } : {}), refundTo: v.result.refund_to },
  };
}

function settleInvalid(network: string, b: Bad, payer?: string): SettleOut {
  return {
    success: false,
    transaction: "",
    network,
    ...(payer ? { payer } : {}),
    errorReason: b.reason,
    errorMessage: b.message,
  };
}

export async function settleNearIntents(ap: Agentpay, m: Merchant, body: Body, deadline: number): Promise<SettleOut> {
  const started = ap.now();
  const network = body.paymentPayload.accepted.network;
  try {
    const payload = body.paymentPayload.payload;
    if (payload.type !== "deposit")
      return settleInvalid(network, bad("invalid_payload", "a quote payload is verified, not settled"));
    const c = await checkDeposit(ap, m, body, payload);
    ap.metrics.verify(c.ok ? "valid" : c.reason);
    if (!c.ok) return settleInvalid(network, c);
    let op = c.op;
    const txHash = payload.txHash;
    if (op.result !== null) return answer(ap, op, verdictOf(op.result as OperationResult, txHash), txHash);

    // best effort: rails records the tx and forwards it to 1Click (idempotent; refused once the execution is final)
    await ap.rails.submitDepositTx(op.execution_id, txHash).catch((e) => {
      const u = upstreamCode(e);
      ap.log.debug({ execution: op.execution_id, code: u.code, timeout: u.timeout }, "deposit tx not forwarded");
    });
    const x = await ap.rails.getExecution(op.execution_id).catch(() => null);
    if (x && x.state === "expired_unpaid" && !x.deposited_amount)
      return settleInvalid(
        op.network,
        bad("invalid_exact_near_intents_deposit_not_found", "no deposit reached the quote before its deadline"),
        op.refund_to,
      );
    const waitMs = Math.min(ap.settings.settleWaitMs, deadline - ap.now() - 750);
    op = await awaitResult(ap, op, waitMs);
    if (op.result !== null)
      return answer(ap, op, verdictOf(op.result as OperationResult, txHash, x?.deposit_tx_hashes ?? []), txHash);
    const status = x ? (x.provider_status ?? x.state) : null;
    return {
      success: false,
      transaction: txHash,
      network: op.network,
      payer: op.refund_to,
      errorReason: "settlement_pending",
      errorMessage:
        x && !isPendingState(x.state)
          ? "the outcome is being recorded; call settle again with the same payload"
          : "the deposit is being processed; call settle again with the same payload",
      ...(status ? { extra: { status: status.slice(0, 64) } } : {}),
    };
  } finally {
    ap.metrics.settleLatency((ap.now() - started) / 1000);
  }
}

/** Purge horizon of operations (§4.1: 30 days after the token expired). */
export const OPERATION_PURGE_AFTER_MS = 30 * 24 * HOUR_S * 1000;
