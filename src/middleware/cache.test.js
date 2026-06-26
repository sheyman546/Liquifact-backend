const { cacheResponse, invalidatePrefix, makeMarketplaceKey, makeInvestorLocksKey, makeInvestorLockKey } = require('./cache');
const { MemoryCacheStore, getSharedStore } = require('../services/cacheStore');
const logger = require('../logger');
const { cacheStoreErrorsTotal } = require('../metrics');

/**
 * Creates a minimal mock Express response for testing.
 *
 * @returns {object} Mock response.
 */
function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    set(name, value) {
      res.headers[name] = value;
      return res;
    },
  };
  return res;
}

describe('cacheResponse', () => {
  let store;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  it('calls next on cache miss and caches the 2xx response', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'from handler' });

      expect(res.body).toEqual({ data: 'from handler' });
      expect(res.headers['X-Cache']).toBe('MISS');
      expect(store.get('/api/escrow/123')).toEqual({ data: 'from handler' });
      done();
    });
  });

  it('returns cached response on cache hit without calling next', () => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    store.set('/api/escrow/123', { data: 'cached' }, 5000);

    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });

    expect(nextCalled).toBe(false);
    expect(res.body).toEqual({ data: 'cached' });
    expect(res.headers['X-Cache']).toBe('HIT');
  });

  it('does not cache non-2xx responses', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = { originalUrl: '/api/escrow/bad' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.status(500).json({ error: 'fail' });

      expect(res.body).toEqual({ error: 'fail' });
      expect(store.get('/api/escrow/bad')).toBeUndefined();
      done();
    });
  });

  it('uses custom keyFn to generate cache key', (done) => {
    const keyFn = (r) => `custom:${r.params.id}`;
    const middleware = cacheResponse({ ttl: 5000, store, keyFn });
    const req = { originalUrl: '/api/escrow/456', params: { id: '456' } };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'keyed' });
      expect(store.get('custom:456')).toEqual({ data: 'keyed' });
      done();
    });
  });

  it('falls through to handler when cache store get throws', (done) => {
    const brokenStore = {
      get() { throw new Error('store broken'); },
    };
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: brokenStore });
    const req = { originalUrl: '/api/escrow/123' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'fallthrough' });
      expect(res.body).toEqual({ data: 'fallthrough' });
      expect(warnSpy).toHaveBeenCalled();
      expect(incSpy).toHaveBeenCalledTimes(1);

      const callArg = warnSpy.mock.calls[0];
      expect(callArg[1]).toBe('Cache store get error, falling through');
      expect(callArg[0]).toMatchObject({ err: expect.any(Error), component: 'cache' });
      expect(callArg[0].err.message).toBe('store broken');

      warnSpy.mockRestore();
      incSpy.mockRestore();
      done();
    });
  });

  it('logs warning but still sends response when cache store set throws', (done) => {
    const setErrorStore = {
      get() { return undefined; },
      set() { throw new Error('set broken'); },
    };
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: setErrorStore });
    const req = { originalUrl: '/api/escrow/789' };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'still works' });
      expect(res.body).toEqual({ data: 'still works' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(incSpy).toHaveBeenCalledTimes(1);

      const callArg = warnSpy.mock.calls[0];
      expect(callArg[1]).toBe('Cache store set error');
      expect(callArg[0]).toMatchObject({ err: expect.any(Error), component: 'cache' });
      expect(callArg[0].err.message).toBe('set broken');

      warnSpy.mockRestore();
      incSpy.mockRestore();
      done();
    });
  });

  it('uses req.log when available for cache store get error', (done) => {
    const brokenStore = {
      get() { throw new Error('req log error'); },
    };
    const reqLog = { warn: jest.fn() };
    const rootWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: brokenStore });
    const req = { originalUrl: '/api/test', log: reqLog };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'ok' });
      expect(res.body).toEqual({ data: 'ok' });
      // req.log.warn should have been used, NOT the root logger
      expect(reqLog.warn).toHaveBeenCalledTimes(1);
      expect(rootWarnSpy).not.toHaveBeenCalled();
      expect(incSpy).toHaveBeenCalledTimes(1);

      const callArg = reqLog.warn.mock.calls[0];
      expect(callArg[1]).toBe('Cache store get error, falling through');
      expect(callArg[0]).toMatchObject({ err: expect.any(Error), component: 'cache' });

      reqLog.warn.mockRestore();
      rootWarnSpy.mockRestore();
      incSpy.mockRestore();
      done();
    });
  });

  it('uses req.log when available for cache store set error', (done) => {
    const setErrorStore = {
      get() { return undefined; },
      set() { throw new Error('req log set error'); },
    };
    const reqLog = { warn: jest.fn() };
    const rootWarnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: setErrorStore });
    const req = { originalUrl: '/api/test', log: reqLog };
    const res = createMockRes();

    middleware(req, res, () => {
      res.json({ data: 'ok' });
      expect(res.body).toEqual({ data: 'ok' });
      expect(reqLog.warn).toHaveBeenCalledTimes(1);
      expect(rootWarnSpy).not.toHaveBeenCalled();
      expect(incSpy).toHaveBeenCalledTimes(1);

      const callArg = reqLog.warn.mock.calls[0];
      expect(callArg[1]).toBe('Cache store set error');
      expect(callArg[0]).toMatchObject({ err: expect.any(Error), component: 'cache' });

      reqLog.warn.mockRestore();
      rootWarnSpy.mockRestore();
      incSpy.mockRestore();
      done();
    });
  });

  it('increments counter on each cache store error', (done) => {
    let getCallCount = 0;
    const brokenStore = {
      get() {
        getCallCount++;
        throw new Error('store error ' + getCallCount);
      },
    };
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const middleware = cacheResponse({ ttl: 5000, store: brokenStore });
    const req = { originalUrl: '/api/test' };
    let callCount = 0;

    function handler() {
      callCount++;
      if (callCount === 1) {
        expect(incSpy).toHaveBeenCalledTimes(1);
        middleware(req, createMockRes(), handler);
      } else {
        expect(incSpy).toHaveBeenCalledTimes(2);
        warnSpy.mockRestore();
        incSpy.mockRestore();
        done();
      }
    }

    middleware(req, createMockRes(), handler);
  });

  // ── Cache-Control: no-cache bypass ───────────────────────────────────────

  it('bypasses cache when Cache-Control: no-cache is present', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = {
      originalUrl: '/api/test',
      headers: { 'cache-control': 'no-cache' },
    };
    const res = createMockRes();

    store.set('/api/test', { cached: 'data' }, 5000);

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
      // Respond as handler would
      res.json({ fresh: 'data' });
      expect(res.body).toEqual({ fresh: 'data' });
      done();
    });

    expect(nextCalled).toBe(true);
  });

  it('bypasses cache when Cache-Control header includes no-cache with other directives', (done) => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = {
      originalUrl: '/api/test',
      headers: { 'cache-control': 'max-age=0, no-cache, must-revalidate' },
    };
    const res = createMockRes();

    store.set('/api/test', { cached: 'data' }, 5000);

    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
      res.json({ fresh: 'data' });
      done();
    });

    expect(nextCalled).toBe(true);
  });

  it('does not bypass cache for other Cache-Control values', () => {
    const middleware = cacheResponse({ ttl: 5000, store });
    const req = {
      originalUrl: '/api/test',
      headers: { 'cache-control': 'max-age=3600' },
    };
    const res = createMockRes();

    store.set('/api/test', { cached: 'data' }, 5000);

    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });

    // Should have returned cached, not called next
    expect(nextCalled).toBe(false);
    expect(res.body).toEqual({ cached: 'data' });
    expect(res.headers['X-Cache']).toBe('HIT');
  });
});

