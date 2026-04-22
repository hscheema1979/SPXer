/**
 * mtf-builder — Symbol-agnostic multi-timeframe aggregation with indicators.
 *
 * Extracted from scripts/backfill/build-mtf-bars.ts so the same logic can be
 * called from the CLI, the generic orchestrator, and future Phase 3 server
 * endpoints. The CLI remains the command-line face; this module is the pure
 * library underneath.
 *
 * Responsibilities:
 *   - Pure: aggregate 1m bars into {2m,3m,5m,10m,15m} buckets.
 *   - Stateful: seed indicator state from prior-day bars (cross-day
 *     continuity) and compute indicators on current-day bars, writing the
 *     JSON blob + denormalized columns back into replay_bars.
 *
 * Concurrency: this module mutates the indicator engine's per-symbol state,
 * so callers must serialize across symbols (the CLI does this via its main
 * for-loop). This matches the behavior of build-mtf-bars.ts pre-refactor.
 *
 * Symbol-agnostic: `symbol` is just a string — SPX, NDX, AAPL, etc. Tier
 * (1 or 2) is passed by the caller from the instrument profile.
 */

import type { Database as DB } from 'better-sqlite3';
import type { Timeframe } from '../types';
import { computeIndicators, seedIndicatorState, resetVWAP } from '../core/indicator-engine';

// ── Constants ────────────────────────────────────────────────────────────────

/** Timeframes the builder knows how to produce from a 1m source. */
export const SUPPORTED_TIMEFRAMES: Timeframe[] = ['2m', '3m', '5m', '10m', '15m'];

export const TF_SECONDS: Record<string, number> = {
  '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900,
};

/**
 * Denormalized indicator columns on replay_bars. Kept here so the MTF builder
 * and any other writer (e.g. compute-indicators.ts) agree on the set. If you
 * add a column, update both this list and the replay_bars schema.
 */
export const DENORM_COLS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

export interface AggBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BuildMtfOptions {
  db: DB;
  symbol: string;
  /** Indicator tier — 1 = options & equities (HMA/EMA/RSI/BB/ATR/VWAP),
   *  2 = index-grade adds EMA50/200/SMA/MACD/ADX/Stoch/CCI. */
  tier: 1 | 2;
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** Prior trading day's ISO date, or null on the first day. */
  priorDate: string | null;
  /** Timeframes to build. Defaults to SUPPORTED_TIMEFRAMES. */
  timeframes?: Timeframe[];
  /** Also recompute 1m indicators in place with cross-day continuity. */
  recompute1m?: boolean;
}

export interface BuildMtfResult {
  symbol: string;
  date: string;
  /** Total bars written (aggregated bars across all TFs + any 1m updates). */
  barsWritten: number;
  /** Per-timeframe counts (useful for progress UIs). */
  byTimeframe: Record<string, number>;
}

// ── Pure aggregation ─────────────────────────────────────────────────────────

/**
 * Aggregate 1m bars into the requested timeframe bucket (seconds). Pure —
 * no DB, no indicator state. Useful for tests and for callers that only
 * want raw OHLCV aggregation without writing indicators.
 */
