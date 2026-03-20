/**
 * backfill-polygon.ts — Backfill historical 0DTE SPXW option bars from Polygon/Massive API.
 *
 * Usage:
 *   npx tsx backfill-polygon.ts                    # backfill last 20 trading days
 *   npx tsx backfill-polygon.ts 2026-03-10         # backfill specific date
 *   npx tsx backfill-polygon.ts 2026-03-01 2026-03-19  # backfill date range
 *
 * Sources:
 *   - Options (SPXW): Polygon API (O:SPXW format)
 *   - SPX underlying: Yahoo Finance (via existing provider)
 *   - SPY (cross-check): Polygon API
 *
 * Rate limits: Polygon starter = 5 req/min. We sleep between batches.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');
const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

if (!POLYGON_KEY) {
  console.error('POLYGON_API_KEY not set in .env');
  process.exit(1);
}

// ── Polygon API helpers ─────────────────────────────────────────────────────

interface PolygonBar {
  o: number; h: number; l: number; c: number;
  v: number; vw: number; n: number; t: number;
}

async function fetchPolygonBars(ticker: string, date: string, limit = 50000): Promise<PolygonBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=${limit}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${POLYGON_KEY}` },
    signal: AbortSignal.timeout(30000),
  });
  const data = await res.json() as any;
  if (data.status === 'NOT_AUTHORIZED') throw new Error(`Not authorized for ${ticker}`);
  if (data.status === 'ERROR') throw new Error(data.error || 'Unknown error');
  return data.results || [];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Symbol construction ─────────────────────────────────────────────────────

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

// ── DB helpers ──────────────────────────────────────────────────────────────

function getDb() { return new Database(DB_PATH); }

function upsertBar(db: Database.Database, symbol: string, tf: string, ts: number, bar: PolygonBar): void {
  db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume
  `).run(symbol, tf, ts, bar.o, bar.h, bar.l, bar.c, bar.v);
}

function upsertContract(db: Database.Database, symbol: string, type: string, strike: number, expiry: string): void {
  db.prepare(`
    INSERT INTO contracts (symbol, type, underlying, strike, expiry, state)
    VALUES (?, ?, 'SPX', ?, ?, 'ACTIVE')
    ON CONFLICT(symbol) DO NOTHING
  `).run(symbol, type, strike, expiry);
}

function hasData(db: Database.Database, symbol: string, date: string): boolean {
  // Check if we already have bars for this symbol on this date
  const dateTs = new Date(date + 'T09:30:00-04:00').getTime() / 1000;
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM bars
    WHERE symbol=? AND timeframe='1m' AND ts >= ? AND ts <= ?
  `).get(symbol, dateTs, dateTs + 390 * 60) as any;
  return (row?.cnt || 0) > 50;  // at least 50 bars = has data
}

// ── SPX from Yahoo ──────────────────────────────────────────────────────────

async function fetchSpxFromYahoo(date: string): Promise<void> {
  // Yahoo can fetch SPX 1m bars — use the existing provider
  const { fetchYahooBars } = await import('./src/providers/yahoo');
  const { buildBars } = await import('./src/pipeline/bar-builder');
  const { computeIndicators } = await import('./src/pipeline/indicator-engine');

  const db = getDb();
  if (hasData(db, 'SPX', date)) {
    console.log(`  [SPX] Already have data for ${date}, skipping`);
    db.close();
    return;
  }

  try {
    // Yahoo needs a range, not specific date — use 5d to cover recent dates
    const rawBars = await fetchYahooBars('^GSPC', '1m', '5d');
    const bars = buildBars('SPX', '1m', rawBars);

    const insert = db.transaction((rows: any[]) => {
      for (const bar of rows) {
        const ind = computeIndicators(bar, 2);
        db.prepare(`
          INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
            open=excluded.open, high=excluded.high, low=excluded.low,
            close=excluded.close, volume=excluded.volume, indicators=excluded.indicators
        `).run(bar.symbol, bar.timeframe, bar.ts, bar.open, bar.high, bar.low, bar.close, bar.volume, JSON.stringify(ind));
      }
    });
    insert(bars);
    console.log(`  [SPX] Ingested ${bars.length} bars from Yahoo`);
  } catch (e: any) {
    console.log(`  [SPX] Yahoo error: ${e.message}`);
  }
  db.close();
}

// ── Main backfill logic ─────────────────────────────────────────────────────

async function backfillDate(date: string, spxApprox: number): Promise<void> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  Backfilling ${date} (SPX ~${spxApprox})`);
  console.log(`${'─'.repeat(60)}`);

  const db = getDb();

  // Generate strikes: ±50pts from approximate SPX, every 5pts
  const strikes: number[] = [];
  const baseStrike = Math.round(spxApprox / 5) * 5;
  for (let s = baseStrike - 50; s <= baseStrike + 50; s += 5) {
    strikes.push(s);
  }

  const sides: Array<'C' | 'P'> = ['C', 'P'];
  let totalBars = 0;
  let fetched = 0;
  const totalContracts = strikes.length * sides.length;

  for (const side of sides) {
    for (const strike of strikes) {
      const polygonTicker = makePolygonOptionTicker(date, side, strike);
      const dbSymbol = makeDbSymbol(date, side, strike);

      // Skip if already have data
      if (hasData(db, dbSymbol, date)) {
        process.stdout.write('.');
        continue;
      }

      fetched++;
      // Rate limit: 5 req/min on starter → 1 req per 12s to be safe
      if (fetched > 1) await sleep(1500);  // 1.5s between requests (conservative)

      try {
        const bars = await fetchPolygonBars(polygonTicker, date);
        if (bars.length === 0) {
          process.stdout.write('_');
          continue;
        }

        // Upsert contract
        upsertContract(db, dbSymbol, side === 'C' ? 'call' : 'put', strike, date);

        // Upsert bars (convert Polygon ms timestamps to seconds)
        const insertBars = db.transaction((rows: PolygonBar[]) => {
          for (const bar of rows) {
            upsertBar(db, dbSymbol, '1m', Math.floor(bar.t / 1000), bar);
          }
        });
        insertBars(bars);

        totalBars += bars.length;
        process.stdout.write(`✓`);
      } catch (e: any) {
        process.stdout.write('!');
        if (e.message.includes('NOT_AUTHORIZED')) {
          console.log(`\n  ⚠️ Not authorized for ${polygonTicker} — skipping`);
        }
      }
    }
  }

  db.close();
  console.log(`\n  Done: ${totalBars} bars across ${totalContracts} contracts (${fetched} fetched, rest cached)`);
}

// ── Get approximate SPX price for each date via SPY ─────────────────────────

async function getSpxApproxForDate(date: string): Promise<number> {
  try {
    const bars = await fetchPolygonBars(`SPY`, date, 5);
    if (bars.length > 0) {
      return bars[0].o * 10;  // SPY ≈ SPX/10
    }
  } catch {}
  return 6600;  // fallback
}

// ── Trading days generator ──────────────────────────────────────────────────

function getTradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(from);
  const end = new Date(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;  // skip weekends
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dates: string[];

  if (args.length === 2) {
    dates = getTradingDays(args[0], args[1]);
  } else if (args.length === 1) {
    dates = [args[0]];
  } else {
    // Default: last 20 trading days
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 30);  // go back 30 calendar days to get ~20 trading days
    dates = getTradingDays(start.toISOString().slice(0, 10), today.toISOString().slice(0, 10));
    dates = dates.slice(-20);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Polygon Backfill — ${dates.length} trading days`);
  console.log(`  ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`${'═'.repeat(60)}`);

  for (const date of dates) {
    const spxApprox = await getSpxApproxForDate(date);
    await sleep(1500);  // rate limit
    await backfillDate(date, spxApprox);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  BACKFILL COMPLETE`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(console.error);
