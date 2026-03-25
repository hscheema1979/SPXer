#!/usr/bin/env npx tsx
/**
 * polygon-validate.ts — Compare and optionally overwrite local bar data with Polygon.
 *
 * Modes:
 *   compare  — Fetch Polygon data for a date, compare with our DB, report discrepancies
 *   overwrite — Fetch Polygon data and replace our bars (then recompute indicators)
 *
 * Usage:
 *   npx tsx scripts/backfill/polygon-validate.ts compare 2026-03-16
 *   npx tsx scripts/backfill/polygon-validate.ts compare 2026-02-20 2026-03-23
 *   npx tsx scripts/backfill/polygon-validate.ts overwrite 2026-02-20 2026-03-23
 *   npx tsx scripts/backfill/polygon-validate.ts overwrite 2026-03-20    # single day
 *
 * SPX note: Polygon requires paid plan for I:SPX. We fetch SPY and scale ×10 as proxy.
 * Options: O:SPXW format works on free/starter plan.
 *
 * Rate limiting: Polygon starter = 5 req/min. Script auto-adapts with exponential backoff.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

if (!POLYGON_KEY) {
  console.error('POLYGON_API_KEY not set in .env');
  process.exit(1);
}

// ── Polygon types ─────────────────────────────────────────────────────────

interface PolygonBar {
  o: number; h: number; l: number; c: number;
  v: number; vw: number; n: number; t: number;
}

// ── Rate limiter ──────────────────────────────────────────────────────────

let requestCount = 0;
let lastRequestTime = 0;
let baseDelay = 250;  // start at 250ms between requests
const MAX_DELAY = 30000;

async function rateLimitedFetch(url: string): Promise<any> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < baseDelay) {
    await sleep(baseDelay - elapsed);
  }

  lastRequestTime = Date.now();
  requestCount++;

  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${POLYGON_KEY}` },
    signal: AbortSignal.timeout(30000),
  });

  // Check for rate limiting
  if (res.status === 429) {
    baseDelay = Math.min(baseDelay * 2, MAX_DELAY);
    console.log(`  Rate limited — backing off to ${baseDelay}ms`);
    await sleep(baseDelay);
    return rateLimitedFetch(url);  // retry
  }

  // If we're doing well, slowly reduce delay (but not below 200ms)
  if (requestCount % 10 === 0 && baseDelay > 200) {
    baseDelay = Math.max(200, baseDelay * 0.8);
  }

  const data = await res.json();
  if (data.status === 'NOT_AUTHORIZED') throw new Error(`Not authorized: ${url}`);
  if (data.status === 'ERROR') throw new Error(data.error || `API error: ${url}`);
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Polygon bar fetching ──────────────────────────────────────────────────

async function fetchPolygonBars(ticker: string, date: string): Promise<PolygonBar[]> {
  const data = await rateLimitedFetch(
    `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`
  );
  return data.results || [];
}

// ── Symbol helpers ────────────────────────────────────────────────────────

function dbSymToPolygon(dbSymbol: string): string {
  // SPXW260316C06700000 → O:SPXW260316C06700000
  return `O:${dbSymbol}`;
}

function getDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

// ── Get our contracts for a date ──────────────────────────────────────────

interface LocalContract {
  symbol: string;
  type: string;
  strike: number;
  barCount: number;
}

function getLocalContracts(db: Database.Database, date: string): LocalContract[] {
  const dayStart = Math.floor(new Date(date + 'T09:00:00-04:00').getTime() / 1000);
  const dayEnd = Math.floor(new Date(date + 'T16:30:00-04:00').getTime() / 1000);

  return db.prepare(`
    SELECT b.symbol, c.type, c.strike, COUNT(*) as barCount
    FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE ? AND b.timeframe = '1m'
      AND b.ts >= ? AND b.ts <= ?
    GROUP BY b.symbol
    ORDER BY c.strike
  `).all(`SPXW${date.slice(2,4)}${date.slice(5,7)}${date.slice(8,10)}%`, dayStart, dayEnd) as LocalContract[];
}

function getLocalBars(db: Database.Database, symbol: string, date: string): Map<number, { o: number; h: number; l: number; c: number; v: number }> {
  const dayStart = Math.floor(new Date(date + 'T09:00:00-04:00').getTime() / 1000);
  const dayEnd = Math.floor(new Date(date + 'T16:30:00-04:00').getTime() / 1000);

  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume FROM bars
    WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(symbol, dayStart, dayEnd) as any[];

  const map = new Map<number, { o: number; h: number; l: number; c: number; v: number }>();
  for (const r of rows) {
    map.set(r.ts, { o: r.open, h: r.high, l: r.low, c: r.close, v: r.volume });
  }
  return map;
}

// ── Compare one contract ──────────────────────────────────────────────────

interface CompareResult {
  symbol: string;
  localBars: number;
  polygonBars: number;
  matched: number;
  mismatched: number;
  localOnly: number;   // bars we have that Polygon doesn't
  polygonOnly: number;  // bars Polygon has that we don't
  maxPriceDiff: number;
  avgPriceDiff: number;
  worstBar?: { ts: number; localClose: number; polygonClose: number; diff: number };
}

function compareContract(
  localBars: Map<number, { o: number; h: number; l: number; c: number; v: number }>,
  polygonBars: PolygonBar[],
): Omit<CompareResult, 'symbol'> {
  const polygonMap = new Map<number, PolygonBar>();
  for (const pb of polygonBars) {
    const ts = Math.floor(pb.t / 1000);
    polygonMap.set(ts, pb);
  }

  let matched = 0;
  let mismatched = 0;
  let localOnly = 0;
  let polygonOnly = 0;
  let maxPriceDiff = 0;
  let totalPriceDiff = 0;
  let compareCount = 0;
  let worstBar: CompareResult['worstBar'] = undefined;

  // Check local bars against Polygon
  for (const [ts, local] of localBars) {
    const pg = polygonMap.get(ts);
    if (!pg) {
      localOnly++;
      continue;
    }
    const closeDiff = Math.abs(local.c - pg.c);
    const pctDiff = local.c > 0 ? (closeDiff / local.c) * 100 : 0;
    totalPriceDiff += pctDiff;
    compareCount++;

    if (pctDiff < 1) {
      matched++;
    } else {
      mismatched++;
      if (pctDiff > maxPriceDiff) {
        maxPriceDiff = pctDiff;
        worstBar = { ts, localClose: local.c, polygonClose: pg.c, diff: pctDiff };
      }
    }
  }

  // Check Polygon bars not in local
  for (const [ts] of polygonMap) {
    if (!localBars.has(ts)) polygonOnly++;
  }

  return {
    localBars: localBars.size,
    polygonBars: polygonBars.length,
    matched,
    mismatched,
    localOnly,
    polygonOnly,
    maxPriceDiff,
    avgPriceDiff: compareCount > 0 ? totalPriceDiff / compareCount : 0,
    worstBar,
  };
}

// ── Compare mode ──────────────────────────────────────────────────────────

async function cmdCompare(dates: string[]) {
  const db = getDb();

  for (const date of dates) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  Comparing ${date} — Local vs Polygon`);
    console.log(`${'═'.repeat(72)}`);

    // Compare SPX via SPY proxy
    console.log('\n  SPX (via SPY×10 proxy):');
    const spyBars = await fetchPolygonBars('SPY', date);
    const localSpx = getLocalBars(db, 'SPX', date);

    if (spyBars.length > 0 && localSpx.size > 0) {
      // Convert SPY to SPX scale for comparison
      const spyAsSpx = spyBars.map(b => ({
        ...b,
        o: b.o * 10, h: b.h * 10, l: b.l * 10, c: b.c * 10,
      }));
      const spxResult = compareContract(localSpx, spyAsSpx as any);
      console.log(`    Local: ${spxResult.localBars} bars | Polygon(SPY×10): ${spxResult.polygonBars} bars`);
      console.log(`    Matched: ${spxResult.matched} | Mismatched: ${spxResult.mismatched} | Avg diff: ${spxResult.avgPriceDiff.toFixed(2)}%`);
      if (spxResult.worstBar) {
        const et = new Date(spxResult.worstBar.ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
        console.log(`    Worst bar: ${et} — local $${spxResult.worstBar.localClose.toFixed(2)} vs Polygon $${spxResult.worstBar.polygonClose.toFixed(2)} (${spxResult.worstBar.diff.toFixed(1)}%)`);
      }
    } else {
      console.log(`    SPY: ${spyBars.length} Polygon bars, ${localSpx.size} local bars`);
    }

    // Compare option contracts
    const contracts = getLocalContracts(db, date);
    console.log(`\n  Options: ${contracts.length} local contracts to compare`);

    let totalMismatched = 0;
    let totalLocalOnly = 0;
    let totalPolygonOnly = 0;
    let contractsCompared = 0;
    let contractsFailed = 0;
    const badContracts: (CompareResult & { symbol: string })[] = [];

    // Sample: compare up to 30 contracts (or all if fewer), prioritizing diverse strikes
    const sample = contracts.length <= 30 ? contracts
      : contracts.filter((_, i) => i % Math.ceil(contracts.length / 30) === 0).slice(0, 30);

    for (const contract of sample) {
      try {
        const polygonTicker = dbSymToPolygon(contract.symbol);
        const pgBars = await fetchPolygonBars(polygonTicker, date);

        if (pgBars.length === 0) {
          process.stdout.write('_');
          continue;
        }

        const local = getLocalBars(db, contract.symbol, date);
        const result = compareContract(local, pgBars);
        contractsCompared++;
        totalMismatched += result.mismatched;
        totalLocalOnly += result.localOnly;
        totalPolygonOnly += result.polygonOnly;

        if (result.mismatched > 0 || result.maxPriceDiff > 5) {
          badContracts.push({ symbol: contract.symbol, ...result });
          process.stdout.write('X');
        } else {
          process.stdout.write('.');
        }
      } catch (e: any) {
        contractsFailed++;
        process.stdout.write('!');
      }
    }

    console.log(`\n\n  Summary: ${contractsCompared} compared, ${contractsFailed} failed`);
    console.log(`  Total mismatched bars: ${totalMismatched}`);
    console.log(`  Bars in local only (interpolated?): ${totalLocalOnly}`);
    console.log(`  Bars in Polygon only (missing from us): ${totalPolygonOnly}`);

    if (badContracts.length > 0) {
      console.log(`\n  WORST CONTRACTS (${badContracts.length}):`);
      console.log(`  ${'Symbol'.padEnd(25)} ${'Local'.padEnd(7)} ${'Poly'.padEnd(7)} ${'Match'.padEnd(7)} ${'Mismatch'.padEnd(9)} ${'MaxDiff'.padEnd(10)} Worst Bar`);
      console.log(`  ${'─'.repeat(90)}`);
      for (const c of badContracts.sort((a, b) => b.maxPriceDiff - a.maxPriceDiff).slice(0, 15)) {
        const worst = c.worstBar
          ? `${new Date(c.worstBar.ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false })} $${c.worstBar.localClose.toFixed(2)}→$${c.worstBar.polygonClose.toFixed(2)}`
          : '';
        console.log(`  ${c.symbol.padEnd(25)} ${String(c.localBars).padEnd(7)} ${String(c.polygonBars).padEnd(7)} ${String(c.matched).padEnd(7)} ${String(c.mismatched).padEnd(9)} ${(c.maxPriceDiff.toFixed(1) + '%').padEnd(10)} ${worst}`);
      }
    }
  }

  db.close();
  console.log(`\n  Total Polygon API requests: ${requestCount}\n`);
}

// ── Overwrite mode ────────────────────────────────────────────────────────

async function cmdOverwrite(dates: string[]) {
  const db = getDb();

  for (const date of dates) {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  Overwriting ${date} with Polygon data`);
    console.log(`${'═'.repeat(72)}`);

    const contracts = getLocalContracts(db, date);
    console.log(`  ${contracts.length} contracts to fetch from Polygon`);

    const upsertBar = db.prepare(`
      INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, indicators)
      VALUES (?, '1m', ?, ?, ?, ?, ?, ?, '{}')
      ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
        open=excluded.open, high=excluded.high, low=excluded.low,
        close=excluded.close, volume=excluded.volume, indicators='{}'
    `);

    // Delete bars that Polygon doesn't have (our interpolated/synthetic ones)
    const deleteBar = db.prepare(`
      DELETE FROM bars WHERE symbol = ? AND timeframe = '1m' AND ts = ?
    `);

    let totalBarsWritten = 0;
    let totalBarsDeleted = 0;
    let contractsDone = 0;
    let contractsFailed = 0;

    for (const contract of contracts) {
      try {
        const polygonTicker = dbSymToPolygon(contract.symbol);
        const pgBars = await fetchPolygonBars(polygonTicker, date);

        if (pgBars.length === 0) {
          process.stdout.write('_');
          continue;
        }

        // Build set of Polygon timestamps
        const pgTimestamps = new Set<number>();
        for (const b of pgBars) {
          pgTimestamps.add(Math.floor(b.t / 1000));
        }

        // Get our local bar timestamps to find ones to delete
        const localBars = getLocalBars(db, contract.symbol, date);
        const toDelete: number[] = [];
        for (const [ts] of localBars) {
          if (!pgTimestamps.has(ts)) toDelete.push(ts);
        }

        // Transaction: upsert Polygon bars + delete our synthetic bars
        const doOverwrite = db.transaction(() => {
          for (const b of pgBars) {
            const ts = Math.floor(b.t / 1000);
            upsertBar.run(contract.symbol, ts, b.o, b.h, b.l, b.c, b.v);
          }
          for (const ts of toDelete) {
            deleteBar.run(contract.symbol, ts);
          }
        });
        doOverwrite();

        totalBarsWritten += pgBars.length;
        totalBarsDeleted += toDelete.length;
        contractsDone++;
        process.stdout.write('✓');
      } catch (e: any) {
        contractsFailed++;
        process.stdout.write('!');
        if (e.message.includes('Not authorized')) {
          console.log(`\n  ⚠️  Not authorized for ${contract.symbol}`);
        }
      }

      // Progress every 20 contracts
      if ((contractsDone + contractsFailed) % 20 === 0) {
        const pct = (((contractsDone + contractsFailed) / contracts.length) * 100).toFixed(0);
        process.stdout.write(` ${pct}% `);
      }
    }

    console.log(`\n  ${contractsDone} contracts overwritten, ${contractsFailed} failed`);
    console.log(`  ${totalBarsWritten} bars written, ${totalBarsDeleted} synthetic bars deleted`);

    // Also fetch SPY and compare/log SPX quality (but don't overwrite SPX — SPY×10 is less accurate than Tradier)
    console.log('\n  SPX check (SPY×10 proxy — not overwriting):');
    try {
      const spyBars = await fetchPolygonBars('SPY', date);
      const localSpx = getLocalBars(db, 'SPX', date);
      console.log(`    SPY: ${spyBars.length} bars | Local SPX: ${localSpx.size} bars`);
      if (spyBars.length > 0 && localSpx.size > 0) {
        // Quick quality check
        let diffs = 0;
        let bigDiffs = 0;
        for (const sb of spyBars) {
          const ts = Math.floor(sb.t / 1000);
          const local = localSpx.get(ts);
          if (local) {
            const pctDiff = Math.abs(local.c - sb.c * 10) / local.c * 100;
            if (pctDiff > 0.1) diffs++;
            if (pctDiff > 1) bigDiffs++;
          }
        }
        console.log(`    SPX vs SPY×10: ${diffs} bars >0.1% diff, ${bigDiffs} bars >1% diff`);
      }
    } catch {}
  }

  db.close();

  // Recompute indicators for overwritten dates
  console.log(`\n${'─'.repeat(72)}`);
  console.log(`  Recomputing indicators for ${dates.length} date(s)...`);
  console.log(`${'─'.repeat(72)}`);

  // Import and run indicator computation
  const { computeIndicators: computeInd, seedState } = await import('../../src/pipeline/indicator-engine');
  const db2 = getDb();

  for (const date of dates) {
    const dayStart = Math.floor(new Date(date + 'T09:00:00-04:00').getTime() / 1000);
    const dayEnd = Math.floor(new Date(date + 'T16:30:00-04:00').getTime() / 1000);

    // Get all symbols with empty indicators on this date
    const symbols = db2.prepare(`
      SELECT DISTINCT symbol FROM bars
      WHERE indicators = '{}' AND timeframe = '1m'
        AND ts >= ? AND ts <= ?
    `).all(dayStart, dayEnd) as any[];

    let symbolsDone = 0;
    for (const { symbol } of symbols) {
      // Get all bars for this symbol (full history for proper indicator seeding)
      const bars = db2.prepare(`
        SELECT ts, open, high, low, close, volume, indicators
        FROM bars WHERE symbol = ? AND timeframe = '1m'
        ORDER BY ts ASC
      `).all(symbol) as any[];

      if (bars.length === 0) continue;

      const barObjs = bars.map((r: any) => ({
        symbol, timeframe: '1m' as any,
        ts: r.ts, open: r.open, high: r.high, low: r.low,
        close: r.close, volume: r.volume,
        indicators: JSON.parse(r.indicators || '{}'),
      }));

      // Seed state and compute
      seedState(symbol, '1m' as any, barObjs);

      const updateStmt = db2.prepare(`UPDATE bars SET indicators = ? WHERE symbol = ? AND timeframe = '1m' AND ts = ?`);
      const doUpdate = db2.transaction(() => {
        for (const bar of barObjs) {
          const ind = computeInd(bar, 1);
          updateStmt.run(JSON.stringify(ind), symbol, bar.ts);
        }
      });
      doUpdate();
      symbolsDone++;
    }
    console.log(`  ${date}: ${symbolsDone} symbols recomputed`);
  }

  db2.close();
  console.log(`\n  Total Polygon API requests: ${requestCount}`);
  console.log('  Done.\n');
}

// ── Trading days helper ───────────────────────────────────────────────────

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

// ── Available dates (only those we have data for) ─────────────────────────

function getAvailableDates(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch') as d
    FROM bars WHERE symbol LIKE 'SPXW%' AND timeframe='1m'
    GROUP BY d HAVING COUNT(*) > 100 ORDER BY d
  `).all() as any[];
  return rows.map((r: any) => r.d);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];

  if (!mode || !['compare', 'overwrite'].includes(mode)) {
    console.log(`
Polygon Data Validator

Usage:
  npx tsx scripts/backfill/polygon-validate.ts compare <date>
  npx tsx scripts/backfill/polygon-validate.ts compare <start-date> <end-date>
  npx tsx scripts/backfill/polygon-validate.ts overwrite <date>
  npx tsx scripts/backfill/polygon-validate.ts overwrite <start-date> <end-date>

Modes:
  compare   — Compare local data with Polygon, report discrepancies (read-only)
  overwrite — Replace local option bars with Polygon data, recompute indicators

Notes:
  - SPX underlying is NOT overwritten (Tradier data is more accurate than SPY×10 proxy)
  - Options bars: Polygon data replaces local bars, synthetic/interpolated bars are removed
  - Indicators are recomputed after overwrite
`);
    return;
  }

  // Parse dates
  const db = getDb();
  const available = getAvailableDates(db);
  db.close();

  let dates: string[];
  if (args.length === 3) {
    dates = getTradingDays(args[1], args[2]).filter(d => available.includes(d));
  } else if (args.length === 2) {
    dates = [args[1]];
  } else {
    console.log(`Available dates: ${available.join(', ')}`);
    console.error('Please specify a date or date range.');
    process.exit(1);
  }

  if (dates.length === 0) {
    console.error('No matching dates with data found.');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log(`  Polygon Validator — ${mode.toUpperCase()} mode`);
  console.log(`  ${dates.length} date(s): ${dates[0]}${dates.length > 1 ? ' → ' + dates[dates.length - 1] : ''}`);
  console.log(`${'═'.repeat(72)}`);

  const startTime = Date.now();

  if (mode === 'compare') {
    await cmdCompare(dates);
  } else {
    await cmdOverwrite(dates);
  }

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`  Elapsed: ${elapsed} minutes\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
