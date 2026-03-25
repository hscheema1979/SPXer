/**
 * Replay store — persistent storage for configs, runs, and results.
 * Uses the unified spxer.db database (replay tables created by config migration).
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import type { ReplayConfig, ReplayRun, ReplayResult } from './types';

// Unified database — replay tables live in spxer.db alongside market data and configs
const REPLAY_DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

export class ReplayStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || REPLAY_DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
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
  }

  // ── Configs ────────────────────────────────────────────────────────────────

  saveConfig(config: ReplayConfig) {
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_configs
      (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(config.id, config.name, config.description || '', JSON.stringify(config), config.baselineId || null, config.createdAt, Date.now());
  }

  getConfig(id: string): ReplayConfig | null {
    const row = this.db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as any;
    return row ? JSON.parse(row.config_json) : null;
  }

  listConfigs(): ReplayConfig[] {
    const rows = this.db.prepare('SELECT config_json FROM replay_configs ORDER BY createdAt DESC').all() as any[];
    return rows.map(r => JSON.parse(r.config_json));
  }

  deleteConfig(id: string) {
    this.db.prepare('DELETE FROM replay_configs WHERE id = ?').run(id);
  }

  // ── Runs ───────────────────────────────────────────────────────────────────

  createRun(configId: string, date: string): string {
    const id = `${configId}-${date}-${Date.now()}`;
    // Clean up previous runs for same config+date to avoid FK conflicts
    const oldRuns = this.db.prepare(
      'SELECT id FROM replay_runs WHERE configId = ? AND date = ?'
    ).all(configId, date) as any[];
    for (const old of oldRuns) {
      this.db.prepare('DELETE FROM replay_results WHERE runId = ?').run(old.id);
      this.db.prepare('DELETE FROM replay_runs WHERE id = ?').run(old.id);
    }
    this.db.prepare(`
      INSERT INTO replay_runs (id, configId, date, startedAt, status)
      VALUES (?, ?, ?, ?, 'running')
    `).run(id, configId, date, Date.now());
    return id;
  }

  completeRun(runId: string) {
    this.db.prepare('UPDATE replay_runs SET status = ?, completedAt = ? WHERE id = ?')
      .run('completed', Date.now(), runId);
  }

  failRun(runId: string, error: string) {
    this.db.prepare('UPDATE replay_runs SET status = ?, completedAt = ?, error = ? WHERE id = ?')
      .run('failed', Date.now(), error, runId);
  }

  getRun(id: string): ReplayRun | null {
    return this.db.prepare('SELECT * FROM replay_runs WHERE id = ?').get(id) as ReplayRun | null;
  }

  getLatestRun(configId: string): ReplayRun | null {
    return this.db.prepare('SELECT * FROM replay_runs WHERE configId = ? ORDER BY startedAt DESC LIMIT 1')
      .get(configId) as ReplayRun | null;
  }

  // ── Results ────────────────────────────────────────────────────────────────

  saveResult(result: ReplayResult) {
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_results
      (runId, configId, date, trades, wins, winRate, totalPnl, avgPnlPerTrade,
       maxWin, maxLoss, maxConsecutiveWins, maxConsecutiveLosses, sharpeRatio, trades_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      result.runId, result.configId, result.date, result.trades, result.wins,
      result.winRate, result.totalPnl, result.avgPnlPerTrade, result.maxWin,
      result.maxLoss, result.maxConsecutiveWins, result.maxConsecutiveLosses,
      result.sharpeRatio, result.trades_json,
    );
  }

  getResultsByConfig(configId: string): ReplayResult[] {
    return this.db.prepare('SELECT * FROM replay_results WHERE configId = ? ORDER BY date ASC')
      .all(configId) as ReplayResult[];
  }

  getResultsByDate(date: string): ReplayResult[] {
    return this.db.prepare('SELECT * FROM replay_results WHERE date = ? ORDER BY configId ASC')
      .all(date) as ReplayResult[];
  }

  // ── Summaries ──────────────────────────────────────────────────────────────

  getConfigSummary(configId: string) {
    return this.db.prepare(`
      SELECT configId,
        COUNT(*) as totalRuns,
        SUM(trades) as totalTrades,
        SUM(wins) as totalWins,
        AVG(winRate) as avgWinRate,
        SUM(totalPnl) as cumulativePnl,
        AVG(totalPnl) as avgDailyPnl,
        MAX(totalPnl) as bestDay,
        MIN(totalPnl) as worstDay
      FROM replay_results WHERE configId = ?
    `).get(configId) as any;
  }

  compareConfigs(configId1: string, configId2: string) {
    const c1 = this.getConfigSummary(configId1);
    const c2 = this.getConfigSummary(configId2);
    return {
      config1: { id: configId1, ...c1 },
      config2: { id: configId2, ...c2 },
      difference: {
        totalTrades: (c2?.totalTrades || 0) - (c1?.totalTrades || 0),
        winRateDiff: (c2?.avgWinRate || 0) - (c1?.avgWinRate || 0),
        pnlDiff: (c2?.cumulativePnl || 0) - (c1?.cumulativePnl || 0),
      },
    };
  }

  exportResultsToCsv(configId: string): string {
    const results = this.getResultsByConfig(configId);
    const lines = [
      'Date,Trades,Wins,Win Rate,Total P&L,Avg P&L,Max Win,Max Loss',
      ...results.map(r =>
        `${r.date},${r.trades},${r.wins},${(r.winRate * 100).toFixed(1)}%,$${r.totalPnl.toFixed(0)},${r.avgPnlPerTrade?.toFixed(2) || ''},$${r.maxWin?.toFixed(0) || ''},$${r.maxLoss?.toFixed(0) || ''}`
      ),
    ];
    return lines.join('\n');
  }

  close() {
    this.db.close();
  }
}

export function createStore(dbPath?: string): ReplayStore {
  return new ReplayStore(dbPath);
}
