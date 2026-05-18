/**
 * backfill-replay-options.ts — Backfill option bars DIRECTLY to parquet.
 *
 * Parquet is the single source of truth (SPXer is research/backtest only;
 * live trading is OptionX's job). No SQLite. Per (profile,date) we write one
 * file: data/parquet/bars/{profileId}/{date}.parquet containing the underlying
 * bars (carried over from the 0DTE parquet) + the fetched option contracts.
 *
 * Options source: Polygon aggregates (Retry-After + exponential backoff on
 * 429; no 50k-row truncation). ThetaData was removed 2026-05-17 — it was
 * SPX-only and carried no field the sweeps consume. 1DTE profiles fetch the
 * next-trading-day expiry.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20                     # SPX single
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24          # range
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20 --profile=qqq-1dte  # 1DTE
 *   ... --force   # overwrite existing parquet days (default: skip days already written)
 *
 * Profiles: spx-0dte (default), ndx-0dte, spy-1dte, qqq-1dte.
 * Prereq: the underlying 0DTE parquet must exist for each date (it carries the
 * underlying bar series + sets the strike band).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import * as path from 'path';
import * as fs from 'fs';
import * as duckdb from 'duckdb';
import { writeDayParquet, EXPORT_COLUMNS, type BarRow } from '../../src/storage/parquet-writer';

const PARQUET_ROOT = path.resolve(__dirname, '../../data/parquet/bars');

function duckAll(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((res, rej) => db.all(sql, (e: Error | null, r: any[]) => e ? rej(e) : res(r)));
}

// ── Profile resolution ────────────────────────────────────────────────────────

interface BackfillTarget {
  profileId: string;            // output parquet partition dir
  prefix: string;
  underlyingDbSymbol: string;
  strikeInterval: number;
  bandHalfWidthDollars: number;
  dte: number;                  // 0 = same-day expiry, 1 = next trading day
  underlyingParquetDir: string; // 0DTE parquet dir carrying the underlying series
}

function resolveTarget(profileId: string | undefined): BackfillTarget {
  switch (profileId) {
    case 'ndx-0dte':
      return { profileId: 'ndx-0dte', prefix: 'NDXP', underlyingDbSymbol: 'NDX', strikeInterval: 10, bandHalfWidthDollars: 500, dte: 0, underlyingParquetDir: 'ndx' };
    case 'spy-1dte':
      return { profileId: 'spy-1dte', prefix: 'SPY', underlyingDbSymbol: 'SPY', strikeInterval: 1, bandHalfWidthDollars: 10, dte: 1, underlyingParquetDir: 'spy' };
    case 'qqq-1dte':
      return { profileId: 'qqq-1dte', prefix: 'QQQ', underlyingDbSymbol: 'QQQ', strikeInterval: 1, bandHalfWidthDollars: 10, dte: 1, underlyingParquetDir: 'qqq' };
    case 'spx-0dte':
    case undefined:
      return { profileId: 'spx-0dte', prefix: 'SPXW', underlyingDbSymbol: 'SPX', strikeInterval: 5, bandHalfWidthDollars: 100, dte: 0, underlyingParquetDir: 'spx' };
    default:
      throw new Error(`Unknown profile id: ${profileId}. Expected one of: spx-0dte, ndx-0dte, spy-1dte, qqq-1dte.`);
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolygonBar {
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

// ── Polygon option fetch (RTH-filtered) ───────────────────────────────────────

/**
 * Fetch 1m option OHLC from Polygon for an OCC dbSymbol (e.g.
 * "SPY260507C00733000" → "O:SPY260507C00733000"). RTH-filtered, ms→sec.
 */
function sleepMs(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

async function fetchPolygonOptionBars(dbSymbol: string, date: string): Promise<PolygonBar[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY not set');
  const ticker = `O:${dbSymbol}`;
  const url = `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`;

  // 429-aware: Polygon rate-limits hard. Honor Retry-After, exponential backoff.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30000),
    });
    if (res.status !== 429) break;
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt);
    await sleepMs(waitMs);
  }
  if (!res) throw new Error('Polygon: no response');
  if (res.status === 429) throw new Error('Polygon 429 after retries');
  const data: any = await res.json();
  if (data.status === 'NOT_AUTHORIZED') throw new Error(`Polygon not authorized for ${ticker}`);
  if (data.status === 'ERROR') throw new Error(data.error || 'Polygon error');
  const results: any[] = data.results || [];
  if (results.length === 0) return [];

  const edt = isDST(date);
  const utcOffset = edt ? 4 : 5;
  const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
  const rthStartSec = Math.floor((dayStartMs + (9.5 + utcOffset) * 3600_000) / 1000);
  const rthEndSec = Math.floor((dayStartMs + (16 + utcOffset) * 3600_000) / 1000);

  return results
    .map((b) => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0, vw: b.vw || 0, n: b.n || 0, t: Math.floor(b.t / 1000) }))
    .filter((b) => b.t >= rthStartSec && b.t <= rthEndSec);
}