export function aggregateBars(bars1m: AggBar[], tfSeconds: number): AggBar[] {
  if (bars1m.length === 0) return [];
  const result: AggBar[] = [];
  let bucket: AggBar[] = [];
  let bucketStart = 0;

  for (const bar of bars1m) {
    const barBucket = Math.floor(bar.ts / tfSeconds) * tfSeconds;
    if (bucket.length === 0) bucketStart = barBucket;
    if (barBucket !== bucketStart && bucket.length > 0) {
      result.push(flushBucket(bucket, bucketStart));
      bucket = [];
      bucketStart = barBucket;
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) result.push(flushBucket(bucket, bucketStart));
  return result;
}

function flushBucket(bucket: AggBar[], bucketStart: number): AggBar {
  // Hot-path: avoid spreading into Math.max/Math.min for large buckets.
  let high = bucket[0].high;
  let low = bucket[0].low;
  let volume = 0;
  for (const b of bucket) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return {
    ts: bucketStart,
    open: bucket[0].open,
    high,
    low,
    close: bucket[bucket.length - 1].close,
    volume,
  };
}

// ── DB helpers ───────────────────────────────────────────────────────────────

function load1mBars(db: DB, symbol: string, startTs: number, endTs: number): AggBar[] {
  return db.prepare(`
    SELECT ts, open, high, low, close, volume
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(symbol, startTs, endTs) as AggBar[];
}

function dayBoundsUtc(date: string): { start: number; end: number } {
  const start = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
  // 24h + 1h slack to catch any late post-market prints
  return { start, end: start + 86400 + 3600 };
}

/**
 * Cached prepared statements per-DB. `better-sqlite3` compiles each
 * `.prepare()` call, so avoid recompiling on every symbol×date.
 */
interface StatementBundle {
  upsertAgg: ReturnType<DB['prepare']>;
  update1m: ReturnType<DB['prepare']>;
}
const STATEMENT_CACHE = new WeakMap<DB, StatementBundle>();

function getStatements(db: DB): StatementBundle {
  const cached = STATEMENT_CACHE.get(db);
  if (cached) return cached;

  const upsertCols = DENORM_COLS.join(', ');
  const upsertPlaceholders = DENORM_COLS.map(() => '?').join(', ');
  const upsertUpdate = DENORM_COLS.map(c => `${c}=excluded.${c}`).join(', ');

  const upsertAgg = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source, ${upsertCols})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'aggregated', ${upsertPlaceholders})
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume,
      indicators=excluded.indicators, source='aggregated',
      ${upsertUpdate}
  `);

  const update1mCols = DENORM_COLS.map(c => `${c}=?`).join(', ');
  const update1m = db.prepare(`
    UPDATE replay_bars SET indicators=?, ${update1mCols}
    WHERE symbol=? AND timeframe='1m' AND ts=?
  `);

  const bundle: StatementBundle = { upsertAgg, update1m };
  STATEMENT_CACHE.set(db, bundle);
  return bundle;
}

// ── Core build routine ───────────────────────────────────────────────────────

/**
 * Build MTF bars + indicators for one symbol on one date. Seeds indicator
 * state from the prior trading day (if provided) so cross-day continuity
 * holds — this matches live-pipeline semantics where HMA/EMA/RSI roll
 * forward overnight.
 */
export function buildMtfForSymbol(opts: BuildMtfOptions): BuildMtfResult {
  const { db, symbol, tier, date, priorDate } = opts;
  const timeframes = opts.timeframes ?? SUPPORTED_TIMEFRAMES;
  const recompute1m = opts.recompute1m ?? false;
  const { upsertAgg, update1m } = getStatements(db);

  const { start: dayStart, end: dayEnd } = dayBoundsUtc(date);
  const bars1m = load1mBars(db, symbol, dayStart, dayEnd);

  const byTimeframe: Record<string, number> = {};
  let barsWritten = 0;

  if (bars1m.length === 0) {
    return { symbol, date, barsWritten: 0, byTimeframe };
  }

  const tfsToProcess: Timeframe[] = recompute1m ? ['1m' as Timeframe, ...timeframes] : timeframes;

  for (const tf of tfsToProcess) {
    const tfSec = TF_SECONDS[tf];
    if (!tfSec) continue;

    const aggBars = tf === '1m' ? bars1m : aggregateBars(bars1m, tfSec);
    if (aggBars.length === 0) continue;

    // Seed indicator state from prior day for cross-day continuity.
    seedPriorDay(db, symbol, tier, tf, priorDate, tfSec);

    const write = db.transaction((bars: AggBar[]) => {
      for (const b of bars) {
        const ind = computeIndicators(
          {
            symbol, timeframe: tf, ts: b.ts,
            open: b.open, high: b.high, low: b.low, close: b.close,
            volume: b.volume, synthetic: false, gapType: null,
          } as any,
          tier,
        );
        const indJson = JSON.stringify(ind);
        const denormVals: Array<number | null> = DENORM_COLS.map(
          c => (ind as Record<string, number | undefined>)[c] ?? null,
        );

        if (tf === '1m') {
          // Bindings: indicators, ...denorm, symbol, ts
          const bindings = [indJson, ...denormVals, symbol, b.ts];
          (update1m.run as (...args: unknown[]) => unknown)(...bindings);
        } else {
          // Bindings: symbol, tf, ts, open, high, low, close, volume, indicators, ...denorm
          const bindings = [symbol, tf, b.ts, b.open, b.high, b.low, b.close, b.volume, indJson, ...denormVals];
          (upsertAgg.run as (...args: unknown[]) => unknown)(...bindings);
        }
        barsWritten++;
      }
    });
    write(aggBars);
    byTimeframe[tf] = aggBars.length;
  }

  return { symbol, date, barsWritten, byTimeframe };
}

/**
 * Feed the prior day's bars through the indicator engine so the first bar
 * of `date` sees warmed-up state. VWAP resets at each day open so we reset
 * it after seeding. If `priorDate` is null (first day in series) we just
 * reset the engine to empty state.
 */
function seedPriorDay(
  db: DB,
  symbol: string,
  tier: 1 | 2,
  tf: Timeframe,
  priorDate: string | null,
  tfSec: number,
): void {
  seedIndicatorState(symbol, tf, []);
  resetVWAP(symbol, tf);

  if (!priorDate) return;

  const { start, end } = dayBoundsUtc(priorDate);
  const priorBars = load1mBars(db, symbol, start, end);
  if (priorBars.length === 0) return;

  const priorAgg = tf === '1m' ? priorBars : aggregateBars(priorBars, tfSec);
  for (const pb of priorAgg) {
    computeIndicators(
      {
        symbol, timeframe: tf, ts: pb.ts,
        open: pb.open, high: pb.high, low: pb.low, close: pb.close,
        volume: pb.volume, synthetic: false, gapType: null,
      } as any,
      tier,
    );
  }
  // VWAP is intraday-only — reset the accumulator after using prior day
  // purely to warm HMA/EMA/RSI state.
  resetVWAP(symbol, tf);
}

// ── Convenience: date helpers ────────────────────────────────────────────────

/**
 * List distinct trading dates for a symbol from replay_bars. Unlike the
 * pre-refactor CLI this does NOT hardcode 'SPX' — pass whatever symbol the
 * caller cares about.
 */
export function listTradingDatesForSymbol(db: DB, symbol: string): string[] {
  return (db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch') as d
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m'
    ORDER BY d
  `).all(symbol) as { d: string }[]).map(r => r.d);
}

/**
 * List distinct symbols that have 1m bars on a date. Useful for the CLI's
 * "all symbols" mode — options for a 0DTE day all live on that date only.
 */
export function listSymbolsForDate(db: DB, date: string): string[] {
  const { start, end } = dayBoundsUtc(date);
  return (db.prepare(`
    SELECT DISTINCT symbol FROM replay_bars
    WHERE timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY symbol
  `).all(start, end) as { symbol: string }[]).map(r => r.symbol);
}
