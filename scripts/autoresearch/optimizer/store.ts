/**
 * Optimizer results store — tracks every parameter variant tested.
 * Lives in the same spxer.db as market data and replay results.
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

export interface OptimizerResult {
  id: string;
  dimension: string;
  label: string;
  configDelta: Record<string, any>;
  dateSet: string;
  phase: string;
  datesRun: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgDailyPnl: number;
  worstDay: number;
  bestDay: number;
  sharpe: number;
  compositeScore: number;
  daily: Array<{ date: string; trades: number; wins: number; pnl: number }>;
  runtimeMs: number;
  createdAt: number;
}

export class OptimizerStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath || DB_PATH);
    this.db.pragma('journal_mode = WAL');
    this.initTable();
  }

  private initTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS optimizer_results (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL,
        label TEXT NOT NULL,
        config_delta TEXT NOT NULL,
        date_set TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'explore',
        dates_run INTEGER NOT NULL,
        trades INTEGER NOT NULL,
        wins INTEGER NOT NULL,
        win_rate REAL NOT NULL,
        total_pnl REAL NOT NULL,
        avg_daily_pnl REAL NOT NULL,
        worst_day REAL NOT NULL,
        best_day REAL NOT NULL,
        sharpe REAL NOT NULL,
        composite_score REAL NOT NULL,
        daily_json TEXT NOT NULL,
        runtime_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opt_dim ON optimizer_results(dimension);
      CREATE INDEX IF NOT EXISTS idx_opt_score ON optimizer_results(composite_score DESC);
    `);
  }

  insert(r: OptimizerResult): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO optimizer_results
      (id, dimension, label, config_delta, date_set, phase, dates_run, trades, wins,
       win_rate, total_pnl, avg_daily_pnl, worst_day, best_day, sharpe, composite_score,
       daily_json, runtime_ms, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      r.id, r.dimension, r.label, JSON.stringify(r.configDelta), r.dateSet, r.phase,
      r.datesRun, r.trades, r.wins, r.winRate, r.totalPnl, r.avgDailyPnl,
      r.worstDay, r.bestDay, r.sharpe, r.compositeScore,
      JSON.stringify(r.daily), r.runtimeMs, r.createdAt,
    );
  }

  getByDimension(dimension: string): OptimizerResult[] {
    return this.db.prepare(
      'SELECT * FROM optimizer_results WHERE dimension=? ORDER BY composite_score DESC'
    ).all(dimension).map(this.mapRow);
  }

  getBestByDimension(dimension: string): OptimizerResult | null {
    const row = this.db.prepare(
      'SELECT * FROM optimizer_results WHERE dimension=? ORDER BY composite_score DESC LIMIT 1'
    ).get(dimension);
    return row ? this.mapRow(row) : null;
  }

  getTopN(n: number, phase?: string): OptimizerResult[] {
    const sql = phase
      ? 'SELECT * FROM optimizer_results WHERE phase=? ORDER BY composite_score DESC LIMIT ?'
      : 'SELECT * FROM optimizer_results ORDER BY composite_score DESC LIMIT ?';
    const rows = phase
      ? this.db.prepare(sql).all(phase, n)
      : this.db.prepare(sql).all(n);
    return rows.map(this.mapRow);
  }

  getBaseline(): OptimizerResult | null {
    const row = this.db.prepare(
      "SELECT * FROM optimizer_results WHERE dimension='baseline' ORDER BY created_at DESC LIMIT 1"
    ).get();
    return row ? this.mapRow(row) : null;
  }

  getSummary(): {
    totalVariants: number;
    dimensions: Array<{ name: string; count: number; bestScore: number; bestLabel: string }>;
    top5: OptimizerResult[];
    baseline: OptimizerResult | null;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM optimizer_results').get() as any).n;
    const dims = this.db.prepare(`
      SELECT dimension, COUNT(*) as cnt,
        MAX(composite_score) as best_score,
        (SELECT label FROM optimizer_results o2
         WHERE o2.dimension = optimizer_results.dimension
         ORDER BY composite_score DESC LIMIT 1) as best_label
      FROM optimizer_results GROUP BY dimension ORDER BY best_score DESC
    `).all() as any[];

    return {
      totalVariants: total,
      dimensions: dims.map(d => ({
        name: d.dimension, count: d.cnt, bestScore: d.best_score, bestLabel: d.best_label,
      })),
      top5: this.getTopN(5),
      baseline: this.getBaseline(),
    };
  }

  close(): void {
    this.db.close();
  }

  private mapRow(row: any): OptimizerResult {
    return {
      id: row.id,
      dimension: row.dimension,
      label: row.label,
      configDelta: JSON.parse(row.config_delta),
      dateSet: row.date_set,
      phase: row.phase,
      datesRun: row.dates_run,
      trades: row.trades,
      wins: row.wins,
      winRate: row.win_rate,
      totalPnl: row.total_pnl,
      avgDailyPnl: row.avg_daily_pnl,
      worstDay: row.worst_day,
      bestDay: row.best_day,
      sharpe: row.sharpe,
      compositeScore: row.composite_score,
      daily: JSON.parse(row.daily_json),
      runtimeMs: row.runtime_ms,
      createdAt: row.created_at,
    };
  }
}