describe('makeMarketplaceKey', () => {
  it('includes tenantId and originalUrl in the cache key', () => {
    const req = { tenantId: 'tenant-alpha', originalUrl: '/api/marketplace?status=verified&limit=10' };
    expect(makeMarketplaceKey(req)).toBe('marketplace:tenant-alpha:/api/marketplace?status=verified&limit=10');
  });

  it('falls back to "unknown" tenantId when missing', () => {
    const req = { originalUrl: '/api/marketplace' };
    expect(makeMarketplaceKey(req)).toBe('marketplace:unknown:/api/marketplace');
  });
});

describe('makeInvestorLocksKey', () => {
  it('includes tenantId and originalUrl in the cache key', () => {
    const req = { tenantId: 'tenant-beta', originalUrl: '/api/investor/locks?funderAddress=GABC' };
    expect(makeInvestorLocksKey(req)).toBe('investor:locks:tenant-beta:/api/investor/locks?funderAddress=GABC');
  });
});

describe('makeInvestorLockKey', () => {
  it('includes tenantId, invoiceId, and funderAddress', () => {
    const req = {
      tenantId: 'tenant-gamma',
      params: { invoiceId: 'inv_123' },
      query: { funderAddress: 'GXXX' },
    };
    expect(makeInvestorLockKey(req)).toBe('investor:lock:tenant-gamma:inv_123:GXXX');
  });
});

