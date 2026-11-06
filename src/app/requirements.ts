/**
 * `POST /x402/requirements` (lld/agentpay.md §3, §5): single-use PaymentRequirements for one 402
 * response. `payTo` is an active Intents-account destination of the merchant (default: the asset's,
 * then the account's default destination); the fee is the `intents_transfer` rule of the account's fee
 * schedule (min fee at the asset's USD price); the binding hashes every field plus 16 random bytes.
 */
import type { PaymentRequired, PaymentRequirements } from "@nearpay/spec";
import { X402_NETWORK, X402_SCHEME, X402_TRANSFER_METHOD, X402_VERSION } from "@nearpay/spec";
import { hex } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { InternalSettlementDestination, SettlementContext } from "@nearpay-internal/spec";
import type { z } from "zod";
import { x402Binding } from "../domain/binding/binding.js";
import { unitsForUsdMicros, x402Fee } from "../domain/facilitator-payment/fee.js";
import { type InternalAsset, upstreamCode } from "../infra/clients/peers.js";
import type { ResourceJson } from "../infra/db/schema.js";
import type { Agentpay } from "./context.js";
import { acctId, type Merchant, settlementContext } from "./merchant.js";
import { railUnavailable } from "./verifier.js";

export interface RequirementsInput {
  resource: ResourceJson;
  amount: string;
  asset_id?: string | undefined;
  pay_to?: string | undefined;
  max_timeout_s: number;
}

type Destination = InternalSettlementDestination;

function isIntents(d: Destination | undefined): d is Destination {
  return d !== undefined && d.type === "intents_account" && d.status === "active";
}

/** The merchant Intents account to pay (§5 `destination_not_intents_account`). */
export function resolveDestination(ctx: SettlementContext, payTo?: string, assetId?: string): Destination {
  const intents = ctx.destinations.filter(isIntents);
  const byId = (id: string | undefined) => ctx.destinations.find((d) => d.id === id);
  let d: Destination | undefined;
  if (payTo) {
    const norm = payTo.toLowerCase();
    const candidates = intents.filter((x) => x.address_norm.toLowerCase() === norm || x.address === payTo);
    d = assetId
      ? candidates.find((x) => x.asset_id === assetId)
      : (candidates.find((x) => x.is_default) ?? candidates[0]);
  } else if (assetId) {
    const def = byId(ctx.defaults[assetId]);
    d = isIntents(def) ? def : intents.find((x) => x.asset_id === assetId);
  } else {
    const def = byId(ctx.defaults["*"]);
    d = isIntents(def) ? def : intents[0];
  }
  if (!d) throw new ApiError("destination_not_intents_account", { params: { asset_id: assetId ?? "any asset" } });
  return d;
}

async function assetInfo(ap: Agentpay, assetId: string, livemode: boolean): Promise<InternalAsset> {
  try {
    return await ap.caches.assets.get(`${livemode}:${assetId}`, () => ap.rails.asset(assetId, livemode));
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "asset_unsupported" || u.status === 404)
      throw new ApiError("asset_unsupported", { params: { asset_id: assetId }, param: "asset_id" });
    throw railUnavailable("asset registry unavailable");
  }
}

export async function issueRequirements(
  ap: Agentpay,
  m: Merchant,
  body: RequirementsInput,
): Promise<z.input<typeof PaymentRequired>> {
  if (!(await ap.limiter.take(`req:${m.account}:${m.livemode}`, ap.settings.requirementRatePerS)))
    throw new ApiError("rate_limited", { headers: { "Retry-After": "1" } });
  if (body.max_timeout_s > ap.settings.requirementTtlMaxS)
    throw ApiError.invalid(`max_timeout_s must be at most ${ap.settings.requirementTtlMaxS}`, "max_timeout_s");
  const ctx = await settlementContext(ap, m);
  if (m.livemode && !ctx.account.live_enabled)
    throw new ApiError("account_not_live", { params: { missing: "live mode" } });
  const feeTo = m.livemode ? ap.settings.treasury : ap.settings.testTreasury;
  if (!feeTo) throw railUnavailable("live treasury not configured");

  const dest = resolveDestination(ctx, body.pay_to, body.asset_id);
  const assetId = body.asset_id ?? dest.asset_id;
  const asset = await assetInfo(ap, assetId, m.livemode);
  const rule = ctx.fee_schedule.rules.intents_transfer;
  const minFee = unitsForUsdMicros(BigInt(rule.min_fee_usd_micros), asset);
  if (minFee === null) throw new ApiError("pricing_unavailable", { params: { asset_id: assetId } });
  const amount = BigInt(body.amount);
  const minimum = minFee > 1n ? minFee : 1n;
  if (amount < minimum)
    throw new ApiError("amount_below_minimum", {
      params: { minimum: `${minimum} base units of ${assetId}` },
      param: "amount",
    });
  const fee = x402Fee(amount, rule.total_bps, minFee);

  const nowS = Math.floor(ap.now() / 1000);
  const expiresAt = nowS + body.max_timeout_s;
  const nonce16 = hex(ap.randomBytes(16));
  const payTo = dest.address;
  const binding = x402Binding({
    account_id: acctId(m),
    resource_url: body.resource.url,
    payTo,
    asset: assetId,
    amount: amount.toString(),
    fee: fee.toString(),
    nonce16,
    expires_at: expiresAt,
  });
  const resource: ResourceJson = {
    url: body.resource.url,
    ...(body.resource.description !== undefined ? { description: body.resource.description } : {}),
    ...(body.resource.mimeType !== undefined ? { mimeType: body.resource.mimeType } : {}),
  };
  await ap.db
    .insertInto("issued_requirements")
    .values({
      binding,
      account_id: m.account,
      livemode: m.livemode,
      resource_url: body.resource.url,
      resource: JSON.stringify(resource),
      pay_to: payTo,
      asset_id: assetId,
      amount: amount.toString(),
      fee_to: feeTo,
      fee_amount: fee.toString(),
      max_timeout_s: body.max_timeout_s,
      nonce16,
      expires_at: new Date(expiresAt * 1000),
    })
    .execute();
  const accepts: PaymentRequirements = {
    scheme: X402_SCHEME,
    network: X402_NETWORK,
    amount: amount.toString(),
    asset: assetId,
    payTo,
    maxTimeoutSeconds: body.max_timeout_s,
    extra: {
      assetTransferMethod: X402_TRANSFER_METHOD,
      paymentFlow: "authorization",
      fee: { to: feeTo, amount: fee.toString() },
      binding: binding as PaymentRequirements["extra"]["binding"],
      verifyingContract: "intents.near",
    },
  };
  return { x402Version: X402_VERSION, resource: { ...resource }, accepts: [accepts] };
}
