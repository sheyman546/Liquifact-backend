/**
 * src/services/investorCommitment.js
 *
 * Persists investor commitment records produced by the fund-invoice flow.
 * Uses Knex (the project's existing query builder) so the implementation works
 * with both PostgreSQL (production) and SQLite (test/CI).
 *
 * Table: investor_commitments
 * Schema is created by migration: migrations/YYYYMMDDHHII_create_investor_commitments.js
 *
 * Idempotency: callers may supply an idempotencyKey (e.g. sha256 of
 * investor + invoiceId + amount). Duplicate submissions with the same key
 * return the existing row rather than inserting a second one.
 */

'use strict';

const db = require('../db/knex'); // project's shared Knex instance

const TABLE = 'investor_commitments';

// Stellar public key: G or C followed by exactly 55 base-32 characters (A-Z2-7)
const STELLAR_ADDRESS_RE = /^[CG][A-Z2-7]{55}$/;

// Sane upper bound: 10^18 stroops (≈ 10 billion XLM — exceeds total supply)
const MAX_STROOP_AMOUNT = 10n ** 18n;

/**
 * Typed error thrown when commitment input fails validation.
 * Callers can use `instanceof CommitmentValidationError` to distinguish
 * domain errors from unexpected runtime failures.
 */
class CommitmentValidationError extends Error {
  /**
   * @param {string} message - Human-readable description.
   * @param {string} code    - Machine-readable error code.
   */
  constructor(message, code) {
    super(message);
    this.name = 'CommitmentValidationError';
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validate that a value is a safe positive integer string suitable for
 * on-chain stroop math.
 *
 * Rules:
 *  - Must be a `string` (never coerced — callers must convert first)
 *  - Must contain only ASCII decimal digits (no sign, no decimal point,
 *    no scientific notation, no whitespace)
 *  - Must not have leading zeros (e.g. "007" is rejected)
 *  - Must be strictly positive (> 0)
 *  - Must not exceed MAX_STROOP_AMOUNT (10^18 stroops ≈ 10 billion XLM)
 *
 * @param {unknown} value - The candidate amount value.
 * @throws {CommitmentValidationError} When the value is not a valid stroop amount.
 */
function validateAmountStroops(value) {
  if (typeof value !== 'string') {
    throw new CommitmentValidationError(
      `amountStroops must be a string, got ${typeof value}`,
      'INVALID_AMOUNT_TYPE'
    );
  }

  if (!/^\d+$/.test(value)) {
    throw new CommitmentValidationError(
      'amountStroops must contain only decimal digits (no sign, decimals, or spaces)',
      'INVALID_AMOUNT_FORMAT'
    );
  }

  // Reject leading zeros ("007", "00") but allow "0" itself for the zero check below
  if (value.length > 1 && value[0] === '0') {
    throw new CommitmentValidationError(
      'amountStroops must not have leading zeros',
      'INVALID_AMOUNT_FORMAT'
    );
  }

  const big = BigInt(value);

  if (big <= 0n) {
    throw new CommitmentValidationError(
      'amountStroops must be a positive integer (> 0)',
      'INVALID_AMOUNT_RANGE'
    );
  }

  if (big > MAX_STROOP_AMOUNT) {
    throw new CommitmentValidationError(
      `amountStroops exceeds maximum allowed value (${MAX_STROOP_AMOUNT.toString()})`,
      'INVALID_AMOUNT_OVERFLOW'
    );
  }
}

/**
 * Validate a Stellar public key (G... or C..., 56 characters total).
 *
 * @param {string} address - The candidate Stellar address.
 * @returns {{ valid: boolean, reason: string }} Result object.
 */
function validateAddress(address) {
  if (!address || typeof address !== 'string') {
    return { valid: false, reason: 'invalid Stellar address: must be a non-empty string' };
  }
  if (!STELLAR_ADDRESS_RE.test(address)) {
    return {
      valid: false,
      reason: 'invalid Stellar address: must start with G or C and be 56 base-32 characters',
    };
  }
  return { valid: true, reason: '' };
}

/**
 * @typedef {Object} CommitmentRecord
 * @property {string}  id
 * @property {string}  invoice_id
 * @property {string}  investor_address
 * @property {string}  escrow_address
 * @property {string}  amount_stroops      — integer string
 * @property {'requires_signature'|'submitted'|'stubbed'} status
 * @property {string|null} unsigned_xdr
 * @property {string|null} tx_hash
 * @property {string|null} ledger
 * @property {string|null} idempotency_key
 * @property {Date}    created_at
 * @property {Date}    updated_at
 */

/**
 * Persist a new commitment, or return the existing one when the idempotency
 * key matches a prior row.
 *
 * @param {Object} params
 * @param {string} params.invoiceId
 * @param {string} params.investorAddress
 * @param {string} params.escrowAddress
 * @param {string} params.amountStroops   — must be a valid positive integer string
 * @param {'requires_signature'|'submitted'|'stubbed'} params.status
 * @param {string|null} [params.unsignedXdr]
 * @param {string|null} [params.txHash]
 * @param {string|null} [params.ledger]
 * @param {string|null} [params.idempotencyKey]
 * @returns {Promise<CommitmentRecord>}
 * @throws {CommitmentValidationError} When inputs fail validation.
 */
async function persistCommitment({
  invoiceId,
  investorAddress,
  escrowAddress,
  amountStroops,
  status,
  unsignedXdr = null,
  txHash = null,
  ledger = null,
  idempotencyKey = null,
}) {
  // Validate amount — throws CommitmentValidationError for any invalid format
  validateAmountStroops(amountStroops);

  // Validate investor address
  const addrResult = validateAddress(investorAddress);
  if (!addrResult.valid) {
    throw new CommitmentValidationError(addrResult.reason, 'INVALID_INVESTOR_ADDRESS');
  }

  // Idempotency check: return early if we've already processed this exact request
  if (idempotencyKey) {
    const existing = await db(TABLE).where({ idempotency_key: idempotencyKey }).first();
    if (existing) {
      return existing;
    }
  }

  const [row] = await db(TABLE)
    .insert({
      invoice_id: invoiceId,
      investor_address: investorAddress,
      escrow_address: escrowAddress,
      amount_stroops: amountStroops,
      status,
      unsigned_xdr: unsignedXdr,
      tx_hash: txHash,
      ledger,
      idempotency_key: idempotencyKey,
    })
    .returning('*');

  return row;
}

/**
 * Update the status of an existing commitment (e.g. once the investor submits
 * the signed XDR and we observe the ledger result).
 *
 * amount_stroops is immutable after creation — passing it in fields violates
 * idempotency and is rejected with a typed error.
 *
 * @param {string} id        — commitment UUID
 * @param {Partial<CommitmentRecord>} fields
 * @returns {Promise<CommitmentRecord>}
 * @throws {CommitmentValidationError} When fields attempts to change amount_stroops.
 */
async function updateCommitment(id, fields) {
  if ('amount_stroops' in fields || 'amountStroops' in fields) {
    throw new CommitmentValidationError(
      'amount_stroops is immutable after commitment creation and cannot be updated',
      'AMOUNT_IMMUTABLE'
    );
  }

  const [row] = await db(TABLE)
    .where({ id })
    .update({ ...fields, updated_at: db.fn.now() })
    .returning('*');
  if (!row) {
    throw new Error(`Commitment not found: ${id}`);
  }
  return row;
}

/**
 * Find commitments for a given investor and invoice.
 *
 * @param {string} investorAddress
 * @param {string} invoiceId
 * @returns {Promise<CommitmentRecord[]>}
 */
async function findCommitments(investorAddress, invoiceId) {
  return db(TABLE).where({ investor_address: investorAddress, invoice_id: invoiceId }).orderBy('created_at', 'desc');
}

// ─── In-memory investor lock store ───────────────────────────────────────────
// Mirrors on-chain lock data (claimNotBefore, yield) into a local cache.
// Marked stale=true because they are read from a DB mirror, not live chain state.

/** @type {Map<string, Object>} key: `${invoiceId}:${funderAddress}` */
const investorLocks = new Map();

/** @param {string} invoiceId @param {string} funderAddress @returns {string} */
function lockKey(invoiceId, funderAddress) {
  return `${invoiceId}:${funderAddress}`;
}

/** Wipe all in-memory lock records (used in tests). */
function clearInvestorLocks() {
  investorLocks.clear();
}

/** Pre-populate the store with representative seed data for testing. */
function seedInvestorLocks() {
  setInvestorLock({
    funderAddress: 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOUJ3LNLRK',
    claimNotBefore: '2026-01-01T00:00:00Z',
    investorEffectiveYieldBps: 800,
    invoiceId: 'inv_7788',
  });
  setInvestorLock({
    funderAddress: 'GDGQVOKHW4VEJRU2TETD8G6RWJ3TVM3VROMV7I3ESNITIBLL6QL6RAIL',
    claimNotBefore: '2026-02-01T00:00:00Z',
    investorEffectiveYieldBps: 750,
    invoiceId: 'inv_9900',
  });
}

/**
 * Upsert a lock record. Overwrites an existing entry for the same
 * (invoiceId, funderAddress) pair.
 *
 * @param {Object} params
 * @param {string} params.funderAddress
 * @param {string} params.claimNotBefore
 * @param {number} params.investorEffectiveYieldBps
 * @param {string} params.invoiceId
 * @returns {Object} The stored lock record.
 */
function setInvestorLock({ funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId }) {
  const key = lockKey(invoiceId, funderAddress);
  const record = { funderAddress, claimNotBefore, investorEffectiveYieldBps, invoiceId, stale: true };
  investorLocks.set(key, record);
  return record;
}

/**
 * Retrieve a single lock by invoice and funder.
 *
 * @param {string} invoiceId
 * @param {string} funderAddress
 * @returns {Object|undefined}
 */
function getInvestorLock(invoiceId, funderAddress) {
  return investorLocks.get(lockKey(invoiceId, funderAddress));
}

/**
 * Retrieve all locks for a given funder address, with optional invoiceId filter.
 *
 * @param {string} funderAddress
 * @param {{ invoiceId?: string }} [opts]
 * @returns {Object[]}
 */
function getInvestorLocksByAddress(funderAddress, opts = {}) {
  const results = [];
  for (const lock of investorLocks.values()) {
    if (lock.funderAddress !== funderAddress) continue;
    if (opts.invoiceId && lock.invoiceId !== opts.invoiceId) continue;
    results.push(lock);
  }
  return results;
}

/**
 * Retrieve all locks, with optional invoiceId filter.
 *
 * @param {{ invoiceId?: string }} [opts]
 * @returns {Object[]}
 */
function getAllInvestorLocks(opts = {}) {
  const results = [];
  for (const lock of investorLocks.values()) {
    if (opts.invoiceId && lock.invoiceId !== opts.invoiceId) continue;
    results.push(lock);
  }
  return results;
}

module.exports = {
  // Validation
  CommitmentValidationError,
  validateAmountStroops,
  validateAddress,
  // DB persistence
  persistCommitment,
  updateCommitment,
  findCommitments,
  // In-memory lock store
  clearInvestorLocks,
  seedInvestorLocks,
  setInvestorLock,
  getInvestorLock,
  getInvestorLocksByAddress,
  getAllInvestorLocks,
};
