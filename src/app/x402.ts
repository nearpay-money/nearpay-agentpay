/**
 * x402 facilitator (lld/agentpay.md §5–§7): `/x402/supported`, `/x402/verify`, `/x402/settle`.
 *
 * Verify (§6): version/scheme/network (schema) and `accepted` == `paymentRequirements` (JCS) → the
 * issued requirement (this merchant and mode, not expired, not consumed, same terms) → local signature
 * check and the exact two-transfer message → `simulate_intents` in the payload's mode → compliance
 * screening of the payer (cached 24 h) → quotas (account, payer) → cache the success 60 s.
 * Settle (§7): replay by payload hash, else verify → queue the payload and consume the requirement in
 * one transaction → wait up to 8 s for the batcher's final outcome (`settlement_pending` otherwise).
 * The first response with the final outcome is the delivery; later ones say `replayed: true`.
 */
import type {
  IntentMessage,
  MultiPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyRequest,
  VerifyResponse,
} from "@nearpay/spec";
import { X402_NETWORK, X402_SCHEME, X402_TRANSFER_METHOD, X402_VERSION } from "@nearpay/spec";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { verifySigned } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { z } from "zod";
import { jcsEqual, payloadHash } from "../domain/binding/binding.js";
import { matchMessage } from "../domain/facilitator-payment/match.js";
import { settleError } from "../domain/facilitator-payment/reasons.js";
import { isTerminal } from "../domain/facilitator-payment/status.js";
import { upstreamCode } from "../infra/clients/peers.js";
import type { Agentpay } from "./context.js";
import { transition } from "./ledger.js";
import { accountRps, acctId, killSwitchEngaged, killSwitchError, type Merchant } from "./merchant.js";
import { railUnavailable, simulate, VerifierUnavailable } from "./verifier.js";
import type { AgentPaymentRow } from "./views.js";

type VerifyBody = z.output<typeof VerifyRequest>;
type InvalidReason = NonNullable<z.output<typeof VerifyResponse>["invalidReason"]>;

export function supported(ap: Agentpay): z.input<typeof SupportedResponse> {
  return {
    kinds: [
      {
        x402Version: X402_VERSION,
        scheme: X402_SCHEME,
        network: X402_NETWORK,
        extra: { assetTransferMethod: X402_TRANSFER_METHOD },
      },
    ],
    extensions: [],
    signers: { "near:*": ap.settings.relayerAccount ? [ap.settings.relayerAccount] : [] },
  };
}

interface Valid {
  readonly ok: true;
  readonly payer: string;
  readonly binding: string;
  readonly hash: Uint8Array;
  readonly signed: MultiPayload;
  readonly message: IntentMessage | null;
  readonly standard: string;
}
interface Invalid {
  readonly ok: false;
  readonly reason: InvalidReason;
  readonly message: string;
}
export type Verified = Valid | Invalid;

const invalid = (reason: InvalidReason, message: string): Invalid => ({ ok: false, reason, message });

/** The echoed terms are the issued ones. `extra.deadline` (0.1.5) may be absent (older agents drop it). */
export function sameTerms(r: RequirementRow, pr: PaymentRequirements): boolean {
  return (
    r.pay_to === pr.payTo &&
    r.asset_id === pr.asset &&
    BigInt(r.amount) === BigInt(pr.amount) &&
    r.fee_to === pr.extra.fee.to &&
    BigInt(r.fee_amount) === BigInt(pr.extra.fee.amount) &&
    r.max_timeout_s === pr.maxTimeoutSeconds &&
    (pr.extra.deadline === undefined || Date.parse(pr.extra.deadline) === r.expires_at.getTime())
  );
}

type RequirementRow = NonNullable<Awaited<ReturnType<typeof loadRequirement>>>;

async function loadRequirement(ap: Agentpay, binding: string) {
  return ap.db.selectFrom("issued_requirements").selectAll().where("binding", "=", binding).executeTakeFirst();
}

async function screen(ap: Agentpay, m: Merchant, payer: string): Promise<"allow" | "block"> {
  try {
    const s = await ap.caches.screenings.get(`${m.livemode}:${payer}`, () =>
      ap.compliance.screen({
        subject_type: "near_account",
        subject: payer,
        context: "x402",
        account_id: acctId(m),
        livemode: m.livemode,
      }),
    );
    return s.decision === "block" ? "block" : "allow";
  } catch (e) {
    const u = upstreamCode(e);
    ap.log.warn({ code: u.code, timeout: u.timeout }, "payer screening unavailable");
    throw new ApiError("screening_unavailable"); // fail closed
  }
}

