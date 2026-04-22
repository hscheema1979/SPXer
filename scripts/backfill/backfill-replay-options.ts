/**
 * backfill-replay-options.ts — Backfill option bars from ThetaData to replay_bars table ONLY.
 *
 * This script fetches clean options data from the local ThetaTerminal (OPRA feed)
 * and writes it to replay_bars, leaving the production bars table untouched.
 * ThetaData replaces Polygon for options because Polygon's volume/trade detail
 * was incomplete for SPXW 0DTE contracts.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20                     # SPX single date
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24          # SPX range
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20 --profile=ndx-0dte  # NDX single
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20 2026-04-17 --profile=ndx-0dte
 *
 * Profiles supported: spx-0dte (default), ndx-0dte, spy-1dte, qqq-1dte.
 * The underlying bars (SPX, NDX, SPY, QQQ) must already be in replay_bars —
 * run scripts/backfill/backfill-worker.ts first for that.
 *
 * Strategy:
 *   - Read the profile to resolve {prefix, underlyingDbSymbol, strikeInterval, bandHalfWidth}
 *   - Fetch underlying close from existing replay_bars to determine strike range
 *   - Fetch all option contracts within ±band of the underlying close
 *   - Use profile's strike interval (5 SPXW, 10 NDXP, 1 SPY/QQQ)
 *   - Both calls and puts
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { fetchOptionTimesales } from '../../src/providers/thetadata';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');

// ── Profile resolution ────────────────────────────────────────────────────────

interface BackfillTarget {
  profileId: string;
  prefix: string;
  underlyingDbSymbol: string;
  strikeInterval: number;
  bandHalfWidthDollars: number;
}

function resolveTarget(profileId: string | undefined): BackfillTarget {
  switch (profileId) {
    case 'ndx-0dte':
      return { profileId: 'ndx-0dte', prefix: 'NDXP', underlyingDbSymbol: 'NDX', strikeInterval: 10, bandHalfWidthDollars: 500 };
    case 'spy-1dte':
      return { profileId: 'spy-1dte', prefix: 'SPY', underlyingDbSymbol: 'SPY', strikeInterval: 1, bandHalfWidthDollars: 10 };
    case 'qqq-1dte':
      return { profileId: 'qqq-1dte', prefix: 'QQQ', underlyingDbSymbol: 'QQQ', strikeInterval: 1, bandHalfWidthDollars: 10 };
    case 'spx-0dte':
    case undefined:
      return { profileId: 'spx-0dte', prefix: 'SPXW', underlyingDbSymbol: 'SPX', strikeInterval: 5, bandHalfWidthDollars: 100 };
    default:
      throw new Error(`Unknown profile id: ${profileId}. Expected one of: spx-0dte, ndx-0dte, spy-1dte, qqq-1dte.`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PolygonBar {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number;
  n: number;
  t: number;
}

interface SpxRange {
  date: string;
  close: number;
  minStrike: number;
  maxStrike: number;
}

// ── DST handling ───────────────────────────────────────────────────────────────

function isDST(date: string): boolean {
  // DST 2026 starts Mar 8, ends Nov 1
  const d = new Date(date + 'T12:00:00Z');
  const month = d.getMonth();
  const day = d.getDate();
  if (month < 2 || month > 10) return false;  // Jan, Feb, Dec = EST
  if (month > 2 && month < 10) return true;   // Apr-Oct = EDT
  if (month === 2) return day >= 8;            // Mar 8+ = EDT
  return day < 1;                               // Nov 1+ = EST
}

// ── Trading days ───────────────────────────────────────────────────────────────

function getTradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// ── ThetaData option fetch (RTH-filtered) ────────────────────────────────────

/**
 * Fetch 1m option OHLC bars from ThetaData, RTH-filtered, shaped like the
 * original Polygon bar output so the rest of this script is unchanged.
 */
async function fetchThetaBars(dbSymbol: string, date: string): Promise<PolygonBar[]> {
  const raws = await fetchOptionTimesales(dbSymbol, date);
  if (raws.length === 0) return [];

  // Filter to RTH only: 9:30 AM - 4:00 PM ET
  const edt = isDST(date);
  const utcOffset = edt ? 4 : 5;
  const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
  const rthStartSec = Math.floor((dayStartMs + (9.5 + utcOffset) * 3600_000) / 1000);
  const rthEndSec = Math.floor((dayStartMs + (16 + utcOffset) * 3600_000) / 1000);

  return raws
    .filter((b) => b.ts >= rthStartSec && b.ts <= rthEndSec)
    .map((b) => ({
      o: b.open,
      h: b.high,
      l: b.low,
      c: b.close,
      v: b.volume || 0,
      vw: 0,
      n: 0,
      t: b.ts,
    }));
}

// ── Symbol construction ───────────────────────────────────────────────────────

function makeDbSymbol(prefix: string, expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  const strikeStr = (strike * 1000).toString().padStart(8, '0');
  return `${prefix}${yy}${mm}${dd}${side}${strikeStr}`;
}

// ── SPX range detection ───────────────────────────────────────────────────────

