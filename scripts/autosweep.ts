#!/usr/bin/env npx tsx
/**
 * autosweep.ts — Deterministic grid sweep of config parameter space.
 *
 * Generates config combinations, runs 23-day backtests via runReplay(),
 * which stores results in the standard replay_results table.
 * The leaderboard page at /replay/sweep aggregates these results.
 *
 * Fully resumable: skips configs that already have all dates tested.
 *
 * Usage:
 *   npx tsx scripts/autosweep.ts                    # run full sweep
 *   npx tsx scripts/autosweep.ts --dry-run           # show configs without running
 *   npx tsx scripts/autosweep.ts --status            # show progress summary
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config/defaults';
import { runReplay } from '../src/replay/machine';
import { createStore } from '../src/replay/store';
import { getAvailableDays } from '../src/replay/framework';
import type { Config } from '../src/config/types';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

// ── CLI flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else flags[a.slice(2)] = 'true';
  }
}
const DRY_RUN = flags['dry-run'] === 'true';
const STATUS = flags['status'] === 'true';
const SHARD = flags['shard'] || '';  // e.g. "2/5" = shard 2 of 5
const ENABLE_KC = flags['kc'] === 'true';  // Enable Keltner Channel trend gate

// ── Parameter space ────────────────────────────────────────────────────────

interface SweepParam {
  hmaFast: number;
  hmaSlow: number;
  dirTf: string;
  exitTf: string;
  stopLoss: number;
  tpMult: number;
}

function generateConfigs(): SweepParam[] {
  const hmaFast = [5, 7];
  const hmaSlow = [19, 21, 23, 25, 27, 29];
  const dirExit: [string, string][] = [
    ['2m', '2m'], ['2m', '3m'], ['2m', '5m'],
    ['3m', '2m'], ['3m', '3m'], ['3m', '5m'],
    ['5m', '2m'], ['5m', '3m'], ['5m', '5m'],
  ];
  const stopLoss = [0, 40, 80];
  const tpMult = [3, 5, 8];

  const configs: SweepParam[] = [];
  for (const f of hmaFast) {
    for (const s of hmaSlow) {
      if (f >= s) continue;
      for (const [dt, et] of dirExit) {
        for (const sl of stopLoss) {
          for (const tp of tpMult) {
            configs.push({ hmaFast: f, hmaSlow: s, dirTf: dt, exitTf: et, stopLoss: sl, tpMult: tp });
          }
        }
      }
    }
  }
  return configs;
}

function paramToConfigId(p: SweepParam): string {
  const prefix = ENABLE_KC ? 'sw4-kc' : 'sw3';
  return `${prefix}-f${p.hmaFast}s${p.hmaSlow}-${p.dirTf}d${p.exitTf}e-sl${p.stopLoss}-tp${p.tpMult}`;
}

function paramToName(p: SweepParam): string {
  const kc = ENABLE_KC ? ' +KC' : '';
  return `HMA ${p.hmaFast}×${p.hmaSlow}${kc} | ${p.dirTf}D/${p.exitTf}E | SL${p.stopLoss}% | TP${p.tpMult}x`;
}

function paramToConfig(p: SweepParam): Config {
  const base = mergeConfig(DEFAULT_CONFIG, {
    id: paramToConfigId(p),
    name: paramToName(p),
    description: `Grid sweep: f${p.hmaFast}/s${p.hmaSlow}, dir=${p.dirTf}, exit=${p.exitTf}, SL=${p.stopLoss}%, TP=${p.tpMult}x${ENABLE_KC ? ', KC enabled' : ''}`,
    exit: {
      ...DEFAULT_CONFIG.exit,
      strategy: 'scannerReverse' as const,
    },
    signals: {
      ...DEFAULT_CONFIG.signals,
      hmaCrossFast: p.hmaFast,
      hmaCrossSlow: p.hmaSlow,
      directionTimeframe: p.dirTf,
      exitTimeframe: p.exitTf,
      requireUnderlyingHmaCross: true,
      // KC settings
      enableKeltnerGate: ENABLE_KC,
      kcSlopeThreshold: ENABLE_KC ? 0.3 : 0.3,  // default threshold
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: p.stopLoss,
      takeProfitMultiplier: p.tpMult,
    },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false },
  } as any);
  return base;
}

// ── Check completion status from replay_results ────────────────────────────

function getCompletedCounts(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`
    SELECT configId, COUNT(DISTINCT date) as days
    FROM replay_results
    GROUP BY configId
  `).all() as { configId: string; days: number }[];
  return new Map(rows.map(r => [r.configId, r.days]));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const dates = getAvailableDays(db);
  const totalDays = dates.length;
  const completedCounts = getCompletedCounts(db);
  db.close();

  const allParams = generateConfigs();

  // A config is "done" if it has results for all available dates
  let remaining = allParams.filter(p => {
    const count = completedCounts.get(paramToConfigId(p)) || 0;
    return count < totalDays;
  });

  // Apply sharding: --shard=X/N takes every Nth remaining config starting at index X-1
  let shardLabel = '';
  if (SHARD) {
    const [shardStr, totalStr] = SHARD.split('/');
    const shardIdx = parseInt(shardStr) - 1;  // 0-based
    const shardTotal = parseInt(totalStr);
    if (shardIdx >= 0 && shardTotal > 0 && shardIdx < shardTotal) {
      remaining = remaining.filter((_, i) => i % shardTotal === shardIdx);
      shardLabel = ` [shard ${shardStr}/${totalStr}]`;
    }
  }

  if (STATUS) {
    const done = allParams.length - allParams.filter(p => (completedCounts.get(paramToConfigId(p)) || 0) < totalDays).length;
    console.log(`\n  Sweep Status`);
    console.log(`  ${'─'.repeat(40)}`);
    console.log(`  Total configs:   ${allParams.length}`);
    console.log(`  Complete:        ${done} (${(done / allParams.length * 100).toFixed(1)}%)`);
    console.log(`  Remaining:       ${allParams.length - done}`);
    console.log(`  Trading days:    ${totalDays}`);
    console.log(`  Est. remaining:  ~${(((allParams.length - done) * totalDays * 0.3) / 60).toFixed(0)} minutes\n`);
    return;
  }

  const totalRemaining = allParams.filter(p => (completedCounts.get(paramToConfigId(p)) || 0) < totalDays).length;

  console.log(`\n${'═'.repeat(80)}`);
  const modeLabel = ENABLE_KC ? ' [KC-ENABLED]' : '';
  console.log(`  AUTOSWEEP — Deterministic Grid Sweep${shardLabel}${modeLabel}`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`  Total configs:   ${allParams.length}`);
  console.log(`  Already done:    ${allParams.length - totalRemaining}`);
  console.log(`  Remaining:       ${remaining.length}`);
  console.log(`  Trading days:    ${totalDays}`);

  if (DRY_RUN) {
    console.log(`\n  DRY RUN — first 20 pending configs:\n`);
    for (const p of remaining.slice(0, 20)) {
      const daysHave = completedCounts.get(paramToConfigId(p)) || 0;
      console.log(`    ${paramToConfigId(p).padEnd(48)} (${daysHave}/${totalDays} days)`);
    }
    if (remaining.length > 20) console.log(`    ... and ${remaining.length - 20} more`);
    console.log();
    return;
  }

  if (remaining.length === 0) {
    console.log(`\n  All ${allParams.length} configs fully tested across ${totalDays} days.`);
    console.log(`  View results at: http://localhost:3601/replay/sweep\n`);
    return;
  }

  console.log(`  Est. time:       ~${((remaining.length * totalDays * 0.3) / 60).toFixed(0)} minutes`);
  console.log(`${'═'.repeat(80)}\n`);

  const store = createStore();
  const startTime = Date.now();
  let done = 0;

  for (const params of remaining) {
    const configId = paramToConfigId(params);
    const cfg = paramToConfig(params);

    // Save config to replay store
    store.saveConfig(cfg);

    // Figure out which dates are missing for this config
    const existingDates = new Set<string>();
    const checkDb = new Database(DB_PATH, { readonly: true });
    const existingRows = checkDb.prepare(
      'SELECT DISTINCT date FROM replay_results WHERE configId = ?'
    ).all(configId) as { date: string }[];
    for (const r of existingRows) existingDates.add(r.date);
    checkDb.close();

    const missingDates = dates.filter(d => !existingDates.has(d));

    let totalPnl = 0;
    let totalTrades = 0;
    let totalWins = 0;

    for (const date of missingDates) {
      try {
        const r = await runReplay(cfg, date, { verbose: false, noJudge: true });
        totalPnl += r.totalPnl;
        totalTrades += r.trades;
        totalWins += r.wins;
      } catch { /* skip */ }
    }

    done++;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = elapsed / done;
    const eta = ((remaining.length - done) * rate / 60).toFixed(0);

    const pnlSign = totalPnl >= 0 ? '+' : '';
    const emoji = totalPnl >= 0 ? '📈' : '📉';
    process.stdout.write(
      `\r  ${emoji} ${String(allParams.length - remaining.length + done).padStart(4)}/${allParams.length} ` +
      `| ${paramToName(params).slice(0, 42).padEnd(42)} ` +
      `| ${pnlSign}$${totalPnl.toFixed(0).padStart(7)} (${missingDates.length} new days) ` +
      `| ETA ${eta}m   `
    );
  }

  store.close();
  console.log(`\n\n  Done. View results at: http://localhost:3601/replay/sweep\n`);
}

main().catch(err => {
  console.error(`FATAL: ${err.message || err}`);
  process.exit(1);
});
