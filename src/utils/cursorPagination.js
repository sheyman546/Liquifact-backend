'use strict';

/**
 * @fileoverview Opaque cursor encoding/decoding for marketplace keyset pagination.
 *
 * Cursors are base64url-encoded JSON objects containing the last-seen value for
 * the active sort field and the row `id` tiebreaker. They are HMAC-signed so
 * that any modification — or reuse with a different sort field — is detected
 * and rejected with a 400 before it reaches the database layer.
 *
 * Cursor payload shape:
 * ```json
 * { "sortField": "yield_bps", "sortValue": 450, "id": "inv_abc123", "iat": 1719187200 }
 * ```
 *
 * Security properties:
 * - Opaque to the client (base64url, not human-readable without decoding).
 * - HMAC-SHA-256 signed; any tampering invalidates the signature.
 * - `sortField` is validated against `MARKETPLACE_QUERY_CONFIG.allowedSortFields`
 *   so a client cannot switch sort fields mid-page silently.
 * - Does not embed tenant ID or filter values — the service layer always re-applies
 *   tenant scoping and filter constraints independently, so a cursor cannot be used
 *   to bypass them.
 * - `iat` (issued-at epoch seconds) is stored for auditability; cursors do not
 *   expire by default but the field is available for future TTL enforcement.
 *
 * @module utils/cursorPagination
 */

const crypto = require('crypto');

/**
 * Secret used to sign cursors.  Falls back to a dev-only default when
 * `CURSOR_SECRET` is not set so tests work without environment setup.
 * Production deployments MUST set `CURSOR_SECRET` to a strong random value.
 *
 * @type {string}
 */
const CURSOR_SECRET = process.env.CURSOR_SECRET || process.env.JWT_SECRET || 'dev-cursor-secret-change-in-prod';

/**
 * Allowed sort fields for marketplace queries (must mirror MARKETPLACE_QUERY_CONFIG).
 * @type {ReadonlyArray<string>}
 */
const ALLOWED_SORT_FIELDS = Object.freeze(['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at']);

/**
 * Computes an HMAC-SHA-256 hex digest over `payload`.
 *
 * @param {string} payload - The string to sign.
 * @returns {string} Hex-encoded HMAC digest.
 */
function _sign(payload) {
  return crypto.createHmac('sha256', CURSOR_SECRET).update(payload).digest('hex');
}

/**
 * Encodes a cursor from the last row returned in a page.
 *
 * @param {Object} params
 * @param {string} params.sortField - The active sort column (e.g. `'yield_bps'`).
 * @param {*}      params.sortValue - The sort-column value from the last row.
 * @param {string} params.id        - The `id` of the last row (tiebreaker).
 * @returns {string} Opaque base64url cursor string.
 *
 * @example
 * const cursor = encodeCursor({ sortField: 'yield_bps', sortValue: 450, id: 'inv_abc' });
 * // → 'eyJzb3J0RmllbGQiOiJ5aWVsZF9icHMiLCJzb3J0VmFsdWUiOjQ1MCwiaWQiOiJpbnZfYWJjIiwiaWF0IjoxNzE5MTg3MjAwfQ.3f9a...'
 */
function encodeCursor({ sortField, sortValue, id }) {
  if (!ALLOWED_SORT_FIELDS.includes(sortField)) {
    throw new Error(`encodeCursor: unsupported sortField "${sortField}"`);
  }
  if (!id || typeof id !== 'string') {
    throw new Error('encodeCursor: id must be a non-empty string');
  }

  const payload = JSON.stringify({
    sortField,
    sortValue,
    id,
    iat: Math.floor(Date.now() / 1000),
  });

  const b64 = Buffer.from(payload).toString('base64url');
  const sig = _sign(b64);
  return `${b64}.${sig}`;
}

/**
 * Decodes and validates an opaque cursor string.
 *
 * @param {string} cursor            - The opaque cursor from the client.
 * @param {string} expectedSortField - The sort field in the current request.
 *   If the cursor encodes a different field the decode is rejected.
 * @returns {{ sortField: string, sortValue: *, id: string, iat: number }}
 * @throws {CursorError} When the cursor is malformed, tampered, or mismatched.
 */
function decodeCursor(cursor, expectedSortField) {
  if (typeof cursor !== 'string' || !cursor.includes('.')) {
    throw new CursorError('Malformed cursor: expected base64url.signature format');
  }

  const dotIdx = cursor.lastIndexOf('.');
  const b64 = cursor.slice(0, dotIdx);
  const sig = cursor.slice(dotIdx + 1);

  // Constant-time comparison to prevent timing attacks
  const expectedSig = _sign(b64);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');

  if (
    sigBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(sigBuf, expectedBuf)
  ) {
    throw new CursorError('Invalid cursor signature');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('Malformed cursor: payload is not valid JSON');
  }

  const { sortField, sortValue, id, iat } = parsed;

  if (!ALLOWED_SORT_FIELDS.includes(sortField)) {
    throw new CursorError(`Cursor contains unknown sort field "${sortField}"`);
  }
  if (typeof id !== 'string' || id.length === 0) {
    throw new CursorError('Cursor is missing a valid id tiebreaker');
  }
  if (typeof iat !== 'number') {
    throw new CursorError('Cursor is missing issued-at timestamp');
  }

  // Reject sort-field mismatch — prevents silent page corruption when the
  // client sends a cursor from a previous sort context.
  if (sortField !== expectedSortField) {
    throw new CursorError(
      `Cursor sort field "${sortField}" does not match requested sort field "${expectedSortField}"`
    );
  }

  return { sortField, sortValue, id, iat };
}

/**
 * Domain error for cursor-related failures.  The route layer maps this to
 * HTTP 400 so internal details never leak to the client.
 */
class CursorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CursorError';
  }
}

module.exports = {
  encodeCursor,
  decodeCursor,
  CursorError,
  ALLOWED_SORT_FIELDS,
};
