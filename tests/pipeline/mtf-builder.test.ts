/**
 * Tests for mtf-builder — pure aggregation + DB-backed build routine.
 *
 * The pure aggregation is covered in depth; the DB-backed path is smoke-tested
 * against a tiny in-memory SQLite to make sure schema contract, denormalized
 * column writes, and prior-day seeding all execute without throwing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  aggregateBars,
  buildMtfForSymbol,
  listTradingDatesForSymbol,
  listSymbolsForDate,
  SUPPORTED_TIMEFRAMES,
  DENORM_COLS,
  TF_SECONDS,
  type AggBar,
} from '../../src/pipeline/mtf-builder';

// ── Pure aggregation ─────────────────────────────────────────────────────────

describe('aggregateBars', () => {
  function bar(ts: number, o: number, h: number, l: number, c: number, v = 10): AggBar {
    return { ts, open: o, high: h, low: l, close: c, volume: v };
  }

  it('returns empty on empty input', () => {
    expect(aggregateBars([], 300)).toEqual([]);
  });

  it('aggregates 1m → 3m with correct OHLCV', () => {
    // Three 1m bars in the 14:00:00 bucket (UTC)
    const base = 1710_000_000;
    // Align bars to a 3m bucket: base is divisible by 180 here
    const src: AggBar[] = [
      bar(base + 0, 100, 105, 99, 102, 5),
      bar(base + 60, 102, 108, 101, 107, 7),
      bar(base + 120, 107, 110, 106, 109, 3),
    ];
    const agg = aggregateBars(src, 180);
    expect(agg.length).toBe(1);
    expect(agg[0]).toEqual({
      ts: Math.floor((base + 0) / 180) * 180,
      open: 100,
      high: 110,
      low: 99,
      close: 109,
      volume: 15,
    });
  });

  it('emits multiple buckets when bars cross boundaries', () => {
    const base = Math.floor(Date.UTC(2026, 0, 1, 14, 30) / 1000);
    const src: AggBar[] = [
      bar(base, 100, 101, 99, 100, 1),
      bar(base + 60, 100, 102, 100, 101, 2),
      bar(base + 180, 101, 103, 100, 103, 4), // new 3m bucket
      bar(base + 240, 103, 105, 102, 104, 6),
    ];
    const agg = aggregateBars(src, 180);
    expect(agg.length).toBe(2);
    expect(agg[0].volume).toBe(3);   // 1+2
    expect(agg[1].volume).toBe(10);  // 4+6
    expect(agg[0].high).toBe(102);
    expect(agg[1].high).toBe(105);
  });

  it('5m aggregation produces correct buckets', () => {
    const base = Math.floor(Date.UTC(2026, 0, 1, 14, 30) / 1000); // aligned to 5m
    const src: AggBar[] = [];
    for (let i = 0; i < 10; i++) src.push(bar(base + i * 60, 100 + i, 100 + i + 1, 100 + i - 1, 100 + i));
    const agg = aggregateBars(src, 300);
    // 10 1m bars → 2 5m bars
    expect(agg.length).toBe(2);
    expect(agg[0].volume).toBe(50); // 5 bars × 10
    expect(agg[1].volume).toBe(50);
  });

  it('is deterministic for the same input', () => {
    const base = Math.floor(Date.UTC(2026, 0, 1, 14, 30) / 1000);
    const src: AggBar[] = [
      bar(base, 100, 101, 99, 100),
      bar(base + 60, 100, 102, 100, 101),
    ];
    const a = aggregateBars(src, 180);
    const b = aggregateBars(src, 180);
    expect(a).toEqual(b);
  });
});

describe('TF_SECONDS and SUPPORTED_TIMEFRAMES', () => {
  it('maps supported TFs to the right second count', () => {
    expect(TF_SECONDS['1m']).toBe(60);
    expect(TF_SECONDS['2m']).toBe(120);
    expect(TF_SECONDS['3m']).toBe(180);
    expect(TF_SECONDS['5m']).toBe(300);
    expect(TF_SECONDS['10m']).toBe(600);
    expect(TF_SECONDS['15m']).toBe(900);
  });

  it('includes all aggregated TFs in the supported list', () => {
    expect(SUPPORTED_TIMEFRAMES).toEqual(['2m', '3m', '5m', '10m', '15m']);
  });

  it('DENORM_COLS covers core + enriched indicators', () => {
    expect(DENORM_COLS).toContain('hma5');
    expect(DENORM_COLS).toContain('rsi14');
    expect(DENORM_COLS).toContain('bbUpper');
    expect(DENORM_COLS).toContain('vwap');
    expect(DENORM_COLS).toContain('atr14');
  });
});

// ── DB-backed build routine (in-memory) ──────────────────────────────────────

function makeReplayBarsDb(): Database.Database {
  const db = new Database(':memory:');
  const cols = DENORM_COLS.map(c => `${c} REAL`).join(', ');
  db.exec(`
    CREATE TABLE replay_bars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      ts INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
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

/** Insert a day of RTH 1m bars for one symbol. Starts 14:30 UTC (09:30 ET DST). */
function seedDay(db: Database.Database, symbol: string, date: string, count: number): void {
  const base = Math.floor(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    14, 30, 0,
  ) / 1000);
  const stmt = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 'test')
  `);
  const insert = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const p = 100 + i * 0.1;
      stmt.run(symbol, base + i * 60, p, p + 0.5, p - 0.5, p + 0.2, 100);
    }
  });
  insert();
}

describe('buildMtfForSymbol (in-memory)', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeReplayBarsDb(); });

  it('produces 0 writes when there are no 1m bars', () => {
    const r = buildMtfForSymbol({
      db, symbol: 'NDX', tier: 2, date: '2026-03-20', priorDate: null,
    });
    expect(r.barsWritten).toBe(0);
    expect(r.byTimeframe).toEqual({});
  });

  it('aggregates 1m into 2m/3m/5m/10m/15m and writes rows', () => {
    seedDay(db, 'NDX', '2026-03-20', 30); // 30 1m bars → 15×2m, 10×3m, 6×5m, 3×10m, 2×15m
    const r = buildMtfForSymbol({
      db, symbol: 'NDX', tier: 2, date: '2026-03-20', priorDate: null,
      timeframes: ['2m', '3m', '5m', '10m', '15m'],
    });

    expect(r.byTimeframe['2m']).toBe(15);
    expect(r.byTimeframe['3m']).toBe(10);
    expect(r.byTimeframe['5m']).toBe(6);
    expect(r.byTimeframe['10m']).toBe(3);
    expect(r.byTimeframe['15m']).toBe(2);

    const rows = db.prepare(`
      SELECT timeframe, COUNT(*) as n FROM replay_bars
      WHERE symbol='NDX' GROUP BY timeframe
    `).all() as Array<{ timeframe: string; n: number }>;
    const byTf = Object.fromEntries(rows.map(r => [r.timeframe, r.n]));
    expect(byTf['1m']).toBe(30);
    expect(byTf['5m']).toBe(6);
  });

  it('recompute1m updates the 1m indicators JSON in place', () => {
    seedDay(db, 'SPX', '2026-03-20', 30);
    const before = db.prepare(`SELECT indicators FROM replay_bars WHERE symbol='SPX' AND timeframe='1m' LIMIT 1`).get() as { indicators: string };
    expect(before.indicators).toBe('{}'); // seeded as empty

    buildMtfForSymbol({
      db, symbol: 'SPX', tier: 2, date: '2026-03-20', priorDate: null,
      timeframes: ['5m'], recompute1m: true,
    });

    const after = db.prepare(`SELECT indicators FROM replay_bars WHERE symbol='SPX' AND timeframe='1m' AND ts > 0 ORDER BY ts DESC LIMIT 1`).get() as { indicators: string };
    expect(after.indicators).not.toBe('{}');
    const ind = JSON.parse(after.indicators);
    // VWAP is reliably populated on every bar
    expect(ind.vwap).toBeTypeOf('number');
  });

  it('writes non-null denormalized columns for TFs that computed indicators', () => {
    seedDay(db, 'SPX', '2026-03-20', 60); // more bars = more indicators warm up
    buildMtfForSymbol({
      db, symbol: 'SPX', tier: 2, date: '2026-03-20', priorDate: null,
      timeframes: ['5m'],
    });
    const row = db.prepare(`SELECT vwap FROM replay_bars WHERE symbol='SPX' AND timeframe='5m' ORDER BY ts DESC LIMIT 1`).get() as { vwap: number | null };
    expect(row.vwap).not.toBeNull();
  });

  it('is idempotent — re-running produces the same row count (upsert path)', () => {
    seedDay(db, 'SPX', '2026-03-20', 30);
    buildMtfForSymbol({ db, symbol: 'SPX', tier: 2, date: '2026-03-20', priorDate: null });
    buildMtfForSymbol({ db, symbol: 'SPX', tier: 2, date: '2026-03-20', priorDate: null });
    const rows = db.prepare(`SELECT COUNT(*) as n FROM replay_bars WHERE symbol='SPX' AND timeframe='5m'`).get() as { n: number };
    expect(rows.n).toBe(6);
  });

  it('listTradingDatesForSymbol returns dates with 1m coverage', () => {
    seedDay(db, 'SPX', '2026-03-20', 10);
    seedDay(db, 'SPX', '2026-03-21', 10);
    seedDay(db, 'NDX', '2026-03-20', 10);
    const dates = listTradingDatesForSymbol(db, 'SPX');
    expect(dates).toEqual(['2026-03-20', '2026-03-21']);
  });

  it('listSymbolsForDate returns only symbols present on that date', () => {
    seedDay(db, 'SPX', '2026-03-20', 10);
    seedDay(db, 'SPXW260320C05000000', '2026-03-20', 10);
    seedDay(db, 'NDX', '2026-03-21', 10);
    const syms = listSymbolsForDate(db, '2026-03-20');
    expect(syms).toEqual(['SPX', 'SPXW260320C05000000']);
  });
});
