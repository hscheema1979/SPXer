/**
 * Replay database helpers — connection factory + migrations.
 *
 * Single database: spxer.db (data/spxer.db)
 *
 * Tables:
 *   replay_bars         — historical backfill bars (SQLite fallback; parquet is primary)
 *   replay_configs      — strategy configs (shared with live agent)
 *   replay_runs         — replay execution records
 *   replay_results      — replay trade results
 *   replay_jobs         — batch job tracking
 *   leaderboard_reports — config leaderboard snapshots
 *   optimizer_results   — autoresearch parameter search results
 *   bars                — live pipeline bars (NOT used by replay)
 *   contracts           — live pipeline contracts
 */

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as path from 'path';

let replayDb: DB | null = null;

/** All replay data lives in spxer.db — bar data, configs, results, runs. */
export const REPLAY_DB_DEFAULT = path.resolve(process.cwd(), process.env.DB_PATH || 'data/spxer.db');

/** Alias — same DB. Kept for call-site clarity (configs/results vs bar queries). */
export const REPLAY_META_DB = REPLAY_DB_DEFAULT;

export function initReplayDb(dbPath?: string): void {
  const p = dbPath || REPLAY_DB_DEFAULT;
  replayDb = new Database(p);
  replayDb.pragma('journal_mode = WAL');
  replayDb.pragma('foreign_keys = ON');
  replayDb.pragma('wal_autocheckpoint = 1000');
  replayDb.pragma('synchronous = NORMAL');
  replayDb.pragma('busy_timeout = 10000');
  replayDb.pragma('cache_size = -64000');
  replayDb.pragma('temp_store = MEMORY');

  runReplayMigrations(replayDb);

  // Simple 15-min PASSIVE checkpoint — replay writes are bursty (backfill,
  // replay runs) not continuous, so autocheckpoint alone usually suffices.
  // This is insurance for long backfill jobs.
  setInterval(() => {
    try {
      if (!replayDb) return;
      const result = replayDb.pragma('wal_checkpoint(PASSIVE)') as Array<{busy: number; log: number; checkpointed: number}>;
      const { log, checkpointed } = result[0] ?? { log: 0, checkpointed: 0 };
      if (log > 100) {
        console.log(`[replay-db] WAL passive checkpoint: ${checkpointed}/${log} pages flushed`);
      }
    } catch (err) {
      console.error('[replay-db] WAL checkpoint failed:', err);
    }
  }, 15 * 60 * 1000);
}

export function getReplayDb(): DB {
  if (!replayDb) throw new Error('Replay DB not initialized — call initReplayDb() first');
  return replayDb;
}

export function closeReplayDb(): void {
  if (replayDb) {
    replayDb.close();
    replayDb = null;
  }
}

function runReplayMigrations(db: DB): void {
  // replay_configs — strategy configurations (also read by live agent on boot)
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      baselineConfigId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `);

  // replay_runs — execution records
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
  `);

  // replay_results — trade statistics
  db.exec(`
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

  // ── Migration: add R-multiple columns if missing ──
  const colCheck = db.prepare("PRAGMA table_info(replay_results)").all() as { name: string }[];
  const colNames = new Set(colCheck.map(c => c.name));
  if (!colNames.has('sumWinPct')) {
    db.exec(`
      ALTER TABLE replay_results ADD COLUMN sumWinPct REAL DEFAULT 0;
      ALTER TABLE replay_results ADD COLUMN cntWins INTEGER DEFAULT 0;
      ALTER TABLE replay_results ADD COLUMN sumLossPct REAL DEFAULT 0;
      ALTER TABLE replay_results ADD COLUMN cntLosses INTEGER DEFAULT 0;
    `);
  }

  // replay_jobs — batch job tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_jobs (
      id TEXT PRIMARY KEY,
      configId TEXT NOT NULL,
      configName TEXT NOT NULL,
      dates_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      completed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      currentDate TEXT,
      results_json TEXT DEFAULT '[]',
      error TEXT,
      pid INTEGER,
      startedAt INTEGER NOT NULL,
      completedAt INTEGER,
      kind TEXT NOT NULL DEFAULT 'replay',
      profile_id TEXT,
      progress_json TEXT NOT NULL DEFAULT '{}'
    );
  `);

  // leaderboard_reports
  db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      configId TEXT NOT NULL,
      report_md TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // optimizer_results
  db.exec(`
    CREATE TABLE IF NOT EXISTS optimizer_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      label TEXT,
      score REAL,
      metrics_json TEXT,
      createdAt INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}
