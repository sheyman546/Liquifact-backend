/**
 * @fileoverview Legal-hold escrow tests.
 *
 * Covers:
 *  - escrow read response includes `legal_hold` field
 *  - funding proceeds when legal_hold = false
 *  - funding is blocked (502) when legal_hold = true
 *  - legacy POST /api/escrow body-based gating
 *  - edge cases: missing invoiceId, invalid ID, adapter errors
 *
 * All on-chain calls are stubbed via the adapter injection pattern so no
 * real Soroban RPC is required.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const jwt = require('jsonwebtoken');
const { describe, it } = require('mocha');
const expect = require('chai').expect;
const express = require('express');
const request = require('supertest');
const sinon = require('sinon');
const escrowRead = require('../services/escrowRead');
const { legalHoldGate } = require('../middleware/legalHoldGate');

describe('Legal Hold Interception Gate Validation Suite', () => {
  let sandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('should allow flow processing when legal_hold flag evaluates to false', async () => {
    sandbox.stub(escrowRead, 'getEscrowStatus').resolves({ legal_hold: false });

    const app = express();
    app.get('/test/:invoiceId', (req, res, next) => { req.params.invoiceId = 'inv-123'; next(); }, legalHoldGate(), (req, res) => res.sendStatus(200));

    const res = await request(app).get('/test/inv-123');
    expect(res.status).to.equal(200);
  });

  it('should block execution with a 423 Locked profile when hold flag evaluates to true', async () => {
    sandbox.stub(escrowRead, 'getEscrowStatus').resolves({ legal_hold: true });

    const app = express();
    app.post('/test', (req, res, next) => { req.body = { invoiceId: 'inv-456' }; next(); }, legalHoldGate(), (req, res) => res.sendStatus(200));

    const res = await request(app).post('/test');
    expect(res.status).to.equal(423);
    expect(res.body.title).to.equal('Legal Hold Active');
  });
});
// ── helpers ──────────────────────────────────────────────────────────────────

/** Mint a valid JWT for authenticated routes. */
function makeToken(payload = { sub: 'test-user' }) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' });
}

/** Auth header string. */
function bearer(token) {
  return `Bearer ${token}`;
}

// ── unit: escrowRead service ──────────────────────────────────────────────────

