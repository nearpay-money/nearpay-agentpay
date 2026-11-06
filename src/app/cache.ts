/** A small in-process TTL cache with in-flight de-duplication (contexts, assets, screenings, verify results). */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  peek(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}

export function ttlCache<T>(ttlMs: number, now: () => number = Date.now, max = 10_000): TtlCache<T> {
  const values = new Map<string, { v: T; until: number }>();
  const pending = new Map<string, Promise<T>>();
  const put = (key: string, v: T) => {
    values.delete(key);
    values.set(key, { v, until: now() + ttlMs });
    if (values.size > max) values.delete(values.keys().next().value as string);
  };
  return {
    async get(key, load) {
      const hit = values.get(key);
      if (hit && hit.until > now()) return hit.v;
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const p = load()
        .then((v) => {
          put(key, v);
          return v;
        })
        .finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    },
    peek(key) {
      const hit = values.get(key);
      return hit && hit.until > now() ? hit.v : undefined;
    },
    set: put,
    delete(key) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
  };
}
