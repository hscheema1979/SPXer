/**
 * Backfill SPX 1m bars from Tradier timesales for a date range.
 * Usage: npx tsx backfill-spx.ts 2026-02-18 2026-03-17
 */
import * as dotenv from 'dotenv';
dotenv.config();
import axios from 'axios';
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const TOKEN = process.env.TRADIER_TOKEN!;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; }

async function fetchSpxDay(date: string): Promise<Bar[]> {
  const url = `https://api.tradier.com/v1/markets/timesales?symbol=SPX&interval=1min&start=${date}T09:30&end=${date}T16:00&session_filter=open`;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
      timeout: 15000,
    });
    const series = data?.series?.data;
    if (!series || !Array.isArray(series)) return [];
    return series.map((d: any) => ({
      ts: Math.floor(new Date(d.time).getTime() / 1000),
      open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0,
    }));
  } catch (e: any) {
    console.error(`  ERROR ${date}: ${e.message}`);
    return [];
  }
}

function computeIndicators(closes: number[]): string {
  const ind: any = {};
  // RSI-14
  if (closes.length >= 15) {
    let avgGain = 0, avgLoss = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= 14; avgLoss /= 14;
    ind.rsi14 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  // EMA9
  if (closes.length >= 9) {
    const k = 2 / 10;
    let ema = closes[closes.length - 9];
    for (let i = closes.length - 8; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    ind.ema9 = ema;
  }
  // EMA21
  if (closes.length >= 21) {
    const k = 2 / 22;
    let ema = closes[closes.length - 21];
    for (let i = closes.length - 20; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    ind.ema21 = ema;
  }
  return JSON.stringify(ind);
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || '2026-02-18';
  const endDate = args[1] || '2026-03-17';

  const db = new Database(DB_PATH);
  const upsert = db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
    VALUES ('SPX', '1m', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, indicators=excluded.indicators
  `);

  // Generate weekdays between start and end
  const dates: string[] = [];
  const cur = new Date(startDate);
  const end = new Date(endDate);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      dates.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }

  console.log(`Backfilling SPX 1m bars: ${dates.length} days (${startDate} → ${endDate})`);

  for (const date of dates) {
    // Check if already have data
    const existing = db.prepare(`
      SELECT count(*) as cnt FROM bars WHERE symbol='SPX' AND timeframe='1m'
        AND ts >= ? AND ts <= ?
    `).get(
      Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000),
      Math.floor(new Date(date + 'T16:00:00-04:00').getTime() / 1000)
    ) as any;

    if (existing.cnt > 100) {
      console.log(`  ${date}: SKIP (${existing.cnt} bars exist)`);
      continue;
    }

    const bars = await fetchSpxDay(date);
    if (bars.length === 0) {
      console.log(`  ${date}: NO DATA`);
      continue;
    }

    const allCloses: number[] = [];
    const insertMany = db.transaction(() => {
      for (const b of bars) {
        allCloses.push(b.close);
        const indicators = computeIndicators(allCloses);
        upsert.run(b.ts, b.open, b.high, b.low, b.close, b.volume, indicators);
      }
    });
    insertMany();
    console.log(`  ${date}: ${bars.length} bars`);

    // Rate limit: 200ms between requests
    await new Promise(r => setTimeout(r, 200));
  }

  db.close();
  console.log('Done.');
}

main().catch(console.error);
