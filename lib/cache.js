// Simple in-memory TTL cache. No external deps, process-local.
// Values: { value, expiresAt }. Periodic sweep to avoid unbounded growth.
class TtlCache {
  constructor({ maxEntries = 2000, sweepIntervalMs = 5 * 60 * 1000 } = {}) {
    this.map = new Map();
    this.maxEntries = maxEntries;
    if (sweepIntervalMs > 0 && sweepIntervalMs < 2 ** 31) {
      const t = setInterval(() => this.sweep(), sweepIntervalMs);
      if (typeof t.unref === 'function') t.unref();
    }
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key, value, ttlSeconds) {
    if (this.map.size >= this.maxEntries) this.sweep();
    if (this.map.size >= this.maxEntries) {
      // evict oldest (Map preserves insertion order)
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async getOrFetch(key, ttlSeconds, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlSeconds);
    return value;
  }

  sweep() {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (now > e.expiresAt) this.map.delete(k);
      if (this.map.size <= this.maxEntries * 0.9) break;
    }
  }
}

module.exports = { TtlCache };
