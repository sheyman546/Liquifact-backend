/**
 * Invoice State Transition Routes
 * Handles invoice lifecycle state transitions with audit logging.
 *
 * Invoices are resolved and persisted through invoiceService (Knex), scoped
 * to the authenticated tenant from extractTenant middleware.
 *
 * Capital-movement routes are protected by the KYC gate:
 *   - POST /:id/link-escrow   — initiates escrow funding lifecycle
 *   - POST /:id/transition     — when targetState is 'funded' or 'settled'
 *
 * @module routes/invoiceStateRoutes
 */

const express = require('express');
const router = express.Router();
const {
  INVOICE_STATES,
  getAllowedTransitions,
  getTransitionHistory,
  canLinkToEscrow,
} = require('../services/invoiceStateMachine');
const invoiceService = require('../services/invoiceService');
const { getAuditLogs } = require('../services/auditLog');
const { requireKycForFunding } = require('../middleware/kycGating');
const { extractTenant } = require('../middleware/tenant');
const idempotencyMiddleware = require('../middleware/idempotency');
const responseHelper = require('../utils/responseHelper');

/**
 * States that initiate or settle capital movement and therefore require
 * the caller to be KYC-verified before transitioning to them.
 */
const CAPITAL_MOVING_STATES = new Set([
  'funded',
  'settled',
  INVOICE_STATES.FUNDED,
  INVOICE_STATES.SETTLED,
].filter(Boolean));

router.use(extractTenant);

/**
 * Helper to extract actor from request
 *
 * @param {import('express').Request} req Express request object
 * @returns {string} Actor identifier
 */
function getActorFromRequest(req) {
  if (req.user && req.user.id) {
    return req.user.id;
  }
  if (req.user && req.user.sub) {
    return req.user.sub;
  }
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Sends a standardized 404 when an invoice is unknown or belongs to another tenant.
 *
 * @param {import('express').Response} res Express response object
 * @returns {import('express').Response}
 */
function sendInvoiceNotFound(res) {
  return res.status(404).json(responseHelper.error('Invoice not found', 'INVOICE_NOT_FOUND'));
}

/**
 * Sends a standardized error envelope for state-machine validation failures.
 *
 * @param {import('express').Response} res Express response object
 * @param {Error & { code?: string, allowedTransitions?: string[], statusCode?: number }} error
 * @returns {import('express').Response}
 */
function sendTransitionError(res, error) {
  const status = error.statusCode || 400;
  const details = error.allowedTransitions
    ? { allowedTransitions: error.allowedTransitions }
    : null;

  return res.status(status).json(responseHelper.error(error.message, error.code, details));
}

/**
 * GET /api/invoices/:id/state
 * Get current state and allowed transitions for an invoice
 */
router.get('/:id/state', async (req, res, next) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const currentState = invoice.status;
    const allowedTransitions = getAllowedTransitions(currentState);

    return res.json({
      ...responseHelper.success({
        invoiceId: id,
        currentState,
        allowedTransitions,
        isTerminal: allowedTransitions.length === 0,
      }),
      message: 'Invoice state retrieved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * KYC gate selector for transition endpoint.
 * Runs `requireKycForFunding` only when the requested targetState is a
 * capital-moving state; passes through for non-capital transitions.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 * @returns {void}
 */
function conditionalKycGate(req, res, next) {
  const { targetState } = req.body || {};
  if (targetState && CAPITAL_MOVING_STATES.has(targetState)) {
    return requireKycForFunding(req, res, next);
  }
  return next();
}

/**
 * POST /api/invoices/:id/transition
 * Execute a state transition
 *
 * Request body:
 * {
 *   "targetState": "approved",
 *   "reason": "Invoice verified and approved by finance team"
 * }
 */
router.post('/:id/transition', conditionalKycGate, idempotencyMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const { targetState, reason } = req.body;

  try {
    if (!targetState) {
      return res.status(400).json(
        responseHelper.error('Target state is required', 'MISSING_TARGET_STATE'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, targetState, req.tenantId, {
      actor,
      reason,
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        reason,
        auditLogId: result.auditLog.id,
      }),
      message: `Invoice transitioned from ${result.previousState} to ${result.newState}`,
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/approve
 * Convenience endpoint to approve an invoice
 */
router.post('/:id/approve', idempotencyMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.APPROVED, req.tenantId, {
      actor,
      reason: reason || 'Invoice approved',
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'approve',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice approved successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/link-escrow
 * Link an approved invoice to escrow.
 *
 * This is a capital-movement endpoint: it initiates the escrow funding
 * lifecycle. KYC must be verified before the link can be made.
 */
router.post('/:id/link-escrow', requireKycForFunding, idempotencyMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const { escrowId, reason } = req.body;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const linkValidation = canLinkToEscrow(invoice);
    if (!linkValidation.canLink) {
      return res.status(400).json(
        responseHelper.error(linkValidation.reason, 'CANNOT_LINK_TO_ESCROW'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.LINKED_ESCROW, req.tenantId, {
      actor,
      reason: reason || 'Invoice linked to escrow',
      ipAddress,
      userAgent,
      escrowId: escrowId || null,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'link-escrow',
        escrowId: escrowId || 'pending',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        escrowId: escrowId || null,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice linked to escrow successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

/**
 * GET /api/invoices/:id/history
 * Get state transition history for an invoice
 */
router.get('/:id/history', async (req, res, next) => {
  const { id } = req.params;

  try {
    const invoice = await invoiceService.resolveInvoiceForTenant(id, req.tenantId);

    if (!invoice) {
      return sendInvoiceNotFound(res);
    }

    const history = await getTransitionHistory(id, getAuditLogs);

    return res.json({
      ...responseHelper.success({
        invoiceId: id,
        currentState: invoice.status,
        transitions: history,
        totalTransitions: history.length,
      }),
      message: 'Invoice transition history retrieved successfully',
    });
  } catch (error) {
    return next(error);
  }
});

/**
 * POST /api/invoices/:id/reject
 * Convenience endpoint to reject an invoice
 */
router.post('/:id/reject', idempotencyMiddleware, async (req, res, next) => {
  const { id } = req.params;
  const { reason } = req.body;

  try {
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json(
        responseHelper.error('Reason is required for rejection', 'MISSING_TRANSITION_REASON'),
      );
    }

    const actor = getActorFromRequest(req);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const userAgent = req.get('user-agent') || 'unknown';

    const result = await invoiceService.transitionInvoice(id, INVOICE_STATES.REJECTED, req.tenantId, {
      actor,
      reason,
      ipAddress,
      userAgent,
      metadata: {
        method: req.method,
        path: req.path,
        action: 'reject',
      },
    });

    return res.status(200).json({
      ...responseHelper.success({
        invoiceId: id,
        previousState: result.previousState,
        currentState: result.newState,
        reason,
        transitionedAt: result.transitionedAt,
        transitionedBy: result.transitionedBy,
        auditLogId: result.auditLog.id,
      }),
      message: 'Invoice rejected successfully',
    });
  } catch (error) {
    if (error.code) {
      return sendTransitionError(res, error);
    }
    return next(error);
  }
});

module.exports = router;
