/**
 * An in-memory NEAR Intents Verifier for tests (the mainnet rejection messages, real signature checks
 * through `@nearpay-internal/intents`): balances, used nonces, keys registered for named accounts. It
 * backs both the mocked sandbox (`/sim/intents/*`) and the fake NEAR RPC (`simulate_intents`,
 * `execute_intents`), so live and test mode see the same rules.
 */

import { verifySigned } from "@nearpay-internal/intents";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

export class Rejection extends Error {
  constructor(
    readonly kind: "invalid" | "insufficient",
    message: string,
  ) {
    super(message);
  }
}

export interface Executed {
  intent_hash: string;
  account_id: string;
  nonce: string;
}

export class FakeVerifier {
  readonly balances = new Map<string, bigint>();
  readonly nonces = new Set<string>();
  readonly keys = new Map<string, string>();
  executions = 0;
  /** Fails `execute` (on chain) when it returns a message. */
  failExecute: ((signed: readonly unknown[]) => string | null) | null = null;

  private k(a: string, t: string) {
    return `${a}\u0000${t}`;
  }
  fund(account: string, token: string, amount: bigint) {
    this.balances.set(this.k(account, token), this.balance(account, token) + amount);
  }
  balance(account: string, token: string): bigint {
    return this.balances.get(this.k(account, token)) ?? 0n;
  }

  /** Checks a batch atomically; with `commit`, applies it. Throws Rejection. */
  run(signed: readonly unknown[], commit: boolean, nowMs = Date.now()): Executed[] {
    const bal = new Map(this.balances);
    const nonces = new Set<string>();
    const keys = new Map<string, string>();
    const out: Executed[] = [];
    for (const p of signed) {
      const v = verifySigned(p);
      if (!v.ok)
        throw new Rejection(
          "invalid",
          v.reason === "invalid_signature" ? "invalid signature" : `invalid payload: ${v.detail}`,
        );
      const m = v.message;
      if (Date.parse(m.deadline) <= nowMs) throw new Rejection("invalid", "deadline has expired");
      if (!v.implicitMatch) {
        const registered = this.keys.get(m.signer_id) ?? keys.get(m.signer_id);
        if (/^([0-9a-f]{64}|0x[0-9a-f]{40})$/.test(m.signer_id) || (registered && registered !== v.signer))
          throw new Rejection("invalid", `public key '${v.signer}' doesn't exist for account '${m.signer_id}'`);
        keys.set(m.signer_id, v.signer);
      }
      const nk = `${m.signer_id}\u0000${m.nonce}`;
      if (this.nonces.has(nk) || nonces.has(nk)) throw new Rejection("invalid", "nonce was already used");
      nonces.add(nk);
      for (const i of m.intents as { intent: string; receiver_id: string; tokens: Record<string, string> }[]) {
        if (i.intent !== "transfer") throw new Rejection("invalid", `unsupported intent: ${i.intent}`);
        for (const [t, a] of Object.entries(i.tokens)) {
          const from = this.k(m.signer_id, t);
          const have = bal.get(from) ?? 0n;
          if (have < BigInt(a)) throw new Rejection("insufficient", "insufficient balance or overflow");
          bal.set(from, have - BigInt(a));
          bal.set(this.k(i.receiver_id, t), (bal.get(this.k(i.receiver_id, t)) ?? 0n) + BigInt(a));
        }
      }
      out.push({
        intent_hash: bs58.encode(sha256(new TextEncoder().encode(JSON.stringify(p)))),
        account_id: m.signer_id,
        nonce: m.nonce,
      });
    }
    if (commit) {
      for (const [k, v] of bal) this.balances.set(k, v);
      for (const n of nonces) this.nonces.add(n);
      for (const [a, key] of keys) this.keys.set(a, key);
      this.executions++;
    }
    return out;
  }
}

export const executedLog = (executed: readonly Executed[]) =>
  `EVENT_JSON:${JSON.stringify({ standard: "dip4", version: "0.4.3", event: "intents_executed", data: executed })}`;
