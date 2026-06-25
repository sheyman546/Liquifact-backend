'use strict';

/**
 * @fileoverview Pure computation functions for escrow derived display fields.
 *
 * Three fields are derived server-side so the UI receives ready-to-render values:
 *   apyPercent      — Annual yield rate rounded to 2 dp.
 *   fundedPercent   — Portion of invoice face value currently in escrow (0–100+).
 *   daysToMaturity  — Whole days until maturity; negative means overdue.
 *
 * ## Time-source precedence
 *
 * `daysToMaturity` (and therefore the APY-feeds display) is computed against
 * the **Stellar ledger close time** when available, falling back to the server
 * wall clock only when ledger time is absent.  This prevents a clock-skewed
 * host from mislabelling an invoice as overdue or not-yet-mature.
 *
 * Precedence (highest → lowest):
 *   1. `opts.ledgerCloseTime` — Unix epoch seconds (number) OR a `Date` object
 *      sourced from the Soroban response's `ledgerCloseTime` field.
 *   2. `opts.now`             — A `Date` override; used in tests.
 *   3. `new Date()`           — Server wall clock; last-resort fallback.
 *      **Caveat:** wall-clock time may diverge from ledger time by up to
 *      several seconds on a clock-skewed host; day-level precision is
 *      unaffected in practice but callers should supply `ledgerCloseTime`
 *      wherever the escrow read path returns one.
 *
 * ## APY assumption
 * `annualRatePercent` is treated as a simple annual rate (no compounding).
 * Invoice-discounting products use simple interest conventions.
 *
 * ## Rounding
 * All percent values use `Math.round(x * 100) / 100` (round-half-up at 2 dp)
 * to avoid IEEE 754 drift in UI rendering.
 *
 * @module services/escrowDerived
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Resolves the effective reference `Date` from caller options.
 *
 * Precedence: `ledgerCloseTime` > `now` > server wall clock.
 *
 * @param {object} [opts={}]
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar ledger
 *   close time as Unix epoch **seconds** (number) or a `Date`.  Values ≤ 0
 *   are treated as absent.
 * @param {Date|null|undefined} [opts.now] - Explicit override for tests.
 * @returns {Date} The resolved reference time.
 */
function resolveReferenceTime(opts = {}) {
  const { ledgerCloseTime, now } = opts;

  // 1. Ledger close time (preferred)
  if (ledgerCloseTime != null) {
    const ledgerDate =
      ledgerCloseTime instanceof Date
        ? ledgerCloseTime
        : new Date(Number(ledgerCloseTime) * 1000); // epoch seconds → ms
    if (!isNaN(ledgerDate.getTime()) && ledgerDate.getTime() > 0) {
      return ledgerDate;
    }
  }

  // 2. Explicit `now` override (tests)
  if (now instanceof Date && !isNaN(now.getTime())) {
    return now;
  }

  // 3. Server wall clock (fallback — see caveat in module JSDoc)
  return new Date();
}

/**
 * Computes APY from a simple annual rate.
 *
 * @param {unknown} annualRatePercent - e.g. 8.5 for 8.5 %.
 * @returns {number|null} Rounded to 2 dp, or null on bad input.
 */
function computeApyPercent(annualRatePercent) {
  if (
    typeof annualRatePercent !== 'number' ||
    !isFinite(annualRatePercent) ||
    annualRatePercent < 0
  ) {
    return null;
  }
  return Math.round(annualRatePercent * 100) / 100;
}

/**
 * Computes funded percent: (fundedAmount / totalAmount) * 100, rounded to 2 dp.
 * Returns null when totalAmount is zero/negative or either value is non-numeric.
 *
 * @param {unknown} fundedAmount - Amount currently held in escrow.
 * @param {unknown} totalAmount  - Invoice face value (denominator).
 * @returns {number|null}
 */