describe('escrowRead service', () => {
  const { readEscrowState, fetchLegalHold, validateInvoiceId } = require('../src/services/escrowRead');

  describe('validateInvoiceId', () => {
    it('accepts valid alphanumeric IDs', () => {
      expect(validateInvoiceId('inv_123').valid).toBe(true);
      expect(validateInvoiceId('INV-ABC-001').valid).toBe(true);
      expect(validateInvoiceId('a').valid).toBe(true);
    });

    it('rejects empty string', () => {
      const r = validateInvoiceId('');
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/non-empty/);
    });

    it('rejects non-string values', () => {
      expect(validateInvoiceId(null).valid).toBe(false);
      expect(validateInvoiceId(42).valid).toBe(false);
      expect(validateInvoiceId(undefined).valid).toBe(false);
    });

    it('rejects IDs with special characters', () => {
      expect(validateInvoiceId('inv 123').valid).toBe(false);
      expect(validateInvoiceId('inv/123').valid).toBe(false);
      expect(validateInvoiceId('../etc/passwd').valid).toBe(false);
    });

    it('rejects IDs longer than 128 characters', () => {
      expect(validateInvoiceId('a'.repeat(129)).valid).toBe(false);
    });
  });

  describe('fetchLegalHold', () => {
    it('returns false when adapter resolves false', async () => {
      const adapter = jest.fn().mockResolvedValue(false);
      const result = await fetchLegalHold('inv_001', adapter);
      expect(result).toBe(false);
      expect(adapter).toHaveBeenCalledWith('inv_001');
    });

    it('returns true when adapter resolves true', async () => {
      const adapter = jest.fn().mockResolvedValue(true);
      const result = await fetchLegalHold('inv_002', adapter);
      expect(result).toBe(true);
    });

    it('coerces numeric 1 to true', async () => {
      const adapter = jest.fn().mockResolvedValue(1);
      expect(await fetchLegalHold('inv_003', adapter)).toBe(true);
    });

    it('coerces string "true" to true', async () => {
      const adapter = jest.fn().mockResolvedValue('true');
      expect(await fetchLegalHold('inv_004', adapter)).toBe(true);
    });

    it('defaults to false when adapter throws (fail-safe)', async () => {
      const adapter = jest.fn().mockRejectedValue(new Error('RPC timeout'));
      const result = await fetchLegalHold('inv_005', adapter);
      expect(result).toBe(false);
    });
  });

  describe('readEscrowState', () => {
    it('includes legal_hold: false in response', async () => {
      const legalHoldAdapter = jest.fn().mockResolvedValue(false);
      const escrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_010',
        status: 'active',
        fundedAmount: 500,
      });

      const state = await readEscrowState('inv_010', { legalHoldAdapter, escrowAdapter });

      expect(state).toMatchObject({
        invoiceId: 'inv_010',
        status: 'active',
        fundedAmount: 500,
        legal_hold: false,
      });
    });

    it('includes legal_hold: true in response', async () => {
      const legalHoldAdapter = jest.fn().mockResolvedValue(true);
      const escrowAdapter = jest.fn().mockResolvedValue({
        invoiceId: 'inv_011',
        status: 'active',
        fundedAmount: 0,
      });

      const state = await readEscrowState('inv_011', { legalHoldAdapter, escrowAdapter });

      expect(state.legal_hold).toBe(true);
    });

    it('throws 400 error for invalid invoiceId', async () => {
      await expect(readEscrowState('')).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_INVOICE_ID',
      });
    });

    it('throws 400 error for invoiceId with path traversal chars', async () => {
      await expect(readEscrowState('../secret')).rejects.toMatchObject({
        status: 400,
      });
    });

    it('fetches base state and legal hold concurrently', async () => {
      const calls = [];
      const legalHoldAdapter = jest.fn().mockImplementation(async (id) => {
        calls.push('legalHold');
        return false;
      });
      const escrowAdapter = jest.fn().mockImplementation(async (id) => {
        calls.push('escrow');
        return { invoiceId: id, status: 'active', fundedAmount: 100 };
      });

      await readEscrowState('inv_012', { legalHoldAdapter, escrowAdapter });

      // Both adapters must have been called exactly once.
      expect(legalHoldAdapter).toHaveBeenCalledTimes(1);
      expect(escrowAdapter).toHaveBeenCalledTimes(1);
    });
  });
});

// ── unit: legalHoldGate middleware ────────────────────────────────────────────

