/**
 * Run top Sharpe TP configs across the full year (256 trading days).
 * Top 5 Sharpe: 1.5, 1.6, 1.8, 1.3, 1.7
 * Plus high-P&L comparisons: 2.0, 2.5, 3.0, 5.0
 * Resumable — skips dates that already have results.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../src/replay/machine';
import { getAvailableDays } from '../src/replay/framework';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');
const BASE_CONFIG_ID = 'hma3x15-undhma-itm5-tp14x-sl70-10k';

// Top 5 Sharpe + key high-P&L configs
const TP_VALUES = [1.3, 1.5, 1.6, 1.7, 1.8, 2.0, 2.5, 3.0, 5.0];

async function main() {
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(BASE_CONFIG_ID) as any;
  if (!row) { console.error(`Config ${BASE_CONFIG_ID} not found`); process.exit(1); }
  const baseConfig = JSON.parse(row.config_json);

  const allDates = getAvailableDays(db);
  console.log(`  Total available dates: ${allDates.length}`);

  // Use full-year config IDs (distinct from the 3-month sweep)
  const configIds = TP_VALUES.map(tp => `year-tp-${tp.toFixed(1).replace('.', '')}`);

  // Check existing results
  const existingResults = db.prepare(
    `SELECT configId, date FROM replay_results WHERE configId LIKE 'year-tp-%'`
  ).all() as { configId: string; date: string }[];
  const doneSet = new Set(existingResults.map(r => `${r.configId}|${r.date}`));

  // Register configs
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO replay_configs (id, name, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, updatedAt=excluded.updatedAt`);

  const configs: Map<number, any> = new Map();
  for (const tp of TP_VALUES) {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    const id = `year-tp-${tp.toFixed(1).replace('.', '')}`;
    cfg.id = id;
    cfg.name = `Year TP ${tp.toFixed(1)}x`;
    cfg.position.takeProfitMultiplier = tp;
    cfg.exit = cfg.exit || {};
    cfg.exit.exitPricing = 'close';
    upsert.run(id, cfg.name, JSON.stringify(cfg), now, now);
    configs.set(tp, cfg);
  }

  // Build work plan
  let totalRemaining = 0;
  const workPlan: { tp: number; id: string; dates: string[] }[] = [];
  for (const tp of TP_VALUES) {
    const id = `year-tp-${tp.toFixed(1).replace('.', '')}`;
    const remaining = allDates.filter(d => !doneSet.has(`${id}|${d}`));
    workPlan.push({ tp, id, dates: remaining });
    totalRemaining += remaining.length;
  }

  const totalAll = TP_VALUES.length * allDates.length;
  const alreadyDone = totalAll - totalRemaining;
  console.log(`\n  Full-Year TP Sweep: ${TP_VALUES.length} configs × ${allDates.length} days = ${totalAll} replays`);
  console.log(`  Already completed: ${alreadyDone}`);
  console.log(`  Remaining: ${totalRemaining}`);
  console.log(`  TP values: ${TP_VALUES.map(t => t.toFixed(1) + 'x').join(', ')}\n`);

  db.close();

  if (totalRemaining === 0) {
    console.log('  All runs complete!\n');
  }

  // Run replays
  let completed = 0;
  const startTime = Date.now();

  for (const work of workPlan) {
    if (work.dates.length === 0) {
      console.log(`  ✓ TP ${work.tp.toFixed(1)}x — already complete (${allDates.length} days)`);
      continue;
    }

    const cfg = configs.get(work.tp)!;

    for (const date of work.dates) {
      try {
        await runReplay(cfg, date, {
          dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
        });
      } catch (e: any) {
        console.error(`  ✗ ${work.id} ${date}: ${e.message}`);
      }
      completed++;
      if (completed % 20 === 0 || completed === totalRemaining) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completed / elapsed;
        const eta = Math.ceil((totalRemaining - completed) / rate);
        const etaMin = Math.floor(eta / 60);
        const etaSec = eta % 60;
        process.stdout.write(`  ${completed}/${totalRemaining} (${rate.toFixed(1)}/s, ~${etaMin}m${etaSec}s left)     \r`);
      }
    }

    console.log(`  ✓ TP ${work.tp.toFixed(1)}x — ${work.dates.length} days completed`);
  }

  // Summary
  const db2 = new Database(DB_PATH);
  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;

  console.log(`\n${'='.repeat(120)}`);
  console.log(`  FULL-YEAR TP SWEEP — ${allDates.length} days (${allDates[0]} → ${allDates[allDates.length - 1]})`);
  console.log(`${'='.repeat(120)}\n`);

  console.log(`  ${'TP'.padEnd(6)} ${'Days'.padStart(5)} ${'Trades'.padStart(7)} ${'WR%'.padStart(7)} ${'Total P&L'.padStart(14)} ${'Avg/Day'.padStart(10)} ${'Avg/Trade'.padStart(11)} ${'Sharpe'.padStart(8)} ${'WinDays'.padStart(9)} ${'Best Day'.padStart(12)} ${'Worst Day'.padStart(12)}`);
  console.log(`  ${'-'.repeat(6)} ${'-'.repeat(5)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(14)} ${'-'.repeat(10)} ${'-'.repeat(11)} ${'-'.repeat(8)} ${'-'.repeat(9)} ${'-'.repeat(12)} ${'-'.repeat(12)}`);

  interface YearResult {
    tp: number;
    days: number;
    trades: number;
    wins: number;
    winRate: number;
    totalPnl: number;
    avgDaily: number;
    avgTrade: number;
    sharpe: number;
    winDays: number;
    bestDay: number;
    worstDay: number;
  }

  const results: YearResult[] = [];

  for (const tp of TP_VALUES) {
    const id = `year-tp-${tp.toFixed(1).replace('.', '')}`;
    const rows = db2.prepare(
      `SELECT trades, wins, totalPnl FROM replay_results WHERE configId = ?`
    ).all(id) as { trades: number; wins: number; totalPnl: number }[];

    if (rows.length === 0) continue;

    const trades = rows.reduce((s, r) => s + r.trades, 0);
    const wins = rows.reduce((s, r) => s + r.wins, 0);
    const dayPnls = rows.map(r => r.totalPnl);
    const totalPnl = dayPnls.reduce((s, v) => s + v, 0);
    const avgDaily = totalPnl / rows.length;
    const winDays = dayPnls.filter(p => p > 0).length;
    const mean = avgDaily;
    const variance = dayPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / rows.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std : 0;

    const r: YearResult = {
      tp, days: rows.length, trades, wins,
      winRate: trades > 0 ? wins / trades : 0,
      totalPnl, avgDaily,
      avgTrade: trades > 0 ? totalPnl / trades : 0,
      sharpe, winDays,
      bestDay: Math.max(...dayPnls),
      worstDay: Math.min(...dayPnls),
    };
    results.push(r);

    const marker = tp === 1.4 ? ' ◄ current' : '';
    console.log(`  ${tp.toFixed(1).padEnd(6)} ${String(r.days).padStart(5)} ${String(r.trades).padStart(7)} ${(r.winRate * 100).toFixed(1).padStart(6)}% ${fmt(r.totalPnl).padStart(14)} ${fmt(r.avgDaily).padStart(10)} ${fmt(r.avgTrade).padStart(11)} ${r.sharpe.toFixed(3).padStart(8)} ${(r.winDays + '/' + r.days).padStart(9)} ${fmt(r.bestDay).padStart(12)} ${fmt(r.worstDay).padStart(12)}${marker}`);
  }

  // Best by Sharpe
  const bestSharpe = results.reduce((a, b) => a.sharpe > b.sharpe ? a : b);
  const bestPnl = results.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
  console.log(`\n  ★ Best Sharpe: TP ${bestSharpe.tp.toFixed(1)}x → Sharpe ${bestSharpe.sharpe.toFixed(3)}, ${fmt(bestSharpe.totalPnl)} total`);
  console.log(`  ★ Best P&L:    TP ${bestPnl.tp.toFixed(1)}x → ${fmt(bestPnl.totalPnl)} total, Sharpe ${bestPnl.sharpe.toFixed(3)}`);
  console.log();

  db2.close();
}

main().catch(console.error);
