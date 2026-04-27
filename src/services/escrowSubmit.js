'use strict';

const AppError = require('../errors/AppError');
const { simulateOrThrowSync, SIMULATION_STATUS, SIMULATION_ERROR_TYPES } = require('./sorobanSim');

const SIGNING_MODES = Object.freeze({
  CUSTODIAL: 'custodial',
  DELEGATED: 'delegated',
});

const SUBMISSION_STATUSES = Object.freeze({
  REQUIRES_SIGNATURE: 'requires_signature',
  REQUIRES_CONFIGURATION: 'requires_configuration',
  STUBBED: 'stubbed',
});

const DEFAULT_SIGNING_MODE = SIGNING_MODES.DELEGATED;
const FUND_OPERATION = 'fund_escrow';
const MAX_METADATA_BYTES = 2048;
const MAX_MEMO_LENGTH = 64;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STELLAR_PUBLIC_KEY_PATTERN = /^G[A-Z2-7]{55}$/;
const SOROBAN_CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;
const ASSET_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;
const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,7})?$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const XDR_PATTERN = /^[A-Za-z0-9+/=]+$/;

/**
 * Checks whether a value is a non-array JSON object.
 *
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True when the value is a plain object.
 */
function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Converts a value to a trimmed string, preserving undefined.
 *
 * @param {unknown} value - Candidate value.
 * @returns {string | undefined} Trimmed string or undefined.
 */
function optionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'object') {
    return undefined;
  }
  return String(value).trim();
}

/**
 * Adds a validation error to the shared list.
 *
 * @param {string[]} errors - Validation error accumulator.
 * @param {string} message - Error message to add.
 * @returns {void}
 */
function addError(errors, message) {
  errors.push(message);
}

/**
 * Creates a stable application validation error.
 *
 * @param {string[]} errors - Validation errors to expose.
 * @returns {AppError} Structured validation error.
 */
function createValidationError(errors) {
  return new AppError({
    type: 'https://liquifact.com/probs/validation-error',
    title: 'Validation Error',
    status: 400,
    detail: errors.join(' '),
    code: 'VALIDATION_ERROR',
    retryable: false,
    retryHint: 'Fix the escrow funding payload and try again.',
  });
}

/**
 * Creates a stable server configuration error.
 *
 * @param {string} detail - Configuration problem to expose.
 * @returns {AppError} Structured configuration error.
 */
function createConfigurationError(detail) {
  return new AppError({
    type: 'https://liquifact.com/probs/escrow-signing-configuration',
    title: 'Escrow Signing Configuration Error',
    status: 500,
    detail,
    code: 'CONFIGURATION_ERROR',
    retryable: false,
    retryHint: 'Correct the escrow signing environment and redeploy.',
  });
}

/**
 * Normalizes and validates a LiquiFact invoice identifier.
 *
 * @param {unknown} value - Raw invoice identifier.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized invoice identifier.
 */
function normalizeInvoiceId(value, errors) {
  const invoiceId = optionalString(value);
  if (!invoiceId) {
    addError(errors, 'invoiceId is required.');
    return undefined;
  }
  if (!IDENTIFIER_PATTERN.test(invoiceId)) {
    addError(errors, 'invoiceId contains unsupported characters.');
    return undefined;
  }
  return invoiceId;
}

/**
 * Normalizes and validates a Stellar public key.
 *
 * @param {unknown} value - Raw public key value.
 * @param {string} field - Field name for validation messages.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized public key.
 */
function normalizePublicKey(value, field, errors) {
  const publicKey = optionalString(value);
  if (!publicKey) {
    addError(errors, `${field} is required.`);
    return undefined;
  }
  if (!STELLAR_PUBLIC_KEY_PATTERN.test(publicKey)) {
    addError(errors, `${field} must be a Stellar G... public key.`);
    return undefined;
  }
  return publicKey;
}

/**
 * Normalizes and validates a Stellar amount string.
 *
 * @param {unknown} amountValue - Raw amount value.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized amount.
 */