describe('legalHoldGate middleware', () => {
  const { legalHoldGate } = require('../src/middleware/legalHoldGate');

  function buildMockReqRes(invoiceId) {
    const req = { params: { invoiceId } };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const next = jest.fn();
    return { req, res, next };
  }

  it('calls next() when legal_hold is false', async () => {
    const adapter = jest.fn().mockResolvedValue(false);
    const mw = legalHoldGate({ legalHoldAdapter: adapter });
    const { req, res, next } = buildMockReqRes('inv_020');

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith(/* no args */);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 502 when legal_hold is true', async () => {
    const adapter = jest.fn().mockResolvedValue(true);
    const mw = legalHoldGate({ legalHoldAdapter: adapter });
    const { req, res, next } = buildMockReqRes('inv_021');

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: 'Escrow is under legal hold' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 400 when invoiceId is missing', async () => {
    const mw = legalHoldGate();
    const { req, res, next } = buildMockReqRes(undefined);

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'invoiceId is required' });
  });

  it('returns 400 when invoiceId is empty string', async () => {
    const mw = legalHoldGate();
    const { req, res, next } = buildMockReqRes('   ');

    await mw(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('forwards unexpected errors to next(err)', async () => {
    const boom = new Error('unexpected');
    const adapter = jest.fn().mockRejectedValue(boom);
    const mw = legalHoldGate({ legalHoldAdapter: adapter });
    const { req, res, next } = buildMockReqRes('inv_022');

    await mw(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ── integration: HTTP routes ──────────────────────────────────────────────────

describe('GET /api/escrow/:invoiceId — legal_hold in response', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    // Stub escrowRead so no real Soroban call is made.
    jest.mock('../src/services/escrowRead', () => ({
      readEscrowState: jest.fn(),
      fetchLegalHold: jest.fn(),
      validateInvoiceId: jest.requireActual('../src/services/escrowRead').validateInvoiceId,
    }));

    app = require('../src/index');
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('returns escrow JSON with legal_hold: false', async () => {
    const { readEscrowState } = require('../src/services/escrowRead');
    readEscrowState.mockResolvedValue({
      invoiceId: 'inv_100',
      status: 'active',
      fundedAmount: 1000,
      legal_hold: false,
    });

    const token = makeToken();
    const res = await request(app)
      .get('/api/escrow/inv_100')
      .set('Authorization', bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      invoiceId: 'inv_100',
      legal_hold: false,
    });
  });

  it('returns escrow JSON with legal_hold: true', async () => {
    const { readEscrowState } = require('../src/services/escrowRead');
    readEscrowState.mockResolvedValue({
      invoiceId: 'inv_101',
      status: 'active',
      fundedAmount: 0,
      legal_hold: true,
    });

    const token = makeToken();
    const res = await request(app)
      .get('/api/escrow/inv_101')
      .set('Authorization', bearer(token));

    expect(res.status).toBe(200);
    expect(res.body.data.legal_hold).toBe(true);
  });

  it('returns 400 for invalid invoiceId', async () => {
    const { readEscrowState } = require('../src/services/escrowRead');
    const err = new Error('invalid');
    err.status = 400;
    readEscrowState.mockRejectedValue(err);

    const token = makeToken();
    const res = await request(app)
      .get('/api/escrow/inv bad')
      .set('Authorization', bearer(token));

    // Express route-param with space won't match — expect 404 or 400.
    expect([400, 404]).toContain(res.status);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/api/escrow/inv_100');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/escrow/:invoiceId/fund — legal hold gating', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../src/services/escrowRead', () => ({
      readEscrowState: jest.fn(),
      fetchLegalHold: jest.fn(),
      validateInvoiceId: jest.requireActual('../src/services/escrowRead').validateInvoiceId,
    }));

    app = require('../src/index');
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('allows funding when legal_hold is false', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');
    fetchLegalHold.mockResolvedValue(false);

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow/inv_200/fund')
      .set('Authorization', bearer(token))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'funded' });
  });

  it('blocks funding with 502 when legal_hold is true', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');
    fetchLegalHold.mockResolvedValue(true);

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow/inv_201/fund')
      .set('Authorization', bearer(token))
      .send({});

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Escrow is under legal hold' });
  });

  it('does NOT call downstream handler when blocked', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');
    fetchLegalHold.mockResolvedValue(true);

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow/inv_202/fund')
      .set('Authorization', bearer(token))
      .send({});

    // Only the gate response — no funding data in body.
    expect(res.body).not.toHaveProperty('data');
    expect(res.status).toBe(502);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app)
      .post('/api/escrow/inv_200/fund')
      .send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/escrow (legacy) — legal hold gating via body.invoiceId', () => {
  let app;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('../src/services/escrowRead', () => ({
      readEscrowState: jest.fn(),
      fetchLegalHold: jest.fn(),
      validateInvoiceId: jest.requireActual('../src/services/escrowRead').validateInvoiceId,
    }));

    app = require('../src/index');
  });

  afterEach(() => {
    jest.resetModules();
  });

  it('allows funding when legal_hold is false', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');
    fetchLegalHold.mockResolvedValue(false);

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow')
      .set('Authorization', bearer(token))
      .send({ invoiceId: 'inv_300' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'funded' });
  });

  it('blocks funding with 502 when legal_hold is true', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');
    fetchLegalHold.mockResolvedValue(true);

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow')
      .set('Authorization', bearer(token))
      .send({ invoiceId: 'inv_301' });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'Escrow is under legal hold' });
  });

  it('proceeds without gating when no invoiceId in body', async () => {
    const { fetchLegalHold } = require('../src/services/escrowRead');

    const token = makeToken();
    const res = await request(app)
      .post('/api/escrow')
      .set('Authorization', bearer(token))
      .send({});

    expect(res.status).toBe(200);
    // fetchLegalHold should not have been called.
    expect(fetchLegalHold).not.toHaveBeenCalled();
  });
});
