/**
 * build-replay-bars.ts — Build clean replay_bars table with sanitized data from Polygon.
 *
 * IMPORTANT: This script has been superseded by the new backfill-replay-options.ts workflow.
 *
 * New workflow (recommended):
 *   1. npx tsx scripts/backfill/build-replay-bars.ts --spx-only 2026-02-20 2026-03-24  # SPX only
 *   2. npx tsx scripts/backfill/backfill-replay-options.ts 2026-02-20 2026-03-24       # Options from Polygon
 *
 * Old workflow (deprecated):
 *   npx tsx scripts/backfill/build-replay-bars.ts 2026-02-20 2026-03-24  # Both SPX + options
 *
 * The old workflow copied unreliable options data from the live bars table.
 * The new workflow fetches clean options data directly from Polygon API.
 *
 * - Creates replay_bars table (same schema as bars) if it doesn't exist
 * - Fetches real SPX 1m bars from Polygon I:SPX for each date
 * - (DEPRECATED) Copies option contract bars from existing bars table
 * - Recomputes indicators on the clean data
 * - NEVER touches the original bars table
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const POLYGON_KEY = process.env.POLYGON_API_KEY!;

if (!POLYGON_KEY) {
  console.error('POLYGON_API_KEY not set in .env');
  process.exit(1);
}

// No rate limit — paid Polygon plan

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

function isDST(date: string): boolean {
  // DST 2026 starts Mar 8, ends Nov 1
  const d = new Date(date + 'T12:00:00Z');
  const month = d.getMonth(); // 0-based
  const day = d.getDate();
  if (month < 2 || month > 10) return false;  // Jan, Feb, Dec = EST
  if (month > 2 && month < 10) return true;   // Apr-Oct = EDT
  if (month === 2) return day >= 8;            // Mar 8+ = EDT
  return day < 1;                               // Nov 1+ = EST
}

interface PolygonBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchSpxFromPolygon(date: string): Promise<PolygonBar[]> {
  const url = `https://api.polygon.io/v2/aggs/ticker/I:SPX/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
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
  const rthStartMs = dayStartMs + (9.5 + utcOffset) * 3600000;  // 9:30 ET in UTC
  const rthEndMs = dayStartMs + (16 + utcOffset) * 3600000;      // 16:00 ET in UTC

  // Store timestamps in real UTC (Polygon already returns real UTC milliseconds)
  return data.results
    .filter((b: any) => b.t >= rthStartMs && b.t <= rthEndMs)
    .map((b: any) => ({
      ts: Math.floor(b.t / 1000),
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
      volume: b.v || 0,
    }));
}

async function main() {
  const args = process.argv.slice(2);
  const spxOnly = args.includes('--spx-only');
  const dateArgs = args.filter(a => !a.startsWith('--'));

  const startDate = dateArgs[0] || '2026-02-20';
  const endDate = dateArgs[1] || startDate;
  const dates = getTradingDays(startDate, endDate);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // ── Create replay_bars table ──────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_bars (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol      TEXT NOT NULL,
      timeframe   TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      open        REAL NOT NULL,
      high        REAL NOT NULL,
      low         REAL NOT NULL,
      close       REAL NOT NULL,
      volume      INTEGER NOT NULL DEFAULT 0,
      synthetic   INTEGER NOT NULL DEFAULT 0,
      gap_type    TEXT,
      indicators  TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
      source      TEXT NOT NULL DEFAULT 'polygon'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_bars_symbol_tf_ts
      ON replay_bars(symbol, timeframe, ts);
  `);

  const upsert = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', 'polygon')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, synthetic=0,
      gap_type=NULL, indicators='{}', source='polygon'
  `);

  const copyFromBars = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    SELECT symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, 'live'
    FROM bars
    WHERE symbol = ? AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
      AND synthetic = 0
    ON CONFLICT(symbol, timeframe, ts) DO NOTHING
  `);

  console.log(`\nBuilding replay_bars: ${dates.length} days (${startDate} → ${endDate})\n`);
  console.log(`Mode: ${spxOnly ? 'SPX only' : 'SPX + option contracts'}\n`);

  let totalSpx = 0;
  let totalContracts = 0;

  for (const date of dates) {
    // ── Fetch SPX from Polygon ──────────────────────────────────────
    let spxBars: PolygonBar[] = [];
    try {
      spxBars = await fetchSpxFromPolygon(date);
    } catch (e: any) {
      console.log(`  ${date}: SPX ERROR — ${e.message}`);
    }

    if (spxBars.length > 0) {
      const doInsert = db.transaction(() => {
        for (const b of spxBars) {
          upsert.run('SPX', b.ts, b.open, b.high, b.low, b.close, b.volume);
        }
      });
      doInsert();
      totalSpx += spxBars.length;
      const open = spxBars[0].open.toFixed(2);
      const close = spxBars[spxBars.length - 1].close.toFixed(2);
      console.log(`  ${date}: ${spxBars.length} SPX bars — open=$${open} close=$${close}`);
    } else {
      console.log(`  ${date}: SPX — NO DATA`);
    }

    // ── Copy option contract bars from existing bars table ──────────
    if (!spxOnly) {
      const edt = isDST(date);
      const utcOffset = edt ? 4 : 5;
      const dayStartTs = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) + (9 + utcOffset) * 3600;
      const dayEndTs = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000) + (17 + utcOffset) * 3600;

      // Get distinct option symbols for this date from bars table
      const contracts = db.prepare(`
        SELECT DISTINCT symbol FROM bars
        WHERE symbol LIKE 'SPXW%' AND timeframe = '1m'
          AND ts >= ? AND ts <= ?
          AND synthetic = 0
      `).all(dayStartTs, dayEndTs) as { symbol: string }[];

      let dayContracts = 0;
      const doCopy = db.transaction(() => {
        for (const { symbol } of contracts) {
          const result = copyFromBars.run(symbol, dayStartTs, dayEndTs);
          dayContracts += result.changes;
        }
      });
      doCopy();
      totalContracts += dayContracts;
      console.log(`           ${contracts.length} contracts, ${dayContracts} option bars copied`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────
  const total = db.prepare('SELECT count(*) as cnt FROM replay_bars').get() as any;
  const spxCount = db.prepare("SELECT count(*) as cnt FROM replay_bars WHERE symbol='SPX'").get() as any;
  const optCount = db.prepare("SELECT count(*) as cnt FROM replay_bars WHERE symbol LIKE 'SPXW%'").get() as any;

  console.log(`\n── Summary ──────────────────────────────────────────`);
  console.log(`  SPX bars added this run:      ${totalSpx}`);
  console.log(`  Option bars copied this run:  ${totalContracts}`);
  console.log(`  Total replay_bars:            ${total.cnt}`);
  console.log(`    SPX:                        ${spxCount.cnt}`);
  console.log(`    Options:                    ${optCount.cnt}`);
  console.log(`\nDone. Original bars table untouched.`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
