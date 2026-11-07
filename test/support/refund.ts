/**
 * Refund legs from an Intents account, built the way payments issues them (payments §8 "next_action":
 * `sign_intent` with the exact NEP-413 arguments, the ERC-191 / raw-ed25519 string and the parsed
 * message, fresh nonce) and signed the way the dashboard / SDK signer signs them.
 */
import { randomBytes } from "node:crypto";
import type { IntentMessage, MultiPayload } from "@nearpay/spec";
import {
  buildPayload,
  evmAddress,
  implicitAccountId,
  makeNonce,
  nep413Message,
  signErc191,
  signNep413,
  signRawEd25519,
} from "@nearpay-internal/intents";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import bs58 from "bs58";
import type { IssuedRefundPayload, RefundTransferTerms } from "../../src/domain/refund-relay/match.js";

export type Standard = "nep413" | "raw_ed25519" | "erc191";

export interface Signer {
  readonly account: string;
  readonly standard: Standard;
  sign(m: IntentMessage): MultiPayload;
}

/** A merchant Intents account that signs with `standard` (ed25519 implicit account, or an EVM address). */
export function signer(standard: Standard = "raw_ed25519", seed: Uint8Array = new Uint8Array(randomBytes(32))): Signer {
  if (standard === "erc191") {
    const account = evmAddress(secp256k1.getPublicKey(seed, false));
    return { account, standard, sign: (m) => signErc191(m, seed) };
  }
  const account = implicitAccountId(ed25519.getPublicKey(seed));
  return {
    account,
    standard,
    sign: (m) => (standard === "nep413" ? signNep413(m, seed) : signRawEd25519(m, seed)),
  };
}

export const binding = () => `np1:${bs58.encode(randomBytes(32))}`;

export interface LegOptions {
  readonly receiver?: string;
  readonly token: string;
  readonly amount: string;
  readonly binding?: string;
  /** Payload deadline (ISO); default now + 10 min. */
  readonly deadline?: string;
  /** rails' latest acceptable deadline; default = the payload deadline. */
  readonly maxDeadline?: string;
  readonly nonce?: string;
}

export interface Leg {
  readonly transfer: RefundTransferTerms;
  readonly message: IntentMessage;
  /** `RefundSignIntent` as payments returns it in `Refund.next_action`. */
  readonly nextAction: IssuedRefundPayload & {
    type: "sign_intent";
    deadline: number;
    display: string;
  };
}

/** One refund leg: rails' `Execution.refund.transfer` and payments' issued `sign_intent` next action. */
export function leg(s: Signer, o: LegOptions): Leg {
  const deadline = o.deadline ?? new Date(Date.now() + 600_000).toISOString();
  const transfer: RefundTransferTerms = {
    signer_id: s.account,
    receiver_id: o.receiver ?? `payer${randomBytes(3).toString("hex")}.near`,
    token: o.token,
    amount: o.amount,
    memo: o.binding ?? binding(),
    deadline: o.maxDeadline ?? deadline,
  };
  const message = buildPayload({
    signerId: s.account,
    deadline,
    nonce: o.nonce ?? makeNonce("5a0dbe11"),
    intents: [
      {
        intent: "transfer",
        receiver_id: transfer.receiver_id,
        tokens: { [transfer.token]: transfer.amount },
        memo: transfer.memo,
      },
    ],
  });
  return {
    transfer,
    message,
    nextAction: {
      type: "sign_intent",
      signer_id: s.account,
      transfer: {
        receiver_id: transfer.receiver_id,
        token: transfer.token,
        amount: transfer.amount,
        memo: transfer.memo,
      },
      standards: [s.standard],
      nep413: { recipient: "intents.near", nonce: message.nonce, message: nep413Message(message) },
      payload: JSON.stringify(message),
      message,
      deadline: Math.floor(Date.parse(deadline) / 1000),
      display: `Transfer ${transfer.amount} to ${transfer.receiver_id}`,
    },
  };
}
