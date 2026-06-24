'use strict';

/**
 * Input Validation Utilities
 *
 * Provides helpers to validate incoming query parameters.
 * Invoice *payload* validation is delegated to the canonical Zod schema in
 * `src/schemas/invoice.js`; `validateInvoicePayload` is re-exported from
 * there so all callers continue to work without modification.
 */

// ── Zod-backed invoice payload validator (re-export) ─────────────────────────

const {
  validateInvoicePayload,
  SUPPORTED_CURRENCIES,
} = require('../schemas/invoice');

/**
 * Supported ISO 4217 currency codes (Set for O(1) look-up).
 * Kept for backward-compat; derives from the Zod schema list.
 * @type {Set<string>}
 */
const VALID_CURRENCIES = new Set(SUPPORTED_CURRENCIES);

// ── Invoice query-param validator ─────────────────────────────────────────────

/**
 * Validates `GET /api/invoices` query parameters.
 *
 * @param {Object} query - The Express `req.query` object.
 * @returns {{ isValid: boolean, errors: string[], validatedParams: Object }}
 */
function validateInvoiceQueryParams(query) {
  const errors = [];
  const validatedParams = { filters: {}, sorting: {} };

  const { status, smeId, buyerId, dateFrom, dateTo, sortBy, order } = query;

  if (status !== undefined) {
    const validStatuses = ['paid', 'pending', 'overdue'];
    if (validStatuses.includes(status)) {
      validatedParams.filters.status = status;
    } else {
      errors.push(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
  }

  if (smeId !== undefined) {
    if (typeof smeId === 'string' && smeId.trim().length > 0) {
      validatedParams.filters.smeId = smeId;
    } else {
      errors.push('Invalid smeId format');
    }
  }

  if (buyerId !== undefined) {
    if (typeof buyerId === 'string' && buyerId.trim().length > 0) {
      validatedParams.filters.buyerId = buyerId;
    } else {
      errors.push('Invalid buyerId format');
    }
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (dateFrom !== undefined) {
    if (dateRegex.test(dateFrom) && !isNaN(Date.parse(dateFrom))) {
      validatedParams.filters.dateFrom = dateFrom;
    } else {
      errors.push('Invalid dateFrom format. Use YYYY-MM-DD');
    }
  }

  if (dateTo !== undefined) {
    if (dateRegex.test(dateTo) && !isNaN(Date.parse(dateTo))) {
      validatedParams.filters.dateTo = dateTo;
    } else {
      errors.push('Invalid dateTo format. Use YYYY-MM-DD');
    }
  }

  if (sortBy !== undefined) {
    const validSortFields = ['amount', 'date'];
    if (validSortFields.includes(sortBy)) {
      validatedParams.sorting.sortBy = sortBy;
    } else {
      errors.push(`Invalid sortBy. Must be one of: ${validSortFields.join(', ')}`);
    }
  }

  if (order !== undefined) {
    const lowerOrder = order.toLowerCase();
    if (['asc', 'desc'].includes(lowerOrder)) {
      validatedParams.sorting.order = lowerOrder;
    } else {
      errors.push('Invalid order. Must be "asc" or "desc"');
    }
  }

  return { isValid: errors.length === 0, errors, validatedParams };
}

// ── Marketplace query-param validator ────────────────────────────────────────

/**
 * Validates marketplace query parameters.
 *
 * Supports both legacy offset pagination (`page` + `limit`) and cursor-based
 * pagination (`cursor` + `limit`).  When `cursor` is supplied, `page` is
 * ignored — the cursor encodes the exact position in the result set.
 *
 * The `cursor` value is treated as an opaque string here; structural
 * validation (HMAC signature, sort-field match) is deferred to
 * `src/utils/cursorPagination.js` so that a single, clear 400 is returned
 * from the route layer.
 *
 * @param {Object} query - The Express query object.
 * @returns {{ isValid: boolean, errors: string[], validatedParams: Object }}
 */
function validateMarketplaceQueryParams(query) {
  const errors = [];
  const validatedParams = { filters: {}, sorting: {}, pagination: {} };

  const {
    status,
    yieldBpsMin,
    yieldBpsMax,
    maturityDateFrom,
    maturityDateTo,
    fundedRatioMin,
    fundedRatioMax,
    sortBy,
    order,
    page,
    limit,
    cursor
  } = query;

  if (status !== undefined) {
    const validStatuses = ['pending_verification', 'verified', 'funded', 'partially_funded', 'completed', 'defaulted'];
    if (validStatuses.includes(status)) {
      validatedParams.filters.status = status;
    } else {
      errors.push(`Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
  }

  if (yieldBpsMin !== undefined) {
    const val = parseInt(yieldBpsMin, 10);
    if (!isNaN(val) && val >= 0) { validatedParams.filters.yieldBpsMin = val; }
    else { errors.push('yieldBpsMin must be a non-negative integer'); }
  }
  if (yieldBpsMax !== undefined) {
    const val = parseInt(yieldBpsMax, 10);
    if (!isNaN(val) && val >= 0) { validatedParams.filters.yieldBpsMax = val; }
    else { errors.push('yieldBpsMax must be a non-negative integer'); }
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (maturityDateFrom !== undefined) {
    if (dateRegex.test(maturityDateFrom) && !isNaN(Date.parse(maturityDateFrom))) {
      validatedParams.filters.maturityDateFrom = maturityDateFrom;
    } else {
      errors.push('Invalid maturityDateFrom format. Use YYYY-MM-DD');
    }
  }
  if (maturityDateTo !== undefined) {
    if (dateRegex.test(maturityDateTo) && !isNaN(Date.parse(maturityDateTo))) {
      validatedParams.filters.maturityDateTo = maturityDateTo;
    } else {
      errors.push('Invalid maturityDateTo format. Use YYYY-MM-DD');
    }
  }

  if (fundedRatioMin !== undefined) {
    const val = parseFloat(fundedRatioMin);
    if (!isNaN(val) && val >= 0 && val <= 100) { validatedParams.filters.fundedRatioMin = val; }
    else { errors.push('fundedRatioMin must be a number between 0 and 100'); }
  }
  if (fundedRatioMax !== undefined) {
    const val = parseFloat(fundedRatioMax);
    if (!isNaN(val) && val >= 0 && val <= 100) { validatedParams.filters.fundedRatioMax = val; }
    else { errors.push('fundedRatioMax must be a number between 0 and 100'); }
  }

  if (sortBy !== undefined) {
    const validSortFields = ['yield_bps', 'maturity_date', 'funded_ratio', 'amount', 'created_at'];
    if (validSortFields.includes(sortBy)) { validatedParams.sorting.sortBy = sortBy; }
    else { errors.push(`Invalid sortBy. Must be one of: ${validSortFields.join(', ')}`); }
  }

  if (order !== undefined) {
    const lowerOrder = order.toLowerCase();
    if (['asc', 'desc'].includes(lowerOrder)) { validatedParams.sorting.order = lowerOrder; }
    else { errors.push('Invalid order. Must be "asc" or "desc"'); }
  }

  // Validate cursor (opaque base64url.signature string)
  if (cursor !== undefined) {
    if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 2048) {
      validatedParams.pagination.cursor = cursor;
    } else {
      errors.push('cursor must be a non-empty string (max 2048 chars)');
    }
  }

  // Validate pagination — page is ignored when a cursor is present
  if (cursor === undefined && page !== undefined) {
    const val = parseInt(page);
    if (!isNaN(val) && val >= 1) {
      validatedParams.pagination.page = val;
    } else {
      errors.push('page must be an integer >= 1');
    }
  }
  if (limit !== undefined) {
    const val = parseInt(limit, 10);
    if (!isNaN(val) && val >= 1 && val <= 100) { validatedParams.pagination.limit = val; }
    else { errors.push('limit must be an integer between 1 and 100'); }
  }

  return { isValid: errors.length === 0, errors, validatedParams };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  validateInvoiceQueryParams,
  validateMarketplaceQueryParams,
  validateInvoicePayload,
  VALID_CURRENCIES,
};
