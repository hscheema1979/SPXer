/**
 * backfill-year.ts — Backfill 1 year of SPX + SPXW options data from Polygon.
 *
 * Two phases:
 *   Phase 1: Fetch SPX 1m bars for all trading days (fast, sequential)
 *   Phase 2: Fetch SPXW option bars with parallelism (slow, 10 concurrent)
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-year.ts                    # Default: 1 year back
 *   npx tsx scripts/backfill/backfill-year.ts 2025-03-27 2026-02-19  # Custom range
 *   npx tsx scripts/backfill/backfill-year.ts --skip-spx         # Skip SPX, options only
 *   npx tsx scripts/backfill/backfill-year.ts --concurrency=20   # More parallel fetches
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

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const skipSpx = args.includes('--skip-spx');
const skipOptions = args.includes('--skip-options');
const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
const CONCURRENCY = concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : 10;
const dateArgs = args.filter(a => !a.startsWith('--'));

// ── Date helpers ──────────────────────────────────────────────────────────────

const US_HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03',
]);

function getTradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  const start = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    if (US_HOLIDAYS.has(iso)) continue;
    days.push(iso);
  }
  return days;
}

function isDST(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  const month = d.getMonth();
  const day = d.getDate();
  // 2025: DST Mar 9 – Nov 2; 2026: DST Mar 8 – Nov 1
  const year = d.getFullYear();
  const dstStart = year === 2025 ? 9 : 8; // March day
  const dstEnd = year === 2025 ? 2 : 1;   // November day
  if (month < 2 || month > 10) return false;
  if (month > 2 && month < 10) return true;
  if (month === 2) return day >= dstStart;
  return day < dstEnd;
}

// ── Polygon fetch ─────────────────────────────────────────────────────────────

interface PolygonBar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

async function fetchBars(ticker: string, date: string, retries = 3): Promise<PolygonBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

      if (res.status === 429) {
        // Rate limited — back off
        const wait = attempt * 5000;
        console.warn(`  ⚠ Rate limited on ${ticker}, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      if (!data.results || data.results.length === 0) return [];

      const edt = isDST(date);
      const utcOffset = edt ? 4 : 5;
      const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
      const rthStartMs = dayStartMs + (9.5 + utcOffset) * 3600000;
      const rthEndMs = dayStartMs + (16 + utcOffset) * 3600000;

      return data.results
        .filter((b: any) => b.t >= rthStartMs && b.t <= rthEndMs)
        .map((b: any) => ({
          ts: Math.floor(b.t / 1000),
          open: b.o, high: b.h, low: b.l, close: b.c,
          volume: b.v || 0,
        }));
    } catch (e: any) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  return [];
}

// ── Symbol helpers ────────────────────────────────────────────────────────────

function makePolygonOptionTicker(expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  return `O:SPXW${yy}${mm}${dd}${side}${(strike * 1000).toString().padStart(8, '0')}`;
}

function makeDbSymbol(expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  return `SPXW${yy}${mm}${dd}${side}${(strike * 1000).toString().padStart(8, '0')}`;
}

// ── Parallel executor ─────────────────────────────────────────────────────────

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startDate = dateArgs[0] || '2025-03-27';
  const endDate = dateArgs[1] || '2026-02-19'; // Day before existing data
  const allDates = getTradingDays(startDate, endDate);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Ensure replay_bars table exists
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

  // Check which dates already have SPX data
  const existingSpxDates = new Set(
    (db.prepare(`
      SELECT DISTINCT date(ts, 'unixepoch') as d FROM replay_bars
      WHERE symbol = 'SPX' AND timeframe = '1m'
    `).all() as any[]).map(r => r.d)
  );

  const newDates = allDates.filter(d => !existingSpxDates.has(d));

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  1-Year Polygon Backfill → replay_bars`);
  console.log(`  Range: ${startDate} → ${endDate}`);
  console.log(`  Total trading days: ${allDates.length} | Already have: ${allDates.length - newDates.length} | New: ${newDates.length}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`${'═'.repeat(70)}\n`);

  if (newDates.length === 0 && !skipSpx) {
    console.log('  All SPX dates already backfilled. Use --skip-spx to go straight to options.\n');
  }

  const upsert = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', 'polygon')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, source='polygon'
  `);

  // ── Phase 1: SPX bars ─────────────────────────────────────────────

  if (!skipSpx && newDates.length > 0) {
    console.log(`\n── Phase 1: SPX Underlying (${newDates.length} days) ──\n`);
    let spxTotal = 0;
    const startTime = Date.now();

    for (let i = 0; i < newDates.length; i++) {
      const date = newDates[i];
      try {
        const bars = await fetchBars('I:SPX', date);
        if (bars.length > 0) {
          db.transaction(() => {
            for (const b of bars) {
              upsert.run('SPX', b.ts, b.open, b.high, b.low, b.close, b.volume);
            }
          })();
          spxTotal += bars.length;
          const spxClose = bars[bars.length - 1].close;
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const pct = ((i + 1) / newDates.length * 100).toFixed(0);
          process.stdout.write(`\r  [${pct}%] ${date}: ${bars.length} bars, SPX=${spxClose.toFixed(0)} (${elapsed}s elapsed)`);
        } else {
          process.stdout.write(`\r  ${date}: NO DATA (holiday?)                                `);
        }
      } catch (e: any) {
        process.stdout.write(`\r  ${date}: ERROR — ${e.message}                              `);
      }
    }
    console.log(`\n\n  ✓ Phase 1 complete: ${spxTotal} SPX bars across ${newDates.length} days\n`);
  }

  // ── Phase 2: Options ──────────────────────────────────────────────

  if (!skipOptions) {
    // Get all dates that have SPX data — use ts range instead of date() for speed
    const allTradingDays = getTradingDays(startDate, endDate);
    const datesWithSpx: { d: string; spx_close: number }[] = [];

    const getSpxClose = db.prepare(`
      SELECT close FROM replay_bars
      WHERE symbol = 'SPX' AND timeframe = '1m' AND ts >= ? AND ts <= ?
      ORDER BY ts DESC LIMIT 1
    `);

    for (const day of allTradingDays) {
      // Compute ts range for this day (9:00 UTC to 22:00 UTC covers all ET possibilities)
      const dayStart = Math.floor(new Date(day + 'T09:00:00Z').getTime() / 1000);
      const dayEnd = Math.floor(new Date(day + 'T22:00:00Z').getTime() / 1000);
      const row = getSpxClose.get(dayStart, dayEnd) as { close: number } | undefined;
      if (row) {
        datesWithSpx.push({ d: day, spx_close: row.close });
      }
    }

    // Check which dates already have option data (fast: use ts ranges)
    const datesWithOptions = new Set<string>();
    const checkOptions = db.prepare(`
      SELECT COUNT(*) as cnt FROM replay_bars
      WHERE symbol LIKE 'SPXW%' AND timeframe = '1m' AND source = 'polygon'
        AND ts >= ? AND ts <= ?
    `);

    for (const { d } of datesWithSpx) {
      const dayStart = Math.floor(new Date(d + 'T09:00:00Z').getTime() / 1000);
      const dayEnd = Math.floor(new Date(d + 'T22:00:00Z').getTime() / 1000);
      const row = checkOptions.get(dayStart, dayEnd) as { cnt: number };
      if (row.cnt > 100) datesWithOptions.add(d); // >100 bars means we have data
    }

    const optionDates = datesWithSpx.filter(r => !datesWithOptions.has(r.d));

    console.log(`\n── Phase 2: Options (${optionDates.length} days, ${CONCURRENCY} concurrent) ──\n`);

    const overallStart = Date.now();
    let totalOptionBars = 0;
    let totalContracts = 0;

    for (let dayIdx = 0; dayIdx < optionDates.length; dayIdx++) {
      const { d: date, spx_close } = optionDates[dayIdx];
      const baseStrike = Math.round(spx_close / 5) * 5;
      const minStrike = baseStrike - 100;
      const maxStrike = baseStrike + 100;

      const strikes: number[] = [];
      for (let s = minStrike; s <= maxStrike; s += 5) strikes.push(s);

      // Build all contract fetch tasks
      type Task = { ticker: string; dbSymbol: string; date: string };
      const tasks: Task[] = [];
      for (const side of ['C', 'P'] as const) {
        for (const strike of strikes) {
          tasks.push({
            ticker: makePolygonOptionTicker(date, side, strike),
            dbSymbol: makeDbSymbol(date, side, strike),
            date,
          });
        }
      }

      let dayBars = 0;
      let dayContracts = 0;
      let dayErrors = 0;
      const dayStart = Date.now();

      await parallelMap(tasks, async (task) => {
        try {
          const bars = await fetchBars(task.ticker, task.date);
          if (bars.length > 0) {
            db.transaction(() => {
              for (const b of bars) {
                upsert.run(task.dbSymbol, b.ts, b.open, b.high, b.low, b.close, b.volume);
              }
            })();
            dayBars += bars.length;
            dayContracts++;
          }
        } catch {
          dayErrors++;
        }
      }, CONCURRENCY);

      totalOptionBars += dayBars;
      totalContracts += dayContracts;

      const dayElapsed = ((Date.now() - dayStart) / 1000).toFixed(1);
      const totalElapsed = ((Date.now() - overallStart) / 1000 / 60).toFixed(1);
      const remaining = optionDates.length - dayIdx - 1;
      const avgPerDay = (Date.now() - overallStart) / (dayIdx + 1);
      const eta = (remaining * avgPerDay / 1000 / 60).toFixed(0);

      console.log(`  [${dayIdx + 1}/${optionDates.length}] ${date} SPX=${spx_close.toFixed(0)} | ${dayContracts} contracts, ${dayBars} bars (${dayElapsed}s)${dayErrors > 0 ? ` [${dayErrors} err]` : ''} | ETA: ${eta}m`);
    }

    console.log(`\n  ✓ Phase 2 complete: ${totalContracts} contracts, ${totalOptionBars} bars`);
    console.log(`    Elapsed: ${((Date.now() - overallStart) / 1000 / 60).toFixed(1)} minutes\n`);
  }

  // ── Summary ───────────────────────────────────────────────────────

  const total = db.prepare('SELECT count(*) as cnt FROM replay_bars').get() as any;
  const spxCount = db.prepare("SELECT count(*) as cnt FROM replay_bars WHERE symbol = 'SPX'").get() as any;
  const optCount = db.prepare("SELECT count(*) as cnt FROM replay_bars WHERE symbol LIKE 'SPXW%'").get() as any;
  const dateRange = db.prepare("SELECT MIN(date(ts,'unixepoch')) as mn, MAX(date(ts,'unixepoch')) as mx, COUNT(DISTINCT date(ts,'unixepoch')) as days FROM replay_bars WHERE symbol = 'SPX'").get() as any;

  console.log(`${'═'.repeat(70)}`);
  console.log(`  FINAL STATE`);
  console.log(`  Date range:     ${dateRange.mn} → ${dateRange.mx} (${dateRange.days} trading days)`);
  console.log(`  SPX bars:       ${spxCount.cnt.toLocaleString()}`);
  console.log(`  Option bars:    ${optCount.cnt.toLocaleString()}`);
  console.log(`  Total bars:     ${total.cnt.toLocaleString()}`);
  console.log(`${'═'.repeat(70)}\n`);

  db.close();
}

main().catch(e => { console.error(e); process.exit(1); });
