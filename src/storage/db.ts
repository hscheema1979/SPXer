import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

let db: DB;

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations();
}

export function getDb(): DB {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}

function runMigrations(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bars (
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
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bars_symbol_tf_ts
      ON bars(symbol, timeframe, ts);
    CREATE TABLE IF NOT EXISTS contracts (
      symbol      TEXT PRIMARY KEY,
      type        TEXT NOT NULL,
      underlying  TEXT NOT NULL DEFAULT 'SPX',
      strike      REAL NOT NULL,
      expiry      TEXT NOT NULL,
      state       TEXT NOT NULL DEFAULT 'UNSEEN',
      first_seen  INTEGER,
      last_bar_ts INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
