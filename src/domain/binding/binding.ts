/**
 * x402 bindings and payload hashes (lld/agentpay.md §3, §4). Pure.
 *
 * - `binding = np1: + base58(sha256(JCS({account_id, resource_url, payTo, asset, amount, fee, nonce16, expires_at})))`
 *   (spec `X402BindingInput`): one per 402 response, single use, carried as the memo of both transfers.
 * - `payload_hash = sha256(JCS(MultiPayload))`: settle and relay are idempotent on it.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import canonicalize from "canonicalize";

export interface X402BindingFields {
  /** Merchant account id (`acct_…`). */
  readonly account_id: string;
  readonly resource_url: string;
  readonly payTo: string;
  readonly asset: string;
  /** Base units (decimal string). */
  readonly amount: string;
  /** Fee base units (decimal string). */
  readonly fee: string;
  /** 16 random bytes, lower-case hex. */
  readonly nonce16: string;
  /** Unix seconds. */
  readonly expires_at: number;
}

const enc = new TextEncoder();

/** RFC 8785 canonical JSON. */
export function jcs(value: unknown): string {
  const s = canonicalize(value);
  if (s === undefined) throw new TypeError("value cannot be canonicalised");
  return s;
}

export function x402Binding(f: X402BindingFields): string {
  if (!/^[0-9a-f]{32}$/.test(f.nonce16)) throw new RangeError("nonce16 must be 16 bytes of lower-case hex");
  if (!Number.isSafeInteger(f.expires_at)) throw new RangeError("expires_at must be unix seconds");
  const input = {
    account_id: f.account_id,
    resource_url: f.resource_url,
    payTo: f.payTo,
    asset: f.asset,
    amount: f.amount,
    fee: f.fee,
    nonce16: f.nonce16,
    expires_at: f.expires_at,
  };
  return `np1:${bs58.encode(sha256(enc.encode(jcs(input))))}`;
}

/** sha256 of the JCS form of a signed payload (independent of key order and whitespace). */
export function payloadHash(signed: unknown): Uint8Array {
  return sha256(enc.encode(jcs(signed)));
}

/** True when two JSON values are equal under JCS (x402 `accepted` vs `paymentRequirements`). */
export function jcsEqual(a: unknown, b: unknown): boolean {
  return jcs(a) === jcs(b);
}
