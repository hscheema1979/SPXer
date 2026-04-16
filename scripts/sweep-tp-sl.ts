/**
 * Sweep stopLossPercent from 20% to 90% in 5% increments,
 * across the top TP configs from the year sweep.
 * Full year (256 trading days). Resumable.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../src/replay/machine';
import { getAvailableDays } from '../src/replay/framework';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

// Top TP configs from year sweep (by Sharpe)
const TP_VALUES = [1.3, 1.5, 1.6, 1.7, 1.8, 2.0, 2.5, 3.0, 5.0];

// SL values: 20% to 90% in 5% increments
const SL_VALUES: number[] = [];
for (let sl = 20; sl <= 90; sl += 5) {
  SL_VALUES.push(sl);
}

async function main() {
  const db = new Database(DB_PATH);

  // Load base config
  const baseRow = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
    .get('hma3x15-undhma-itm5-tp14x-sl70-10k') as any;
  if (!baseRow) { console.error('Base config not found'); process.exit(1); }
  const baseConfig = JSON.parse(baseRow.config_json);

  const allDates = getAvailableDays(db);
  console.log(`  Available dates: ${allDates.length}`);

  // Build all combos
  const combos: { tp: number; sl: number; id: string }[] = [];
  for (const tp of TP_VALUES) {
    for (const sl of SL_VALUES) {
      combos.push({ tp, sl, id: `sweep-tpsl-tp${tp.toFixed(1).replace('.','')}-sl${sl}` });
    }
  }

  // Check existing
  const existingResults = db.prepare(
    `SELECT configId, date FROM replay_results WHERE configId LIKE 'sweep-tpsl-%'`
  ).all() as { configId: string; date: string }[];
  const doneSet = new Set(existingResults.map(r => `${r.configId}|${r.date}`));

  // Register configs
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO replay_configs (id, name, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, updatedAt=excluded.updatedAt`);

  const configMap: Map<string, any> = new Map();
  for (const c of combos) {
    const cfg = JSON.parse(JSON.stringify(baseConfig));
    cfg.id = c.id;
    cfg.name = `TP ${c.tp.toFixed(1)}x SL ${c.sl}%`;
    cfg.position.takeProfitMultiplier = c.tp;
    cfg.position.stopLossPercent = c.sl;
    cfg.exit = cfg.exit || {};
    cfg.exit.exitPricing = 'close';
    upsert.run(c.id, cfg.name, JSON.stringify(cfg), now, now);
    configMap.set(c.id, cfg);
  }

  // Build work plan
  let totalRemaining = 0;
  const workPlan: { id: string; tp: number; sl: number; dates: string[] }[] = [];
  for (const c of combos) {
    const remaining = allDates.filter(d => !doneSet.has(`${c.id}|${d}`));
    workPlan.push({ ...c, dates: remaining });
    totalRemaining += remaining.length;
  }

  const totalAll = combos.length * allDates.length;
  const alreadyDone = totalAll - totalRemaining;

  console.log(`\n  TP×SL Sweep: ${TP_VALUES.length} TPs × ${SL_VALUES.length} SLs = ${combos.length} configs × ${allDates.length} days = ${totalAll} replays`);
  console.log(`  Already completed: ${alreadyDone}`);
  console.log(`  Remaining: ${totalRemaining}`);
  console.log(`  TP values: ${TP_VALUES.map(t => t.toFixed(1) + 'x').join(', ')}`);
  console.log(`  SL values: ${SL_VALUES.map(s => s + '%').join(', ')}\n`);

  db.close();

  if (totalRemaining === 0) {
    console.log('  All runs complete!\n');
  }

  // Run replays
  let completed = 0;
  const startTime = Date.now();

  for (const work of workPlan) {
    if (work.dates.length === 0) continue;

    const cfg = configMap.get(work.id)!;
    for (const date of work.dates) {
      try {
        await runReplay(cfg, date, {
          dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
        });
      } catch (e: any) {
        // skip
      }
      completed++;
      if (completed % 50 === 0 || completed === totalRemaining) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completed / elapsed;
        const eta = Math.ceil((totalRemaining - completed) / rate);
        const etaMin = Math.floor(eta / 60);
        const etaSec = eta % 60;
        process.stdout.write(`  ${completed}/${totalRemaining} (${rate.toFixed(1)}/s, ~${etaMin}m${etaSec}s left)     \r`);
      }
    }
    console.log(`  ✓ ${work.id} — ${work.dates.length} days`);
  }

  // Summary — aggregate by TP×SL
  const db2 = new Database(DB_PATH);
  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;

  console.log(`\n${'='.repeat(130)}`);
  console.log(`  TP × SL SWEEP — ${allDates.length} days (${allDates[0]} → ${allDates[allDates.length - 1]})`);
  console.log(`${'='.repeat(130)}\n`);

  // Header
  const slHeader = SL_VALUES.map(s => `SL${s}%`.padStart(10)).join('');
  console.log(`  ${'TP'.padEnd(6)}${slHeader}`);
  console.log(`  ${'-'.repeat(6)}${SL_VALUES.map(() => '-'.repeat(10)).join('')}`);

  // Track best overall
  let bestCombo = { tp: 0, sl: 0, sharpe: -Infinity, pnl: 0 };
  let bestPnlCombo = { tp: 0, sl: 0, sharpe: 0, pnl: -Infinity };

  // Build grid: rows = TP, cols = SL, cells = Sharpe
  const grid: Map<string, { sharpe: number; pnl: number; wr: number; days: number }> = new Map();

  for (const c of combos) {
    const rows = db2.prepare(
      `SELECT totalPnl, wins, trades FROM replay_results WHERE configId = ?`
    ).all(c.id) as { totalPnl: number; wins: number; trades: number }[];

    if (rows.length === 0) { grid.set(c.id, { sharpe: 0, pnl: 0, wr: 0, days: 0 }); continue; }

    const dayPnls = rows.map(r => r.totalPnl);
    const totalPnl = dayPnls.reduce((s, v) => s + v, 0);
    const mean = totalPnl / rows.length;
    const variance = dayPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / rows.length;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? mean / std : 0;
    const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
    const totalWins = rows.reduce((s, r) => s + r.wins, 0);
    const wr = totalTrades > 0 ? totalWins / totalTrades : 0;

    grid.set(c.id, { sharpe, pnl: totalPnl, wr, days: rows.length });

    if (sharpe > bestCombo.sharpe) bestCombo = { tp: c.tp, sl: c.sl, sharpe, pnl: totalPnl };
    if (totalPnl > bestPnlCombo.pnl) bestPnlCombo = { tp: c.tp, sl: c.sl, sharpe, pnl: totalPnl };
  }

  // Print Sharpe grid
  console.log('\n  SHARPE RATIO:');
  console.log(`  ${'TP'.padEnd(6)}${slHeader}`);
  console.log(`  ${'-'.repeat(6)}${SL_VALUES.map(() => '-'.repeat(10)).join('')}`);
  for (const tp of TP_VALUES) {
    let row = `  ${tp.toFixed(1).padEnd(6)}`;
    for (const sl of SL_VALUES) {
      const id = `sweep-tpsl-tp${tp.toFixed(1).replace('.','')}-sl${sl}`;
      const g = grid.get(id);
      const val = g ? g.sharpe.toFixed(3) : '?';
      const isBest = g && g.sharpe === bestCombo.sharpe;
      row += (isBest ? `★${val}` : val).padStart(10);
    }
    console.log(row);
  }

  // Print P&L grid
  console.log('\n  TOTAL P&L ($K):');
  console.log(`  ${'TP'.padEnd(6)}${slHeader}`);
  console.log(`  ${'-'.repeat(6)}${SL_VALUES.map(() => '-'.repeat(10)).join('')}`);
  for (const tp of TP_VALUES) {
    let row = `  ${tp.toFixed(1).padEnd(6)}`;
    for (const sl of SL_VALUES) {
      const id = `sweep-tpsl-tp${tp.toFixed(1).replace('.','')}-sl${sl}`;
      const g = grid.get(id);
      const val = g ? `${(g.pnl / 1000).toFixed(0)}K` : '?';
      const isBest = g && g.pnl === bestPnlCombo.pnl;
      row += (isBest ? `★${val}` : val).padStart(10);
    }
    console.log(row);
  }

  console.log(`\n  ★ Best Sharpe: TP ${bestCombo.tp.toFixed(1)}x + SL ${bestCombo.sl}% → Sharpe ${bestCombo.sharpe.toFixed(3)}, ${fmt(bestCombo.pnl)}`);
  console.log(`  ★ Best P&L:    TP ${bestPnlCombo.tp.toFixed(1)}x + SL ${bestPnlCombo.sl}% → ${fmt(bestPnlCombo.pnl)}, Sharpe ${bestPnlCombo.sharpe.toFixed(3)}`);
  console.log();

  db2.close();
}

main().catch(console.error);
