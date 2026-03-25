/**
 * Force-fetch SPX 1m bars from Tradier (or Polygon SPY×10 for old dates).
 * Overwrites existing bars. Resets indicators so they get recomputed.
 *
 * Usage: npx tsx scripts/backfill/backfill-spx-force.ts 2026-02-20 2026-03-24
 */
import * as dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const TOKEN = process.env.TRADIER_TOKEN!;
const POLYGON_KEY = process.env.POLYGON_API_KEY!;

function getTradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(from);
  const end = new Date(to);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

async function fetchTradier(date: string): Promise<Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> | null> {
  const url = `https://api.tradier.com/v1/markets/timesales?symbol=SPX&interval=1min&start=${date}T09:30&end=${date}T16:00&session_filter=open`;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      timeout: 15000,
    });
    const series = data?.series?.data;
    if (!series || !Array.isArray(series)) return null;
    return series.map((d: any) => ({
      ts: Math.floor(new Date(d.time).getTime() / 1000),
      o: d.open, h: d.high, l: d.low, c: d.close, v: d.volume ?? 0,
    }));
  } catch {
    return null;
  }
}

async function fetchPolygonSpy(date: string): Promise<Array<{ ts: number; o: number; h: number; l: number; c: number; v: number }> | null> {
  try {
    const res = await fetch(
      `https://api.polygon.io/v2/aggs/ticker/SPY/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`,
      { headers: { Authorization: `Bearer ${POLYGON_KEY}` }, signal: AbortSignal.timeout(30000) },
    );
    const data = await res.json() as any;
    if (!data.results) return null;

    // Feb 2026 is EST (UTC-5), Mar 8+ is EDT (UTC-4). Determine offset.
    const dateObj = new Date(date + 'T12:00:00Z');
    const isEDT = dateObj.getMonth() >= 2 && dateObj.getDate() >= 8; // rough DST check for 2026
    const utcOffset = isEDT ? 4 : 5;
    const rthStartHourUTC = 9 + utcOffset + 0.5; // 9:30 ET in UTC hours
    const rthEndHourUTC = 16 + utcOffset;         // 16:00 ET in UTC hours

    const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
    const rthStartMs = dayStartMs + rthStartHourUTC * 3600000;
    const rthEndMs = dayStartMs + rthEndHourUTC * 3600000;

    return data.results
      .filter((b: any) => b.t >= rthStartMs && b.t <= rthEndMs)
      .map((b: any) => ({
        ts: Math.floor(b.t / 1000),
        o: b.o * 10, h: b.h * 10, l: b.l * 10, c: b.c * 10, v: b.v,
      }));
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || '2026-02-20';
  const endDate = args[1] || '2026-03-24';
  const dates = getTradingDays(startDate, endDate);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const upsert = db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
    VALUES ('SPX', '1m', ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, indicators='{}'
  `);

  console.log(`\nBackfilling SPX 1m bars: ${dates.length} days (${startDate} → ${endDate})\n`);

  for (const date of dates) {
    // Try Tradier first
    let bars = await fetchTradier(date);
    let source = 'Tradier';

    if (!bars || bars.length < 100) {
      // Fallback to Polygon SPY×10
      bars = await fetchPolygonSpy(date);
      source = 'Polygon SPY×10';
    }

    if (!bars || bars.length === 0) {
      console.log(`  ${date}: NO DATA from either source`);
      continue;
    }

    const doInsert = db.transaction(() => {
      for (const b of bars!) {
        upsert.run(b.ts, b.o, b.h, b.l, b.c, b.v);
      }
    });
    doInsert();
    console.log(`  ${date}: ${bars.length} bars from ${source}`);

    await new Promise(r => setTimeout(r, 200));
  }

  db.close();
  console.log('\nDone. Run compute-indicators.ts to recompute SPX indicators.');
}

main().catch(e => { console.error(e); process.exit(1); });
