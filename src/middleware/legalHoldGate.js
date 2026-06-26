/**
 * @fileoverview Legal-hold gating middleware.
 *
 * Checks the `legal_hold` flag on an escrow before any funding action is
 * allowed to proceed. Must be placed after the invoiceId has been resolved
 * (i.e. after route params or body variables are available) and before the handler 
 * that submits a capital-moving transaction.
 *
 * Usage:
 * router.post('/api/escrow/:invoiceId/fund', legalHoldGate(), fundHandler);
 *
 * @module middleware/legalHoldGate
 */

'use strict';

const { fetchLegalHold } = require('../services/escrowRead');
const { createProblemResponse } = require('./problemJson');
const { incrementMetric } = require('../metrics');
const logger = require('../logger');

/**
 * Express middleware factory that blocks the request with HTTP 423 Locked
 * (RFC 7807 problem details format) when the escrow identified by the resolved
 * invoiceId is marked under an active legal hold constraint.
 *
 * @param {object}   [options={}]
 * @param {Function} [options.legalHoldAdapter] - Injected adapter used for unit testing isolation.
 * @returns {import('express').RequestHandler}
 */
function legalHoldGate(options = {}) {
  const { legalHoldAdapter } = options;

  return async function checkLegalHold(req, res, next) {
    // Contract requirement: support lookup from both route parameters and parsed request bodies
    const invoiceId = (req.params && req.params.invoiceId) || (req.body && req.body.invoiceId);

    if (!invoiceId || typeof invoiceId !== 'string' || invoiceId.trim() === '') {
      return createProblemResponse(res, {
        status: 400,
        title: 'Bad Request',
        detail: 'An invoice identifier (invoiceId) is strictly required to evaluate legal hold constraints.',
        instance: req.originalUrl
      });
    }

    const cleanInvoiceId = invoiceId.trim();

    try {
      let held;
      if (legalHoldAdapter) {
        const result = await legalHoldAdapter(cleanInvoiceId);
        held = result === true || result === 1 || result === 'true';
      } else {
        held = await fetchLegalHold(cleanInvoiceId);
      }

      if (held) {
        logger.warn(
          { invoiceId: cleanInvoiceId },
          'legalHoldGate: funding blocked — escrow is under legal hold',
        );

        // Emit diagnostic counter metrics tracking blocked attempts
        incrementMetric('legal_hold_blocked_attempts', { invoiceId: cleanInvoiceId });

        // Standardized 423 Locked RFC 7807 Error Frame
        return createProblemResponse(res, {
          status: 423,
          title: 'Legal Hold Active',
          detail: `Operation rejected: Invoice ${cleanInvoiceId} is currently placed under an active legal hold constraint.`,
          instance: req.originalUrl
        });
      }

      return next();
    } catch (err) {
      logger.error(
        { errCode: err && err.code, invoiceId: cleanInvoiceId },
        'legalHoldGate: unexpected error during legal-hold check — falling closed',
      );

      // Security requirement (Fail-Closed): block transaction paths if downstream read links fail
      return createProblemResponse(res, {
        status: 500,
        title: 'Internal Integrity Error',
        detail: 'Unable to reliably verify legal hold verification states at this time.',
        instance: req.originalUrl
      });
    }
  };
}

module.exports = { legalHoldGate };