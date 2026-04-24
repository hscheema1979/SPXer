/**
 * Signals Database — Persistent storage for detected signals (EOD review)
 *
 * Separate from spxer.db to avoid bloat and rotation issues.
 * Never deleted, grows indefinitely for historical analysis.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const SIGNALS_DB_PATH = path.join(process.cwd(), 'data/signals.db');

let db: Database.Database | null = null;

export function initSignalsDb(): Database.Database {
  if (db) return db;

  // Ensure data directory exists
  const dir = path.dirname(SIGNALS_DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(SIGNALS_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  // Create table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS detected_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      symbol TEXT NOT NULL,
      strike REAL NOT NULL,
      side TEXT NOT NULL,
      direction TEXT NOT NULL,
      offset_label TEXT,
      hma_fast INTEGER NOT NULL,
      hma_slow INTEGER NOT NULL,
      hma_fast_val REAL,
      hma_slow_val REAL,
      timeframe TEXT NOT NULL,
      price REAL,
      ts INTEGER NOT NULL,
      is_fresh INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_date ON detected_signals(date);
    CREATE INDEX IF NOT EXISTS idx_symbol_date ON detected_signals(symbol, date);
    CREATE INDEX IF NOT EXISTS idx_timeframe_date ON detected_signals(timeframe, date);
  `);

  return db;
}

export function getSignalsDb(): Database.Database {
  if (!db) {
    return initSignalsDb();
  }
  return db;
}

export function closeSignalsDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Record a detected signal to the signals DB.
 */
export function recordSignal(signal: {
  date: string;
  symbol: string;
  strike: number;
  side: 'call' | 'put';
  direction: 'bullish' | 'bearish';
  offsetLabel?: string;
  hmaFast: number;
  hmaSlow: number;
  hmaFastVal: number;
  hmaSlowVal: number;
  timeframe: string;
  price: number;
  ts: number;
  isFresh: boolean;
}): void {
  const db = getSignalsDb();

  const stmt = db.prepare(`
    INSERT INTO detected_signals (
      date, symbol, strike, side, direction, offset_label,
      hma_fast, hma_slow, hma_fast_val, hma_slow_val,
      timeframe, price, ts, is_fresh
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    signal.date,
    signal.symbol,
    signal.strike,
    signal.side,
    signal.direction,
    signal.offsetLabel || null,
    signal.hmaFast,
    signal.hmaSlow,
    signal.hmaFastVal,
    signal.hmaSlowVal,
    signal.timeframe,
    signal.price,
    signal.ts,
    signal.isFresh ? 1 : 0
  );
}

/**
 * Get signals for a specific date (for EOD review).
 */
export function getSignalsForDate(date: string): any[] {
  const db = getSignalsDb();

  const stmt = db.prepare(`
    SELECT * FROM detected_signals
    WHERE date = ?
    ORDER BY ts ASC
  `);

  return stmt.all(date);
}

/**
 * Get recent signals (last N days).
 */
export function getRecentSignals(days: number = 7): any[] {
  const db = getSignalsDb();

  const stmt = db.prepare(`
    SELECT * FROM detected_signals
    WHERE date >= date('now', '-' || ? || ' days')
    ORDER BY ts DESC
  `);

  return stmt.all(days);
}