function normalizeAmount(amountValue, errors) {
  const amount = optionalString(amountValue);
  if (!amount) {
    addError(errors, 'amount is required.');
    return undefined;
  }
  if (!AMOUNT_PATTERN.test(amount)) {
    addError(errors, 'amount must be a positive decimal with up to 7 decimal places.');
    return undefined;
  }
  if (/^0(?:\.0{1,7})?$/.test(amount)) {
    addError(errors, 'amount must be greater than zero.');
    return undefined;
  }
  return amount;
}

/**
 * Normalizes and validates the funding asset descriptor.
 *
 * @param {Object} payload - Request payload.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {{code: string, issuer: string | null, type: string} | undefined} Asset descriptor.
 */
function normalizeAsset(payload, errors) {
  const assetSource = isPlainObject(payload.asset) ? payload.asset : payload;
  const code = optionalString(assetSource.code || assetSource.assetCode || payload.assetCode);
  const issuer = optionalString(assetSource.issuer || assetSource.assetIssuer || payload.assetIssuer);

  if (!code) {
    addError(errors, 'asset.code is required.');
    return undefined;
  }

  const normalizedCode = code.toUpperCase();
  if (!ASSET_CODE_PATTERN.test(normalizedCode)) {
    addError(errors, 'asset.code must be 1-12 uppercase alphanumeric characters.');
    return undefined;
  }

  if (normalizedCode === 'XLM') {
    if (issuer) {
      addError(errors, 'asset.issuer must be omitted for native XLM.');
      return undefined;
    }
    return { code: normalizedCode, issuer: null, type: 'native' };
  }

  const normalizedIssuer = normalizePublicKey(issuer, 'asset.issuer', errors);
  if (!normalizedIssuer) {
    return undefined;
  }

  return { code: normalizedCode, issuer: normalizedIssuer, type: 'credit_alphanum' };
}

/**
 * Normalizes and validates a signing mode value.
 *
 * @param {unknown} value - Raw signing mode.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized signing mode.
 */
function normalizeRequestedSigningMode(value, errors) {
  const signingMode = optionalString(value);
  if (!signingMode) {
    return undefined;
  }

  const normalizedMode = signingMode.toLowerCase();
  if (!Object.values(SIGNING_MODES).includes(normalizedMode)) {
    addError(errors, 'signingMode must be "custodial" or "delegated".');
    return undefined;
  }

  return normalizedMode;
}

/**
 * Normalizes and validates an optional idempotency key.
 *
 * @param {unknown} value - Raw idempotency key.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized idempotency key.
 */
function normalizeIdempotencyKey(value, errors) {
  const idempotencyKey = optionalString(value);
  if (!idempotencyKey) {
    return undefined;
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    addError(errors, 'idempotencyKey must be 8-128 URL-safe characters.');
    return undefined;
  }
  return idempotencyKey;
}

/**
 * Normalizes an optional short memo value.
 *
 * @param {unknown} value - Raw memo value.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized memo.
 */
function normalizeMemo(value, errors) {
  const memo = optionalString(value);
  if (!memo) {
    return undefined;
  }
  if (memo.length > MAX_MEMO_LENGTH) {
    addError(errors, `memo must be ${MAX_MEMO_LENGTH} characters or fewer.`);
    return undefined;
  }
  return memo;
}

/**
 * Normalizes optional metadata without allowing oversized audit payloads.
 *
 * @param {unknown} value - Raw metadata value.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {Object | undefined} Metadata object.
 */
function normalizeMetadata(value, errors) {
  if (value === undefined) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    addError(errors, 'metadata must be a JSON object when provided.');
    return undefined;
  }

  const byteLength = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (byteLength > MAX_METADATA_BYTES) {
    addError(errors, `metadata must be ${MAX_METADATA_BYTES} bytes or fewer.`);
    return undefined;
  }

  return value;
}

/**
 * Normalizes an optional signed transaction envelope placeholder.
 *
 * @param {unknown} value - Raw signed XDR value.
 * @param {string[]} errors - Validation error accumulator.
 * @returns {string | undefined} Normalized XDR value.
 */
