/**
 * Tests for missing-dates — coverage gap detection on replay_bars.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { findMissingDates, hasWorkPending } from '../../src/backfill/missing-dates';
import { DENORM_COLS } from '../../src/pipeline/mtf-builder';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  const cols = DENORM_COLS.map(c => `${c} REAL`).join(', ');
  db.exec(`
    CREATE TABLE replay_bars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
      volume INTEGER NOT NULL DEFAULT 0,
      synthetic INTEGER NOT NULL DEFAULT 0,
      gap_type TEXT,
      indicators TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'test',
      ${cols}
    );
    CREATE UNIQUE INDEX idx_replay_bars_symbol_tf_ts
      ON replay_bars(symbol, timeframe, ts);
  `);
  return db;
}

/** Insert N bars at a given TF for (symbol, date). Optionally populate hma5. */
function seed(
  db: Database.Database,
  symbol: string,
  date: string,
  tf: string,
  count: number,
  withIndicators = false,
): void {
  const base = Math.floor(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    14, 30, 0,
  ) / 1000);
  const hma5Value = withIndicators ? 100 : null;
  const stmt = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, hma5)
    VALUES (?, ?, ?, 100, 101, 99, 100, 1, ?)
  `);
  const tfSec = { '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900 }[tf] ?? 60;
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) stmt.run(symbol, tf, base + i * tfSec, hma5Value);
  });
  tx();
}

describe('findMissingDates', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });

  it('returns empty when there are no trading dates', () => {
    const gaps = findMissingDates(db, 'SPX');
    expect(gaps).toEqual([]);
  });

  it('uses explicit tradingDates when given (no anchor lookup)', () => {
    const gaps = findMissingDates(db, 'NDX', {
      tradingDates: ['2026-03-20', '2026-03-21'],
      anchorSymbol: 'SPX',
    });
    expect(gaps.length).toBe(2);
    expect(gaps[0].date).toBe('2026-03-20');
    expect(gaps[0].missingRaw).toBe(true);
    expect(gaps[1].missingRaw).toBe(true);
  });

  it('flags missingRaw when no 1m bars exist for the symbol', () => {
    seed(db, 'SPX', '2026-03-20', '1m', 30);
    const gaps = findMissingDates(db, 'NDX', { anchorSymbol: 'SPX' });
    expect(gaps.length).toBe(1);
    expect(gaps[0].missingRaw).toBe(true);
    expect(gaps[0].missingMtfs).toContain('5m');
    expect(gaps[0].missingIndicators).toContain('1m');
  });

  it('flags missingMtfs when 1m is present but aggregates are absent', () => {
    seed(db, 'SPX', '2026-03-20', '1m', 30, true); // 1m with indicators
    const gaps = findMissingDates(db, 'SPX', { anchorSymbol: 'SPX' });
    expect(gaps.length).toBe(1);
    const g = gaps[0];
    expect(g.missingRaw).toBe(false);
    expect(g.missingMtfs).toEqual(expect.arrayContaining(['2m', '3m', '5m', '10m', '15m']));
    expect(g.missingIndicators).toEqual([]);
  });

  it('flags missingIndicators when aggregates exist but hma5 is null', () => {
    seed(db, 'SPX', '2026-03-20', '1m', 30, true);
    seed(db, 'SPX', '2026-03-20', '5m', 6, false); // aggregates without indicators
    const gaps = findMissingDates(db, 'SPX', { anchorSymbol: 'SPX' });
    const g = gaps[0];
    expect(g.missingRaw).toBe(false);
    expect(g.missingMtfs).not.toContain('5m'); // present
    expect(g.missingIndicators).toContain('5m'); // but indicator nulls
  });

  it('reports a fully-covered date with no work pending', () => {
    seed(db, 'SPX', '2026-03-20', '1m', 30, true);
    for (const tf of ['2m', '3m', '5m', '10m', '15m']) {
      seed(db, 'SPX', '2026-03-20', tf, 5, true);
    }
    const gaps = findMissingDates(db, 'SPX', { anchorSymbol: 'SPX' });
    expect(gaps.length).toBe(1);
    const g = gaps[0];
    expect(g.missingRaw).toBe(false);
    expect(g.missingMtfs).toEqual([]);
    expect(g.missingIndicators).toEqual([]);
    expect(hasWorkPending(g)).toBe(false);
  });

  it('filters to start/end range', () => {
    seed(db, 'SPX', '2026-03-18', '1m', 10);
    seed(db, 'SPX', '2026-03-19', '1m', 10);
    seed(db, 'SPX', '2026-03-20', '1m', 10);
    seed(db, 'SPX', '2026-03-21', '1m', 10);
    const gaps = findMissingDates(db, 'SPX', {
      start: '2026-03-19', end: '2026-03-20', anchorSymbol: 'SPX',
    });
    expect(gaps.map(g => g.date)).toEqual(['2026-03-19', '2026-03-20']);
  });

  it('derives trading dates from the anchor when not provided', () => {
    // NDX has no 1m coverage at all; SPX defines the calendar.
    seed(db, 'SPX', '2026-03-20', '1m', 10);
    seed(db, 'SPX', '2026-03-21', '1m', 10);
    const gaps = findMissingDates(db, 'NDX', { anchorSymbol: 'SPX' });
    expect(gaps.length).toBe(2);
    expect(gaps.every(g => g.missingRaw)).toBe(true);
  });
});

describe('hasWorkPending', () => {
  it('true when raw missing', () => {
    expect(hasWorkPending({
      date: 'x', missingRaw: true, missingMtfs: [], missingIndicators: [],
    })).toBe(true);
  });

  it('true when MTFs missing', () => {
    expect(hasWorkPending({
      date: 'x', missingRaw: false, missingMtfs: ['5m'], missingIndicators: [],
    })).toBe(true);
  });

  it('true when indicators missing', () => {
    expect(hasWorkPending({
      date: 'x', missingRaw: false, missingMtfs: [], missingIndicators: ['5m'],
    })).toBe(true);
  });

  it('false when nothing missing', () => {
    expect(hasWorkPending({
      date: 'x', missingRaw: false, missingMtfs: [], missingIndicators: [],
    })).toBe(false);
  });
});
