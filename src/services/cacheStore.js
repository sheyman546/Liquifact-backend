// src/services/cacheStore.js
/**
 * In-memory cache store backed by a native Map.
 * Each entry is stored with an expiry timestamp for TTL-based eviction.
 * Supports a configurable maximum number of entries with LRU eviction.
 * Metrics for hits, misses, and evictions are emitted via the metrics module.
 *
 * @class
 */
const { footprintCacheHitsTotal, footprintCacheMissesTotal, footprintCacheEvictionsTotal } = require('../metrics');

class MemoryCacheStore {
  /**
   * Creates a new MemoryCacheStore instance with optional bounds.
   *
   * @param {object} [options] - Options for the cache store.
   * @param {number} [options.maxEntries] - Maximum number of entries before LRU eviction. Defaults to 5000.
   */
  constructor(options = {}) {
    const { maxEntries = 5000 } = options;
    // treat non‑positive values as unlimited (Infinity) to preserve backward compatibility
    this._maxEntries = maxEntries > 0 ? maxEntries : Infinity;
    // Map preserves insertion order – we will delete/re‑insert on access to maintain LRU ordering
    this._cache = new Map();
  }

  /**
   * Retrieves a cached value by key. Returns undefined if the key is missing
   * or expired. Expired entries are lazily evicted. Updates LRU order on hit.
   *
   * @param {string} key - The cache key to look up.
   * @returns {*} The cached value, or undefined if missing/expired.
   */
  get(key) {
    const entry = this._cache.get(key);
    if (!entry) {
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      // TTL expiry – treat as miss and clean up
      this._cache.delete(key);
      footprintCacheMissesTotal.inc();
      return undefined;
    }
    // Cache hit – move entry to the end to mark it as most‑recently used
    this._cache.delete(key);
    this._cache.set(key, entry);
    footprintCacheHitsTotal.inc();
    return entry.value;
  }

  /**
   * Stores a value in the cache with a TTL in milliseconds.
   * Enforces the LRU bound after insertion.
   *
   * @param {string} key - The cache key.
   * @param {*} value - The value to cache.
   * @param {number} ttlMs - Time-to-live in milliseconds.
   * @returns {void}
   */
  set(key, value, ttlMs) {
    // If key already exists, delete it first so that insertion order reflects recency
    if (this._cache.has(key)) {
      this._cache.delete(key);
    }
    const entry = { value, expiresAt: Date.now() + ttlMs };
    this._cache.set(key, entry);
    // Evict least‑recently used entries while we exceed the bound
    while (this._cache.size > this._maxEntries) {
      const lruKey = this._cache.keys().next().value;
      this._cache.delete(lruKey);
      footprintCacheEvictionsTotal.inc();
    }
  }

  /**
   * Removes a specific entry from the cache.
   *
   * @param {string} key - The cache key to remove.
   * @returns {void}
   */
  del(key) {
    this._cache.delete(key);
  }

  /**
   * Removes all entries from the cache.
   *
   * @returns {void}
   */
  clear() {
    this._cache.clear();
  }
}

/**
 * Factory function that creates a cache store instance.
 * Currently returns a MemoryCacheStore. Future implementations can check
 * for REDIS_URL and return a Redis-backed store.
 *
 * @param {object} [options] Options passed to the MemoryCacheStore constructor.
 * @returns {MemoryCacheStore} A cache store instance.
 */
function createCacheStore(options = {}) {
  return new MemoryCacheStore(options);
}

module.exports = { MemoryCacheStore, createCacheStore };
