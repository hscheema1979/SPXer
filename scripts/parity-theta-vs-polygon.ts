/**
 * parity-theta-vs-polygon.ts — compare ThetaData historical bars against the
 * Polygon-backfilled bars already in SQLite, for a single trading day.
 *
 * Usage:
 *   npx tsx scripts/parity-theta-vs-polygon.ts 2026-03-19
 *   npx tsx scripts/parity-theta-vs-polygon.ts 2026-03-19 --symbols=5
 *
 * Picks N active SPXW contracts for the date (by row count in `bars`), then
 * fetches the same contracts from ThetaData's /v2/hist/option/ohlc, and diffs:
 *   - bar count
 *   - per-bar OHLC absolute deltas (max, mean)
 *   - volume totals
 *   - timestamp alignment
 *
 * Exit code 0 if parity is within tolerance, 1 otherwise.
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database = require('better-sqlite3');
import * as path from 'path';
import { fetchOptionTimesales, fetchSpxTimesales, ping } from '../src/providers/thetadata';

const DB_PATH = path.resolve(__dirname, '../data/spxer.db');

const date = process.argv[2];
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: parity-theta-vs-polygon.ts YYYY-MM-DD [--symbols=N]');
  process.exit(1);
}
const nSymbolsArg = process.argv.find((a) => a.startsWith('--symbols='));
const N_SYMBOLS = nSymbolsArg ? parseInt(nSymbolsArg.split('=')[1], 10) : 5;

// Tolerances
const PRICE_TOL = 0.02;    // $0.02 OHLC delta acceptable (tick size)
const COUNT_TOL_PCT = 0.05; // ±5% bar count acceptable (providers may differ on empty-minute handling)

interface PolyBar { ts: number; open: number; high: number; low: number; close: number; volume: number }

function getDateRange(d: string): [number, number] {
  // Trading day in ET → UTC seconds (ET is UTC-4 EDT / UTC-5 EST)
  // Cover full 24h in UTC to be safe; we'll filter to RTH in the query instead.
  const start = new Date(`${d}T00:00:00Z`).getTime() / 1000;
  const end = start + 86400;
  return [start, end];
}

function loadPolygonBars(db: Database.Database, symbol: string, d: string): PolyBar[] {
  const [start, end] = getDateRange(d);
  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume
    FROM bars
    WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts < ?
    ORDER BY ts ASC
  `).all(symbol, start, end) as PolyBar[];
  return rows;
}

function pickActiveContracts(db: Database.Database, d: string, limit: number): string[] {
  const [start, end] = getDateRange(d);
  const rows = db.prepare(`
    SELECT symbol, COUNT(*) AS n
    FROM bars
    WHERE timeframe = '1m' AND ts >= ? AND ts < ? AND symbol LIKE 'SPXW%'
    GROUP BY symbol
    HAVING n > 50
    ORDER BY n DESC
    LIMIT ?
  `).all(start, end, limit) as { symbol: string; n: number }[];
  return rows.map((r) => r.symbol);
}

function diffBars(polygon: PolyBar[], theta: PolyBar[]): {
  polyCount: number; thetaCount: number;
  matched: number;
  maxDelta: number; meanDelta: number;
  polyVol: number; thetaVol: number;
  tsAligned: boolean;
} {
  const byTsP = new Map(polygon.map((b) => [b.ts, b]));
  const byTsT = new Map(theta.map((b) => [b.ts, b]));
  let matched = 0;
  let deltaSum = 0;
  let maxDelta = 0;
  let deltaCount = 0;
  for (const [ts, pb] of byTsP) {
    const tb = byTsT.get(ts);
    if (!tb) continue;
    matched++;
    for (const field of ['open', 'high', 'low', 'close'] as const) {
      const d = Math.abs(pb[field] - tb[field]);
      deltaSum += d;
      deltaCount++;
      if (d > maxDelta) maxDelta = d;
    }
  }
  const polyVol = polygon.reduce((s, b) => s + b.volume, 0);
  const thetaVol = theta.reduce((s, b) => s + b.volume, 0);
  return {
    polyCount: polygon.length,
    thetaCount: theta.length,
    matched,
    maxDelta,
    meanDelta: deltaCount > 0 ? deltaSum / deltaCount : 0,
    polyVol, thetaVol,
    tsAligned: matched > 0 && matched === Math.min(polygon.length, theta.length),
  };
}

async function main() {
  console.log(`=== Parity check: Polygon (SQLite) vs ThetaData REST — ${date} ===\n`);

  const reachable = await ping();
  if (!reachable) {
    console.error('ThetaData Terminal not reachable on', process.env.THETADATA_REST_URL || 'http://127.0.0.1:25510');
    process.exit(2);
  }
  console.log('ThetaData Terminal: reachable ✓\n');

  const db = new Database(DB_PATH, { readonly: true });

  // ── SPX underlying ────────────────────────────────────────────────────────
  console.log('--- SPX underlying (1m) ---');
  const polySpx = loadPolygonBars(db, 'SPX', date);
  const thetaSpx = await fetchSpxTimesales(date);
  const spxDiff = diffBars(polySpx, thetaSpx);
  console.log(`  Polygon bars: ${spxDiff.polyCount}  ThetaData bars: ${spxDiff.thetaCount}  matched ts: ${spxDiff.matched}`);
  console.log(`  OHLC max Δ: $${spxDiff.maxDelta.toFixed(4)}  mean Δ: $${spxDiff.meanDelta.toFixed(4)}`);
  console.log('  (Note: ThetaData /hist/index/price returns last price; Polygon has true OHLC — deltas expected)\n');

  // ── SPXW contracts ────────────────────────────────────────────────────────
  const contracts = pickActiveContracts(db, date, N_SYMBOLS);
  if (contracts.length === 0) {
    console.error(`No active SPXW contracts found in SQLite for ${date}. Has this day been backfilled from Polygon?`);
    process.exit(3);
  }
  console.log(`--- SPXW options (1m), top ${contracts.length} by Polygon bar count ---`);

  let worstMaxDelta = 0;
  let worstCountSkew = 0;
  let failed = false;

  for (const sym of contracts) {
    const poly = loadPolygonBars(db, sym, date);
    const theta = await fetchOptionTimesales(sym, date);
    const d = diffBars(poly, theta);
    const countSkewPct = d.polyCount > 0 ? Math.abs(d.thetaCount - d.polyCount) / d.polyCount : 1;
    const priceBad = d.maxDelta > PRICE_TOL;
    const countBad = countSkewPct > COUNT_TOL_PCT;
    const mark = priceBad || countBad ? '✗' : '✓';
    if (priceBad || countBad) failed = true;
    if (d.maxDelta > worstMaxDelta) worstMaxDelta = d.maxDelta;
    if (countSkewPct > worstCountSkew) worstCountSkew = countSkewPct;
    console.log(
      `  ${mark} ${sym}  ` +
      `poly=${String(d.polyCount).padStart(3)} theta=${String(d.thetaCount).padStart(3)} ` +
      `match=${String(d.matched).padStart(3)} ` +
      `maxΔ=$${d.maxDelta.toFixed(3).padStart(6)} meanΔ=$${d.meanDelta.toFixed(3)} ` +
      `vol poly=${d.polyVol} theta=${d.thetaVol}`
    );
  }

  console.log(`\n--- Summary ---`);
  console.log(`  Worst OHLC delta across ${contracts.length} contracts: $${worstMaxDelta.toFixed(4)} (tolerance $${PRICE_TOL})`);
  console.log(`  Worst bar-count skew: ${(worstCountSkew * 100).toFixed(2)}% (tolerance ${(COUNT_TOL_PCT * 100).toFixed(0)}%)`);
  console.log(`  ${failed ? '✗ PARITY FAILED' : '✓ PARITY OK'} — safe to cancel Polygon: ${failed ? 'NO' : 'YES'}`);
  db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(4);
});
