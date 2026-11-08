/**
 * Operation-token keys (lld/agentpay.md §3.1 step 3, §11 `NP_X402_OPERATION_KEY_FILES`): files matching a glob
 * with `*` in the file name, e.g. `/run/secrets/x402_op_key_*`; the `*` part is the key id (`kid`,
 * `[a-z0-9-]{1,32}`). Each file holds ≥ 32 random bytes — raw, or as hex text (64+ hex digits). The newest file
 * (modification time, then kid) signs new tokens; every loaded key verifies, so a rotated-out key stays loaded
 * while tokens minted with it are unexpired (refund deadline + 24 h). Never logged.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { matchFiles } from "../relayer/key-pool/keys.js";

export interface OperationKeys {
  /** Key id and key that sign new tokens. */
  readonly signing: { readonly kid: string; readonly key: Uint8Array };
  /** Every loaded key by id (verification). */
  readonly all: ReadonlyMap<string, Uint8Array>;
}

const KID_RE = /^[a-z0-9-]{1,32}$/;

/** Decodes a key file: hex text (≥ 64 hex digits, even length) or raw bytes; at least 32 bytes either way. */
export function parseOperationKey(raw: Buffer): Uint8Array {
  const text = raw.toString("latin1").trim();
  const key = /^(?:[0-9a-fA-F]{2}){32,}$/.test(text) ? Buffer.from(text, "hex") : raw;
  if (key.length < 32) throw new Error("x402 operation key must be at least 32 bytes");
  return new Uint8Array(key);
}

export interface KeyFileSystem {
  list(dir: string): string[];
  read(path: string): Buffer;
  mtimeMs(path: string): number;
}

const nodeFs: KeyFileSystem = {
  list: (d) => readdirSync(d),
  read: (p) => readFileSync(p),
  mtimeMs: (p) => statSync(p).mtimeMs,
};

/** Loads the keys; null when the pattern is unset (near-intents issuance and quotes are then refused). */
export function loadOperationKeys(pattern: string | undefined, fs: KeyFileSystem = nodeFs): OperationKeys | null {
  if (!pattern) return null;
  if (!basename(pattern).includes("*")) throw new Error("NP_X402_OPERATION_KEY_FILES needs a * in the file name");
  const [prefix, suffix] = basename(pattern).split("*", 2) as [string, string];
  const files = matchFiles(pattern, fs.list);
  if (!files.length) throw new Error(`no x402 operation key files match ${pattern}`);
  const all = new Map<string, Uint8Array>();
  let newest: { kid: string; at: number } | null = null;
  for (const f of files) {
    const name = basename(f);
    const kid = name.slice(prefix.length, name.length - suffix.length);
    if (!KID_RE.test(kid)) throw new Error(`x402 operation key id ${JSON.stringify(kid)} must match ${KID_RE}`);
    all.set(kid, parseOperationKey(fs.read(f)));
    const at = fs.mtimeMs(f);
    if (!newest || at > newest.at || (at === newest.at && kid > newest.kid)) newest = { kid, at };
  }
  const kid = (newest as { kid: string }).kid;
  return { signing: { kid, key: all.get(kid) as Uint8Array }, all };
}