/**
 * Fetch 1m option bars from Polygon. Kept as a thin wrapper (name + return
 * shape unchanged) so callers stay untouched after the ThetaData removal.
 */
export async function fetchOptionBarsWithFallback(dbSymbol: string, date: string): Promise<{ bars: PolygonBar[]; src: 'polygon' }> {
  const pbars = await fetchPolygonOptionBars(dbSymbol, date);
  return { bars: pbars, src: 'polygon' };
}

// ── Symbol construction ───────────────────────────────────────────────────────

function makeDbSymbol(prefix: string, expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  const strikeStr = (strike * 1000).toString().padStart(8, '0');
  return `${prefix}${yy}${mm}${dd}${side}${strikeStr}`;
}

/**
 * Resolve the option expiry for a trade date + DTE. Weekend-aware (skips
 * Sat/Sun). Holidays aren't modeled — a holiday expiry just yields no
 * Polygon data (skipped), acceptable for a backfill.
 */
export function expiryForDate(date: string, dte: number): string {
  if (dte <= 0) return date;
  const dt = new Date(date + 'T12:00:00Z');
  let added = 0;
  while (added < dte) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const dow = dt.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return dt.toISOString().slice(0, 10);
}

// ── Underlying from 0DTE parquet (sets strike band + carried into the file) ────

interface UnderlyingDay {
  range: SpxRange;
  rows: BarRow[];  // underlying bars, all EXPORT_COLUMNS, carried verbatim
}

/**
 * Read the underlying series for `date` from the 0DTE parquet. Returns the
 * strike band (last RTH close ± bandHalfWidth) AND the underlying rows so they
 * can be carried into the new {profileId}/{date}.parquet (sweeps/replay need
 * symbol == underlyingSymbol present alongside the contracts).
 */
async function getUnderlyingDay(date: string, target: BackfillTarget): Promise<UnderlyingDay | null> {
  const fp = path.join(PARQUET_ROOT, target.underlyingParquetDir, `${date}.parquet`);
  if (!fs.existsSync(fp)) return null;

  const colSel = EXPORT_COLUMNS.map(c =>
    (c === 'ts' || c === 'volume' || c === 'synthetic') ? `CAST(${c} AS VARCHAR) AS ${c}` : c
  ).join(', ');
  const duck = new duckdb.Database(':memory:');
  try {
    const rows = await duckAll(duck,
      `SELECT ${colSel} FROM read_parquet('${fp}')
       WHERE symbol = '${target.underlyingDbSymbol}' ORDER BY timeframe, ts`);
    if (!rows.length) return null;

    // Strike band from the last RTH 1m close.
    const edt = isDST(date);
    const utcOffset = edt ? 4 : 5;
    const dayStartTs = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) + (9.5 + utcOffset) * 3600;
    const dayEndTs = dayStartTs + 390 * 60;
    let close: number | null = null;
    for (const r of rows) {
      if (r.timeframe !== '1m') continue;
      const ts = Number(r.ts);
      if (ts >= dayStartTs && ts <= dayEndTs) close = Number(r.close);
    }
    if (close == null) close = Number(rows[rows.length - 1].close);

    const baseStrike = Math.round(close / target.strikeInterval) * target.strikeInterval;
    return {
      range: {
        date, close,
        minStrike: baseStrike - target.bandHalfWidthDollars,
        maxStrike: baseStrike + target.bandHalfWidthDollars,
      },
      rows: rows as BarRow[],
    };
  } finally {
    await new Promise<void>(res => duck.close(() => res()));
  }
}

// ── Main backfill logic ───────────────────────────────────────────────────────

function optionRow(dbSymbol: string, bar: PolygonBar, src: string): BarRow {
  return {
    symbol: dbSymbol, timeframe: '1m', ts: bar.t,
    open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v,
    synthetic: 0, gap_type: null, indicators: '{}', source: src,
  };
}