function computeFundedPercent(fundedAmount, totalAmount) {
  if (
    typeof fundedAmount !== 'number' ||
    !isFinite(fundedAmount) ||
    typeof totalAmount !== 'number' ||
    !isFinite(totalAmount) ||
    totalAmount <= 0
  ) {
    return null;
  }
  return Math.round((fundedAmount / totalAmount) * 10000) / 100;
}

/**
 * Computes whole days from the reference time to `maturityDate`.
 * Uses `Math.floor` so a maturity later the same day returns 0.
 * Negative values indicate overdue.
 *
 * The reference time is resolved via {@link resolveReferenceTime}:
 * ledger close time is used when supplied; falls back to `opts.now` then the
 * server wall clock.
 *
 * @param {Date|string|number|null|undefined} maturityDate
 * @param {object|Date} [opts={}] - Options object **or** a legacy `Date`
 *   (accepted for backwards compatibility when callers pass `new Date()` directly).
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar ledger
 *   close time in Unix epoch **seconds**.  Takes precedence over `opts.now`.
 * @param {Date|null|undefined} [opts.now] - Explicit reference time override.
 * @returns {number|null} Null when maturityDate is absent or unparseable.
 */
function computeDaysToMaturity(maturityDate, opts = {}) {
  if (maturityDate == null) return null;
  const maturity =
    maturityDate instanceof Date ? maturityDate : new Date(maturityDate);
  if (isNaN(maturity.getTime())) return null;

  // Support legacy callers that pass a Date directly as the second argument.
  const resolvedOpts = opts instanceof Date ? { now: opts } : opts;
  const ref = resolveReferenceTime(resolvedOpts);

  return Math.floor((maturity.getTime() - ref.getTime()) / MS_PER_DAY);
}

/**
 * Derives display fields from a raw escrow state object.
 *
 * Source fields consumed from `state`:
 *   fundedAmount      {number}             — Amount currently held.
 *   totalAmount       {number}             — Invoice face value.
 *   annualRatePercent {number}             — Simple annual yield in % (e.g. 8.5).
 *   maturityDate      {Date|string|number} — Maturity timestamp.
 *   maturityTimestamp {Date|string|number} — Alias for maturityDate; ignored when
 *                                            maturityDate is present.
 *
 * All output fields default to null when their source data is absent or invalid.
 *
 * ## Time-source precedence for daysToMaturity
 *   1. `opts.ledgerCloseTime` — Unix epoch seconds from the Soroban response.
 *   2. `opts.now`             — Explicit override (tests).
 *   3. `new Date()`           — Server wall clock (fallback; see module caveat).
 *
 * @param {object} state - Raw escrow state.
 * @param {object} [opts={}]
 * @param {number|Date|null|undefined} [opts.ledgerCloseTime] - Stellar ledger
 *   close time in Unix epoch **seconds** (or a `Date`).  Preferred time source
 *   for `daysToMaturity`.  Sourced from the Soroban `ledgerCloseTime` field
 *   returned by {@link module:services/escrowRead.readEscrowState}.
 * @param {Date|null|undefined} [opts.now] - Fallback reference time (tests).
 * @returns {{ apyPercent: number|null, fundedPercent: number|null, daysToMaturity: number|null }}
 */
function computeEscrowDerivedFields(state, opts = {}) {
  const { fundedAmount, totalAmount, annualRatePercent, maturityDate, maturityTimestamp } =
    state;

  const maturity =
    maturityDate != null ? maturityDate : maturityTimestamp != null ? maturityTimestamp : null;

  return {
    apyPercent: computeApyPercent(annualRatePercent),
    fundedPercent: computeFundedPercent(fundedAmount, totalAmount),
    daysToMaturity: computeDaysToMaturity(maturity, opts),
  };
}

module.exports = {
  computeApyPercent,
  computeFundedPercent,
  computeDaysToMaturity,
  computeEscrowDerivedFields,
  resolveReferenceTime,
};
