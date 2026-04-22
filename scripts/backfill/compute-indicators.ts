/**
 * compute-indicators.ts — Backfill indicator values for bars in the database.
 *
 * Reads bars from the configured table, computes indicators incrementally,
 * and writes them back. Table is configurable via BAR_TABLE env var.
 *
 * Usage:
 *   npx tsx scripts/backfill/compute-indicators.ts                         # all dates (bars table)
 *   npx tsx scripts/backfill/compute-indicators.ts 2026-02-20              # specific date
 *   npx tsx scripts/backfill/compute-indicators.ts 2026-02-20 2026-03-20   # date range
 *
 *   BAR_TABLE=replay_bars npx tsx scripts/backfill/compute-indicators.ts   # use replay_bars table
 *   FORCE=1 npx tsx scripts/backfill/compute-indicators.ts 2026-04-17      # recompute rows even
 *                                                                         # if indicators are
 *                                                                         # partially populated
 *                                                                         # (fixes partial backfills)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database = require('better-sqlite3');
import * as path from 'path';
import { computeIndicators, seedState } from '../../src/pipeline/indicator-engine';
import type { Bar, Timeframe } from '../../src/types';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
// Configurable table: 'bars' (default) or 'replay_bars' (sanitized)
const BAR_TABLE = process.env.BAR_TABLE || 'bars';
// FORCE=1 processes every row in the date range, even rows whose indicators
// JSON is already non-empty. Required to fix partial-backfill corruption
// (e.g. rows that have hma3/hma15 but null hma5/hma19/ema/rsi/vwap).
const FORCE = process.env.FORCE === '1' || process.env.FORCE === 'true';
// SYMBOL=NDX (or comma-separated list) restricts processing to specific
// symbols. Useful when fixing partial backfill for one underlying without
// touching every option contract in the date range.
const SYMBOL_FILTER = process.env.SYMBOL
  ? process.env.SYMBOL.split(',').map(s => s.trim()).filter(Boolean)
  : null;

function getDb() {
  const db = new Database(DB_PATH);
  // Use WAL mode to match the rest of the system
  db.pragma('journal_mode = WAL');
  return db;
}

async function computeIndicatorsForSymbol(
  db: Database.Database,
  symbol: string,
  tf: Timeframe,
  dryRun: boolean = false
): Promise<number> {
  // Get all bars for this symbol, ordered by timestamp
  const bars = db.prepare(`
    SELECT id, symbol, timeframe, ts, open, high, low, close, volume, indicators
    FROM ${BAR_TABLE}
    WHERE symbol = ? AND timeframe = ?
    ORDER BY ts ASC
  `).all(symbol, tf) as any[];

  if (bars.length === 0) return 0;

  // Seed the indicator engine with all bars (it maintains rolling state)
  const barObjs = bars.map(r => ({
    id: r.id,  // Preserve database ID for updates
    symbol: r.symbol,
    timeframe: r.timeframe as Timeframe,
    ts: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    indicators: JSON.parse(r.indicators || '{}'),
  })) as Bar[];

  seedState(symbol, tf, barObjs);

  // Now compute indicators for each bar and collect updates
  let updated = 0;
  const updates = db.transaction((data: Array<[number, string]>) => {
    for (const [id, ind] of data) {
      db.prepare(`UPDATE ${BAR_TABLE} SET indicators = ? WHERE id = ?`).run(ind, id);
      updated++;
    }
  });

  const indicatorData: Array<[number, string]> = [];
  for (const bar of barObjs) {
    const indicators = computeIndicators(bar, 1);  // Tier 1 only for speed
    indicatorData.push([bar.id, JSON.stringify(indicators)]);
  }

  if (!dryRun) {
    updates(indicatorData);
    // Checkpoint WAL to main database
    db.pragma('wal_checkpoint(TRUNCATE)');
  }

  return updated;
}

async function main() {
  const args = process.argv.slice(2);
  const db = getDb();

  // Parse date range
  let dateFilter = '';
  if (args.length === 2) {
    dateFilter = `AND DATE(ts, 'unixepoch') >= '${args[0]}' AND DATE(ts, 'unixepoch') <= '${args[1]}'`;
  } else if (args.length === 1) {
    dateFilter = `AND DATE(ts, 'unixepoch') = '${args[0]}'`;
  }

  // Get all unique (symbol, timeframe) pairs needing recomputation.
  // Default: only rows where indicators is empty ('{}').
  // FORCE=1: every row in the date range — required when indicators are
  // partially populated (e.g. 2026-04-17 has hma3/hma15 but null hma5/hma19).
  const baseWhere = FORCE
    ? (dateFilter ? `WHERE ${dateFilter.replace(/^AND /, '')}` : '')
    : `WHERE indicators = '{}' ${dateFilter}`;
  // Tack on symbol filter if SYMBOL env var is set
  let whereClause = baseWhere;
  if (SYMBOL_FILTER && SYMBOL_FILTER.length) {
    const placeholders = SYMBOL_FILTER.map(() => '?').join(',');
    whereClause = baseWhere
      ? `${baseWhere} AND symbol IN (${placeholders})`
      : `WHERE symbol IN (${placeholders})`;
  }
  const pairsStmt = db.prepare(`
    SELECT DISTINCT symbol, timeframe
    FROM ${BAR_TABLE}
    ${whereClause}
    ORDER BY symbol, timeframe
  `);
  const pairs = (SYMBOL_FILTER && SYMBOL_FILTER.length
    ? pairsStmt.all(...SYMBOL_FILTER)
    : pairsStmt.all()) as any[];

  if (FORCE) {
    console.log(`  [FORCE=1] Reprocessing ALL rows in date range regardless of indicator state`);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Computing Indicators — ${pairs.length} symbol/timeframe combos`);
  console.log(`${'═'.repeat(60)}\n`);

  let totalUpdated = 0;
  for (const pair of pairs) {
    process.stdout.write(`  ${pair.symbol} (${pair.timeframe}): `);
    const updated = await computeIndicatorsForSymbol(db, pair.symbol, pair.timeframe);
    console.log(`✓ ${updated} bars updated`);
    totalUpdated += updated;
  }

  db.close();
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  COMPLETE: ${totalUpdated} bars computed`);
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch(console.error);
