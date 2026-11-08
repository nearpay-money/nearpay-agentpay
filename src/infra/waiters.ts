/**
 * Settle waiters (lld/agentpay.md §7: "wait on Valkey channel `ap:<id>` up to 8 s"): the batcher
 * publishes `ap:<uuid>` after an agent payment reaches a final state; api replicas subscribe while a
 * `/x402/settle` call waits. Without Valkey (or while it is down) notifications stay in-process, and
 * every waiter also re-reads the row on a short timer, so a lost notification only delays the answer.
 * Stage 3: `xo:<operation uuid>` (near-intents operations, §3.1/§8) uses the same mechanism with `topic: "xo"`.
 */
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";

/** `ap`: agent payments; `xo`: near-intents operations. */
export type WaitTopic = "ap" | "xo";

export interface Waiters {
  /** Announces that agent payment (or, with topic `xo`, operation) `id` (uuid) changed. Never throws. */
  publish(id: string, topic?: WaitTopic): Promise<void>;
  /** Calls `fn` when `id` changes; returns the unsubscribe function. */
  subscribe(id: string, fn: () => void, topic?: WaitTopic): () => void;
  close(): Promise<void>;
}

const channel = (id: string, topic: WaitTopic = "ap") => `${topic}:${id}`;

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
    if (ch.startsWith("ap:") || ch.startsWith("xo:")) local.emit(ch);
  });
  sub?.on("ready", () => {
    if (counts.size) sub.subscribe(...counts.keys()).catch(() => {});
  });
  return {
    async publish(id, topic) {
      const ch = channel(id, topic);
      if (pub?.status === "ready") await pub.publish(ch, "1").catch(() => local.emit(ch));
      else local.emit(ch);
    },
    subscribe(id, fn, topic) {
      const ch = channel(id, topic);
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
