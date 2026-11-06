/**
 * Settle waiters (lld/agentpay.md §7: "wait on Valkey channel `ap:<id>` up to 8 s"): the batcher
 * publishes `ap:<uuid>` after an agent payment reaches a final state; api replicas subscribe while a
 * `/x402/settle` call waits. Without Valkey (or while it is down) notifications stay in-process, and
 * every waiter also re-reads the row on a short timer, so a lost notification only delays the answer.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

export interface Waiters {
  /** Announces that agent payment `id` (uuid) changed. Never throws. */
  publish(id: string): Promise<void>;
  /** Calls `fn` when agent payment `id` changes; returns the unsubscribe function. */
  subscribe(id: string, fn: () => void): () => void;
  close(): Promise<void>;
}

const channel = (id: string) => `ap:${id}`;

export function waiters(valkeyUrl: string | undefined): Waiters {
  const local = new EventEmitter();
  local.setMaxListeners(0);
  const opts = {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
  } as const;
  const pub = valkeyUrl ? new Redis(valkeyUrl, opts) : null;
  const sub = valkeyUrl ? new Redis(valkeyUrl, { ...opts, enableOfflineQueue: true }) : null;
  pub?.on("error", () => {});
  sub?.on("error", () => {});
  const counts = new Map<string, number>();
  sub?.on("message", (ch: string) => {
    if (ch.startsWith("ap:")) local.emit(ch);
  });
  sub?.on("ready", () => {
    if (counts.size) sub.subscribe(...counts.keys()).catch(() => {});
  });
  return {
    async publish(id) {
      if (pub?.status === "ready") await pub.publish(channel(id), "1").catch(() => local.emit(channel(id)));
      else local.emit(channel(id));
    },
    subscribe(id, fn) {
      const ch = channel(id);
      local.on(ch, fn);
      const n = (counts.get(ch) ?? 0) + 1;
      counts.set(ch, n);
      if (n === 1 && sub?.status === "ready") sub.subscribe(ch).catch(() => {});
      return () => {
        local.off(ch, fn);
        const left = (counts.get(ch) ?? 1) - 1;
        if (left <= 0) {
          counts.delete(ch);
          if (sub?.status === "ready") sub.unsubscribe(ch).catch(() => {});
        } else counts.set(ch, left);
      };
    },
    async close() {
      pub?.disconnect();
      sub?.disconnect();
      local.removeAllListeners();
    },
  };
}
