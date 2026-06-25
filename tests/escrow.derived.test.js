'use strict';

/**
 * @fileoverview Tests for escrowDerived service — APY, funded percent, days-to-maturity.
 *
 * Covers:
 *   - computeApyPercent: valid rates, null/invalid inputs, rounding, IEEE 754 edge cases
 *   - computeFundedPercent: normal cases, zero/negative totalAmount, non-numeric inputs
 *   - computeDaysToMaturity: future/past/today, ISO strings, ms timestamps, null/invalid
 *   - computeEscrowDerivedFields: full integration, maturityTimestamp alias, null fall-through
 *   - HTTP: GET /v1/escrow/:invoiceId includes derived fields in JSON response
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const {
  computeApyPercent,
  computeFundedPercent,
  computeDaysToMaturity,
  computeEscrowDerivedFields,
} = require('../src/services/escrowDerived');

// ── computeApyPercent ─────────────────────────────────────────────────────────

describe('computeApyPercent', () => {
  it('returns the value unchanged for a round rate', () => {
    expect(computeApyPercent(8)).toBe(8);
    expect(computeApyPercent(0)).toBe(0);
    expect(computeApyPercent(100)).toBe(100);
  });

  it('rounds to 2 decimal places', () => {
    expect(computeApyPercent(8.5)).toBe(8.5);
    expect(computeApyPercent(8.123)).toBe(8.12);
    expect(computeApyPercent(8.126)).toBe(8.13);
    expect(computeApyPercent(8.125)).toBe(8.13); // round-half-up
  });

  it('handles IEEE 754 drift without leaking extra decimals', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS
    const result = computeApyPercent(0.1 + 0.2);
    expect(result).toBe(0.3);
  });

  it('returns null for null', () => {
    expect(computeApyPercent(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(computeApyPercent(undefined)).toBeNull();
  });

  it('returns null for non-numeric strings', () => {
    expect(computeApyPercent('8.5')).toBeNull();
    expect(computeApyPercent('')).toBeNull();
  });

  it('returns null for objects and arrays', () => {
    expect(computeApyPercent({})).toBeNull();
    expect(computeApyPercent([])).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(computeApyPercent(Infinity)).toBeNull();
    expect(computeApyPercent(-Infinity)).toBeNull();
  });

  it('returns null for NaN', () => {
    expect(computeApyPercent(NaN)).toBeNull();
  });

  it('returns null for negative rates', () => {
    expect(computeApyPercent(-1)).toBeNull();
    expect(computeApyPercent(-0.001)).toBeNull();
  });
});

// ── computeFundedPercent ──────────────────────────────────────────────────────

describe('computeFundedPercent', () => {
  it('computes 50% correctly', () => {
    expect(computeFundedPercent(500, 1000)).toBe(50);
  });

  it('computes 75% correctly', () => {
    expect(computeFundedPercent(750, 1000)).toBe(75);
  });

  it('computes 100% (fully funded)', () => {
    expect(computeFundedPercent(1000, 1000)).toBe(100);
  });

  it('computes 0% (nothing funded)', () => {
    expect(computeFundedPercent(0, 1000)).toBe(0);
  });

  it('rounds repeating decimals to 2 dp', () => {
    expect(computeFundedPercent(1, 3)).toBe(33.33);
    expect(computeFundedPercent(2, 3)).toBe(66.67);
  });

  it('allows over-funded values (> 100%)', () => {
    expect(computeFundedPercent(1500, 1000)).toBe(150);
  });

  it('returns null when totalAmount is zero', () => {
    expect(computeFundedPercent(0, 0)).toBeNull();
    expect(computeFundedPercent(100, 0)).toBeNull();
  });

  it('returns null when totalAmount is negative', () => {
    expect(computeFundedPercent(100, -500)).toBeNull();
  });

  it('returns null for non-numeric fundedAmount', () => {
    expect(computeFundedPercent(null, 1000)).toBeNull();
    expect(computeFundedPercent(undefined, 1000)).toBeNull();
    expect(computeFundedPercent('500', 1000)).toBeNull();
  });

  it('returns null for non-numeric totalAmount', () => {
    expect(computeFundedPercent(500, null)).toBeNull();
    expect(computeFundedPercent(500, undefined)).toBeNull();
    expect(computeFundedPercent(500, '1000')).toBeNull();
  });

  it('returns null when fundedAmount is Infinity', () => {
    expect(computeFundedPercent(Infinity, 1000)).toBeNull();
  });

  it('returns null when totalAmount is Infinity', () => {
    expect(computeFundedPercent(500, Infinity)).toBeNull();
  });

  it('returns null for NaN inputs', () => {
    expect(computeFundedPercent(NaN, 1000)).toBeNull();
    expect(computeFundedPercent(500, NaN)).toBeNull();
  });
});

// ── computeDaysToMaturity ─────────────────────────────────────────────────────

describe('computeDaysToMaturity', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  it('returns 30 for exactly 30 days in future', () => {
    const future = new Date('2026-05-27T12:00:00.000Z');
    expect(computeDaysToMaturity(future, NOW)).toBe(30);
  });

  it('returns 0 when maturity is later the same day', () => {
    const laterToday = new Date('2026-04-27T23:59:00.000Z');
    expect(computeDaysToMaturity(laterToday, NOW)).toBe(0);
  });

  it('returns 0 when maturity equals now exactly', () => {
    expect(computeDaysToMaturity(new Date(NOW.getTime()), NOW)).toBe(0);
  });

  it('returns negative days when maturity is in the past (overdue)', () => {
    const past = new Date('2026-03-27T12:00:00.000Z'); // 31 days ago
    expect(computeDaysToMaturity(past, NOW)).toBe(-31);
  });

  it('floors fractional days', () => {
    // 1.5 days from now → 1
    const oneAndHalf = new Date(NOW.getTime() + 1.5 * 24 * 60 * 60 * 1000);
    expect(computeDaysToMaturity(oneAndHalf, NOW)).toBe(1);
  });

  it('accepts an ISO date string', () => {
    expect(computeDaysToMaturity('2026-05-27T12:00:00.000Z', NOW)).toBe(30);
  });

  it('accepts a Unix timestamp in milliseconds', () => {
    const ms = new Date('2026-05-27T12:00:00.000Z').getTime();
    expect(computeDaysToMaturity(ms, NOW)).toBe(30);
  });

  it('accepts a date-only string', () => {
    // new Date('2026-05-27') parses as UTC midnight
    const result = computeDaysToMaturity('2026-05-27', NOW);
    expect(typeof result).toBe('number');
  });

  it('returns null for null', () => {
    expect(computeDaysToMaturity(null, NOW)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(computeDaysToMaturity(undefined, NOW)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(computeDaysToMaturity('not-a-date', NOW)).toBeNull();
    expect(computeDaysToMaturity('', NOW)).toBeNull();
  });

  it('defaults now to current system time when omitted', () => {
    const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const result = computeDaysToMaturity(future);
    // Should be ~5 days but we can only check type since clock ticks
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(4); // allow for 1-second drift
  });
});

// ── computeEscrowDerivedFields ────────────────────────────────────────────────

describe('computeEscrowDerivedFields', () => {
  const NOW = new Date('2026-04-27T12:00:00.000Z');

  it('computes all three fields from a complete state', () => {
    const state = {
      fundedAmount: 750,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: '2026-05-27T12:00:00.000Z',
    };
    expect(computeEscrowDerivedFields(state, { now: NOW })).toEqual({
      apyPercent: 8.5,
      fundedPercent: 75,
      daysToMaturity: 30,
    });
  });

  it('returns all nulls when state is empty', () => {
    expect(computeEscrowDerivedFields({})).toEqual({
      apyPercent: null,
      fundedPercent: null,
      daysToMaturity: null,
    });
  });

  it('uses maturityTimestamp as alias when maturityDate is absent', () => {
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 10,
      maturityTimestamp: '2026-05-27T12:00:00.000Z',
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.daysToMaturity).toBe(30);
  });

  it('prefers maturityDate over maturityTimestamp when both present', () => {
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 10,
      maturityDate: '2026-05-27T12:00:00.000Z',
      maturityTimestamp: '2026-06-27T12:00:00.000Z', // different, ignored
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.daysToMaturity).toBe(30); // from maturityDate
  });

  it('returns null for each field independently when its input is invalid', () => {
    const state = {
      fundedAmount: 'bad',
      totalAmount: 1000,
      annualRatePercent: null,
      maturityDate: 'invalid',
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.apyPercent).toBeNull();
    expect(result.fundedPercent).toBeNull();
    expect(result.daysToMaturity).toBeNull();
  });

  it('computes valid fields even when others are null', () => {
    const state = {
      fundedAmount: 200,
      totalAmount: 400,
      annualRatePercent: 5,
      // no maturityDate
    };
    const result = computeEscrowDerivedFields(state, { now: NOW });
    expect(result.apyPercent).toBe(5);
    expect(result.fundedPercent).toBe(50);
    expect(result.daysToMaturity).toBeNull();
  });

  it('defaults now to current time when opts are omitted', () => {
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5 };
    const result = computeEscrowDerivedFields(state);
    expect(result.apyPercent).toBe(5);
    expect(result.fundedPercent).toBe(0);
    expect(result.daysToMaturity).toBeNull();
  });

  it('returns an object with exactly the three derived keys', () => {
    const result = computeEscrowDerivedFields({});
    expect(Object.keys(result).sort()).toEqual(
      ['apyPercent', 'daysToMaturity', 'fundedPercent']
    );
  });
});

// ── HTTP integration: GET /v1/escrow/:invoiceId ───────────────────────────────

describe('GET /v1/escrow/:invoiceId — derived fields in response', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../src/services/soroban', () => ({
      callSorobanContract: jest.fn(async (op) => op()),
    }));

    jest.mock('../src/config/escrowMap', () => ({
      resolveEscrowAddress: jest.fn(() => 'CESCROWADDR0000000000000000000000000000000000000000000'),
      validateMappingConfig: jest.fn(() => ({ valid: true })),
    }));

    // Disable Redis cache so every request hits the operation stub
    jest.mock('../src/cache/redis', () => ({
      createRedisEscrowSummaryCache: jest.fn(() => null),
      RedisEscrowSummaryCache: jest.fn(),
    }));

    app = require('../src/index');
  });

  afterEach(() => {
    jest.resetModules();
  });

  function makeToken(payload = { sub: 'test-user' }) {
    const jwt = require('jsonwebtoken');
    return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
  }

  it('includes apyPercent, fundedPercent, daysToMaturity in response', async () => {
    const request = require('supertest');
    const { callSorobanContract } = require('../src/services/soroban');

    callSorobanContract.mockImplementation(async (op) => ({
      invoiceId: 'inv_500',
      status: 'active',
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ledgerSequence: 1234,
    }));

    const res = await request(app)
      .get('/v1/escrow/inv_500')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      invoiceId: 'inv_500',
      apyPercent: 8.5,
      fundedPercent: 50,
    });
    expect(typeof res.body.data.daysToMaturity).toBe('number');
    expect(res.body.data.daysToMaturity).toBeGreaterThanOrEqual(29);
  });

  it('returns null derived fields when state lacks source data', async () => {
    const request = require('supertest');
    const { callSorobanContract } = require('../src/services/soroban');

    callSorobanContract.mockImplementation(async (op) => ({
      invoiceId: 'inv_501',
      status: 'not_found',
      fundedAmount: 0,
      ledgerSequence: 1234,
    }));

    const res = await request(app)
      .get('/v1/escrow/inv_501')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.apyPercent).toBeNull();
    expect(res.body.data.fundedPercent).toBeNull();
    expect(res.body.data.daysToMaturity).toBeNull();
  });

  it('returns 404 when escrow address is not mapped', async () => {
    const request = require('supertest');
    const { resolveEscrowAddress } = require('../src/config/escrowMap');
    resolveEscrowAddress.mockReturnValue(null);

    const res = await request(app)
      .get('/v1/escrow/inv_999')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(404);
  });

  it('returns 401 without auth token', async () => {
    const request = require('supertest');
    const res = await request(app).get('/v1/escrow/inv_500');
    expect(res.status).toBe(401);
  });

  it('merges derived fields with raw escrow state (non-destructive)', async () => {
    const request = require('supertest');
    const { callSorobanContract } = require('../src/services/soroban');

    callSorobanContract.mockImplementation(async (op) => ({
      invoiceId: 'inv_502',
      status: 'active',
      fundedAmount: 250,
      totalAmount: 500,
      annualRatePercent: 12,
      ledgerSequence: 999,
    }));

    const res = await request(app)
      .get('/v1/escrow/inv_502')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    // raw fields preserved
    expect(res.body.data.fundedAmount).toBe(250);
    expect(res.body.data.ledgerSequence).toBe(999);
    // derived fields added
    expect(res.body.data.apyPercent).toBe(12);
    expect(res.body.data.fundedPercent).toBe(50);
  });
});

// ── resolveReferenceTime ──────────────────────────────────────────────────────

const { resolveReferenceTime } = require('../src/services/escrowDerived');

describe('resolveReferenceTime', () => {
  it('prefers ledgerCloseTime (epoch seconds) over opts.now', () => {
    const ledger = new Date('2026-04-27T00:00:00.000Z');
    const later = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({
      ledgerCloseTime: ledger.getTime() / 1000, // seconds
      now: later,
    });
    expect(result.getTime()).toBe(ledger.getTime());
  });

  it('prefers ledgerCloseTime as Date over opts.now', () => {
    const ledger = new Date('2026-04-27T00:00:00.000Z');
    const later = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: ledger, now: later });
    expect(result.getTime()).toBe(ledger.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is absent', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is null', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: null, now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to opts.now when ledgerCloseTime is 0', () => {
    const now = new Date('2026-04-28T00:00:00.000Z');
    const result = resolveReferenceTime({ ledgerCloseTime: 0, now });
    expect(result.getTime()).toBe(now.getTime());
  });

  it('falls back to wall clock when both ledgerCloseTime and now are absent', () => {
    const before = Date.now();
    const result = resolveReferenceTime({});
    const after = Date.now();
    expect(result.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.getTime()).toBeLessThanOrEqual(after);
  });
});

// ── computeDaysToMaturity — ledger time ───────────────────────────────────────

describe('computeDaysToMaturity — ledger time', () => {
  const MATURITY = new Date('2026-05-27T12:00:00.000Z');

  it('uses ledgerCloseTime (epoch seconds) when provided', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBe(30);
  });

  it('uses ledgerCloseTime (Date) when provided', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, { ledgerCloseTime: ledger });
    expect(result).toBe(30);
  });

  it('ledger time overrides opts.now', () => {
    // ledger says 30 days out; opts.now says 1 day out — ledger wins
    const ledger = new Date('2026-04-27T12:00:00.000Z'); // 30 days before maturity
    const closer = new Date('2026-05-26T12:00:00.000Z'); // 1 day before maturity
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
      now: closer,
    });
    expect(result).toBe(30);
  });

  it('falls back to opts.now when ledgerCloseTime missing', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, { now });
    expect(result).toBe(30);
  });

  it('accepts legacy bare Date as second argument (backwards compat)', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const result = computeDaysToMaturity(MATURITY, now);
    expect(result).toBe(30);
  });

  it('marks invoice overdue when ledger time is past maturity', () => {
    const ledger = new Date('2026-06-27T12:00:00.000Z'); // 31 days after maturity
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result).toBe(-31);
  });

  it('returns 0 when ledger time equals maturity exactly', () => {
    const result = computeDaysToMaturity(MATURITY, {
      ledgerCloseTime: MATURITY.getTime() / 1000,
    });
    expect(result).toBe(0);
  });
});

// ── computeEscrowDerivedFields — ledger time ──────────────────────────────────

describe('computeEscrowDerivedFields — ledger time', () => {
  const MATURITY_ISO = '2026-05-27T12:00:00.000Z';

  it('uses ledgerCloseTime (epoch seconds) for daysToMaturity', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z');
    const state = {
      fundedAmount: 500,
      totalAmount: 1000,
      annualRatePercent: 8.5,
      maturityDate: MATURITY_ISO,
    };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result.daysToMaturity).toBe(30);
    expect(result.apyPercent).toBe(8.5);
    expect(result.fundedPercent).toBe(50);
  });

  it('ledgerCloseTime beats opts.now', () => {
    const ledger = new Date('2026-04-27T12:00:00.000Z'); // 30 days out
    const later = new Date('2026-05-26T12:00:00.000Z');  // 1 day out
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
      now: later,
    });
    expect(result.daysToMaturity).toBe(30);
  });

  it('falls back to opts.now when ledgerCloseTime absent', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, { now });
    expect(result.daysToMaturity).toBe(30);
  });

  it('marks overdue when ledger is past maturity', () => {
    const ledger = new Date('2026-06-27T12:00:00.000Z'); // 31 days past
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    const result = computeEscrowDerivedFields(state, {
      ledgerCloseTime: ledger.getTime() / 1000,
    });
    expect(result.daysToMaturity).toBe(-31);
  });

  it('null ledgerCloseTime triggers fallback without throwing', () => {
    const now = new Date('2026-04-27T12:00:00.000Z');
    const state = { fundedAmount: 0, totalAmount: 100, annualRatePercent: 5, maturityDate: MATURITY_ISO };
    expect(() =>
      computeEscrowDerivedFields(state, { ledgerCloseTime: null, now })
    ).not.toThrow();
    const result = computeEscrowDerivedFields(state, { ledgerCloseTime: null, now });
    expect(result.daysToMaturity).toBe(30);
  });
});