function getSpxRangeForDate(db: Database.Database, date: string, target: BackfillTarget): SpxRange | null {
  // Query window in real UTC: 9:30 ET → 16:00 ET
  const edt = isDST(date);
  const utcOffset = edt ? 4 : 5;
  const dayStartTs = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) + (9.5 + utcOffset) * 3600;
  const dayEndTs = dayStartTs + 390 * 60;  // 6.5 hours

  const row = db.prepare(`
    SELECT ts, close
    FROM replay_bars
    WHERE symbol = ? AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(target.underlyingDbSymbol, dayStartTs, dayEndTs) as { ts: number; close: number } | undefined;

  if (!row) {
    return null;
  }

  const close = row.close;
  // Round to nearest strike interval for this profile
  const baseStrike = Math.round(close / target.strikeInterval) * target.strikeInterval;

  return {
    date,
    close,
    minStrike: baseStrike - target.bandHalfWidthDollars,
    maxStrike: baseStrike + target.bandHalfWidthDollars,
  };
}

// ── Main backfill logic ───────────────────────────────────────────────────────

async function backfillDate(
  db: Database.Database,
  date: string,
  spxRange: SpxRange,
  target: BackfillTarget,
): Promise<{ fetched: number; withData: number; totalBars: number; errors: string[] }> {
  const strikes: number[] = [];
  for (let s = spxRange.minStrike; s <= spxRange.maxStrike; s += target.strikeInterval) {
    strikes.push(s);
  }

  const sides: Array<'C' | 'P'> = ['C', 'P'];
  let totalBars = 0;
  let fetched = 0;
  let withData = 0;
  const errors: string[] = [];

  // Prepare upsert statement — options come from ThetaData (OPRA feed)
  const upsert = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', 'thetadata')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, synthetic=0,
      gap_type=NULL, indicators='{}', source='thetadata'
  `);

  // Check what we already have (ThetaData-sourced)
  const alreadyHave = db.prepare(`
    SELECT COUNT(*) as cnt FROM replay_bars
    WHERE symbol = ? AND timeframe = '1m' AND source = 'thetadata'
  `);

  for (const side of sides) {
    for (const strike of strikes) {
      const dbSymbol = makeDbSymbol(target.prefix, date, side, strike);

      // Check if we already have ThetaData for this contract
      const existing = alreadyHave.get(dbSymbol) as any;
      if (existing && existing.cnt > 50) {
        process.stdout.write('.');
        continue;
      }

      fetched++;

      try {
        const bars = await fetchThetaBars(dbSymbol, date);

        if (bars.length === 0) {
          process.stdout.write('_');
          continue;
        }

        withData++;

        // Insert bars in transaction
        const insert = db.transaction((rows: PolygonBar[]) => {
          for (const bar of rows) {
            upsert.run(dbSymbol, bar.t, bar.o, bar.h, bar.l, bar.c, bar.v);
          }
        });
        insert(bars);

        totalBars += bars.length;
        process.stdout.write('✓');
      } catch (e: any) {
        const msg = `${dbSymbol}: ${e.message}`;
        errors.push(msg);
        process.stdout.write('!');
      }
    }
  }

  return { fetched, withData, totalBars, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const rawArgs = process.argv.slice(2);
  // Split positional dates from --flags
  const positional = rawArgs.filter((a) => !a.startsWith('--'));
  const flags = rawArgs.filter((a) => a.startsWith('--'));
  const profileFlag = flags.find((f) => f.startsWith('--profile='))?.slice('--profile='.length);

  if (positional.length < 1) {
    console.error(`
Usage:
  npx tsx scripts/backfill/backfill-replay-options.ts <date> [--profile=spx-0dte|ndx-0dte|spy-1dte|qqq-1dte]
  npx tsx scripts/backfill/backfill-replay-options.ts <start-date> <end-date> [--profile=<id>]

Examples:
  npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20
  npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24
  npx tsx scripts/backfill/backfill-replay-options.ts 2026-04-17 --profile=ndx-0dte

Prereq: the underlying bars (SPX/NDX/SPY/QQQ) must already be in replay_bars
for each target date. Run backfill-worker.ts first (it fetches from Polygon).
    `);
    process.exit(1);
  }

  const target = resolveTarget(profileFlag);

  const startDate = positional[0];
  const endDate = positional[1] || startDate;
  const dates = getTradingDays(startDate, endDate);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ThetaData Options Backfill to replay_bars`);
  console.log(`  Profile: ${target.profileId} (${target.prefix} options, ${target.underlyingDbSymbol} underlying)`);
  console.log(`  ${dates.length} trading days: ${startDate} → ${endDate}`);
  console.log(`${'═'.repeat(70)}\n`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  let totalFetched = 0;
  let totalWithData = 0;
  let totalBars = 0;
  const allErrors: string[] = [];

  for (const date of dates) {
    // Get underlying range for this date
    const spxRange = getSpxRangeForDate(db, date, target);

    if (!spxRange) {
      console.log(`  ${date}: ⚠️  No ${target.underlyingDbSymbol} data in replay_bars, skipping`);
      continue;
    }

    console.log(`  ${date}: ${target.underlyingDbSymbol}=${spxRange.close.toFixed(2)} strikes=${spxRange.minStrike}-${spxRange.maxStrike} step ${target.strikeInterval}`);

    const result = await backfillDate(db, date, spxRange, target);

    totalFetched += result.fetched;
    totalWithData += result.withData;
    totalBars += result.totalBars;
    allErrors.push(...result.errors);

    console.log(
      `    → ${result.fetched} fetched, ${result.withData} with data, ${result.totalBars} bars${
        result.errors.length > 0 ? `, ${result.errors.length} errors` : ''
      }`
    );

    if (result.errors.length > 0) {
      for (const err of result.errors.slice(0, 3)) {
        console.log(`      ! ${err}`);
      }
      if (result.errors.length > 3) {
        console.log(`      ... and ${result.errors.length - 3} more errors`);
      }
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SUMMARY`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Dates processed:    ${dates.length}`);
  console.log(`  Contracts fetched:  ${totalFetched}`);
  console.log(`  Contracts with data: ${totalWithData}`);
  console.log(`  Total bars inserted: ${totalBars}`);
  if (allErrors.length > 0) {
    console.log(`  Total errors:        ${allErrors.length}`);
  }
  console.log(`${'═'.repeat(70)}\n`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
