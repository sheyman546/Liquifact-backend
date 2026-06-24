'use strict';

const crypto = require('crypto');
const db = require('../db/knex');
const logger = require('../logger');
const { withRetry } = require('../utils/retry');
const { appendAuditEvent } = require('./auditLogStore');

// Lazily-resolved shared worker to avoid circular dependency at module load time.
// Set via setSharedWorker() by the application bootstrap or tests.
let _sharedWorker = null;

/**
 * Injects the BackgroundWorker instance used by enqueueWebhookDelivery.
 * Call this once at application startup (src/index.js) after the worker has
 * been created and the 'webhook_delivery' handler has been registered.
 *
 * @param {import('../workers/worker')} worker - Configured BackgroundWorker.
 * @returns {void}
 */
function setSharedWorker(worker) {
  _sharedWorker = worker;
}

let client;
try {
  client = require('prom-client');
} catch (e) {
  // In test environments where prom-client may not be installed, provide a noop shim
  client = {
    Counter: class {
      constructor() { }
      inc() { }
    },
  };
}
const { registry } = require('../metrics');

const SIGNATURE_VERSION = 'v1';
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Recursively sorts keys of an object to ensure deterministic JSON serialization.
 *
 * @param {any} obj - The object to sort.
 * @returns {any} A new object with keys sorted.
 */
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  }
  const sortedObj = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    sortedObj[key] = sortKeys(obj[key]);
  }
  return sortedObj;
}

/**
 * Creates an HMAC-SHA256 signature for the given payload and timestamp.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {number} timestamp - Unix timestamp in seconds.
 * @returns {string} The hex-encoded signature.
 */
function createSignature(secret, rawBody, timestamp) {
  const signedPayload = `${timestamp}.${rawBody}`;
  return crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
}

/**
 * Creates a signature header in the format t=<timestamp>,v1=<signature>.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @returns {string} The signature header string.
 */
function createSignatureHeader(secret, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createSignature(secret, rawBody, timestamp);
  return `t=${timestamp},v1=${signature}`;
}

/**
 * Emits a webhook for escrow events.
 *
 * @param {string} event - The event type ('escrow_funded' or 'escrow_settled').
 * @param {string} invoiceId - The invoice ID.
 * @param {Object} [additionalData={}] - Additional data to include in the payload.
 * @returns {Promise<void>}
 */
async function emitWebhook(event, invoiceId, additionalData = {}) {
  try {
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'Invoice not found for webhook emission');
      return;
    }

    const { tenant_id } = invoice;

    const tenant = await db('tenants').select('settings').where('id', tenant_id).first();
    if (!tenant || !tenant.settings) {
      logger.warn({ tenant_id, invoiceId }, 'Tenant settings not found for webhook');
      return;
    }

    const { webhook_url, webhook_secret } = tenant.settings;
    if (!webhook_url || !webhook_secret) {
      logger.info({ tenant_id, invoiceId }, 'Webhook URL or secret not configured');
      return;
    }

    const payload = sortKeys({
      event,
      timestamp: new Date().toISOString(),
      invoiceId,
      ...additionalData,
    });

    // Sign payload and create signature header
    const body = JSON.stringify(payload);
    const signatureHeader = createSignatureHeader(webhook_secret, body);

    // Metric: ensure counter exists on first require
    if (!emitWebhook._failureCounter) {
      emitWebhook._failureCounter = new client.Counter({
        name: 'webhook_delivery_failures_total',
        help: 'Total webhook deliveries that exhausted retries and were placed in dead-letter',
        registers: [registry],
      });
    }

    const maxRetries = Number(process.env.WEBHOOK_MAX_RETRIES || 3);
    const baseDelay = Number(process.env.WEBHOOK_BASE_DELAY || 500);
    const maxDelay = Number(process.env.WEBHOOK_MAX_DELAY || 10000);

    // shouldRetry: only on network/timeouts or 5xx
    const shouldRetry = (err) => {
      if (!err) return false;
      // network/socket errors often have a code
      if (err.code) {
        return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err.code) || err.name === 'AbortError';
      }
      if (err.status) {
        const s = Number(err.status);
        return s >= 500 && s < 600;
      }
      return false;
    };

    // Operation to perform
    const operation = async () => {
      const controller = new AbortController();
      const timeoutMs = Number(process.env.WEBHOOK_TIMEOUT_MS || 5000);
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Signature': signatureHeader,
          },
          body,
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = new Error(`Webhook responded with ${response.status}`);
          err.status = response.status;
          throw err;
        }

        return { ok: true, status: response.status };
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Record attempts via auditLogStore on each failed try
    const onRetry = async ({ attempt, error }) => {
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'webhook.dispatch',
          actorType: 'system',
          actorId: tenant_id,
          targetType: 'invoice',
          targetId: invoiceId,
          statusCode: error && error.status ? Number(error.status) : null,
          metadata: {
            attempt,
            url: webhook_url,
            error: error && error.message ? error.message : String(error),
            payload,
          },
        });
      } catch (e) {
        // don't let audit failures stop retries
        logger.warn({ err: e.message }, 'Failed to append audit event for webhook attempt');
      }
    };

    // Execute with retry
    try {
      const result = await withRetry(operation, { maxRetries, baseDelay, maxDelay, shouldRetry, onRetry });

      // record successful delivery
      try {
        await appendAuditEvent({
          eventType: 'webhook_delivery',
          action: 'webhook.dispatch',
          actorType: 'system',
          actorId: tenant_id,
          targetType: 'invoice',
          targetId: invoiceId,
          statusCode: result && result.status ? Number(result.status) : 200,
          metadata: { url: webhook_url, payload, attempt: 1 },
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to append audit event for webhook success');
      }

      logger.info({ event, invoiceId, tenant_id }, 'Webhook emitted successfully');
    } catch (error) {
      // exhausted retries -> dead-letter
      try {
        await db('webhook_dead_letters').insert({
          tenant_id,
          invoice_id: invoiceId,
          event,
          payload: JSON.stringify(payload),
          last_error: error && error.message ? error.message : String(error),
          attempts: maxRetries + 1,
          created_at: new Date(),
        });
      } catch (e) {
        logger.warn({ err: e.message }, 'Failed to persist webhook dead-letter');
      }

      // emit delivery-failure metric
      try {
        emitWebhook._failureCounter.inc();
      } catch (e) {
        // ignore metric errors
      }

      logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
    }
  } catch (error) {
    logger.error({ event, invoiceId, error: error.message }, 'Failed to emit webhook');
  }
}

