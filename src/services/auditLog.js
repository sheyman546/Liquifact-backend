/**
 * Audit Log Service
 * Manages immutable audit records for invoice mutations.
 * Each record captures actor, timestamp, action, and changed fields.
 * 
 * @module services/auditLog
 */

/**
 * In-memory store for audit logs.
 * In production, this would be persisted to a database.
 * @type {Array<Object>}
 */
let auditLogs = [];

/**
 * Generates a unique audit log ID using timestamp and random suffix.
 * Format: AUDIT-{timestamp}-{randomString}
 * 
 * @returns {string} Unique audit log ID
 */
function generateAuditLogId() {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 11);
  return `AUDIT-${timestamp}-${random}`;
}

/**
 * Sanitizes sensitive data from objects to prevent logging secrets.
 * Masks values for known sensitive fields.
 * 
 * @param {Object} obj Object to sanitize
 * @returns {Object} Sanitized copy of the object
 */
function sanitizeSensitiveData(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const sensitiveFields = ['password', 'token', 'secret', 'key', 'apiKey', 'authorization'];
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };

  const sanitizeRecursive = (current) => {
    if (current === null || typeof current !== 'object') {
      return;
    }

    Object.keys(current).forEach((key) => {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some((field) => lowerKey.includes(field))) {
        current[key] = '***REDACTED***';
      } else if (typeof current[key] === 'object') {
        sanitizeRecursive(current[key]);
      }
    });
  };

  sanitizeRecursive(sanitized);
  return sanitized;
}

/**
 * Calculates the differences between two objects.
 * Returns only the fields that changed.
 * 
 * @param {Object} before Previous state
 * @param {Object} after New state
 * @returns {Object} Object with 'before' and 'after' showing changed fields
 */
function calculateChanges(before, after) {
  if (!before || !after) {
    return { before: sanitizeSensitiveData(before), after: sanitizeSensitiveData(after) };
  }

  const changes = {};
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);

  allKeys.forEach((key) => {
    const beforeVal = before[key];
    const afterVal = after[key];

    // Deep comparison for objects/arrays
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      if (!changes.before) {
        changes.before = {};
      }
      if (!changes.after) {
        changes.after = {};
      }
      changes.before[key] = beforeVal;
      changes.after[key] = afterVal;
    }
  });

  return {
    before: sanitizeSensitiveData(changes.before || {}),
    after: sanitizeSensitiveData(changes.after || {}),
  };
}

/**
 * Creates an immutable audit log entry.
 * 
 * Capture timeline: after action completes but before response is sent
 * This ensures we capture the final state of the resource.
 * 
 * @param {Object} options Audit log options
 * @param {string} options.actor User ID or identifier of who performed the action
 * @param {string} options.action Type of action: 'CREATE', 'UPDATE', 'DELETE', 'READ'
 * @param {string} options.resourceType Type of resource: 'invoice', 'escrow', etc.
 * @param {string} options.resourceId Unique identifier of the resource
 * @param {Object} [options.before] State before mutation
 * @param {Object} [options.after] State after mutation
 * @param {number} [options.statusCode=200] HTTP status code of the operation
 * @param {string} [options.ipAddress] IP address of the requester
 * @param {string} [options.userAgent] User agent string
 * @param {Object} [options.metadata={}] Additional context
 * @returns {Object} The created audit log entry (immutable)
 * @throws {Error} If required fields are missing or invalid
 */
