/**
 * Sweep takeProfitMultiplier from 1.3 to 3.0 in 0.1 increments.
 * Uses the live config across Jan 2 → Apr 2, 2026 (63 trading days).
 * Close pricing (current live behavior — no intrabar).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../src/replay/machine';
import { getAvailableDays } from '../src/replay/framework';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');
const CONFIG_ID = 'hma3x15-undhma-itm5-tp14x-sl70-10k';
const START_DATE = '2026-01-02';
const END_DATE = '2026-04-02';

interface SweepRow {
  tp: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgDaily: number;
  winDays: number;
  totalDays: number;
  bestDay: number;
  worstDay: number;
  avgTrade: number;
}

async function main() {
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(CONFIG_ID) as any;
  if (!row) { console.error(`Config ${CONFIG_ID} not found`); process.exit(1); }
  const baseConfig = JSON.parse(row.config_json);

  const allDates = getAvailableDays(db);
  const dates = allDates.filter(d => d >= START_DATE && d <= END_DATE);

  // Build TP values: 1.3, 1.4, 1.5, ... 3.0
  const tpValues: number[] = [];
  for (let tp = 1.3; tp <= 3.01; tp += 0.1) {
    tpValues.push(Math.round(tp * 10) / 10);
  }

  console.log(`\n  TP Multiplier Sweep: ${tpValues.length} values × ${dates.length} days = ${tpValues.length * dates.length} replays`);
  console.log(`  Config: ${CONFIG_ID} | Close pricing\n`);

  // Register all sweep configs
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO replay_configs (id, name, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, updatedAt=excluded.updatedAt`);

  const configs: Map<number, any> = new Map();
  for (const tp of tpValues) {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    const id = `sweep-tp-${tp.toFixed(1).replace('.', '')}`;
    cfg.id = id;
    cfg.name = `Sweep TP ${tp.toFixed(1)}x`;
    cfg.position.takeProfitMultiplier = tp;
    // Ensure close pricing (no intrabar)
    cfg.exit.exitPricing = 'close';
    upsert.run(id, cfg.name, JSON.stringify(cfg), now, now);
    configs.set(tp, cfg);
    // Clean old results
    db.prepare(`DELETE FROM replay_results WHERE configId = ?`).run(id);
    db.prepare(`DELETE FROM replay_runs WHERE configId = ?`).run(id);
  }
  db.close();

  const results: SweepRow[] = [];
  const totalRuns = tpValues.length * dates.length;
  let completed = 0;
  const startTime = Date.now();

  for (const tp of tpValues) {
    const cfg = configs.get(tp)!;
    const dayPnls: number[] = [];
    let trades = 0, wins = 0;

    for (const date of dates) {
      try {
        const r = await runReplay(cfg, date, {
          dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
        });
        trades += r.trades;
        wins += r.wins;
        dayPnls.push(r.totalPnl);
      } catch (e: any) {
        // skip
      }
      completed++;
      if (completed % 50 === 0 || completed === totalRuns) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completed / elapsed;
        const eta = Math.ceil((totalRuns - completed) / rate);
        process.stdout.write(`  ${completed}/${totalRuns} (${rate.toFixed(1)}/s, ~${eta}s left)     \r`);
      }
    }

    const totalPnl = dayPnls.reduce((s, v) => s + v, 0);
    const winDays = dayPnls.filter(p => p > 0).length;

    results.push({
      tp,
      trades,
      wins,
      winRate: trades > 0 ? wins / trades : 0,
      totalPnl,
      avgDaily: dayPnls.length > 0 ? totalPnl / dayPnls.length : 0,
      winDays,
      totalDays: dayPnls.length,
      bestDay: dayPnls.length > 0 ? Math.max(...dayPnls) : 0,
      worstDay: dayPnls.length > 0 ? Math.min(...dayPnls) : 0,
      avgTrade: trades > 0 ? totalPnl / trades : 0,
    });

    const r = results[results.length - 1];
    console.log(`  TP ${tp.toFixed(1)}x | ${r.trades} trades | WR ${(r.winRate * 100).toFixed(1)}% | P&L ${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(0)} | Avg/day ${r.avgDaily >= 0 ? '+' : ''}$${r.avgDaily.toFixed(0)}`);
  }

  // Summary table
  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;

  console.log(`\n${'='.repeat(100)}`);
  console.log(`  TP MULTIPLIER SWEEP — ${dates.length} days (${START_DATE} → ${END_DATE})`);
  console.log(`${'='.repeat(100)}\n`);

  console.log(`  ${'TP'.padEnd(6)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'Total P&L'.padStart(12)} ${'Avg/Day'.padStart(10)} ${'Avg/Trade'.padStart(11)} ${'WinDays'.padStart(8)} ${'Best Day'.padStart(10)} ${'Worst Day'.padStart(10)}`);
  console.log(`  ${'-'.repeat(6)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(11)} ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);

  let bestTp = results[0];
  for (const r of results) {
    if (r.totalPnl > bestTp.totalPnl) bestTp = r;
    const marker = r.tp === 1.4 ? ' ◄ current' : '';
    console.log(`  ${r.tp.toFixed(1).padEnd(6)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${fmt(r.totalPnl).padStart(12)} ${fmt(r.avgDaily).padStart(10)} ${fmt(r.avgTrade).padStart(11)} ${(r.winDays + '/' + r.totalDays).padStart(8)} ${fmt(r.bestDay).padStart(10)} ${fmt(r.worstDay).padStart(10)}${marker}`);
  }

  console.log(`\n  ★ Best: TP ${bestTp.tp.toFixed(1)}x → ${fmt(bestTp.totalPnl)} total (${fmt(bestTp.avgDaily)}/day)\n`);
}

main().catch(console.error);
