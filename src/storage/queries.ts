import { getDb } from './db';
import type { Bar, Contract, ContractState } from '../types';
import type { Statement } from 'better-sqlite3';
import { validateBar } from '../core/bar-validator';
import { recordDbWrite } from '../ops/pipeline-health';

// Lazy-initialised prepared statement — created once per DB connection, reused on every call.
// This avoids the overhead of db.prepare() on every row in tight loops.
let _upsertBarStmt: Statement | null = null;

/** Call this whenever the underlying DB is re-initialised (e.g. in tests). */
export function resetPreparedStatements(): void {
  _upsertBarStmt = null;
}

function getUpsertBarStmt(): Statement {
  if (!_upsertBarStmt) {
    _upsertBarStmt = getDb().prepare(`
      INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, spread)
      VALUES (@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume, @synthetic, @gapType, @indicators, @spread)
      ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
        open=excluded.open, high=excluded.high, low=excluded.low,
        close=excluded.close, volume=excluded.volume,
        synthetic=excluded.synthetic, gap_type=excluded.gap_type,
        indicators=excluded.indicators,
        spread=COALESCE(excluded.spread, bars.spread)
    `);
  }
  return _upsertBarStmt;
}

export function upsertBar(bar: Bar): boolean {
  // Last-line-of-defence validation — providers should have already filtered,
  // but this catches anything that slipped through (e.g. synthetic bars with bad prices)
  if (!validateBar(bar).valid) return false;
  try {
    getUpsertBarStmt().run({
      ...bar,
      synthetic: bar.synthetic ? 1 : 0,
      gapType: bar.gapType,
      indicators: JSON.stringify(bar.indicators),
      spread: bar.spread ?? null,
    });
    return true;
  } catch (err) {
    console.error(`[db] upsertBar failed for ${bar.symbol} ts=${bar.ts}:`, err);
    return false;
  }
}

export function upsertBars(bars: Bar[]): { written: number; failed: number } {
  let written = 0;
  let failed = 0;
  try {
    const db = getDb();
    const insert = db.transaction((rows: Bar[]) => {
      for (const row of rows) {
        if (upsertBar(row)) written++; else failed++;
      }
    });
    insert(bars);
  } catch (err) {
    // Transaction itself failed (e.g. DB locked beyond busy_timeout)
    failed += bars.length - written;
    console.error(`[db] upsertBars transaction failed after ${written}/${bars.length} writes:`, err);
  }
  if (failed > 0) {
    console.error(`[db] upsertBars: ${failed} bars lost for symbols: ${[...new Set(bars.map(b => b.symbol))].join(', ')}`);
  }
  recordDbWrite(bars.length, written);
  return { written, failed };
}

export function getBars(symbol: string, timeframe: string, n: number): Bar[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM bars WHERE symbol=? AND timeframe=?
    ORDER BY ts DESC LIMIT ?
  `).all(symbol, timeframe, n) as any[];
  return rows.reverse().map(rowToBar);
}

export function getLatestBar(symbol: string, timeframe: string): Bar | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM bars WHERE symbol=? AND timeframe=? ORDER BY ts DESC LIMIT 1
  `).get(symbol, timeframe) as any;
  return row ? rowToBar(row) : null;
}

export function upsertContract(contract: Contract): void {
  try {
    getDb().prepare(`
      INSERT INTO contracts (symbol, type, underlying, strike, expiry, state, first_seen, last_bar_ts, created_at)
      VALUES (@symbol, @type, @underlying, @strike, @expiry, @state, @firstSeen, @lastBarTs, @createdAt)
      ON CONFLICT(symbol) DO UPDATE SET
        state=excluded.state, last_bar_ts=excluded.last_bar_ts
    `).run(contract);
  } catch (err) {
    console.error(`[db] upsertContract failed for ${contract.symbol}:`, err);
  }
}

