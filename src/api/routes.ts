/**
 * Spec route bindings (lld/agentpay.md §5). Authentication and scopes (`agentpay.facilitate`,
 * `service:agentpay.relay`) are enforced from the spec by the service bootstrap; checkout routes are
 * open at the gateway and authenticate with the session's client secret, which payments checks.
 */
import {
  agentPay,
  agentPayRequirements,
  getAgentPayment,
  listAgentPayments,
  x402Requirements,
  x402Settle,
  x402Supported,
  x402Verify,
} from "@nearpay/spec";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import { relaySignedIntent } from "@nearpay-internal/spec";
import * as payments from "../app/agent-payments.js";
import * as checkout from "../app/checkout.js";
import type { Agentpay } from "../app/context.js";
import { type Merchant, merchantOf } from "../app/merchant.js";
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

    // ---- internal (payments)
    implement(relaySignedIntent, async (ctx) =>
      respond(202, {
        agent_payment_id: (await checkout.relayCheckout(ap, {
          executionId: ctx.body.execution_id,
          binding: ctx.body.binding,
          signed: ctx.body.signed,
        })) as `ap_${string}`,
      }),
    ),
  ];
}