describe('invalidatePrefix', () => {
  it('deletes all keys matching the prefix', () => {
    const store = new MemoryCacheStore();
    store.set('marketplace:tenant-a:url1', { data: 1 }, 50000);
    store.set('marketplace:tenant-a:url2', { data: 2 }, 50000);
    store.set('investor:locks:tenant-a', { data: 3 }, 50000);
    store.set('other:key', { data: 4 }, 50000);

    invalidatePrefix(store, 'marketplace:');

    expect(store.get('marketplace:tenant-a:url1')).toBeUndefined();
    expect(store.get('marketplace:tenant-a:url2')).toBeUndefined();
    expect(store.get('investor:locks:tenant-a')).toEqual({ data: 3 });
    expect(store.get('other:key')).toEqual({ data: 4 });
  });

  it('does nothing when no keys match', () => {
    const store = new MemoryCacheStore();
    store.set('other:key', { data: 1 }, 50000);

    invalidatePrefix(store, 'marketplace:');

    expect(store.get('other:key')).toEqual({ data: 1 });
  });

  it('handles empty store without error', () => {
    const store = new MemoryCacheStore();
    invalidatePrefix(store, 'marketplace:');
  });

  it('logs and swallows store errors', () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const incSpy = jest.spyOn(cacheStoreErrorsTotal, 'inc').mockImplementation(() => {});
    const brokenStore = {
      delByPrefix() { throw new Error('store error'); },
    };

    invalidatePrefix(brokenStore, 'marketplace:');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(incSpy).toHaveBeenCalledTimes(1);

    const callArg = warnSpy.mock.calls[0];
    expect(callArg[1]).toBe('Cache invalidation error');
    expect(callArg[0]).toMatchObject({ err: expect.any(Error), component: 'cache', cachePrefix: 'marketplace:' });
    expect(callArg[0].err.message).toBe('store error');

    warnSpy.mockRestore();
    incSpy.mockRestore();
  });
});

describe('getSharedStore', () => {
  it('returns the same instance across calls', () => {
    const a = getSharedStore();
    const b = getSharedStore();
    expect(a).toBe(b);
  });

  it('is a MemoryCacheStore with working get/set', () => {
    const store = getSharedStore();
    store.set('shared-test', { ok: true }, 5000);
    expect(store.get('shared-test')).toEqual({ ok: true });
    store.del('shared-test');
  });
});

describe('MemoryCacheStore — keys and delByPrefix', () => {
  let store;

  beforeEach(() => {
    store = new MemoryCacheStore();
  });

  describe('keys', () => {
    it('returns all valid keys', () => {
      store.set('a', 1, 50000);
      store.set('b', 2, 50000);
      const keys = store.keys();
      expect(keys).toContain('a');
      expect(keys).toContain('b');
    });

    it('excludes expired keys', () => {
      const now = Date.now();
      jest.spyOn(Date, 'now')
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 100000);

      store.set('expired', 'x', 100);
      const keys = store.keys();

      expect(keys).not.toContain('expired');
      Date.now.mockRestore();
    });

    it('returns empty array for empty store', () => {
      expect(store.keys()).toEqual([]);
    });
  });

  describe('delByPrefix', () => {
    it('deletes only matching keys', () => {
      store.set('alpha:1', 'a1', 50000);
      store.set('alpha:2', 'a2', 50000);
      store.set('beta:1', 'b1', 50000);

      store.delByPrefix('alpha:');

      expect(store.get('alpha:1')).toBeUndefined();
      expect(store.get('alpha:2')).toBeUndefined();
      expect(store.get('beta:1')).toBe('b1');
    });

    it('evicts expired entries during iteration', () => {
      const SET_TIME = 1000;
      const ITERATE_TIME = 2000;
      let callIndex = 0;
      jest.spyOn(Date, 'now').mockImplementation(() => {
        callIndex++;
        return callIndex <= 2 ? SET_TIME : ITERATE_TIME;
      });

      store.set('keep:1', 'k1', 50000);    // expires at SET_TIME+50000 = 51000
      store.set('expired:1', 'e1', 100);    // expires at SET_TIME+100   = 1100

      // Call with a prefix that matches neither key
      store.delByPrefix('other:');

      // expired:1 should have been evicted (1100 < 2000)
      expect(store.get('expired:1')).toBeUndefined();
      // keep:1 still valid (51000 > 2000) → preserved
      expect(store.get('keep:1')).toBe('k1');

      Date.now.mockRestore();
    });

    it('is safe on empty store', () => {
      store.delByPrefix('anything:');
    });
  });
});

describe('Tenant isolation — distinct cache keys', () => {
  it('produces different cache keys for different tenants with same query', () => {
    const reqA = { tenantId: 'tenant-a', originalUrl: '/api/marketplace?status=verified' };
    const reqB = { tenantId: 'tenant-b', originalUrl: '/api/marketplace?status=verified' };
    expect(makeMarketplaceKey(reqA)).not.toBe(makeMarketplaceKey(reqB));
  });

  it('produces different cache keys for different query strings', () => {
    const reqA = { tenantId: 'tenant-a', originalUrl: '/api/marketplace?status=verified' };
    const reqB = { tenantId: 'tenant-a', originalUrl: '/api/marketplace?status=partially_funded' };
    expect(makeMarketplaceKey(reqA)).not.toBe(makeMarketplaceKey(reqB));
  });

  it('tenant-scoped invalidation does not affect other tenants', () => {
    const store = new MemoryCacheStore();
    store.set('marketplace:tenant-a:url', { a: 1 }, 50000);
    store.set('marketplace:tenant-b:url', { b: 2 }, 50000);

    invalidatePrefix(store, 'marketplace:tenant-a:');

    expect(store.get('marketplace:tenant-a:url')).toBeUndefined();
    expect(store.get('marketplace:tenant-b:url')).toEqual({ b: 2 });
  });
});
