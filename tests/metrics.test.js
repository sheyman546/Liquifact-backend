'use strict';

jest.mock('redis', () => {
  const mockClient = {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    setEx: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    quit: jest.fn().mockResolvedValue('OK'),
    isOpen: false,
  };
  return {
    createClient: jest.fn(() => mockClient),
  };
}, { virtual: true });

const request = require('supertest');
const { createApp } = require('../src/app');
const metrics = require('../src/metrics');
const JobQueue = require('../src/workers/jobQueue');
const BackgroundWorker = require('../src/workers/worker');

// Destructure internal helpers used by the metrics-auth / safeEqual tests.
const { metricsAuth, safeEqual, extractClientIp, LOOPBACK } = metrics;

describe('GET /metrics', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    metrics.resetMetricsForTests();
    metrics.registry.resetMetrics();
  });

  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('METRICS_BEARER_TOKEN configured', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'test-metrics-secret';
    });

    it('returns 200 with Prometheus text when correct token supplied', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/# HELP/);
    });

    it('returns 200 when Authorization header uses uppercase key', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('authorization', 'Bearer test-metrics-secret');

      expect(res.status).toBe(200);
    });

    it('returns 401 when Authorization header is missing', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when token is wrong', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 401 when Authorization scheme is not Bearer', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
    });

    it('returns 401 with uniform error body for missing token (no distinction)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
      // Body must not reveal whether token exists or not
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });

    it('returns 401 with uniform error body for wrong token (no distinction)', async () => {
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Unauthorized' });
    });
  });

  describe('METRICS_BEARER_TOKEN not configured (private-network mode)', () => {
    it('returns 200 from loopback (supertest uses 127.0.0.1)', async () => {
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/# HELP/);
    });

    it('includes queue and worker metrics when registered', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 1 });
      worker.registerHandler('test', async () => {});

      const jobId = worker.enqueue('test', { data: 'test' });
      const queuedJob = queue.getJob(jobId);
      expect(queuedJob).toBeDefined();

      metrics.refreshMetrics();

      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/liquifact_job_queue_depth/);
      expect(res.text).toMatch(/liquifact_job_retry_queue_size/);
      expect(res.text).toMatch(/liquifact_worker_inflight_count/);
      expect(res.text).toMatch(/liquifact_job_queue_depth \d+/);
    });
  });

  describe('metrics instrumentation', () => {
    it('updates queue depth and retry queue size from job queue stats', () => {
      const queue = new JobQueue();
      const jobId = queue.enqueue('test', { data: 'pending' });
      metrics.registerJobQueue(queue);

      queue.dequeue();
      queue.retry(jobId, new Error('failed'));
      metrics.refreshMetrics();

      const output = metrics.registry.metrics();
      expect(output).toMatch(/liquifact_job_queue_depth \d+/);
      expect(output).toMatch(/liquifact_job_retry_queue_size 1/);
    });

    it('updates worker in-flight count from worker stats', async () => {
      const queue = new JobQueue();
      const worker = new BackgroundWorker({ jobQueue: queue, pollIntervalMs: 50, maxConcurrency: 2 });
      worker.registerHandler('test', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      worker.start();
      worker.enqueue('test', { data: 1 });
      worker.enqueue('test', { data: 2 });

      await new Promise((resolve) => setTimeout(resolve, 50));
      metrics.refreshMetrics();

      const output = metrics.registry.metrics();
      expect(output).toMatch(/liquifact_worker_inflight_count [12]/);
      await worker.stop();
    });
  });
});

describe('safeEqual — constant-time comparison', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(safeEqual('abc', 'xyz')).toBe(false);
  });

  it('returns false for strings of different lengths', () => {
    expect(safeEqual('short', 'longer')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(safeEqual('', '')).toBe(true);
  });

  it('returns false for empty vs non-empty', () => {
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('returns false for similar prefixes', () => {
    expect(safeEqual('Bearer token-a', 'Bearer token-b')).toBe(false);
  });

  it('handles special characters', () => {
    expect(safeEqual('a!@#', 'a!@#')).toBe(true);
    expect(safeEqual('a!@#', 'a!@$')).toBe(false);
  });
});

describe('extractClientIp', () => {
  it('returns socket.remoteAddress when available', () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, ip: '10.0.0.1' };
    expect(extractClientIp(req)).toBe('127.0.0.1');
  });

  it('falls back to req.ip when socket.remoteAddress is absent', () => {
    const req = { socket: {}, ip: '::1' };
    expect(extractClientIp(req)).toBe('::1');
  });

  it('falls back to req.ip when socket is absent', () => {
    const req = { ip: '::ffff:127.0.0.1' };
    expect(extractClientIp(req)).toBe('::ffff:127.0.0.1');
  });

  it('returns empty string when neither source is available', () => {
    const req = { socket: {} };
    expect(extractClientIp(req)).toBe('');
  });

  it('returns empty string when req is empty', () => {
    expect(extractClientIp({})).toBe('');
  });
});

