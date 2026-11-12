// Session-only cache of the last good read. Never persisted. A cached value is returned with its read time and a
// stale flag, so the layout can say "Read 13:40, refresh" and never present it as current.
import { STALE_MS } from "./derive.mjs";

export function createCache({ ttlMs = STALE_MS, now = () => Date.now() } = {}) {
  const store = new Map();
  return {
    put(key, value) {
      store.set(key, { value, at: now() });
      return value;
    },
    get(key) {
      const hit = store.get(key);
      if (!hit) return null;
      return { value: hit.value, at: hit.at, stale: now() - hit.at > ttlMs };
    },
    clear: () => store.clear(),
  };
}

/** Load through the cache: a fresh hit is reused; a stale hit or miss calls load(). In-flight loads are shared. */
export function cachedLoader(cache, key, load) {
  let inflight = null;
  return async ({ force = false } = {}) => {
    const hit = cache.get(key);
    if (hit && !hit.stale && !force) return hit.value;
    if (!inflight) inflight = load().then((v) => cache.put(key, v)).finally(() => { inflight = null; });
    return inflight;
  };
}
