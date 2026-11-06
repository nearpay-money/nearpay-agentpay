/**
 * Relayer key pool (lld/agentpay.md §9). The owner's relayer account holds N function-call keys
 * restricted to `intents.near` / `execute_intents` (zero deposit, allowance 5 NEAR each); their secret
 * keys arrive as files (`NP_RELAYER_KEY_FILES`, e.g. `/run/secrets/relayer_key_*`). A key carries one
 * transaction at a time (`in_flight`), so its nonce never races; `draining` keys finish in-flight work
 * and take no new batches; `retired` keys are never used. Adding a key is a human-signed transaction.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { nearPublicKey } from "@nearpay-internal/intents";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import type { Db, Tx } from "../../app/context.js";

export interface RelayerKey {
  readonly publicKey: string;
  /** `ed25519:<base58>` (NEAR secret key format). */
  readonly secretKey: string;
}

/** Allowance per key when it was added (5 NEAR), for the 20% alert (RB-09). */
export const KEY_ALLOWANCE_YOCTO = 5n * 10n ** 24n;
export const LOW_ALLOWANCE_YOCTO = KEY_ALLOWANCE_YOCTO / 5n;

/** Parses a key file: `ed25519:<base58>` or a near-cli credentials JSON (`private_key`/`secret_key`). */
export function parseKeyFile(content: string): RelayerKey {
  let s = content.trim();
  if (s.startsWith("{")) {
    const j = JSON.parse(s) as { private_key?: string; secret_key?: string };
    s = (j.private_key ?? j.secret_key ?? "").trim();
  }
  if (!s.startsWith("ed25519:")) throw new Error("relayer key must be ed25519:<base58>");
  const raw = bs58.decode(s.slice(8));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("relayer key must be 32 or 64 bytes");
  const pub = ed25519.getPublicKey(raw.slice(0, 32));
  if (raw.length === 64 && bs58.encode(raw.slice(32)) !== bs58.encode(pub))
    throw new Error("relayer key: public half does not match the seed");
  return { publicKey: nearPublicKey(pub), secretKey: s };
}

/** Files matching `pattern` (a `*` wildcard in the file name only). */
export function matchFiles(pattern: string, list: (dir: string) => string[] = (d) => readdirSync(d)): string[] {
  const dir = dirname(pattern);
  const base = basename(pattern);
  const re = new RegExp(
    `^${base
      .split("*")
      .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return list(dir)
    .filter((f) => re.test(f))
    .sort()
    .map((f) => join(dir, f));
}

export function loadKeyFiles(
  pattern: string | undefined,
  read: (p: string) => string = (p) => readFileSync(p, "utf8"),
) {
  if (!pattern) return [];
  return matchFiles(pattern).map((f) => {
    try {
      return parseKeyFile(read(f));
    } catch (e) {
      throw new Error(`${f}: ${(e as Error).message}`);
    }
  });
}

/** Registers the configured keys (new keys start `active`; existing rows keep their status). */
export async function registerKeys(db: Db, accountId: string, keys: readonly RelayerKey[]): Promise<void> {
  for (const k of keys)
    await db
      .insertInto("relayer_keys")
      .values({ public_key: k.publicKey, account_id: accountId, status: "active" })
      .onConflict((oc) => oc.column("public_key").doUpdateSet({ account_id: accountId }))
      .execute();
}

/** Takes a free active key among `available` (least recently used first) and marks it in flight. */
export async function claimKey(
  tx: Tx,
  available: readonly string[],
): Promise<{ publicKey: string; lastNonce: bigint | null } | null> {
  if (available.length === 0) return null;
  const k = await tx
    .selectFrom("relayer_keys")
    .select(["public_key", "last_nonce"])
    .where("status", "=", "active")
    .where("in_flight", "=", false)
    .where("public_key", "in", [...available])
    .orderBy("last_used_at", (ob) => ob.asc().nullsFirst())
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (!k) return null;
  await tx.updateTable("relayer_keys").set({ in_flight: true }).where("public_key", "=", k.public_key).execute();
  return { publicKey: k.public_key, lastNonce: k.last_nonce === null ? null : BigInt(k.last_nonce) };
}

/** Frees a key; `nonce` is the nonce its last transaction used (null forgets it after a rejected nonce). */
export async function releaseKey(db: Db, publicKey: string, nonce: bigint | null | undefined): Promise<void> {
  if (publicKey === "sandbox") return;
  await db
    .updateTable("relayer_keys")
    .set({
      in_flight: false,
      last_used_at: new Date(),
      ...(nonce !== undefined ? { last_nonce: nonce === null ? null : nonce.toString() } : {}),
    })
    .where("public_key", "=", publicKey)
    .execute();
}
