#!/usr/bin/env tsx
/**
 * One-time migration: copy replay tables from data/replay.db into data/spxer.db.
 * Also creates config system tables (models, prompts, configs, active_configs).
 *
 * Safe to run multiple times — uses INSERT OR IGNORE.
 *
 * Usage:
 *   npx tsx scripts/migrate-replay-to-spxer.ts
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const REPLAY_DB = path.resolve(process.cwd(), 'data/replay.db');
const SPXER_DB = path.resolve(process.cwd(), 'data/spxer.db');

function migrate() {
  console.log('=== Migrating replay.db → spxer.db ===\n');

  const replay = new Database(REPLAY_DB, { readonly: true });
  const spxer = new Database(SPXER_DB);
  spxer.pragma('journal_mode = WAL');

  // 1. Create replay tables in spxer.db (matching store.ts schema)
  spxer.exec(`
    CREATE TABLE IF NOT EXISTS replay_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      baselineConfigId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS replay_runs (
      id TEXT PRIMARY KEY,
      configId TEXT NOT NULL,
      date TEXT NOT NULL,
      startedAt INTEGER NOT NULL,
      completedAt INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      FOREIGN KEY(configId) REFERENCES replay_configs(id),
      UNIQUE(configId, date)
    );

    CREATE TABLE IF NOT EXISTS replay_results (
      runId TEXT PRIMARY KEY,
      configId TEXT NOT NULL,
      date TEXT NOT NULL,
      trades INTEGER NOT NULL,
      wins INTEGER NOT NULL,
      winRate REAL NOT NULL,
      totalPnl REAL NOT NULL,
      avgPnlPerTrade REAL,
      maxWin REAL,
      maxLoss REAL,
      maxConsecutiveWins INTEGER,
      maxConsecutiveLosses INTEGER,
      sharpeRatio REAL,
      trades_json TEXT NOT NULL,
      FOREIGN KEY(runId) REFERENCES replay_runs(id),
      FOREIGN KEY(configId) REFERENCES replay_configs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_runs_config ON replay_runs(configId);
    CREATE INDEX IF NOT EXISTS idx_runs_date ON replay_runs(date);
    CREATE INDEX IF NOT EXISTS idx_results_config ON replay_results(configId);
    CREATE INDEX IF NOT EXISTS idx_results_date ON replay_results(date);
  `);

  // 2. Create config system tables (matching manager.ts schema)
  spxer.exec(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('scanner','judge','both')),
      base_url TEXT NOT NULL,
      model_name TEXT NOT NULL,
      api_key_env TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL DEFAULT 180000,
      max_tokens INTEGER NOT NULL DEFAULT 4096,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('scanner','judge')),
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      version TEXT,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      config_json TEXT NOT NULL,
      baseline_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_configs (
      subsystem TEXT PRIMARY KEY,
      config_id TEXT NOT NULL,
      loaded_at INTEGER NOT NULL,
      FOREIGN KEY(config_id) REFERENCES configs(id)
    );
  `);

  // 3. Copy replay_configs
  const configs = replay.prepare('SELECT * FROM replay_configs').all() as any[];
  const insertConfig = spxer.prepare(`
    INSERT OR IGNORE INTO replay_configs (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let configCount = 0;
  for (const c of configs) {
    const result = insertConfig.run(c.id, c.name, c.description, c.config_json, c.baselineConfigId, c.createdAt, c.updatedAt);
    if (result.changes > 0) configCount++;
  }
  console.log(`  replay_configs: ${configCount}/${configs.length} migrated`);

  // 4. Copy replay_runs
  const runs = replay.prepare('SELECT * FROM replay_runs').all() as any[];
  const insertRun = spxer.prepare(`
    INSERT OR IGNORE INTO replay_runs (id, configId, date, startedAt, completedAt, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let runCount = 0;
  for (const r of runs) {
    const result = insertRun.run(r.id, r.configId, r.date, r.startedAt, r.completedAt, r.status, r.error);
    if (result.changes > 0) runCount++;
  }
  console.log(`  replay_runs: ${runCount}/${runs.length} migrated`);

  // 5. Copy replay_results
  const results = replay.prepare('SELECT * FROM replay_results').all() as any[];
  const insertResult = spxer.prepare(`
    INSERT OR IGNORE INTO replay_results (runId, configId, date, trades, wins, winRate, totalPnl, avgPnlPerTrade, maxWin, maxLoss, maxConsecutiveWins, maxConsecutiveLosses, sharpeRatio, trades_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let resultCount = 0;
  for (const r of results) {
    const res = insertResult.run(r.runId, r.configId, r.date, r.trades, r.wins, r.winRate, r.totalPnl, r.avgPnlPerTrade, r.maxWin, r.maxLoss, r.maxConsecutiveWins, r.maxConsecutiveLosses, r.sharpeRatio, r.trades_json);
    if (res.changes > 0) resultCount++;
  }
  console.log(`  replay_results: ${resultCount}/${results.length} migrated`);

  // 6. Verify
  const verifyConfigs = (spxer.prepare('SELECT COUNT(*) as n FROM replay_configs').get() as any).n;
  const verifyRuns = (spxer.prepare('SELECT COUNT(*) as n FROM replay_runs').get() as any).n;
  const verifyResults = (spxer.prepare('SELECT COUNT(*) as n FROM replay_results').get() as any).n;

  console.log(`\n  Verification (spxer.db):`);
  console.log(`    replay_configs: ${verifyConfigs}`);
  console.log(`    replay_runs: ${verifyRuns}`);
  console.log(`    replay_results: ${verifyResults}`);

  replay.close();
  spxer.close();

  console.log('\n=== Migration complete ===');
  console.log('  replay.db can now be archived or deleted.');
  console.log('  All replay data is now in spxer.db.');
}

migrate();
