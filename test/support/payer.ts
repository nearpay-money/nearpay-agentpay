/** Test payers signing NearPay transfers: implicit or named NEAR accounts (raw ed25519 / NEP-413) and EVM wallets (ERC-191). */
import { randomBytes } from "node:crypto";
import {
  buildPayload,
  buildTransferIntents,
  evmAddress,
  implicitAccountId,
  makeNonce,
  signErc191,
  signNep413,
  signRawEd25519,
} from "@nearpay-internal/intents";
import type { IntentMessage, MultiPayload } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

export interface Terms {
  payTo: string;
  asset: string;
  amount: string;
  feeTo: string;
  fee: string;
  binding: string;
  /** Payload deadline (ISO); default now + 60 s. */
  deadline?: string;
}

export interface SignOptions {
  standard?: "raw_ed25519" | "nep413" | "erc191";
  tamper?: (m: IntentMessage) => void;
}

export interface Payer {
  readonly account: string;
  sign(t: Terms, o?: SignOptions): MultiPayload;
}

function message(account: string, t: Terms): IntentMessage {
  const deadline = t.deadline ?? new Date(Date.now() + 60_000).toISOString();
  return buildPayload({
    signerId: account,
    deadline,
    nonce: makeNonce("5a0dbe11"),
    intents: buildTransferIntents({
      pay_to: t.payTo,
      token: t.asset,
      amount: t.amount,
      fee_to: t.feeTo,
      fee_amount: t.fee,
      binding: t.binding,
      deadline,
    } as never),
  });
}

/** A NEAR payer: implicit account of a fresh key, or `named` (its first key registers in the Verifier). */
export function payer(named?: string): Payer {
  const seed = new Uint8Array(randomBytes(32));
  const account = named ?? implicitAccountId(ed25519.getPublicKey(seed));
  return {
    account,
    sign(t, o = {}) {
      const m = message(account, t);
      o.tamper?.(m);
      return o.standard === "nep413" ? signNep413(m, seed) : signRawEd25519(m, seed);
    },
  };
}

/** An EVM wallet payer (eth-implicit Intents account `0x…`), ERC-191. */
export function evmPayer(): Payer {
  const key = new Uint8Array(randomBytes(32));
  const account = evmAddress(secp256k1.getPublicKey(key, false));
  return {
    account,
    sign(t, o = {}) {
      const m = message(account, t);
      o.tamper?.(m);
      return signErc191(m, key);
    },
  };
}