async function backfillDate(
  date: string,
  under: UnderlyingDay,
  target: BackfillTarget,
): Promise<{ fetched: number; withData: number; totalBars: number; errors: string[] }> {
  const spxRange = under.range;
  const strikes: number[] = [];
  for (let s = spxRange.minStrike; s <= spxRange.maxStrike; s += target.strikeInterval) {
    strikes.push(s);
  }

  const sides: Array<'C' | 'P'> = ['C', 'P'];
  let totalBars = 0;
  let fetched = 0;
  let withData = 0;
  const errors: string[] = [];

  // Accumulate the whole day in memory → one atomic parquet write.
  // Seed with the underlying bars carried from the 0DTE parquet.
  const dayRows: BarRow[] = [...under.rows];

  // 1DTE: contract expires the next trading day, but bars are fetched for
  // the trade `date`. 0DTE: expiry == date.
  const expiry = expiryForDate(date, target.dte);

  for (const side of sides) {
    for (const strike of strikes) {
      const dbSymbol = makeDbSymbol(target.prefix, expiry, side, strike);
      fetched++;

      try {
        const { bars, src } = await fetchOptionBarsWithFallback(dbSymbol, date);

        if (bars.length === 0) {
          process.stdout.write('_');
          continue;
        }

        withData++;
        for (const bar of bars) dayRows.push(optionRow(dbSymbol, bar, src));

        totalBars += bars.length;
        void src; // always 'polygon' since the ThetaData removal
        process.stdout.write('✓');
      } catch (e: any) {
        const msg = `${dbSymbol}: ${e.message}`;
        errors.push(msg);
        process.stdout.write('!');
      }
    }
  }

  // One atomic parquet write for the whole day (underlying + contracts).
  if (totalBars > 0) {
    await writeDayParquet({ profileId: target.profileId, date, rows: dayRows });
  } else {
    process.stdout.write(' (no option data — parquet not written)');
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

  const force = flags.includes('--force');

  if (positional.length < 1) {
    console.error(`
Usage:
  npx tsx scripts/backfill/backfill-replay-options.ts <date> [--profile=spx-0dte|ndx-0dte|spy-1dte|qqq-1dte] [--force]
  npx tsx scripts/backfill/backfill-replay-options.ts <start-date> <end-date> [--profile=<id>] [--force]

Writes data/parquet/bars/{profileId}/{date}.parquet directly (no SQLite).
Days with an existing parquet file are skipped unless --force.
Prereq: the underlying 0DTE parquet (data/parquet/bars/{spx|spy|qqq|ndx}/)
must exist for each target date — it carries the underlying series + band.
    `);
    process.exit(1);
  }

  const target = resolveTarget(profileFlag);

  const startDate = positional[0];
  const endDate = positional[1] || startDate;
  const dates = getTradingDays(startDate, endDate);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Options Backfill → parquet (Polygon)`);
  console.log(`  Profile: ${target.profileId} (${target.prefix} opts, ${target.underlyingDbSymbol} underlying${target.dte ? `, ${target.dte}DTE` : ''})`);
  console.log(`  ${dates.length} trading days: ${startDate} → ${endDate}${force ? '  [--force]' : ''}`);
  console.log(`${'═'.repeat(70)}\n`);

  let totalFetched = 0;
  let totalWithData = 0;
  let totalBars = 0;
  const allErrors: string[] = [];

  for (const date of dates) {
    const outPath = path.join(PARQUET_ROOT, target.profileId, `${date}.parquet`);
    if (!force && fs.existsSync(outPath)) {
      console.log(`  ${date}: parquet exists — skip (use --force to overwrite)`);
      continue;
    }

    const under = await getUnderlyingDay(date, target);
    if (!under) {
      console.log(`  ${date}: ⚠️  no ${target.underlyingDbSymbol} 0DTE parquet (${target.underlyingParquetDir}) — skip`);
      continue;
    }

    console.log(`  ${date}: ${target.underlyingDbSymbol}=${under.range.close.toFixed(2)} strikes=${under.range.minStrike}-${under.range.maxStrike} step ${target.strikeInterval}`);

    const result = await backfillDate(date, under, target);

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
}

// Only run as a CLI — importing the exported helpers must NOT trigger a backfill.
if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
