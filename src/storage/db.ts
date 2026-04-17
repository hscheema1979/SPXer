import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as fs from 'fs';

let db: DB;

export function initDb(path: string): void {
  db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Auto-checkpoint every 1000 pages (~4MB): SQLite automatically runs a PASSIVE checkpoint
  // inline with writes once the WAL reaches this size. PASSIVE never blocks readers or writers.
  // better-sqlite3 is fully synchronous so there is no "event loop blocking" concern —
  // every DB call already blocks. This keeps WAL bounded without a manual interval.
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('synchronous = NORMAL');   // Faster writes, still durable with WAL
  db.pragma('busy_timeout = 5000');     // Wait 5s on lock instead of failing immediately
  db.pragma('cache_size = -64000');     // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY');     // Temp tables in memory
  runMigrations();
  runConfigMigrations();

  // WAL management — two strategies:
  //
  // 1. Every 15 min: PASSIVE checkpoint (non-blocking, flushes committed pages)
  // 2. Every 2 hours: TRUNCATE checkpoint (resets WAL file to zero)
  //    Uses RESTART first to flush all pages, then TRUNCATE.
  //    If readers block TRUNCATE, falls back to RESTART (which still shrinks WAL).
  //
  // The old hourly TRUNCATE was always skipped because other processes (metrics,
  // dashboard, agents) hold open read connections. RESTART+TRUNCATE is more aggressive.

  // Frequent PASSIVE flush — keeps WAL pages committed to main DB
  setInterval(() => {
    try {
      const d = getDb();
      const result = d.pragma('wal_checkpoint(PASSIVE)') as Array<{busy: number; log: number; checkpointed: number}>;
      const { log, checkpointed } = result[0] ?? { log: 0, checkpointed: 0 };
      if (log > 0) {
        console.log(`[db] WAL passive checkpoint: ${checkpointed}/${log} pages flushed`);
      }
    } catch (err) {
      console.error('[db] WAL passive checkpoint failed:', err);
    }
  }, 15 * 60 * 1000); // every 15 min

  // Aggressive TRUNCATE — reclaim WAL disk space
  setInterval(() => {
    try {
      const d = getDb();
      const before = getDbStats();

      // Skip if WAL is already small
      if (before.walSizeMb < 50) {
        console.log(`[db] WAL is ${before.walSizeMb}MB — truncate not needed`);
        return;
      }

      // Try TRUNCATE directly (resets WAL file to zero)
      try {
        d.pragma('wal_checkpoint(TRUNCATE)');
        const after = getDbStats();
        console.log(`[db] WAL truncated: ${before.walSizeMb}MB → ${after.walSizeMb}MB`);
        return;
      } catch {
        // TRUNCATE failed (readers blocking) — fall back to RESTART
      }

      // RESTART flushes all pages and resets but doesn't truncate the file
      try {
        d.pragma('wal_checkpoint(RESTART)');
        const after = getDbStats();
        console.log(`[db] WAL restart checkpoint: ${before.walSizeMb}MB → ${after.walSizeMb}MB (truncate blocked by readers)`);
      } catch (err) {
        console.warn(`[db] WAL restart checkpoint failed: ${err}`);
      }
    } catch (err) {
      console.error('[db] WAL truncate cycle failed:', err);
    }
  }, 2 * 60 * 60 * 1000); // every 2 hours

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
