/**
 * backfill-replay-options.ts — Backfill SPXW option bars from Polygon to replay_bars table ONLY.
 *
 * This script fetches clean options data from Polygon API and writes it to replay_bars,
 * leaving the production bars table untouched. Used for reliable backtesting data.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20           # single date
 *   npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24  # date range
 *
 * Rate limits: Polygon paid plan (no rate limit needed)
 *
 * Strategy:
 *   - Fetch SPX close from existing replay_bars to determine strike range
 *   - Fetch all option contracts within ±100 points of SPX
 *   - 5-point strike intervals (standard SPXW strikes)
 *   - Both calls and puts
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const POLYGON_KEY = process.env.POLYGON_API_KEY!;
const POLYGON_BASE = 'https://api.polygon.io';

if (!POLYGON_KEY) {
  console.error('POLYGON_API_KEY not set in .env');
  process.exit(1);
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

// ── Polygon API ───────────────────────────────────────────────────────────────

async function fetchPolygonBars(ticker: string, date: string): Promise<PolygonBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${ticker}`);
  }

  const data = await res.json() as any;
  if (data.status === 'ERROR') {
    throw new Error(data.error || 'Polygon API error');
  }
  if (!data.results || data.results.length === 0) {
    return [];
  }

  // Filter to RTH only: 9:30 AM - 4:00 PM ET
  const edt = isDST(date);
  const utcOffset = edt ? 4 : 5;
  const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
  const rthStartMs = dayStartMs + (9.5 + utcOffset) * 3600000;
  const rthEndMs = dayStartMs + (16 + utcOffset) * 3600000;

  // Store timestamps in real UTC (Polygon already returns real UTC milliseconds)
  return data.results
    .filter((b: any) => b.t >= rthStartMs && b.t <= rthEndMs)
    .map((b: any) => ({
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      v: b.v || 0,
      vw: b.vw || 0,
      n: b.n || 0,
      t: Math.floor(b.t / 1000),  // Convert ms to seconds, real UTC
    }));
}

// ── Symbol construction ───────────────────────────────────────────────────────

function makePolygonOptionTicker(expiry: string, side: 'C' | 'P', strike: number): string {
  // expiry: "2026-03-19" → "260319"
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  const strikeStr = (strike * 1000).toString().padStart(8, '0');
  return `O:SPXW${yy}${mm}${dd}${side}${strikeStr}`;
}

function makeDbSymbol(expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  const strikeStr = (strike * 1000).toString().padStart(8, '0');
  return `SPXW${yy}${mm}${dd}${side}${strikeStr}`;
}

// ── SPX range detection ───────────────────────────────────────────────────────

function getSpxRangeForDate(db: Database.Database, date: string): SpxRange | null {
  // Query window in real UTC: 9:30 ET → 16:00 ET
  const edt = isDST(date);
  const utcOffset = edt ? 4 : 5;
  const dayStartTs = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) + (9.5 + utcOffset) * 3600;
  const dayEndTs = dayStartTs + 390 * 60;  // 6.5 hours

  const row = db.prepare(`
    SELECT ts, close
    FROM replay_bars
    WHERE symbol = 'SPX' AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
    ORDER BY ts DESC
    LIMIT 1
  `).get(dayStartTs, dayEndTs) as { ts: number; close: number } | undefined;

  if (!row) {
    return null;
  }

  const close = row.close;
  // Round to nearest 5
  const baseStrike = Math.round(close / 5) * 5;

  return {
    date,
    close,
    minStrike: baseStrike - 100,
    maxStrike: baseStrike + 100,
  };
}

// ── Main backfill logic ───────────────────────────────────────────────────────

async function backfillDate(
  db: Database.Database,
  date: string,
  spxRange: SpxRange,
): Promise<{ fetched: number; withData: number; totalBars: number; errors: string[] }> {
  const strikes: number[] = [];
  for (let s = spxRange.minStrike; s <= spxRange.maxStrike; s += 5) {
    strikes.push(s);
  }

  const sides: Array<'C' | 'P'> = ['C', 'P'];
  let totalBars = 0;
  let fetched = 0;
  let withData = 0;
  const errors: string[] = [];

  // Prepare upsert statement
  const upsert = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', 'polygon')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, synthetic=0,
      gap_type=NULL, indicators='{}', source='polygon'
  `);

  // Check what we already have
  const alreadyHave = db.prepare(`
    SELECT COUNT(*) as cnt FROM replay_bars
    WHERE symbol = ? AND timeframe = '1m' AND source = 'polygon'
  `);

  const dayStartTs = Math.floor(new Date(date + 'T09:30:00').getTime() / 1000);

  for (const side of sides) {
    for (const strike of strikes) {
      const polygonTicker = makePolygonOptionTicker(date, side, strike);
      const dbSymbol = makeDbSymbol(date, side, strike);

      // Check if we already have Polygon data for this contract
      const existing = alreadyHave.get(dbSymbol) as any;
      if (existing && existing.cnt > 50) {
        process.stdout.write('.');
        continue;
      }

      fetched++;

      try {
        const bars = await fetchPolygonBars(polygonTicker, date);

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
        const msg = `${polygonTicker}: ${e.message}`;
        errors.push(msg);
        process.stdout.write('!');
      }
    }
  }

  return { fetched, withData, totalBars, errors };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(`
Usage:
  npx tsx scripts/backfill/backfill-replay-options.ts <date>
  npx tsx scripts/backfill/backfill-replay-options.ts <start-date> <end-date>

Example:
  npx tsx scripts/backfill/backfill-replay-options.ts 2026-03-20
  npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24
    `);
    process.exit(1);
  }

  const startDate = args[0];
  const endDate = args[1] || startDate;
  const dates = getTradingDays(startDate, endDate);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Polygon Options Backfill to replay_bars`);
  console.log(`  ${dates.length} trading days: ${startDate} → ${endDate}`);
  console.log(`${'═'.repeat(70)}\n`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  let totalFetched = 0;
  let totalWithData = 0;
  let totalBars = 0;
  const allErrors: string[] = [];

  for (const date of dates) {
    // Get SPX range for this date
    const spxRange = getSpxRangeForDate(db, date);

    if (!spxRange) {
      console.log(`  ${date}: ⚠️  No SPX data in replay_bars, skipping`);
      continue;
    }

    console.log(`  ${date}: SPX=${spxRange.close.toFixed(2)} strikes=${spxRange.minStrike}-${spxRange.maxStrike}`);

    const result = await backfillDate(db, date, spxRange);

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
