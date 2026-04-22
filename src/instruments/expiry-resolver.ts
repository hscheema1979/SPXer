/**
 * Expiry resolver — pure date math for "what expiry should we trade next?"
 *
 * The expiry *policy* (0DTE vs 1DTE vs "weekly >= 5 business days") is a
 * strategy choice and belongs in Config (future phases will wire it in).
 * This file provides the computation: given today's ET date, a policy, and
 * optional min/max DTE, return the target expiry as a 'YYYY-MM-DD' string.
 *
 * Design rules:
 *   - Strings, not Dates, for expiry values. We work in 'YYYY-MM-DD' ET
 *     throughout to dodge the UTC/ET round-trip bugs CLAUDE.md warns about.
 *   - Pure functions, no I/O. Market holidays are passed in or default to
 *     the known list from src/config.ts.
 *   - Business days = Mon-Fri minus holidays. Early-close days are still
 *     full trading days for expiry purposes.
 *
 * Examples:
 *   resolveExpiry({ policy: '0DTE' }, { todayET: '2026-04-20' })
 *     → { expiryET: '2026-04-20', cadence: 'daily', dte: 0 }
 *
 *   resolveExpiry({ policy: '1DTE' }, { todayET: '2026-04-17' })  // Friday
 *     → { expiryET: '2026-04-20', cadence: 'daily', dte: 1 }      // Monday
 *
 *   resolveExpiry({ policy: 'nearestAfterMinDte', minDte: 5 },
 *                 { todayET: '2026-04-20' })                       // Monday
 *     → { expiryET: '2026-04-27', cadence: 'weekly', dte: 5 }      // next Monday
 */

import { MARKET_HOLIDAYS } from '../config';

export type ExpiryPolicy =
  | '0DTE'                 // Today (if trading day), else next trading day
  | '1DTE'                 // Next trading day strictly after today's reference
  | 'nearestAfterMinDte';  // First trading day that is >= minDte business days out

export interface ExpiryPolicyOptions {
  policy: ExpiryPolicy;
  /** Required for 'nearestAfterMinDte'. Business days. */
  minDte?: number;
  /** Optional cap — reject if computed DTE exceeds this. */
  maxDte?: number;
}

export interface ResolveExpiryContext {
  /** Current date in ET as 'YYYY-MM-DD'. Caller provides for testability. */
  todayET: string;
  /** Override the holiday set (for tests). Defaults to src/config MARKET_HOLIDAYS. */
  holidays?: ReadonlySet<string>;
}

export interface ResolvedExpiry {
  /** Target expiry date in ET as 'YYYY-MM-DD'. */
  expiryET: string;
  /** Classification of the selected expiry's cadence. */
  cadence: 'daily' | 'weekly';
  /** Calendar days between todayET and expiryET (0 for same-day). */
  dte: number;
}

// ── Date primitives (string-based, ET-safe) ────────────────────────────────

/** Parse 'YYYY-MM-DD' → [year, month, day] numbers. Throws on malformed. */
function parseISODate(d: string): [number, number, number] {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`[expiry-resolver] Malformed date: '${d}' (expected YYYY-MM-DD)`);
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** Format [y, m, d] → 'YYYY-MM-DD'. */
function formatISODate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Add N days to a 'YYYY-MM-DD' string, returning a new 'YYYY-MM-DD'.
 * Uses Date arithmetic at UTC-midnight so no DST bugs.
 */