/** §6. Invalid payloads are results; an unreachable Verifier or compliance service throws (503). */
export async function verifyPayload(ap: Agentpay, m: Merchant, body: VerifyBody): Promise<Verified> {
  const pr = body.paymentRequirements;
  const signed = body.paymentPayload.payload.signed;
  if (body.x402Version !== X402_VERSION || body.paymentPayload.x402Version !== X402_VERSION)
    return invalid("invalid_x402_version", "x402Version must be 2");
  if (pr.scheme !== X402_SCHEME) return invalid("invalid_scheme", "scheme must be exact");
  if (pr.network !== X402_NETWORK) return invalid("invalid_network", "network must be near:mainnet");
  if (!jcsEqual(body.paymentPayload.accepted, pr))
    return invalid("invalid_payment_requirements", "accepted does not equal paymentRequirements");

  const binding = pr.extra.binding;
  const req = await loadRequirement(ap, binding);
  if (!req || req.account_id !== m.account || req.livemode !== m.livemode)
    return invalid("requirement_unknown", "these requirements were not issued to this account and mode");
  if (!sameTerms(req, pr)) return invalid("invalid_payment_requirements", "the requirements were altered");
  // the merchant middleware forwards the resource it expects: it must be the one the requirements were issued for
  const resource = body.paymentPayload.resource;
  if (resource && resource.url !== req.resource_url)
    return invalid("invalid_payment_requirements", "the payload is for another resource");
  if (req.consumed_at) return invalid("requirement_consumed", "these requirements were already used");
  if (req.expires_at.getTime() <= ap.now()) return invalid("requirement_expired", "these requirements expired");

  const hash = payloadHash(signed);
  const key = Buffer.from(hash).toString("hex");
  const cached = ap.caches.verified.peek(key);
  if (cached && cached.binding === binding)
    return { ok: true, payer: cached.payer, binding, hash, signed, message: null, standard: signed.standard };

  const v = verifySigned(signed);
  if (!v.ok) return invalid(v.reason, v.detail);
  const match = matchMessage(
    v.message,
    {
      payTo: req.pay_to,
      asset: req.asset_id,
      amount: req.amount,
      feeTo: req.fee_to,
      feeAmount: req.fee_amount,
      binding,
      deadlineMaxMs: req.expires_at.getTime(),
      contract: ap.settings.contract,
    },
    ap.now(),
  );
  if (!match.ok) return invalid(match.reason, match.detail);
  const payer = v.message.signer_id;

  let sim: Awaited<ReturnType<typeof simulate>>;
  try {
    sim = await simulate(ap, m.livemode, [signed]);
  } catch (e) {
    if (e instanceof VerifierUnavailable) throw railUnavailable("verifier unavailable");
    throw e;
  }
  if (!sim.ok) return invalid(sim.reason, sim.detail);

  if ((await screen(ap, m, payer)) === "block") return invalid("payer_blocked", "the payer cannot pay this merchant");

  const rps = await accountRps(ap, m);
  if (!(await ap.limiter.take(`acct:${m.account}:${m.livemode}`, rps)))
    return invalid("quota_exceeded", "the account's verification quota is exhausted");
  if (!(await ap.limiter.take(`payer:${m.livemode}:${payer}`, ap.settings.payerRatePerS)))
    return invalid("quota_exceeded", "the payer's quota is exhausted");

  ap.caches.verified.set(key, { payer, binding });
  return { ok: true, payer, binding, hash, signed, message: v.message, standard: v.standard };
}

export async function verify(ap: Agentpay, m: Merchant, body: VerifyBody): Promise<z.input<typeof VerifyResponse>> {
  const r = await verifyPayload(ap, m, body);
  ap.metrics.verify(r.ok ? "valid" : r.reason);
  return r.ok
    ? { isValid: true, payer: r.payer }
    : { isValid: false, invalidReason: r.reason, invalidMessage: r.message };
}

// ---------------------------------------------------------------------------------------------- settle

type SettleOut = z.input<typeof SettleResponse>;

/**
 * The settle answer for an agent payment. `replayed` (0.1.5, CR-15-12) marks a final outcome that an
 * earlier settle response already carried; it is never set on `settlement_pending` (not a result yet).
 */
export function settleView(r: AgentPaymentRow, replayed = false): SettleOut {
  const transaction = r.tx_hash ?? "";
  const again = replayed && isTerminal(r.status) ? { replayed: true } : {};
  if (r.status === "settled")
    return { success: true, transaction, network: X402_NETWORK, payer: r.payer, amount: r.amount, ...again };
  if (r.status === "failed")
    return {
      success: false,
      transaction,
      network: X402_NETWORK,
      payer: r.payer,
      errorReason: settleError(r.error_reason),
      errorMessage: `settlement failed: ${r.error_reason ?? "unknown"}`,
      ...again,
    };
  return {
    success: false,
    transaction,
    network: X402_NETWORK,
    payer: r.payer,
    errorReason: "settlement_pending",
    errorMessage: "the payment is queued for settlement; call settle again with the same payload",
  };
}

