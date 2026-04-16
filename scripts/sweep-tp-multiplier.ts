/**
 * Sweep takeProfitMultiplier from 1.3 to 3.0 in 0.1 increments.
 * RESUMABLE — skips configs/dates that already have results.
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

  // Build TP values: 1.3, 1.4, 1.5, ... 10.0
  const tpValues: number[] = [];
  for (let tp = 1.3; tp <= 10.01; tp += 0.1) {
    tpValues.push(Math.round(tp * 10) / 10);
  }

  // Check what's already done
  const existingResults = db.prepare(
    `SELECT configId, date FROM replay_results WHERE configId LIKE 'sweep-tp-%'`
  ).all() as { configId: string; date: string }[];
  
  const doneSet = new Set(existingResults.map(r => `${r.configId}|${r.date}`));

  // Count remaining work
  let totalRemaining = 0;
  const workPlan: { tp: number; dates: string[] }[] = [];
  for (const tp of tpValues) {
    const id = `sweep-tp-${tp.toFixed(1).replace('.', '')}`;
    const remaining = dates.filter(d => !doneSet.has(`${id}|${d}`));
    if (remaining.length > 0) {
      workPlan.push({ tp, dates: remaining });
      totalRemaining += remaining.length;
    }
  }

  const alreadyDone = tpValues.length * dates.length - totalRemaining;
  console.log(`\n  TP Multiplier Sweep: ${tpValues.length} values × ${dates.length} days`);
  console.log(`  Already completed: ${alreadyDone} replays`);
  console.log(`  Remaining: ${totalRemaining} replays across ${workPlan.length} TP values`);
  console.log(`  Config: ${CONFIG_ID} | Close pricing\n`);

  if (totalRemaining === 0) {
    console.log('  All sweep runs already complete! Generating summary...\n');
  }

  // Register sweep configs (upsert — won't overwrite existing)
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
    cfg.exit = cfg.exit || {};
    cfg.exit.exitPricing = 'close';
    upsert.run(id, cfg.name, JSON.stringify(cfg), now, now);
    configs.set(tp, cfg);
  }
  db.close();

  // Run remaining replays
  let completed = 0;
  const startTime = Date.now();

  for (const work of workPlan) {
    const cfg = configs.get(work.tp)!;
    const id = `sweep-tp-${work.tp.toFixed(1).replace('.', '')}`;

    for (const date of work.dates) {
      try {
        await runReplay(cfg, date, {
          dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
        });
      } catch (e: any) {
        console.error(`  ✗ ${id} ${date}: ${e.message}`);
      }
      completed++;
      if (completed % 10 === 0 || completed === totalRemaining) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completed / elapsed;
        const eta = Math.ceil((totalRemaining - completed) / rate);
        const etaMin = Math.floor(eta / 60);
        const etaSec = eta % 60;
        process.stdout.write(`  ${completed}/${totalRemaining} (${rate.toFixed(1)}/s, ~${etaMin}m${etaSec}s left)     \r`);
      }
    }

    // Print progress for this TP value
    console.log(`  ✓ TP ${work.tp.toFixed(1)}x — ${work.dates.length} days completed`);
  }

  // Now gather all results for summary
  const db2 = new Database(DB_PATH);
  const results: SweepRow[] = [];

  for (const tp of tpValues) {
    const id = `sweep-tp-${tp.toFixed(1).replace('.', '')}`;
    const rows = db2.prepare(
      `SELECT trades, wins, totalPnl, winRate FROM replay_results WHERE configId = ?`
    ).all(id) as { trades: number; wins: number; totalPnl: number; winRate: number }[];

    if (rows.length === 0) continue;

    const trades = rows.reduce((s, r) => s + r.trades, 0);
    const wins = rows.reduce((s, r) => s + r.wins, 0);
    const dayPnls = rows.map(r => r.totalPnl);
    const totalPnl = dayPnls.reduce((s, v) => s + v, 0);
    const winDays = dayPnls.filter(p => p > 0).length;

    results.push({
      tp,
      trades,
      wins,
      winRate: trades > 0 ? wins / trades : 0,
      totalPnl,
      avgDaily: rows.length > 0 ? totalPnl / rows.length : 0,
      winDays,
      totalDays: rows.length,
      bestDay: Math.max(...dayPnls),
      worstDay: Math.min(...dayPnls),
      avgTrade: trades > 0 ? totalPnl / trades : 0,
    });
  }
  db2.close();

  // Summary table
  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;

  console.log(`\n${'='.repeat(110)}`);
  console.log(`  TP MULTIPLIER SWEEP — ${dates.length} days (${START_DATE} → ${END_DATE})`);
  console.log(`${'='.repeat(110)}\n`);

  console.log(`  ${'TP'.padEnd(6)} ${'Days'.padStart(5)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'Total P&L'.padStart(12)} ${'Avg/Day'.padStart(10)} ${'Avg/Trade'.padStart(11)} ${'WinDays'.padStart(8)} ${'Best Day'.padStart(10)} ${'Worst Day'.padStart(10)}`);
  console.log(`  ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(12)} ${'-'.repeat(10)} ${'-'.repeat(11)} ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);

  let bestTp = results[0];
  for (const r of results) {
    if (r.totalPnl > bestTp.totalPnl) bestTp = r;
    const marker = r.tp === 1.4 ? ' ◄ current' : '';
    console.log(`  ${r.tp.toFixed(1).padEnd(6)} ${String(r.totalDays).padStart(5)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${fmt(r.totalPnl).padStart(12)} ${fmt(r.avgDaily).padStart(10)} ${fmt(r.avgTrade).padStart(11)} ${(r.winDays + '/' + r.totalDays).padStart(8)} ${fmt(r.bestDay).padStart(10)} ${fmt(r.worstDay).padStart(10)}${marker}`);
  }

  console.log(`\n  ★ Best: TP ${bestTp.tp.toFixed(1)}x → ${fmt(bestTp.totalPnl)} total (${fmt(bestTp.avgDaily)}/day)`);
  
  // Compute delta vs current 1.4x
  const current = results.find(r => r.tp === 1.4);
  if (current && bestTp.tp !== 1.4) {
    const delta = bestTp.totalPnl - current.totalPnl;
    console.log(`  Δ vs 1.4x (current): ${fmt(delta)} over ${dates.length} days`);
  }
  console.log();
}

main().catch(console.error);
