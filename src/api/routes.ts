/**
 * Spec route bindings (lld/agentpay.md §5). Authentication and scopes (`agentpay.facilitate`,
 * `service:agentpay.relay`) are enforced from the spec by the service bootstrap; checkout routes are
 * open at the gateway and authenticate with the session's client secret, which payments checks.
 */

import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import { relaySignedIntent } from "@nearpay-internal/spec";
import {
  agentPay,
  agentPayRequirements,
  getAgentPayment,
  listAgentPayments,
  x402NearIntentsRequirements,
  x402NearIntentsSettle,
  x402NearIntentsVerify,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay-money/spec";
import * as payments from "../app/agent-payments.js";
import * as checkout from "../app/checkout.js";
import type { Agentpay } from "../app/context.js";
import { type Merchant, merchantOf } from "../app/merchant.js";
import { issueNearIntents, settleNearIntents, verifyNearIntents } from "../app/near-intents.js";
import * as refunds from "../app/refunds.js";
import { issueRequirements } from "../app/requirements.js";
import { settle, supported, verify } from "../app/x402.js";

/** The account principal of a merchant route (secret/restricted key or dashboard session). */
export function merchant(ctx: RequestContext): Merchant {
  const acct = ctx.principal?.acct;
  if (!acct) throw new ApiError("authentication_required");
  return merchantOf(acct, ctx.livemode);
}

const secretOf = (ctx: { headers: { "x-nearpay-client-secret"?: string } }) => ctx.headers["x-nearpay-client-secret"];

export function agentpayRoutes(ap: Agentpay): RouteBinding[] {
  return [
    // ---- x402 facilitator
    implement(x402Supported, async () => supported(ap) as never),
    implement(x402Requirements, async (ctx) => issueRequirements(ap, merchant(ctx), ctx.body) as never),
    implement(x402Verify, async (ctx) => verify(ap, merchant(ctx), ctx.body) as never),
    implement(x402Settle, async (ctx) => settle(ap, merchant(ctx), ctx.body, ctx.deadline) as never),

    // ---- x402 exact + near-intents (Stage 3, §3.1): own routes, PR #3370 wire shapes
    implement(x402NearIntentsRequirements, async (ctx) => issueNearIntents(ap, merchant(ctx), ctx.body) as never),
    implement(x402NearIntentsVerify, async (ctx) => verifyNearIntents(ap, merchant(ctx), ctx.body) as never),
    implement(
      x402NearIntentsSettle,
      async (ctx) => settleNearIntents(ap, merchant(ctx), ctx.body, ctx.deadline) as never,
    ),

    // ---- agent payments
    implement(listAgentPayments, async (ctx) => payments.listAgentPayments(ap, merchant(ctx), ctx.query) as never),
    implement(getAgentPayment, async (ctx) => payments.getAgentPayment(ap, merchant(ctx), ctx.params.id) as never),

    // ---- agents paying checkout sessions (client secret)
    implement(
      agentPayRequirements,
      async (ctx) => checkout.agentPayRequirements(ap, ctx.params.id, secretOf(ctx), ctx.body.payer) as never,
    ),
    implement(agentPay, async (ctx) =>
      respond(202, (await checkout.agentPay(ap, ctx.params.id, secretOf(ctx), ctx.body.signed)) as never),
    ),

    // ---- internal (payments): checkout attempts and, since spec 0.2.0, Intents-account refund legs
    implement(relaySignedIntent, async (ctx) => {
      const b = ctx.body;
      if (b.kind !== "refund" && b.refund !== undefined)
        throw ApiError.invalid("refund is only accepted with kind refund", "refund");
      const id =
        b.kind === "refund"
          ? await refunds.relayRefund(ap, {
              executionId: b.execution_id,
              binding: b.binding,
              signed: b.signed,
              refund: b.refund,
            })
          : await checkout.relayCheckout(ap, { executionId: b.execution_id, binding: b.binding, signed: b.signed });
      return respond(202, { agent_payment_id: id as `ap_${string}` });
    }),
  ];
}
