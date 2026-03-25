/**
 * Fetch SPX 1m bars from Yahoo Finance for specific dates.
 * Falls back to 2m bars interpolated to 1m if 1m is unavailable (>30 days old).
 *
 * Usage: npx tsx scripts/backfill/backfill-spx-yahoo.ts 2026-02-20 2026-02-25
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');

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

interface YahooBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchYahoo(date: string, interval: '1m' | '2m'): Promise<YahooBar[]> {
  // Determine if date is EST or EDT
  const dateObj = new Date(date + 'T12:00:00Z');
  const month = dateObj.getMonth(); // 0-based
  const day = dateObj.getDate();
  // DST starts second Sunday of March in US — rough check for 2026: Mar 8
  const isEDT = (month > 2) || (month === 2 && day >= 8);
  const tz = isEDT ? 'EDT' : 'EST';
  const utcOffset = isEDT ? 4 : 5;

  const startStr = `${date}T${9 + utcOffset}:30:00Z`;  // 9:30 ET in UTC
  const endStr = `${date}T${16 + utcOffset}:00:00Z`;    // 16:00 ET in UTC

  const period1 = Math.floor(new Date(startStr).getTime() / 1000);
  const period2 = Math.floor(new Date(endStr).getTime() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=${interval}&period1=${period1}&period2=${period2}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json() as any;

  const result = data?.chart?.result?.[0];
  if (!result?.timestamp) {
    const err = data?.chart?.error;
    if (err) throw new Error(err.description || err.code);
    return [];
  }

  const ts = result.timestamp;
  const q = result.indicators.quote[0];
  const bars: YahooBar[] = [];

  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({
      ts: ts[i],
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume[i] || 0,
    });
  }

  return bars;
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] || '2026-02-20';
  const endDate = args[1] || startDate;
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

  console.log(`\nFetching SPX bars from Yahoo: ${dates.length} days\n`);

  for (const date of dates) {
    // Try 1m first
    let bars: YahooBar[] = [];
    let source = '1m';

    try {
      bars = await fetchYahoo(date, '1m');
    } catch {
      // 1m not available (>30 days), fall back to 2m
    }

    if (bars.length < 100) {
      try {
        bars = await fetchYahoo(date, '2m');
        source = '2m';
      } catch (e: any) {
        console.log(`  ${date}: ERROR — ${e.message}`);
        continue;
      }
    }

    if (bars.length === 0) {
      console.log(`  ${date}: NO DATA`);
      continue;
    }

    const doInsert = db.transaction(() => {
      for (const b of bars) {
        upsert.run(b.ts, b.open, b.high, b.low, b.close, b.volume);
      }
    });
    doInsert();
    console.log(`  ${date}: ${bars.length} bars (${source}) — open=$${bars[0].open.toFixed(2)} close=$${bars[bars.length - 1].close.toFixed(2)}`);

    await new Promise(r => setTimeout(r, 300));
  }

  db.close();
  console.log('\nDone. Run compute-indicators.ts to recompute.');
}

main().catch(e => { console.error(e); process.exit(1); });
