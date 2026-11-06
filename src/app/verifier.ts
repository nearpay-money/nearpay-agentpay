/**
 * The Verifier per mode (INV-8): live payloads are simulated and executed on `intents.near` over NEAR
 * RPC; test payloads only ever reach the sandbox's simulated Verifier (`/sim/intents/*`).
 */
import type { MultiPayload } from "@nearpay/spec";
import { classifyVerifierError } from "@nearpay-internal/intents";
import { ApiError } from "@nearpay-internal/service";
import type { VerifierFailure } from "../domain/facilitator-payment/reasons.js";
import { upstreamCode } from "../infra/clients/peers.js";
import { RpcError, VerifierError } from "../infra/near/rpc.js";
import type { Agentpay } from "./context.js";

export type Simulation =
  | { ok: true; executed: readonly { intent_hash: string; account_id: string; nonce: string }[] }
  | { ok: false; reason: VerifierFailure; detail: string };

/** The Verifier could not be asked (RPC providers or the sandbox are down): retry later. */
export class VerifierUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierUnavailable";
  }
}

export function railUnavailable(reason: string): ApiError {
  return new ApiError("rail_unavailable", { params: { reason } });
}

/** `simulate_intents` in the payload's mode; Verifier rejections are results, transport failures throw. */
export async function simulate(ap: Agentpay, livemode: boolean, signed: readonly MultiPayload[]): Promise<Simulation> {
  if (livemode) {
    if (!ap.chain) throw new VerifierUnavailable("no NEAR RPC configured");
    try {
      const r = await ap.chain.simulate(signed);
      return { ok: true, executed: r.intents_executed };
    } catch (e) {
      if (e instanceof VerifierError) return { ok: false, reason: e.reason, detail: e.message };
      if (e instanceof RpcError) throw new VerifierUnavailable(e.message);
      throw e;
    }
  }
  if (!ap.sandbox) throw new VerifierUnavailable("test mode is not available (no sandbox)");
  try {
    const r = await ap.sandbox.simulate(signed);
    return { ok: true, executed: r.intents_executed };
  } catch (e) {
    const u = upstreamCode(e);
    if (u.code === "insufficient_balance")
      return { ok: false, reason: "insufficient_funds", detail: u.message ?? "insufficient balance" };
    if (u.code === "intent_invalid") {
      const detail = u.message ?? "rejected";
      return { ok: false, reason: classifyVerifierError(detail), detail };
    }
    throw new VerifierUnavailable(u.code ?? (u.timeout ? "sandbox timeout" : "sandbox unreachable"));
  }
}
