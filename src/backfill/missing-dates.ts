/**
 * missing-dates — coverage gap detection for replay_bars.
 *
 * Drives the universal backfill orchestrator: given a profile id and a
 * date range, compute which dates are missing raw 1m bars, missing
 * aggregated MTFs, or missing denormalized indicator columns — and
 * therefore need work.
 *
 * Reads only from replay_bars. The trading-day universe comes from the
 * SPX-underlying coverage (treated as the canonical trading calendar)
 * because that's what the replay system already anchors on.
 *
 * All queries are keyed by the *profile's underlying DB symbol* (e.g.
 * 'SPX', 'NDX', 'SPY'). Option coverage isn't checked here — the
 * orchestrator owns that because option-chain membership varies by day
 * and can't be inferred from a fixed list.
 */

import type { Database as DB } from 'better-sqlite3';
import type { Timeframe } from '../types';
import { SUPPORTED_TIMEFRAMES, DENORM_COLS } from '../pipeline/mtf-builder';

export interface CoverageGap {
  date: string;
  /** No 1m bars at all on this date for the symbol. */
  missingRaw: boolean;
  /** MTFs present in replay_bars missing aggregates for this date. */
  missingMtfs: Timeframe[];
  /** Timeframes whose denormalized indicator columns are null. */
  missingIndicators: Timeframe[];
}

export interface FindMissingOptions {
  /** Inclusive YYYY-MM-DD. */
  start?: string;
  /** Inclusive YYYY-MM-DD. */
  end?: string;
  /** Timeframes to check. Defaults to 1m + SUPPORTED_TIMEFRAMES. */
  timeframes?: Timeframe[];
  /**
   * Trading-day universe. If omitted, we derive from replay_bars by looking
   * at which dates the *anchor* symbol (defaults to 'SPX') has 1m bars on.
   * Pass explicit dates when you want to backfill a known calendar that
   * may not yet have ANY data in replay_bars (e.g. new NDX ticker).
   */
  tradingDates?: string[];
  anchorSymbol?: string;
}

/**
 * Find coverage gaps for a single symbol over a date range.
 *
 * Return order matches the trading-date list — callers can iterate in
 * chronological order for predictable progress bars.
 */
export function findMissingDates(
  db: DB,
  symbol: string,
  opts: FindMissingOptions = {},
): CoverageGap[] {
  const tfs: Timeframe[] = opts.timeframes ?? (['1m', ...SUPPORTED_TIMEFRAMES] as Timeframe[]);
  const anchor = opts.anchorSymbol ?? 'SPX';
  const tradingDates = opts.tradingDates ?? deriveTradingDates(db, anchor);
  const filtered = tradingDates.filter(d =>
    (!opts.start || d >= opts.start) && (!opts.end || d <= opts.end));

  if (filtered.length === 0) return [];

  // Check if denorm columns exist yet (they're added by mtf-builder on first run).
  const hasHma5 = (() => {
    try {
      const cols = (db.prepare(`PRAGMA table_info(replay_bars)`).all() as Array<{ name: string }>);
      return cols.some(c => c.name === 'hma5');
    } catch { return false; }
  })();
  const indicatorExpr = hasHma5
    ? `SUM(CASE WHEN hma5 IS NULL THEN 1 ELSE 0 END)`
    : `COUNT(*)`;  // all rows count as "missing indicators" when column doesn't exist

  // Pull all rows for this symbol in the date range in a single query.
  const firstTs = toUnix(filtered[0]);
  const lastTs = toUnix(filtered[filtered.length - 1]) + 86400 + 3600;
  const rows = db.prepare(`
    SELECT
      date(ts, 'unixepoch') as d,
      timeframe as tf,
      COUNT(*) as bar_cnt,
      ${indicatorExpr} as null_indicator_cnt
    FROM replay_bars
    WHERE symbol = ? AND ts >= ? AND ts < ?
    GROUP BY d, tf
  `).all(symbol, firstTs, lastTs) as Array<{
    d: string;
    tf: string;
    bar_cnt: number;
    null_indicator_cnt: number;
  }>;

  // Build a (date → tf → coverage) index.
  const idx = new Map<string, Map<string, { bars: number; nullInds: number }>>();
  for (const r of rows) {
    let tfMap = idx.get(r.d);
    if (!tfMap) { tfMap = new Map(); idx.set(r.d, tfMap); }
    tfMap.set(r.tf, { bars: r.bar_cnt, nullInds: r.null_indicator_cnt });
  }

  const out: CoverageGap[] = [];
  for (const date of filtered) {
    const tfMap = idx.get(date);
    const has1m = !!tfMap?.get('1m')?.bars;
    if (!has1m) {
      // No raw — everything downstream is also "missing" but we collapse to
      // the simpler missingRaw signal; orchestrator sees this and kicks off
      // a full fetch + MTF build.
      out.push({
        date,
        missingRaw: true,
        missingMtfs: tfs.filter(t => t !== '1m'),
        missingIndicators: tfs,
      });
      continue;
    }

    const missingMtfs: Timeframe[] = [];
    const missingIndicators: Timeframe[] = [];
    for (const tf of tfs) {
      const cov = tfMap?.get(tf);
      if (!cov || cov.bars === 0) {
        if (tf !== '1m') missingMtfs.push(tf);
      } else if (cov.nullInds > 0) {
        // Warmup NULLs are expected: HMA needs ~5 bars, RSI needs 14 bars
        // before they can produce values. If more than half the bars are
        // NULL, indicators were never computed. A small fraction of NULLs
        // (≤ 25% of bars) is normal warmup — don't flag the date.
        const nullRatio = cov.nullInds / cov.bars;
        if (nullRatio > 0.25) {
          missingIndicators.push(tf);
        }
      }
    }

    out.push({ date, missingRaw: false, missingMtfs, missingIndicators });
  }
  return out;
}

/**
 * A date is "work pending" if any of: raw missing, MTFs missing, indicators
 * missing. Convenience filter for the orchestrator.
 */
export function hasWorkPending(gap: CoverageGap): boolean {
  return gap.missingRaw
    || gap.missingMtfs.length > 0
    || gap.missingIndicators.length > 0;
}

/**
 * Trading-day universe for `anchor` (default 'SPX'). We treat anchor's 1m
 * coverage as the canonical calendar so all symbols align on the same
 * trading days — avoids trying to backfill holidays or weekends.
 */
function deriveTradingDates(db: DB, anchor: string): string[] {
  return (db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch') as d
    FROM replay_bars WHERE symbol=? AND timeframe='1m'
    ORDER BY d
  `).all(anchor) as { d: string }[]).map(r => r.d);
}

function toUnix(isoDate: string): number {
  return Math.floor(new Date(isoDate + 'T00:00:00Z').getTime() / 1000);
}

// Re-export for callers that want the canonical denorm list without
// reaching into the pipeline module.
export { DENORM_COLS };
