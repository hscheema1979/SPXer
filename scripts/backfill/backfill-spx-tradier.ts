/**
 * Fetch real SPX bars from Tradier timesales.
 * Uses 1min when available, falls back to 5min for older dates.
 * Overwrites existing bars.
 *
 * Usage: npx tsx scripts/backfill/backfill-spx-tradier.ts 2026-02-20 2026-02-25
 */
import * as dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const TOKEN = process.env.TRADIER_TOKEN!;

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

async function fetchTimesales(date: string, interval: string): Promise<any[] | null> {
  const url = `https://api.tradier.com/v1/markets/timesales?symbol=SPX&interval=${interval}&start=${date}T09:30&end=${date}T16:00&session_filter=open`;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      timeout: 15000,
    });
    const series = data?.series?.data;
    if (!series || !Array.isArray(series)) return null;
    return series;
  } catch {
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || '2026-02-20';
  const endDate = args[1] || startDate;
  const dates = getTradingDays(startDate, endDate);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Delete existing SPY×10 junk for these dates first
  const deleteStmt = db.prepare(`
    DELETE FROM bars WHERE symbol = 'SPX' AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
  `);

  const upsert = db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
    VALUES ('SPX', '1m', ?, ?, ?, ?, ?, ?, '{}')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, indicators='{}'
  `);

  console.log(`\nFetching real SPX bars from Tradier: ${dates.length} days\n`);

  for (const date of dates) {
    // Try 1min first
    let series = await fetchTimesales(date, '1min');
    let interval = '1min';

    if (!series || series.length < 50) {
      // Fall back to 5min
      series = await fetchTimesales(date, '5min');
      interval = '5min';
    }

    if (!series || series.length === 0) {
      console.log(`  ${date}: NO DATA`);
      continue;
    }

    // Clear old data for this date range
    const dayStart = Math.floor(new Date(date + 'T09:00:00-05:00').getTime() / 1000);
    const dayEnd = Math.floor(new Date(date + 'T17:00:00-05:00').getTime() / 1000);
    deleteStmt.run(dayStart, dayEnd);

    const doInsert = db.transaction(() => {
      for (const d of series!) {
        const ts = d.timestamp || Math.floor(new Date(d.time).getTime() / 1000);
        upsert.run(ts, d.open, d.high, d.low, d.close, d.volume ?? 0);
      }
    });
    doInsert();

    console.log(`  ${date}: ${series.length} bars (${interval}) — open=$${series[0].open.toFixed(2)} close=$${series[series.length - 1].close.toFixed(2)}`);

    await new Promise(r => setTimeout(r, 250));
  }

  db.close();
  console.log('\nDone. Run compute-indicators.ts to recompute.');
}

main().catch(e => { console.error(e); process.exit(1); });
