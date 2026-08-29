'use strict';

/**
 * Stale-while-error TTL cache around a single async producer.
 *
 * Three properties matter here, and all three exist because this sits in front
 * of the only network calls the site makes:
 *   - concurrent callers share one in-flight request (no thundering herd);
 *   - a value is served from memory until it is `ttlMs` old;
 *   - if a refresh throws, the LAST GOOD value keeps being served rather than
 *     propagating the error, so a Blockscout blip cannot blank a working panel.
 *
 * @param {number} ttlMs
 * @param {() => Promise<any>} fn
 * @returns {() => Promise<any>}
 */
function cached(ttlMs, fn) {
  let value;
  let hasValue = false;
  let expires = 0;
  let inflight = null;

  return async () => {
    if (hasValue && Date.now() < expires) return value;
    if (inflight) return inflight;

    inflight = (async () => {
      try {
        value = await fn();
        hasValue = true;
        expires = Date.now() + ttlMs;
        return value;
      } catch (err) {
        if (hasValue) {
          // Keep serving the last good value, but retry on the next call
          // instead of pinning a stale number for a whole TTL.
          expires = 0;
          return value;
        }
        throw err;
      } finally {
        inflight = null;
      }
    })();

    return inflight;
  };
}

/**
 * The same cache, one per key — for producers that take arguments, like a
 * page of the rewards feed keyed by (cursor, limit). Each key gets its own
 * `cached()` with the full stale-while-error / shared-in-flight behavior.
 * Bounded: past `max` keys the least recently used one is dropped, so a
 * visitor paging deep into the feed cannot grow memory without limit.
 *
 * @param {number} ttlMs
 * @param {(...args: any[]) => Promise<any>} fn called with the args given after the key
 * @param {{max?: number}} [opts]
 * @returns {(key: string, ...args: any[]) => Promise<any>}
 */
function cachedByKey(ttlMs, fn, { max = 64 } = {}) {
  const entries = new Map(); // insertion order doubles as recency order

  return (key, ...args) => {
    let get = entries.get(key);
    if (get) {
      entries.delete(key); // re-insert to mark as most recently used
    } else {
      get = cached(ttlMs, () => fn(...args));
    }
    entries.set(key, get);
    if (entries.size > max) entries.delete(entries.keys().next().value);
    return get();
  };
}

module.exports = { cached, cachedByKey };