function createAuditLog({
  actor,
  action,
  resourceType,
  resourceId,
  before = null,
  after = null,
  statusCode = 200,
  ipAddress = 'unknown',
  userAgent = 'unknown',
  metadata = {},
} = {}) {
  // Validation
  if (!actor) {
    throw new Error('Audit log actor is required');
  }
  if (!action) {
    throw new Error('Audit log action is required');
  }
  if (!resourceType) {
    throw new Error('Audit log resourceType is required');
  }
  if (!resourceId) {
    throw new Error('Audit log resourceId is required');
  }

  const validActions = ['CREATE', 'UPDATE', 'DELETE', 'READ', 'STATE_TRANSITION'];
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}. Must be one of: ${validActions.join(', ')}`);
  }

  const entry = Object.freeze({
    id: generateAuditLogId(),
    timestamp: new Date().toISOString(),
    actor,
    action,
    resourceType,
    resourceId,
    changes: calculateChanges(before, after),
    statusCode,
    ipAddress,
    userAgent,
    metadata: Object.freeze({ ...metadata }),
  });

  auditLogs.push(entry);
  return entry;
}

/**
 * Retrieves audit logs with optional filtering.
 * 
 * @param {Object} options Filter options
 * @param {string} [options.resourceId] Filter by resource ID
 * @param {string} [options.resourceType] Filter by resource type
 * @param {string} [options.actor] Filter by actor
 * @param {string} [options.action] Filter by action
 * @param {string} [options.tenantId] Filter by tenant ID for isolation
 * @param {number} [options.limit=100] Maximum number of records to return
 * @param {number} [options.offset=0] Number of records to skip
 * @returns {Array<Object>} Matching audit log entries (read-only copies)
 */
function getAuditLogs({
  resourceId = null,
  resourceType = null,
  actor = null,
  action = null,
  tenantId = null,
  limit = 100,
  offset = 0,
} = {}) {
  let filtered = auditLogs;

  if (resourceId) {
    filtered = filtered.filter((log) => log.resourceId === resourceId);
  }
  if (resourceType) {
    filtered = filtered.filter((log) => log.resourceType === resourceType);
  }
  if (actor) {
    filtered = filtered.filter((log) => log.actor === actor);
  }
  if (action) {
    filtered = filtered.filter((log) => log.action === action);
  }
  if (tenantId) {
    filtered = filtered.filter((log) => log.metadata && log.metadata.tenantId === tenantId);
  }

  // Return in reverse chronological order (newest first)
  return filtered
    .slice()
    .reverse()
    .slice(offset, offset + limit)
    .map((log) => Object.freeze({ ...log }));
}

/**
 * Retrieves audit logs for a specific invoice.
 * Convenience method for invoice-specific queries.
 * 
 * @param {string} invoiceId Invoice resource ID
 * @param {number} [limit=100] Maximum records to return
 * @param {number} [offset=0] Records to skip (for pagination)
 * @param {string} [tenantId] Tenant ID for isolation
 * @returns {Array<Object>} Audit log entries for the invoice
 */
function getInvoiceAuditTrail(invoiceId, limit = 100, offset = 0, tenantId = null) {
  return getAuditLogs({
    resourceId: invoiceId,
    resourceType: 'invoice',
    limit,
    offset,
    tenantId,
  });
}

/**
 * Counts total audit logs matching criteria.
 * Useful for pagination and metrics.
 * 
 * @param {Object} options Filter options (same as getAuditLogs)
 * @returns {number} Total count of matching entries
 */
function countAuditLogs(options = {}) {
  const logs = getAuditLogs({ ...options, limit: Infinity, offset: 0 });
  return logs.length;
}

/**
 * Clears all audit logs (for testing only).
 * In production, this would trigger a secure backup/archive process.
 * 
 * @returns {void}
 * @throws {Error} If environment is production
 */
function clearAuditLogs() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Cannot clear audit logs in production');
  }
  auditLogs = [];
}

/**
 * Exports audit logs as a JSON string.
 * Useful for compliance, debugging, and integration testing.
 * 
 * @param {Object} options Export options
 * @param {number} [options.limit=Infinity] Maximum records to export
 * @param {string} [options.format='json'] Export format ('json' or 'csv')
 * @returns {string} Formatted audit logs
 */
function exportAuditLogs({ limit = Infinity, format = 'json' } = {}) {
  const logs = getAuditLogs({ limit });

  if (format === 'csv') {
    // CSV export with proper escaping
    const headers = 'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent';
    const rows = logs.map((log) => {
      const escapeCsv = (val) => {
        if (typeof val === 'string' && (val.includes(',') || val.includes('"'))) {
          return `"${val.replace(/"/g, '""')}"`;
        }
        return val;
      };
      return [
        log.id,
        log.timestamp,
        escapeCsv(log.actor),
        log.action,
        log.resourceType,
        log.resourceId,
        log.statusCode,
        escapeCsv(log.ipAddress),
        escapeCsv(log.userAgent),
      ].join(',');
    });
    return `${headers}\n${rows.join('\n')}`;
  }

  return JSON.stringify(logs, null, 2);
}

/**
 * Exports audit logs for a specific invoice as JSON or CSV.
 * Secrets are redacted via sanitizeSensitiveData.
 *
 * @param {Object} options
 * @param {string} options.invoiceId Invoice resource ID
 * @param {number} [options.limit=100] Maximum records to export
 * @param {string} [options.format='json'] 'json' or 'csv'
 * @param {string} [options.tenantId] Tenant ID for isolation
 * @returns {string} Formatted audit log output
 */
function exportInvoiceAuditLogs({ invoiceId, limit = 100, format = 'json', tenantId = null } = {}) {
  const logs = getAuditLogs({
    resourceId: invoiceId,
    resourceType: 'invoice',
    limit,
    offset: 0,
    tenantId,
  });

  if (format === 'csv') {
    const escapeCsv = (val) => {
      const str = val == null ? '' : String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    const headers = 'id,timestamp,actor,action,resourceType,resourceId,statusCode,ipAddress,userAgent';
    const rows = logs.map((log) =>
      [
        escapeCsv(log.id),
        escapeCsv(log.timestamp),
        escapeCsv(log.actor),
        escapeCsv(log.action),
        escapeCsv(log.resourceType),
        escapeCsv(log.resourceId),
        log.statusCode,
        escapeCsv(log.ipAddress),
        escapeCsv(log.userAgent),
      ].join(',')
    );
    return rows.length > 0 ? `${headers}\n${rows.join('\n')}` : headers;
  }

  return JSON.stringify(logs, null, 2);
}

module.exports = {
  createAuditLog,
  getAuditLogs,
  getInvoiceAuditTrail,
  countAuditLogs,
  clearAuditLogs,
  exportAuditLogs,
  exportInvoiceAuditLogs,
  // Exported for testing purposes
  generateAuditLogId,
  sanitizeSensitiveData,
  calculateChanges,
};
