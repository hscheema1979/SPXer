/**
 * build-mtf-bars.ts — Build multi-timeframe bars from 1m data in replay_bars.
 *
 * Aggregates 1m bars into 2m, 3m, 5m, 10m, 15m bars.
 * Computes indicators WITH cross-day continuity (loads prior day bars to seed state).
 * Stores results back into replay_bars with the appropriate timeframe tag.
 *
 * Usage:
 *   npx tsx scripts/backfill/build-mtf-bars.ts                           # all dates, all TFs
 *   npx tsx scripts/backfill/build-mtf-bars.ts 2026-02-20                # single date
 *   npx tsx scripts/backfill/build-mtf-bars.ts 2026-02-20 2026-03-24    # date range
 *   npx tsx scripts/backfill/build-mtf-bars.ts --tf=3m,5m               # specific timeframes
 *   npx tsx scripts/backfill/build-mtf-bars.ts --recompute-1m           # also recompute 1m indicators with continuity
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import Database from 'better-sqlite3';
import * as path from 'path';
import { computeIndicators, seedIndicatorState, resetVWAP } from '../../src/core/indicator-engine';
import type { Timeframe } from '../../src/types';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const TIMEFRAMES: Timeframe[] = ['2m', '3m', '5m', '10m', '15m'];
const TF_SECONDS: Record<string, number> = {
  '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900,
};

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagArgs = args.filter(a => a.startsWith('--'));
const dateArgs = args.filter(a => !a.startsWith('--'));

const tfFlag = flagArgs.find(a => a.startsWith('--tf='));
const selectedTfs: Timeframe[] = tfFlag
  ? tfFlag.split('=')[1].split(',') as Timeframe[]
  : TIMEFRAMES;

const recompute1m = flagArgs.includes('--recompute-1m');

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTradingDays(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch') as d
    FROM replay_bars WHERE symbol='SPX' AND timeframe='1m'
    ORDER BY d
  `).all() as { d: string }[]).map(r => r.d);
}

function getSymbolsForDate(db: Database.Database, date: string): string[] {
  const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
  const dayEnd = dayStart + 86400 + 3600;
  return (db.prepare(`
    SELECT DISTINCT symbol FROM replay_bars
    WHERE timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY symbol
  `).all(dayStart, dayEnd) as { symbol: string }[]).map(r => r.symbol);
}

function load1mBars(db: Database.Database, symbol: string, startTs: number, endTs: number) {
  return db.prepare(`
    SELECT ts, open, high, low, close, volume
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(symbol, startTs, endTs) as Array<{
    ts: number; open: number; high: number; low: number; close: number; volume: number;
  }>;
}

interface AggBar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

function aggregateBars(bars1m: AggBar[], tfSeconds: number): AggBar[] {
  if (bars1m.length === 0) return [];
  const result: AggBar[] = [];
  let bucket: AggBar[] = [];
  let bucketStart = 0;

  for (const bar of bars1m) {
    const barBucket = Math.floor(bar.ts / tfSeconds) * tfSeconds;
    if (bucket.length === 0) bucketStart = barBucket;
    if (barBucket !== bucketStart && bucket.length > 0) {
      result.push({
        ts: bucketStart,
        open: bucket[0].open,
        high: Math.max(...bucket.map(b => b.high)),
        low: Math.min(...bucket.map(b => b.low)),
        close: bucket[bucket.length - 1].close,
        volume: bucket.reduce((s, b) => s + b.volume, 0),
      });
      bucket = [];
      bucketStart = barBucket;
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) {
    result.push({
      ts: bucketStart,
      open: bucket[0].open,
      high: Math.max(...bucket.map(b => b.high)),
      low: Math.min(...bucket.map(b => b.low)),
      close: bucket[bucket.length - 1].close,
      volume: bucket.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const allDates = getTradingDays(db);
  let dates: string[];
  if (dateArgs.length === 0) {
    dates = allDates;
  } else if (dateArgs.length === 1) {
    dates = [dateArgs[0]];
  } else {
    const start = allDates.indexOf(dateArgs[0]);
    const end = allDates.indexOf(dateArgs[1]);
    dates = allDates.slice(Math.max(0, start), end + 1);
  }

  const upsert = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'aggregated')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, indicators=excluded.indicators, source='aggregated'
  `);

  const update1mInd = db.prepare(`
    UPDATE replay_bars SET indicators=? WHERE symbol=? AND timeframe='1m' AND ts=?
  `);

  const tfsToProcess = recompute1m ? ['1m' as Timeframe, ...selectedTfs] : selectedTfs;

  console.log(`\nBuilding MTF bars: ${dates.length} dates × ${tfsToProcess.join(', ')}`);
  console.log(`Cross-day continuity: enabled (prior day seeds indicator state)\n`);

  let totalBarsWritten = 0;

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    const priorDate = di > 0 ? dates[di - 1] : (allDates[allDates.indexOf(date) - 1] || null);

    const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const dayEnd = dayStart + 86400 + 3600;

    // Get all symbols for this date
    const symbols = getSymbolsForDate(db, date);

    let dateBars = 0;

    for (const symbol of symbols) {
      const isUnderlying = symbol === 'SPX';
      const tier = isUnderlying ? 2 : 1;

      // Load current day 1m bars
      const bars1m = load1mBars(db, symbol, dayStart, dayEnd);
      if (bars1m.length === 0) continue;

      for (const tf of tfsToProcess) {
        const tfSec = TF_SECONDS[tf];
        if (!tfSec) continue;

        // Aggregate (or use raw 1m)
        const aggBars = tf === '1m' ? bars1m : aggregateBars(bars1m, tfSec);
        if (aggBars.length === 0) continue;

        // Seed indicator state from prior day for continuity
        if (priorDate) {
          const priorStart = Math.floor(new Date(priorDate + 'T00:00:00Z').getTime() / 1000);
          const priorEnd = priorStart + 86400 + 3600;
          const priorBars = load1mBars(db, symbol, priorStart, priorEnd);

          if (priorBars.length > 0) {
            // Aggregate prior day bars to same timeframe
            const priorAgg = tf === '1m' ? priorBars : aggregateBars(priorBars, tfSec);
            // Seed state by feeding prior bars through indicator engine
            seedIndicatorState(symbol, tf as Timeframe, []);
            resetVWAP(symbol, tf as Timeframe);
            for (const pb of priorAgg) {
              computeIndicators({
                symbol, timeframe: tf as Timeframe, ts: pb.ts,
                open: pb.open, high: pb.high, low: pb.low, close: pb.close,
                volume: pb.volume, synthetic: false, gapType: null as any,
              } as any, tier as 1 | 2);
            }
            // State is now seeded — VWAP resets at market open
            resetVWAP(symbol, tf as Timeframe);
          } else {
            seedIndicatorState(symbol, tf as Timeframe, []);
            resetVWAP(symbol, tf as Timeframe);
          }
        } else {
          seedIndicatorState(symbol, tf as Timeframe, []);
          resetVWAP(symbol, tf as Timeframe);
        }

        // Compute indicators on current day bars
        const doWrite = db.transaction((bars: AggBar[]) => {
          for (const b of bars) {
            const ind = computeIndicators({
              symbol, timeframe: tf as Timeframe, ts: b.ts,
              open: b.open, high: b.high, low: b.low, close: b.close,
              volume: b.volume, synthetic: false, gapType: null as any,
            } as any, tier as 1 | 2);

            const indJson = JSON.stringify(ind);

            if (tf === '1m') {
              // Update existing 1m bar indicators
              update1mInd.run(indJson, symbol, b.ts);
            } else {
              // Insert aggregated bar
              upsert.run(symbol, tf, b.ts, b.open, b.high, b.low, b.close, b.volume, indJson);
            }
            dateBars++;
          }
        });
        doWrite(aggBars);
      }
    }

    totalBarsWritten += dateBars;
    console.log(`  ${date}: ${symbols.length} symbols, ${dateBars} bars written`);
  }

  console.log(`\n  TOTAL: ${totalBarsWritten} bars written`);

  // Summary
  const summary = db.prepare(`
    SELECT timeframe, COUNT(*) as cnt, COUNT(DISTINCT symbol) as syms
    FROM replay_bars GROUP BY timeframe ORDER BY timeframe
  `).all() as any[];
  console.log('\n  DB Summary:');
  for (const s of summary) {
    console.log(`    ${s.timeframe}: ${s.cnt} bars (${s.syms} symbols)`);
  }

  db.close();
  console.log('\nDone.');
}

main();