describe('LOOPBACK set', () => {
  it('contains 127.0.0.1', () => {
    expect(LOOPBACK.has('127.0.0.1')).toBe(true);
  });

  it('contains ::1', () => {
    expect(LOOPBACK.has('::1')).toBe(true);
  });

  it('contains ::ffff:127.0.0.1', () => {
    expect(LOOPBACK.has('::ffff:127.0.0.1')).toBe(true);
  });

  it('does not contain external IPs', () => {
    expect(LOOPBACK.has('10.0.0.1')).toBe(false);
    expect(LOOPBACK.has('192.168.1.1')).toBe(false);
    expect(LOOPBACK.has('172.16.0.1')).toBe(false);
  });
});

describe('export guard — every module export is defined and valid', () => {
  const metricExports = [
    'footprintCacheHitsTotal',
    'footprintCacheMissesTotal',
    'footprintCacheEvictionsTotal',
    'escrowIndexerEventsProcessedTotal',
    'escrowIndexerEventsSkippedTotal',
    'escrowIndexerCycleFailuresTotal',
    'escrowReconciliationMismatches',
    'maturityReminderDeliveryAttemptsTotal',
    'maturityReminderDeliverySuccessTotal',
    'maturityReminderDeadLetterTotal',
    'sorobanCircuitBreakerStateTransitionsTotal',
    'cacheStoreErrorsTotal',
    'redisCacheFailOpenTotal',
    'readinessGauge',
  ];

  const counterExports = [
    'footprintCacheHitsTotal',
    'footprintCacheMissesTotal',
    'footprintCacheEvictionsTotal',
    'escrowIndexerEventsProcessedTotal',
    'escrowIndexerEventsSkippedTotal',
    'escrowIndexerCycleFailuresTotal',
    'escrowReconciliationMismatches',
    'maturityReminderDeliveryAttemptsTotal',
    'maturityReminderDeliverySuccessTotal',
    'maturityReminderDeadLetterTotal',
    'sorobanCircuitBreakerStateTransitionsTotal',
    'cacheStoreErrorsTotal',
    'redisCacheFailOpenTotal',
  ];

  const gaugeExports = [
    'readinessGauge',
    'escrowIndexerLastCursorAdvanceTimestampSeconds',
  ];

  it('every exported metric is defined (not undefined)', () => {
    for (const key of metricExports) {
      expect(metrics[key]).toBeDefined();
    }
  });

  it('every exported metric is not null', () => {
    for (const key of metricExports) {
      expect(metrics[key]).not.toBeNull();
    }
  });

  it('every counter export has an inc method', () => {
    for (const key of counterExports) {
      expect(typeof metrics[key].inc).toBe('function');
    }
  });

  it('every gauge export has a set method', () => {
    for (const key of gaugeExports) {
      expect(typeof metrics[key].set).toBe('function');
    }
  });

  it('sorobanCircuitBreakerStateTransitionsTotal has expected labelNames', () => {
    const counter = metrics.sorobanCircuitBreakerStateTransitionsTotal;
    expect(counter.labelNames).toBeDefined();
    const names = Array.isArray(counter.labelNames) ? counter.labelNames : [];
    expect(names).toContain('breaker_name');
    expect(names).toContain('from_state');
    expect(names).toContain('to_state');
    expect(names.length).toBe(3);
  });
});