function normalizeSignedTransactionXdr(value, errors) {
  const signedTransactionXdr = optionalString(value);
  if (!signedTransactionXdr) {
    return undefined;
  }
  if (signedTransactionXdr.length > 8192 || !XDR_PATTERN.test(signedTransactionXdr)) {
    addError(errors, 'signedTransactionXdr must be base64 text no larger than 8192 characters.');
    return undefined;
  }
  return signedTransactionXdr;
}

/**
 * Validates and normalizes a funding request body.
 *
 * @param {unknown} payload - Raw request body.
 * @param {Object} [options={}] - Request context.
 * @param {string} [options.idempotencyKey] - Idempotency key from an HTTP header.
 * @returns {Object} Normalized funding request.
 */
function validateFundingRequest(payload, options = {}) {
  const errors = [];

  if (!isPlainObject(payload)) {
    throw createValidationError(['Escrow funding payload must be a JSON object.']);
  }

  const amountValue = payload.amount !== undefined && payload.amount !== null
    ? payload.amount
    : payload.fundedAmount;

  const request = {
    invoiceId: normalizeInvoiceId(payload.invoiceId, errors),
    funderPublicKey: normalizePublicKey(payload.funderPublicKey, 'funderPublicKey', errors),
    amount: normalizeAmount(amountValue, errors),
    asset: normalizeAsset(payload, errors),
    signingMode: normalizeRequestedSigningMode(payload.signingMode, errors),
    idempotencyKey: normalizeIdempotencyKey(payload.idempotencyKey || options.idempotencyKey, errors),
    memo: normalizeMemo(payload.memo, errors),
    metadata: normalizeMetadata(payload.metadata, errors),
    signedTransactionXdr: normalizeSignedTransactionXdr(payload.signedTransactionXdr, errors),
    clientReference: normalizeIdempotencyKey(payload.clientReference, errors),
  };

  if (errors.length > 0) {
    throw createValidationError(errors);
  }

  return request;
}

/**
 * Reads and validates the configured signing mode.
 *
 * @param {NodeJS.ProcessEnv} env - Environment variable source.
 * @returns {string} Configured signing mode.
 */
function normalizeConfiguredSigningMode(env) {
  const rawMode = optionalString(env.ESCROW_SIGNING_MODE);
  if (!rawMode) {
    return DEFAULT_SIGNING_MODE;
  }

  const configuredMode = rawMode.toLowerCase();
  if (!Object.values(SIGNING_MODES).includes(configuredMode)) {
    throw createConfigurationError('ESCROW_SIGNING_MODE must be "custodial" or "delegated".');
  }

  return configuredMode;
}

/**
 * Validates a configured Soroban RPC URL when present.
 *
 * @param {unknown} value - Raw URL value.
 * @returns {string | null} Normalized URL or null.
 */