/**
 * Verifies a webhook signature with timestamp tolerance.
 *
 * @param {string} secret - The webhook secret.
 * @param {string} rawBody - The raw JSON payload string.
 * @param {string} signatureHeader - The X-Signature header value.
 * @param {number} [toleranceMs=TOLERANCE_MS] - Tolerance window in milliseconds.
 * @returns {Object} Result object with valid boolean and optional error message.
 */
function verifySignature(secret, rawBody, signatureHeader, toleranceMs = TOLERANCE_MS) {
  const parts = signatureHeader.split(',');
  let timestamp = null;
  let signature = null;

  for (const part of parts) {
    if (part.startsWith('t=')) {
      timestamp = parseInt(part.slice(2), 10);
    } else if (part.startsWith('v1=')) {
      signature = part.slice(3);
    }
  }

  if (!timestamp || !signature) {
    return { valid: false, error: 'Invalid signature header format' };
  }

  const now = Date.now();
  const timestampMs = timestamp * 1000;
  if (Math.abs(now - timestampMs) > toleranceMs) {
    return { valid: false, error: 'Timestamp outside tolerance window' };
  }

  const expectedSignature = createSignature(secret, rawBody, timestamp);
  const valid = crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expectedSignature, 'hex')
  );

  return { valid, error: valid ? null : 'Signature mismatch' };
}

/**
 * Enqueues a `webhook_delivery` job for a successful invoice state transition.
 *
 * The function looks up the tenant's webhook configuration from the database;
 * if no URL or secret is configured it returns silently. The job payload
 * includes the transition metadata so that the signed outbound request can be
 * composed by the worker without an additional DB round-trip.
 *
 * Secrets and full target URLs are **never** logged at info level.
 *
 * @param {Object} options - Enqueue options.
 * @param {string} options.invoiceId    - Invoice that transitioned.
 * @param {string} options.event        - Event type label (e.g. `'invoice.approved'`).
 * @param {Object} options.transition   - Transition metadata.
 * @param {string} options.transition.from          - Previous state.
 * @param {string} options.transition.to            - New state.
 * @param {string} options.transition.actor         - Who triggered the transition.
 * @param {string|null} [options.transition.reason] - Optional reason.
 * @param {string} options.transition.transitionedAt - ISO timestamp.
 * @returns {Promise<string|null>} The enqueued job ID, or null if skipped.
 */
async function enqueueWebhookDelivery({ invoiceId, event, transition }) {
  if (!_sharedWorker) {
    // Worker not yet initialised (e.g. during unit tests that only test
    // signature helpers). Log at debug level and bail out.
    logger.info({ invoiceId, event }, 'webhook: shared worker not set, skipping enqueue');
    return null;
  }

  try {
    const invoice = await db('invoices').select('tenant_id').where('id', invoiceId).first();
    if (!invoice) {
      logger.warn({ invoiceId }, 'webhook: invoice not found, skipping enqueue');
      return null;
    }

    const { tenant_id: tenantId } = invoice;

    const tenant = await db('tenants').select('settings').where('id', tenantId).first();
    if (!tenant || !tenant.settings) {
      logger.warn({ tenantId, invoiceId }, 'webhook: tenant settings not found, skipping enqueue');
      return null;
    }

    const { webhook_url: webhookUrl, webhook_secret: webhookSecret } = tenant.settings;
    if (!webhookUrl || !webhookSecret) {
      // Not configured — this is expected; log at info, not warn.
      logger.info({ tenantId, invoiceId }, 'webhook: URL or secret not configured, skipping enqueue');
      return null;
    }

    const jobId = _sharedWorker.enqueue('webhook_delivery', {
      invoiceId,
      tenantId,
      webhookUrl,
      webhookSecret,
      event,
      transition,
    });

    logger.info(
      { invoiceId, tenantId, event, jobId },
      'webhook: delivery job enqueued'
    );

    return jobId;
  } catch (err) {
    logger.error(
      { invoiceId, event, error: err && err.message ? err.message : String(err) },
      'webhook: failed to enqueue delivery job'
    );
    return null;
  }
}

module.exports = {
  emitWebhook,
  verifySignature,
  createSignature,
  createSignatureHeader,
  sortKeys,
  setSharedWorker,
  enqueueWebhookDelivery,
  SIGNATURE_VERSION,
  TOLERANCE_MS,
};