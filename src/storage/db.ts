import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as fs from 'fs';

let db: DB;

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('wal_autocheckpoint = 0'); // disable auto-checkpoint; checkpoint manually to avoid blocking event loop
  db.pragma('synchronous = NORMAL');   // Faster writes, still durable with WAL
  db.pragma('busy_timeout = 5000');     // Wait 5s on lock instead of failing immediately
  db.pragma('cache_size = -64000');     // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY');     // Temp tables in memory
  runMigrations();
  runConfigMigrations();

  // Checkpoint WAL every 5 minutes to prevent unbounded growth
  setInterval(() => {
    try {
      const d = getDb();
      d.pragma('wal_checkpoint(TRUNCATE)');
      console.log('[db] WAL checkpoint complete');
    } catch (err) {
      console.error('[db] WAL checkpoint failed:', err);
    }
  }, 5 * 60 * 1000);

  // Daily backup
  setInterval(() => backupDb(), 24 * 60 * 60 * 1000);
  // Also backup immediately on first init
  setTimeout(() => backupDb(), 10_000);
}

export function getDb(): DB {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function closeDb(): void {
  if (db) db.close();
}

/** @deprecated ConfigManager removed — configs live in replay_configs via ReplayStore */

export function backupDb(): void {
  try {
    const d = getDb();
    const backupPath = (process.env.DB_PATH || './data/spxer.db') + '.backup';
    d.backup(backupPath);
    console.log(`[db] backup complete: ${backupPath}`);
  } catch (err) {
    console.error('[db] backup failed:', err);
  }
}

export function getDbStats(): { sizeMb: number; walSizeMb: number } {
  const dbPath = process.env.DB_PATH || './data/spxer.db';
  const sizeMb = fs.existsSync(dbPath) ? fs.statSync(dbPath).size / (1024 * 1024) : 0;
  const walPath = dbPath + '-wal';
  const walSizeMb = fs.existsSync(walPath) ? fs.statSync(walPath).size / (1024 * 1024) : 0;
  return { sizeMb: Math.round(sizeMb * 10) / 10, walSizeMb: Math.round(walSizeMb * 10) / 10 };
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

/** Add replay tables to the single DB. */
function runConfigMigrations(): void {
  // Create replay tables (migrated from replay.db)
  // NOTE: Uses camelCase columns to match existing DB schema and query code
  // in replay/store.ts and server/replay-routes.ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_runs (
      id          TEXT PRIMARY KEY,
      configId    TEXT NOT NULL,
      date        TEXT NOT NULL,
      startedAt   INTEGER NOT NULL,
      completedAt INTEGER,
      status      TEXT NOT NULL,
      error       TEXT,
      FOREIGN KEY(configId) REFERENCES replay_configs(id),
      UNIQUE(configId, date)
    );
    CREATE INDEX IF NOT EXISTS idx_runs_config ON replay_runs(configId);
    CREATE INDEX IF NOT EXISTS idx_runs_date ON replay_runs(date);

    CREATE TABLE IF NOT EXISTS replay_results (
      runId       TEXT PRIMARY KEY,
      configId    TEXT NOT NULL,
      date        TEXT NOT NULL,
      trades      INTEGER NOT NULL,
      wins        INTEGER NOT NULL,
      winRate     REAL NOT NULL,
      totalPnl    REAL NOT NULL,
      avgPnlPerTrade REAL,
      maxWin      REAL,
      maxLoss     REAL,
      maxConsecutiveWins INTEGER,
      maxConsecutiveLosses INTEGER,
      sharpeRatio REAL,
      trades_json TEXT NOT NULL,
      FOREIGN KEY(runId) REFERENCES replay_runs(id),
      FOREIGN KEY(configId) REFERENCES replay_configs(id)
    );
    CREATE INDEX IF NOT EXISTS idx_results_config ON replay_results(configId);
    CREATE INDEX IF NOT EXISTS idx_results_date ON replay_results(date);
  `);
}