/**
 * Answers with the payment's state. The first response carrying its final outcome claims the report
 * (conditional update, so concurrent settle calls cannot both win); every later one is `replayed`.
 */
export async function report(ap: Agentpay, r: AgentPaymentRow): Promise<SettleOut> {
  if (!isTerminal(r.status)) return settleView(r);
  const claimed = await ap.db
    .updateTable("agent_payments")
    .set({ result_reported_at: new Date(ap.now()) })
    .where("id", "=", r.id)
    .where("result_reported_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return settleView(r, !claimed);
}

/** Waits until the agent payment is final or `waitMs` passed (Valkey notification + 250 ms re-reads). */
export async function awaitFinal(ap: Agentpay, id: string, waitMs: number): Promise<AgentPaymentRow> {
  const read = () => ap.db.selectFrom("agent_payments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  let row = await read();
  if (isTerminal(row.status) || waitMs <= 0) return row;
  const until = ap.now() + waitMs;
  let wake: (() => void) | null = null;
  const unsubscribe = ap.waiters.subscribe(id, () => wake?.());
  try {
    while (!isTerminal(row.status) && ap.now() < until) {
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

function settleInvalid(reason: InvalidReason | "unexpected_settle_error", message: string): SettleOut {
  return { success: false, transaction: "", network: X402_NETWORK, errorReason: reason, errorMessage: message };
}

export async function settle(ap: Agentpay, m: Merchant, body: VerifyBody, deadline: number): Promise<SettleOut> {
  const started = ap.now();
  try {
    const waitMs = () => Math.min(ap.settings.settleWaitMs, deadline - ap.now() - 750);
    const hash = Buffer.from(payloadHash(body.paymentPayload.payload.signed));
    const existing = await ap.db
      .selectFrom("agent_payments")
      .selectAll()
      .where("payload_hash", "=", hash)
      .executeTakeFirst();
    if (existing) {
      if (existing.account_id !== m.account || existing.livemode !== m.livemode || existing.kind !== "x402")
        return settleInvalid("requirement_unknown", "this payload belongs to another payment");
      return report(ap, await awaitFinal(ap, existing.id, waitMs()));
    }
    if (m.livemode && (await killSwitchEngaged(ap))) throw killSwitchError();

    const v = await verifyPayload(ap, m, body);
    ap.metrics.verify(v.ok ? "valid" : v.reason);
    if (!v.ok) return settleInvalid(v.reason, v.message);
    const message = v.message ?? (verifySigned(v.signed) as { ok: true; message: IntentMessage }).message;
    const pr = body.paymentRequirements;

    const queued = await ap.db.transaction().execute(async (tx) => {
      const req = await tx
        .selectFrom("issued_requirements")
        .selectAll()
        .where("binding", "=", v.binding)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (req.consumed_at) {
        const winner = await tx
          .selectFrom("agent_payments")
          .selectAll()
          .where("payload_hash", "=", hash)
          .executeTakeFirst();
        return winner ?? null;
      }
      const id = uuidv7();
      const row = await tx
        .insertInto("agent_payments")
        .values({
          id,
          account_id: m.account,
          livemode: m.livemode,
          kind: "x402",
          binding: v.binding,
          payer: v.payer,
          pay_to: req.pay_to,
          fee_to: req.fee_to,
          payload_hash: hash,
          payload: JSON.stringify(v.signed),
          standard: v.standard,
          nonces: [message.nonce],
          deadline: new Date(message.deadline),
          status: "queued",
          amount: req.amount,
          asset_id: req.asset_id,
          fee_amount: req.fee_amount,
          resource_url: req.resource_url,
        })
        .onConflict((oc) => oc.column("payload_hash").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (!row)
        return (
          (await tx.selectFrom("agent_payments").selectAll().where("payload_hash", "=", hash).executeTakeFirst()) ??
          null
        );
      await tx
        .updateTable("issued_requirements")
        .set({ consumed_at: new Date(), consumed_by: id })
        .where("binding", "=", v.binding)
        .execute();
      await transition(tx, id, null, "queued", {
        cause: "x402 settle",
        actor: "api",
        evidence: { binding: v.binding, amount: pr.amount, payer: v.payer },
      });
      return row;
    });
    if (!queued) return settleInvalid("requirement_consumed", "these requirements were already used");
    ap.log.info({ agent_payment: fromUuid("ap", queued.id), binding: v.binding }, "x402 payment queued");
    return report(ap, await awaitFinal(ap, queued.id, waitMs()));
  } finally {
    ap.metrics.settleLatency((ap.now() - started) / 1000);
  }
}