export function getContractsByState(...states: ContractState[]): Contract[] {
  const db = getDb();
  const placeholders = states.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM contracts WHERE state IN (${placeholders})`
  ).all(...states) as any[];
  return rows.map(rowToContract);
}

export function getAllActiveContracts(): Contract[] {
  return getContractsByState('ACTIVE', 'STICKY');
}

export function getExpiredContracts(): Contract[] {
  return getContractsByState('EXPIRED');
}

/** Bulk-expire contracts with expiry before the given date */
export function expireContractsBefore(dateET: string): number {
  try {
    const db = getDb();
    const result = db.prepare(
      `UPDATE contracts SET state='EXPIRED' WHERE expiry < ? AND state IN ('ACTIVE', 'STICKY')`
    ).run(dateET);
    return result.changes;
  } catch (err) {
    console.error(`[db] expireContractsBefore failed:`, err);
    return 0;
  }
}

/** Expire today's contracts (for after RTH close) */
export function expireContractsOnDate(dateET: string): number {
  try {
    const db = getDb();
    const result = db.prepare(
      `UPDATE contracts SET state='EXPIRED' WHERE expiry = ? AND state IN ('ACTIVE', 'STICKY')`
    ).run(dateET);
    return result.changes;
  } catch (err) {
    console.error(`[db] expireContractsOnDate failed:`, err);
    return 0;
  }
}

export function deleteBarsBySymbols(symbols: string[]): void {
  try {
    const db = getDb();
    const placeholders = symbols.map(() => '?').join(',');
    db.prepare(`DELETE FROM bars WHERE symbol IN (${placeholders})`).run(...symbols);
  } catch (err) {
    console.error(`[db] deleteBarsBySymbols failed for ${symbols.length} symbols:`, err);
  }
}

export function insertSignal(signal: {
  symbol: string; strike: number; expiry: string; side: string;
  direction: string; offsetLabel: string; hmaFast: number; hmaSlow: number;
  hmaFastVal: number; hmaSlowVal: number; timeframe: string;
  price: number; ts: number;
}): void {
  try {
    getDb().prepare(`
      INSERT INTO signals (symbol, strike, expiry, side, direction, offset_label,
        hma_fast, hma_slow, hma_fast_val, hma_slow_val, timeframe, price, ts)
      VALUES (@symbol, @strike, @expiry, @side, @direction, @offsetLabel,
        @hmaFast, @hmaSlow, @hmaFastVal, @hmaSlowVal, @timeframe, @price, @ts)
    `).run(signal);
  } catch (err) {
    console.error(`[db] insertSignal failed for ${signal.symbol}:`, err);
  }
}

export function getLatestSignals(opts: {
  offsetLabel?: string; timeframe?: string; hmaPair?: string; limit?: number;
}): any[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: any[] = [];
  if (opts.offsetLabel) { clauses.push('offset_label = ?'); params.push(opts.offsetLabel); }
  if (opts.timeframe) { clauses.push('timeframe = ?'); params.push(opts.timeframe); }
  if (opts.hmaPair) {
    const [f, s] = opts.hmaPair.split('_');
    clauses.push('hma_fast = ? AND hma_slow = ?');
    params.push(Number(f), Number(s));
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = opts.limit || 50;
  return db.prepare(
    `SELECT * FROM signals ${where} ORDER BY ts DESC LIMIT ?`
  ).all(...params, limit);
}

export function getDbSizeMb(): number {
  const db = getDb();
  const result = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
  return Math.round(result.size / 1024 / 1024 * 10) / 10;
}

function rowToBar(row: any): Bar {
  let indicators: Record<string, number> = {};
  try {
    indicators = JSON.parse(row.indicators || '{}');
  } catch {
    console.warn(`[db] rowToBar: corrupt indicators JSON for ${row.symbol} ts=${row.ts} — using empty`);
  }
  const bar: Bar = {
    symbol: row.symbol, timeframe: row.timeframe, ts: row.ts,
    open: row.open, high: row.high, low: row.low, close: row.close,
    volume: row.volume, synthetic: row.synthetic === 1,
    gapType: row.gap_type, indicators,
  };
  if (row.spread != null) bar.spread = row.spread;
  return bar;
}

function rowToContract(row: any): Contract {
  return {
    symbol: row.symbol, type: row.type, underlying: row.underlying,
    strike: row.strike, expiry: row.expiry, state: row.state,
    firstSeen: row.first_seen, lastBarTs: row.last_bar_ts, createdAt: row.created_at,
  };
}

export function getOptionBarHealth(sinceTs: number): { total: number; synthetic: number; stale: number; contracts: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN synthetic = 1 THEN 1 ELSE 0 END) as synthetic,
      SUM(CASE WHEN gap_type = 'stale' THEN 1 ELSE 0 END) as stale,
      COUNT(DISTINCT symbol) as contracts
    FROM bars
    WHERE timeframe = '1m'
      AND ts >= ?
      AND symbol LIKE 'SPXW%'
  `).get(sinceTs) as any;
  return {
    total: row?.total ?? 0,
    synthetic: row?.synthetic ?? 0,
    stale: row?.stale ?? 0,
    contracts: row?.contracts ?? 0,
  };
}
