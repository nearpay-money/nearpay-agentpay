/**
 * KIT 0.3.0 ADAPTER — the only place agentpay touches the `@nearpay-internal/intents` 0.3.0 x402 helpers
 * (`jcs`, `nearIntentsBinding`, `mintOperationToken`, `verifyOperationToken`; lld/agentpay.md §3.1).
 *
 * Kit 0.3.0 is not published yet (agentpay builds on kit 0.2.1), so this file carries a byte-identical copy of
 * the kit's implementation (nearpay-kit `packages/intents/src/x402.ts` at stage-3/3.1-kit 311104b), checked
 * against the spec 0.3.0 vectors (`test-vectors/x402-near-intents.json`) in `test/unit/near-intents-kit.test.ts`.
 * When kit 0.3.0 is published, replace the body of this file with
 *
 *   export { jcs, mintOperationToken, nearIntentsBinding, verifyOperationToken } from "@nearpay-internal/intents";
 *   export type { NearIntentsBindingInput, OperationTokenCheck, OperationTokenInput } from "@nearpay-internal/intents";
 *
 * and keep the vector test. Pure (no I/O).
 */
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

export interface NearIntentsBindingInput {
  readonly method: "near-intents";
  readonly account_id: string;
  readonly resource_url: string;
  readonly origin_network: string;
  readonly origin_asset_id: string;
  readonly pay_to: string;
  readonly asset_id: string;
  readonly amount: string;
  readonly max_timeout_s: number;
  readonly nonce16: string;
  readonly expires_at: number;
}

export interface OperationTokenInput {
  readonly v: 1;
  readonly binding: string;
  readonly network: string;
  readonly deposit_address: string;
  readonly deposit_memo: string | null;
  readonly resource_url: string;
  readonly destination: {
    readonly network: string;
    readonly asset: string;
    readonly amount: string;
    readonly recipient: string;
  };
  readonly expiry: number;
}

type Json = string | number | null | { readonly [k: string]: Json };

/** RFC 8785 for strings, safe integers, null and objects (no arrays, floats or booleans needed here). */
export function jcs(value: unknown): string {
  if (value === null || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new RangeError(`jcs: only safe integers are supported, got ${value}`);
    return String(value);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, Json>).filter(([, v]) => v !== undefined);
    // JCS sorts by UTF-16 code units, which is JavaScript's default string order
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${jcs(v)}`).join(",")}}`;
  }
  throw new TypeError(`jcs: unsupported value of type ${Array.isArray(value) ? "array" : typeof value}`);
}

const enc = new TextEncoder();

/** `np1:` binding of a `near-intents` unquoted entry. */
export function nearIntentsBinding(input: NearIntentsBindingInput): string {
  if (input.method !== "near-intents") throw new RangeError("binding input method must be near-intents");
  if (!/^[0-9a-f]{32}$/.test(input.nonce16)) throw new RangeError("nonce16 must be 16 bytes of lower-case hex");
  return `np1:${bs58.encode(sha256(enc.encode(jcs(input))))}`;
}

const KID_RE = /^[a-z0-9-]{1,32}$/;
const TOKEN_RE = /^([a-z0-9-]{1,32})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})$/;

function mac(key: Uint8Array, input: OperationTokenInput): string {
  return Buffer.from(hmac(sha256, key, enc.encode(jcs(input)))).toString("base64url");
}

/** Mints an operation token; `input.expiry` is the token's expiry (refund deadline + ≥ 24 h). */
export function mintOperationToken(key: Uint8Array, kid: string, input: OperationTokenInput): string {
  if (!KID_RE.test(kid)) throw new RangeError(`kid must match ${KID_RE}`);
  if (key.length < 32) throw new RangeError("operation token key must be at least 32 bytes");
  if (input.v !== 1) throw new RangeError("operation token input version must be 1");
  return `${kid}.${input.expiry}.${mac(key, input)}`;
}

export type OperationTokenCheck =
  | { readonly ok: true; readonly kid: string; readonly expiry: number }
  | { readonly ok: false; readonly reason: "malformed" | "expired" | "unknown_key" | "invalid" };

/**
 * Verifies a token against the facilitator's keys and the recomputed input (built from
 * `accepted.network`, the payload's deposit address/memo, `resource.url`, the server's own
 * destination terms and the binding). Expiry is checked first, without a key lookup
 * (`invalid_exact_near_intents_token_expired`); `unknown_key` and `invalid` map to `…_token_invalid`.
 */
export function verifyOperationToken(
  token: string,
  keys: ReadonlyMap<string, Uint8Array>,
  input: Omit<OperationTokenInput, "expiry">,
  nowSeconds: number,
): OperationTokenCheck {
  const m = TOKEN_RE.exec(token);
  if (!m) return { ok: false, reason: "malformed" };
  const kid = m[1] as string;
  const expiry = Number(m[2]);
  if (expiry <= nowSeconds) return { ok: false, reason: "expired" };
  const key = keys.get(kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  const expected = mac(key, { ...input, expiry } as OperationTokenInput);
  const a = Buffer.from(expected);
  const b = Buffer.from(m[3] as string);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0 ? { ok: true, kid, expiry } : { ok: false, reason: "invalid" };
}
