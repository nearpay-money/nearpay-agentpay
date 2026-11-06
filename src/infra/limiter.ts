/**
 * Request quotas (lld/agentpay.md §3 issuance rate, §6 step 6): one-second fixed windows shared through
 * Valkey (`INCR` + `EXPIRE`, atomic per key); in-process windows when Valkey is absent or failing (each
 * api replica then enforces the limit on its own).
 */
import { Redis } from "ioredis";
import { hit, type Window } from "../domain/quota/window.js";

export interface Limiter {
  /** Counts one request for `key`; false once `limit` requests were counted in the current second. */
  take(key: string, limit: number): Promise<boolean>;
  close(): Promise<void>;
}

export function limiter(valkeyUrl: string | undefined, now: () => number = Date.now): Limiter {
  const local = new Map<string, Window>();
  const redis = valkeyUrl
    ? new Redis(valkeyUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 1_000 })
    : null;
  redis?.on("error", () => {});
  const inProcess = (key: string, limit: number) => {
    const r = hit(local.get(key), now(), limit);
    local.set(key, r.window);
    if (local.size > 50_000) local.delete(local.keys().next().value as string);
    return r.ok;
  };
  return {
    async take(key, limit) {
      if (redis?.status === "ready") {
        const k = `quota:${key}:${Math.floor(now() / 1000)}`;
        try {
          const r = await redis.multi().incr(k).expire(k, 2).exec();
          const count = Number(r?.[0]?.[1]);
          if (Number.isFinite(count)) return count <= limit;
        } catch {
          // fall through to the in-process window
        }
      }
      return inProcess(key, limit);
    },
    async close() {
      redis?.disconnect();
    },
  };
}