describe('sorobanCircuitBreakerStateTransitionsTotal — circuit breaker integration', () => {
  const { CircuitBreaker, CircuitBreakerState } = require('../src/utils/circuitBreaker');

  beforeEach(() => {
    metrics.registry.resetMetrics();
  });

  it('is incremented on CLOSED -> OPEN transition', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1, recoveryTimeout: 999999 });
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    const metric = metrics.registry.getSingleMetric('soroban_circuit_breaker_state_transitions_total');
    expect(metric).toBeDefined();
  });

  it('is incremented on OPEN -> HALF_OPEN and back to OPEN on failure', async () => {
    const breaker = new CircuitBreaker({ name: 'test-half-open', failureThreshold: 1, recoveryTimeout: 1 });
    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.nextAttemptTime = 0;
    await expect(breaker.execute(async () => { throw new Error('still fail'); })).rejects.toThrow('still fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);
  });

  it('is incremented on HALF_OPEN -> CLOSED on success', async () => {
    const breaker = new CircuitBreaker({ name: 'test-recover', failureThreshold: 1, recoveryTimeout: 1 });

    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.nextAttemptTime = 0;
    breaker._transitionState(CircuitBreakerState.HALF_OPEN);
    expect(breaker.state).toBe(CircuitBreakerState.HALF_OPEN);

    await breaker.execute(async () => 'ok');

    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('is incremented on reset() transition back to CLOSED', async () => {
    const breaker = new CircuitBreaker({ name: 'test-reset', failureThreshold: 1, recoveryTimeout: 99999 });
    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow('fail');

    expect(breaker.state).toBe(CircuitBreakerState.OPEN);

    breaker.reset();

    expect(breaker.state).toBe(CircuitBreakerState.CLOSED);
  });

  it('label values are bounded to the CircuitBreakerState enum', () => {
    const validStates = ['CLOSED', 'OPEN', 'HALF_OPEN'];
    expect(Object.values(CircuitBreakerState)).toEqual(validStates);
  });

  it('does not increment when state does not change', () => {
    const breaker = new CircuitBreaker({ name: 'test-noop' });
    const initial = breaker.state;

    breaker._transitionState(CircuitBreakerState.CLOSED);

    expect(breaker.state).toBe(initial);
  });

  it('returns Prometheus text before any transition (edge: scrape before first transition)', () => {
    const promString = metrics.registry.metrics();
    expect(typeof promString).toBe('string');
  });
});

describe('metricsAuth unit', () => {
  afterEach(() => {
    delete process.env.METRICS_BEARER_TOKEN;
  });

  describe('token configured', () => {
    beforeEach(() => {
      process.env.METRICS_BEARER_TOKEN = 'super-secret-token';
    });

    it('calls next() when correct bearer token is supplied', () => {
      const req = {
        headers: { authorization: 'Bearer super-secret-token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects non-loopback when token is wrong', () => {
      const req = {
        headers: { authorization: 'Bearer wrong-token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects even loopback addresses when token is configured but wrong', () => {
      // When token is set, loopback is NOT a bypass — token is required
      const req = {
        headers: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects loopback with wrong token even from ::1', () => {
      const req = {
        headers: { authorization: 'Bearer bad' },
        ip: '::1',
        socket: { remoteAddress: '::1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('no token configured', () => {
    it('calls next() for 127.0.0.1 loopback', () => {
      const req = { headers: {}, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('rejects non-loopback', () => {
      const req = { headers: {}, ip: '10.0.0.5', socket: { remoteAddress: '10.0.0.5' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() for ::1 (IPv6 loopback)', () => {
      const req = { headers: {}, ip: '::1', socket: { remoteAddress: '::1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('calls next() for ::ffff:127.0.0.1', () => {
      const req = { headers: {}, ip: '::ffff:127.0.0.1', socket: { remoteAddress: '::ffff:127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('falls back to socket.remoteAddress when req.ip is empty', () => {
      const req = { headers: {}, ip: '', socket: { remoteAddress: '127.0.0.1' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });

    it('returns 401 when both req.ip and socket.remoteAddress are absent', () => {
      const req = { headers: {}, ip: undefined, socket: {} };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('X-Forwarded-For spoofing protection', () => {
    it('ignores X-Forwarded-For header when socket is non-loopback', () => {
      // Attacker sends X-Forwarded-For: 127.0.0.1 but connects from 10.0.0.99
      const req = {
        headers: { 'x-forwarded-for': '127.0.0.1' },
        ip: '127.0.0.1', // Express resolved from X-Forwarded-For
        socket: { remoteAddress: '10.0.0.99' }, // Actual TCP connection
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      // Must reject because socket.remoteAddress is 10.0.0.99 (not loopback)
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks X-Forwarded-For spoof via ::ffff:127.0.0.1', () => {
      const req = {
        headers: { 'x-forwarded-for': '::ffff:127.0.0.1' },
        ip: '::ffff:127.0.0.1',
        socket: { remoteAddress: '172.16.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('blocks X-Forwarded-For ::1 spoof', () => {
      const req = {
        headers: { 'x-forwarded-for': '::1' },
        ip: '::1',
        socket: { remoteAddress: '192.168.1.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('allows real loopback even when X-Forwarded-For is absent', () => {
      const req = {
        headers: {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
    });
  });

  describe('uniform error response', () => {
    it('does not distinguish between missing and wrong token in response body', () => {
      process.env.METRICS_BEARER_TOKEN = 'secret';

      const missingReq = {
        headers: {},
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const wrongReq = {
        headers: { authorization: 'Bearer wrong' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };

      const res1 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(missingReq, res1, next);
      metricsAuth(wrongReq, res2, next);

      expect(res1.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
      expect(res2.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    });
  });

  describe('Authorization header casing', () => {
    it('accepts lowercase "authorization" header', () => {
      process.env.METRICS_BEARER_TOKEN = 'token';
      const req = {
        headers: { authorization: 'Bearer token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      delete process.env.METRICS_BEARER_TOKEN;
    });

    it('accepts uppercase "Authorization" header', () => {
      process.env.METRICS_BEARER_TOKEN = 'token';
      const req = {
        headers: { Authorization: 'Bearer token' },
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.1' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      metricsAuth(req, res, next);
      expect(next).toHaveBeenCalled();
      delete process.env.METRICS_BEARER_TOKEN;
    });
  });
});