export function addDays(dateStr: string, n: number): string {
  const [y, m, d] = parseISODate(dateStr);
  const utc = Date.UTC(y, m - 1, d);
  const newUtc = utc + n * 86_400_000;
  const dt = new Date(newUtc);
  return formatISODate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Difference in calendar days between two 'YYYY-MM-DD' strings: `b - a`.
 * Positive if b is after a.
 */
export function dateDiffDays(a: string, b: string): number {
  const [ay, am, ad] = parseISODate(a);
  const [by, bm, bd] = parseISODate(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Day of week for 'YYYY-MM-DD'. 0 = Sun, 6 = Sat. */
export function dayOfWeek(dateStr: string): number {
  const [y, m, d] = parseISODate(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Is this date a US equity-market holiday (per MARKET_HOLIDAYS)? */
export function isMarketHoliday(dateStr: string, holidays: ReadonlySet<string> = MARKET_HOLIDAYS): boolean {
  return holidays.has(dateStr);
}

/** Is this date a US equity-market trading day (Mon-Fri, not a holiday)? */
export function isTradingDay(dateStr: string, holidays: ReadonlySet<string> = MARKET_HOLIDAYS): boolean {
  const dow = dayOfWeek(dateStr);
  if (dow === 0 || dow === 6) return false; // Sun, Sat
  return !isMarketHoliday(dateStr, holidays);
}

/** The first trading day on or after `from`. Returns `from` itself if it qualifies. */
export function tradingDayOnOrAfter(from: string, holidays: ReadonlySet<string> = MARKET_HOLIDAYS): string {
  let d = from;
  // Safety cap — 14 iterations covers any realistic holiday cluster.
  for (let i = 0; i < 14; i++) {
    if (isTradingDay(d, holidays)) return d;
    d = addDays(d, 1);
  }
  throw new Error(`[expiry-resolver] No trading day found within 14 days of ${from}`);
}

/** The first trading day strictly after `from`. */
export function nextTradingDay(from: string, holidays: ReadonlySet<string> = MARKET_HOLIDAYS): string {
  return tradingDayOnOrAfter(addDays(from, 1), holidays);
}

// ── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolve the target expiry for a given policy and date context.
 *
 * Behavior by policy:
 *
 *   '0DTE': If today is a trading day → today. Else next trading day.
 *           (Intraday time-of-day is NOT considered — an agent that has
 *           missed today's close should be gated upstream, not here.)
 *
 *   '1DTE': Next trading day strictly after today's reference trading day.
 *
 *   'nearestAfterMinDte':
 *           First trading day ≥ `minDte` business days after today.
 *           `minDte` defaults to 5 when undefined. `maxDte` rejects if
 *           the resolved DTE exceeds it.
 *
 * Cadence classification: 'daily' for expiries within 3 calendar days,
 * 'weekly' otherwise. This is a labelling convenience; the underlying
 * math is the same.
 */
export function resolveExpiry(
  opts: ExpiryPolicyOptions,
  ctx: ResolveExpiryContext
): ResolvedExpiry {
  const holidays = ctx.holidays ?? MARKET_HOLIDAYS;
  const today = ctx.todayET;

  // Validate input shape once.
  parseISODate(today);

  let expiry: string;

  switch (opts.policy) {
    case '0DTE': {
      expiry = tradingDayOnOrAfter(today, holidays);
      break;
    }
    case '1DTE': {
      const ref = tradingDayOnOrAfter(today, holidays);
      expiry = nextTradingDay(ref, holidays);
      break;
    }
    case 'nearestAfterMinDte': {
      const minDte = opts.minDte ?? 5;
      if (minDte < 0) {
        throw new Error(`[expiry-resolver] minDte must be >= 0, got ${minDte}`);
      }
      expiry = tradingDayOnOrAfter(addDays(today, minDte), holidays);
      break;
    }
    default: {
      throw new Error(`[expiry-resolver] Unknown policy: '${String(opts.policy)}'`);
    }
  }

  const dte = dateDiffDays(today, expiry);

  if (opts.maxDte !== undefined && dte > opts.maxDte) {
    throw new Error(
      `[expiry-resolver] Resolved expiry ${expiry} is ${dte} days out, exceeds maxDte=${opts.maxDte}`
    );
  }

  const cadence: 'daily' | 'weekly' = dte <= 3 ? 'daily' : 'weekly';

  return { expiryET: expiry, cadence, dte };
}
