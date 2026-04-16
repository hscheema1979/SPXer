/**
 * Bar validation — single source of truth for data quality checks.
 *
 * Called at every ingestion point:
 *   - providers/tradier.ts  (after fetchTimesales parsing)
 *   - providers/yahoo.ts    (after fetchYahooBars parsing)
 *   - storage/queries.ts    (last-line-of-defence before DB write)
 *
 * A bar that fails validation is REJECTED and logged — never silently stored.
 * Downstream consumers (indicator engine, signal detector) can trust that any
 * bar they receive has valid finite OHLCV values and a sane timestamp.
 */

export interface BarValidationResult {
  valid: boolean;
  issues: string[];
}

// Unix timestamp bounds: 2010-01-01 → 2040-01-01
const TS_MIN = 1262304000;
const TS_MAX = 2208988800;

// Sanity bounds for SPX/ES and option contract prices
const PRICE_MIN = 0.001;   // options can be sub-penny
const PRICE_MAX = 100_000; // nothing we trade exceeds this

/**
 * Validate a raw OHLCV record from a provider before it enters the bar builder.
 * Uses loose bounds because raw provider data may use slightly different conventions.
 */
export function validateRaw(
  raw: { ts: number; open: number; high: number; low: number; close: number; volume: number },
  context: string,
): BarValidationResult {
  const issues: string[] = [];

  // Timestamp
  if (!Number.isFinite(raw.ts) || raw.ts < TS_MIN || raw.ts > TS_MAX) {
    issues.push(`invalid ts=${raw.ts}`);
  }

  // Price fields — must be finite and positive
  for (const [field, val] of Object.entries({ open: raw.open, high: raw.high, low: raw.low, close: raw.close })) {
    if (!Number.isFinite(val) || val < PRICE_MIN || val > PRICE_MAX) {
      issues.push(`invalid ${field}=${val}`);
    }
  }

  // OHLC consistency (only if individual fields passed)
  if (issues.length === 0) {
    if (raw.high < raw.low) issues.push(`high(${raw.high}) < low(${raw.low})`);
    if (raw.close > raw.high) issues.push(`close(${raw.close}) > high(${raw.high})`);
    if (raw.close < raw.low)  issues.push(`close(${raw.close}) < low(${raw.low})`);
    if (raw.open > raw.high)  issues.push(`open(${raw.open}) > high(${raw.high})`);
    if (raw.open < raw.low)   issues.push(`open(${raw.open}) < low(${raw.low})`);
  }

  // Volume — must be finite and non-negative (0 is valid for thin options)
  if (!Number.isFinite(raw.volume) || raw.volume < 0) {
    issues.push(`invalid volume=${raw.volume}`);
  }

  if (issues.length > 0) {
    console.warn(`[bar-validator] REJECTED ${context} ts=${raw.ts}: ${issues.join(', ')}`);
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Validate a fully-constructed Bar object before DB write.
 * Synthetic bars (gap fill) skip OHLC consistency checks since they have flat prices.
 */
export function validateBar(
  bar: { symbol: string; timeframe: string; ts: number; open: number; high: number; low: number; close: number; volume: number; synthetic: boolean },
): BarValidationResult {
  const context = `${bar.symbol}@${bar.timeframe}`;
  const issues: string[] = [];

  if (!bar.symbol) issues.push('missing symbol');
  if (!bar.timeframe) issues.push('missing timeframe');

  if (!Number.isFinite(bar.ts) || bar.ts < TS_MIN || bar.ts > TS_MAX) {
    issues.push(`invalid ts=${bar.ts}`);
  }

  for (const [field, val] of Object.entries({ open: bar.open, high: bar.high, low: bar.low, close: bar.close })) {
    if (!Number.isFinite(val) || val < PRICE_MIN || val > PRICE_MAX) {
      issues.push(`invalid ${field}=${val}`);
    }
  }

  if (!bar.synthetic && issues.length === 0) {
    if (bar.high < bar.low)    issues.push(`high(${bar.high}) < low(${bar.low})`);
    if (bar.close > bar.high)  issues.push(`close(${bar.close}) > high(${bar.high})`);
    if (bar.close < bar.low)   issues.push(`close(${bar.close}) < low(${bar.low})`);
  }

  if (!Number.isFinite(bar.volume) || bar.volume < 0) {
    issues.push(`invalid volume=${bar.volume}`);
  }

  if (issues.length > 0) {
    console.warn(`[bar-validator] REJECTED bar ${context} ts=${bar.ts}: ${issues.join(', ')}`);
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Filter an array of raws, returning only valid ones.
 * Logs a summary if any were rejected.
 */
export function filterValidRaws<T extends { ts: number; open: number; high: number; low: number; close: number; volume: number }>(
  raws: T[],
  context: string,
): T[] {
  const valid: T[] = [];
  let rejected = 0;
  for (const raw of raws) {
    if (validateRaw(raw, context).valid) {
      valid.push(raw);
    } else {
      rejected++;
    }
  }
  if (rejected > 0) {
    console.warn(`[bar-validator] ${context}: rejected ${rejected}/${raws.length} bars`);
  }
  return valid;
}
