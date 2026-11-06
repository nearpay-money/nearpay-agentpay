/** Rows → spec objects (AgentPayment). */
import type { AgentPayment } from "@nearpay/spec";
import { fromUuid } from "@nearpay-internal/ids";
import type { Selectable } from "kysely";
import type { AgentPaymentsTable } from "../infra/db/schema.js";

export type AgentPaymentRow = Selectable<AgentPaymentsTable>;

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export function agentPaymentView(r: AgentPaymentRow): AgentPayment {
  return {
    id: fromUuid("ap", r.id) as AgentPayment["id"],
    object: "agent_payment",
    created: unix(r.created_at),
    livemode: r.livemode,
    kind: r.kind,
    status: r.status,
    payer: r.payer,
    pay_to: r.pay_to,
    asset_id: r.asset_id,
    amount: r.amount,
    fee_amount: r.fee_amount,
    binding: r.binding as AgentPayment["binding"],
    resource_url: r.resource_url,
    checkout_session: r.checkout_session_id
      ? (fromUuid("cs", r.checkout_session_id) as AgentPayment["checkout_session"])
      : null,
    tx_hash: r.tx_hash,
    block_height: r.block_height === null ? null : Number(r.block_height),
    error_reason: r.error_reason,
    settled_at: r.settled_at ? unix(r.settled_at) : null,
    // the aggregate version: every change goes through ledger.updatePayment (or the batcher's tx_hash
    // write), which bumps it; it is also the `aggregate.version` of the agent payment's events (0.1.5)
    sequence: r.version,
  };
}
