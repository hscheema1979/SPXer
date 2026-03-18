import { getDb } from './db';
import type { Bar, Contract, ContractState } from '../types';

export function upsertBar(bar: Bar): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators)
    VALUES (@symbol, @timeframe, @ts, @open, @high, @low, @close, @volume, @synthetic, @gapType, @indicators)
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume,
      synthetic=excluded.synthetic, gap_type=excluded.gap_type,
      indicators=excluded.indicators
  `).run({
    ...bar,
    synthetic: bar.synthetic ? 1 : 0,
    gapType: bar.gapType,
    indicators: JSON.stringify(bar.indicators),
  });
}

export function upsertBars(bars: Bar[]): void {
  const db = getDb();
  const insert = db.transaction((rows: Bar[]) => rows.forEach(upsertBar));
  insert(bars);
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
  getDb().prepare(`
    INSERT INTO contracts (symbol, type, underlying, strike, expiry, state, first_seen, last_bar_ts, created_at)
    VALUES (@symbol, @type, @underlying, @strike, @expiry, @state, @firstSeen, @lastBarTs, @createdAt)
    ON CONFLICT(symbol) DO UPDATE SET
      state=excluded.state, last_bar_ts=excluded.last_bar_ts
  `).run(contract);
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

export function deleteBarsBySymbols(symbols: string[]): void {
  const db = getDb();
  const placeholders = symbols.map(() => '?').join(',');
  db.prepare(`DELETE FROM bars WHERE symbol IN (${placeholders})`).run(...symbols);
}

export function getDbSizeMb(): number {
  const db = getDb();
  const result = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
  return Math.round(result.size / 1024 / 1024 * 10) / 10;
}

function rowToBar(row: any): Bar {
  return {
    symbol: row.symbol, timeframe: row.timeframe, ts: row.ts,
    open: row.open, high: row.high, low: row.low, close: row.close,
    volume: row.volume, synthetic: row.synthetic === 1,
    gapType: row.gap_type, indicators: JSON.parse(row.indicators || '{}'),
  };
}

function rowToContract(row: any): Contract {
  return {
    symbol: row.symbol, type: row.type, underlying: row.underlying,
    strike: row.strike, expiry: row.expiry, state: row.state,
    firstSeen: row.first_seen, lastBarTs: row.last_bar_ts, createdAt: row.created_at,
  };
}