function normalizeConfiguredRpcUrl(value) {
  const rpcUrl = optionalString(value);
  if (!rpcUrl) {
    return null;
  }

  try {
    const parsed = new URL(rpcUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
    return parsed.toString();
  } catch {
    throw createConfigurationError('SOROBAN_RPC_URL must be a valid HTTP(S) URL.');
  }
}

/**
 * Validates a configured Soroban contract ID when present.
 *
 * @param {unknown} value - Raw contract ID.
 * @returns {string | null} Normalized contract ID or null.
 */
function normalizeConfiguredContractId(value) {
  const contractId = optionalString(value);
  if (!contractId) {
    return null;
  }
  if (!SOROBAN_CONTRACT_ID_PATTERN.test(contractId)) {
    throw createConfigurationError('LIQUIFACT_ESCROW_CONTRACT_ID must be a Soroban C... contract ID.');
  }
  return contractId;
}

/**
 * Resolves env-driven signing configuration without exposing key material.
 *
 * @param {string} [requestedMode] - Request-level signing mode override.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment variable source.
 * @returns {Object} Redacted signing configuration.
 */
function resolveSigningConfig(requestedMode, env = process.env) {
  const mode = requestedMode || normalizeConfiguredSigningMode(env);
  const rpcUrl = normalizeConfiguredRpcUrl(env.SOROBAN_RPC_URL);
  const networkPassphrase = optionalString(env.STELLAR_NETWORK_PASSPHRASE) || null;
  const escrowContractId = normalizeConfiguredContractId(env.LIQUIFACT_ESCROW_CONTRACT_ID);
  const custodialSigningEnabled = optionalString(env.ESCROW_CUSTODIAL_SIGNING_ENABLED) === 'true';
  const custodialKeyId = optionalString(env.ESCROW_CUSTODIAL_KEY_ID) || null;
  const custodialKmsProvider = optionalString(env.ESCROW_CUSTODIAL_KMS_PROVIDER) || null;

  const networkReady = Boolean(rpcUrl && networkPassphrase && escrowContractId);
  const custodialReady = Boolean(
    custodialSigningEnabled &&
      custodialKeyId &&
      custodialKmsProvider &&
      networkReady,
  );

  return {
    mode,
    network: {
      ready: networkReady,
      rpcUrlConfigured: Boolean(rpcUrl),
      networkPassphrase,
      escrowContractId,
    },
    custodial: {
      ready: custodialReady,
      enabled: custodialSigningEnabled,
      keyConfigured: Boolean(custodialKeyId),
      kmsProviderConfigured: Boolean(custodialKmsProvider),
    },
    delegated: {
      ready: networkReady,
    },
  };
}

/**
 * Builds the Soroban fund operation intent represented by this stub.
 *
 * @param {Object} request - Normalized funding request.
 * @param {Object} config - Redacted signing configuration.
 * @param {Object} options - Request context.
 * @returns {Object} Funding operation intent.
 */
function buildFundingIntent(request, config, options) {
  return {
    operation: FUND_OPERATION,
    invoiceId: request.invoiceId,
    funderPublicKey: request.funderPublicKey,
    amount: request.amount,
    asset: request.asset,
    contractId: config.network.escrowContractId,
    networkPassphrase: config.network.networkPassphrase,
    idempotencyKey: request.idempotencyKey || null,
    memo: request.memo || null,
    clientReference: request.clientReference || null,
    metadata: request.metadata || null,
    requestedAt: options.now.toISOString(),
    requestedBy: options.userId ? String(options.userId) : null,
  };
}

/**
 * Determines the safe non-submission outcome for the current request.
 *
 * @param {Object} request - Normalized funding request.
 * @param {Object} config - Redacted signing configuration.
 * @returns {{status: string, reason: string, nextAction: string}} Stub outcome.
 */
function determineStubOutcome(request, config) {
  if (config.mode === SIGNING_MODES.DELEGATED && !request.signedTransactionXdr) {
    return {
      status: SUBMISSION_STATUSES.REQUIRES_SIGNATURE,
      reason: 'Delegated signing requires a client-signed transaction envelope before submission.',
      nextAction: 'return_unsigned_transaction_xdr_when_soroban_builder_is_implemented',
    };
  }

  if (config.mode === SIGNING_MODES.DELEGATED && !config.delegated.ready) {
    return {
      status: SUBMISSION_STATUSES.REQUIRES_CONFIGURATION,
      reason: 'Delegated submission requires Soroban RPC, network passphrase, and escrow contract configuration.',
      nextAction: 'configure_soroban_network_before_accepting_signed_xdr',
    };
  }

  if (config.mode === SIGNING_MODES.CUSTODIAL && !config.custodial.ready) {
    return {
      status: SUBMISSION_STATUSES.REQUIRES_CONFIGURATION,
      reason: 'Custodial signing requires explicit enablement plus KMS key, Soroban RPC, network passphrase, and contract configuration.',
      nextAction: 'configure_custodial_signing_or_use_delegated_signing',
    };
  }

  return {
    status: SUBMISSION_STATUSES.STUBBED,
    reason: 'Funding request validated, but this design stub never signs or submits a live Soroban transaction.',
    nextAction: 'implement_soroban_transaction_build_sign_and_submit_pipeline',
  };
}

/**
 * Simulates a Soroban transaction before submission.
 *
 * This function calls the simulateOrThrow utility to validate that the
 * transaction would succeed before attempting actual submission. It uses
 * the cached footprint when available to avoid redundant simulations.
 *
 * @param {Object} request - Normalized funding request.
 * @param {Object} config - Signing configuration.
 * @returns {Promise<Object>} Simulation result or null if simulation is skipped.
 */
async function simulateBeforeSubmit(request, config) {
  // Only simulate if we have a signed XDR and the network is configured
  if (!request.signedTransactionXdr || !config.network.escrowContractId) {
    return null;
  }

  try {
    const simulationResult = await simulateOrThrowSync({
      operation: FUND_OPERATION,
      invoiceId: request.invoiceId,
      funderPublicKey: request.funderPublicKey,
      transactionXdr: request.signedTransactionXdr,
      options: {
        useCache: true,
      },
    });

    return {
      simulated: true,
      simulationStatus: simulationResult.status,
      footprint: simulationResult.footprint,
      resourceConfig: simulationResult.resourceConfig,
      cached: simulationResult.cached,
    };
  } catch (error) {
    // Return simulation failure without throwing - the caller decides how to handle
    return {
      simulated: true,
      simulationStatus: SIMULATION_STATUS.FAILURE,
      error: error,
    };
  }
}

/**
 * Validates an escrow funding request and returns a no-submit Soroban intent.
 *
 * This service intentionally never signs with a custodial key and never sends
 * a transaction to Soroban. Future live submission code must replace this
 * stub behind explicit env gates and tests.
 *
 * When a signed transaction XDR is provided and the network is configured,
 * this function now simulates the transaction before submission to validate
 * it would succeed. The simulation result is included in the response.
 *
 * @param {unknown} payload - Raw funding request payload.
 * @param {Object} [options={}] - Request context.
 * @param {NodeJS.ProcessEnv} [options.env=process.env] - Environment source.
 * @param {Date} [options.now=new Date()] - Request timestamp.
 * @param {string} [options.idempotencyKey] - Idempotency key from a header.
 * @param {string | number} [options.userId] - Authenticated user identifier.
 * @returns {Promise<Object>} Non-submitted funding intent result.
 */
async function submitEscrowFunding(payload, options = {}) {
  const normalizedOptions = {
    env: options.env || process.env,
    now: options.now || new Date(),
    idempotencyKey: options.idempotencyKey,
    userId: options.userId,
  };
  const request = validateFundingRequest(payload, normalizedOptions);
  const config = resolveSigningConfig(normalizedOptions.env, request.signingMode);
  const outcome = determineStubOutcome(request, config);

  // Simulate transaction if we have a signed XDR and network is configured
  let simulationResult = null;
  if (request.signedTransactionXdr && config.network.ready) {
    simulationResult = await simulateBeforeSubmit(request, config);
  }

  return {
    status: outcome.status,
    submitted: false,
    signingMode: config.mode,
    reason: outcome.reason,
    nextAction: outcome.nextAction,
    intent: buildFundingIntent(request, config, normalizedOptions),
    transaction: {
      unsignedXdr: null,
      signedXdrAccepted: Boolean(request.signedTransactionXdr),
      hash: null,
    },
    simulation: simulationResult || {
      simulated: false,
      simulationStatus: null,
    },
    controls: {
      liveSubmissionEnabled: false,
      custodialSigningReady: config.custodial.ready,
      delegatedSubmissionReady: config.delegated.ready,
      custodialKeyConfigured: config.custodial.keyConfigured,
    },
  };
}

module.exports = {
  submitEscrowFunding,
  validateFundingRequest,
  resolveSigningConfig,
  determineStubOutcome,
  SIGNING_MODES,
  SUBMISSION_STATUSES,
};
