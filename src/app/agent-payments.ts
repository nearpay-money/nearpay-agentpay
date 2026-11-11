/** `GET /v1/agent_payments` and `/v1/agent_payments/{id}` (lld/agentpay.md §5): merchant-scoped (INV-8). */

import { isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { AgentPayment } from "@nearpay-money/spec";
import type { Agentpay } from "./context.js";
import type { Merchant } from "./merchant.js";
import { type PageQuery, pageOf } from "./pages.js";
import { agentPaymentView } from "./views.js";

export async function getAgentPayment(ap: Agentpay, m: Merchant, id: string): Promise<AgentPayment> {
  const row = isId("ap", id)
    ? await ap.db
        .selectFrom("agent_payments")
        .selectAll()
        .where("id", "=", toUuid(id, "ap"))
        .where("account_id", "=", m.account)
        .where("livemode", "=", m.livemode)
        .executeTakeFirst()
    : undefined;
  if (!row) throw ApiError.missing("agent_payment", id, "id");
  return agentPaymentView(row);
}

export async function listAgentPayments(
  ap: Agentpay,
  m: Merchant,
  q: PageQuery & { kind?: string | undefined },
): Promise<{ object: "list"; data: AgentPayment[]; has_more: boolean; url: string }> {
  for (const c of ["starting_after", "ending_before"] as const) {
    const v = q[c];
    if (v !== undefined && !isId("ap", v)) throw ApiError.invalid(`${c} must be an agent payment id`, c);
  }
  let base = ap.db
    .selectFrom("agent_payments")
    .selectAll()
    .where("account_id", "=", m.account)
    .where("livemode", "=", m.livemode);
  if (q.kind) base = base.where("kind", "=", q.kind as "x402");
  const page = await pageOf(base, q, "ap");
  return { object: "list", data: page.rows.map(agentPaymentView), has_more: page.hasMore, url: "/v1/agent_payments" };
}
