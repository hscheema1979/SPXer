/**
 * run-variant.ts — Run ONE config variant across N dates.
 * Outputs structured JSON to stdout. The agent reads this and decides what to do next.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/optimizer/run-variant.ts \
 *     --dimension=stopLoss --label="SL 70%" --dates=quick6 \
 *     --config='{"position":{"stopLossPercent":70}}'
 *
 * Dates presets:
 *   quick6  — 6 representative dates (fast: ~30s)
 *   full22  — all 22 dates (~2-3 min)
 *   CSV     — custom: "2026-02-20,2026-03-02"
 */

import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import * as fs from 'fs';
import * as path from 'path';
import { runReplay } from '../../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../../src/config/defaults';
import { ReplayStore } from '../../../src/replay/store';
import { OptimizerStore } from './store';
import type { Config } from '../../../src/config/types';

const QUICK6 = ['2026-02-20', '2026-02-24', '2026-03-05', '2026-03-10', '2026-03-19', '2026-03-20'];
const FULL22 = [
  '2026-02-20', '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27',
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-23',
];

// Parse flags
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const eq = a.indexOf('=');
  if (eq > 0) {
    flags[a.slice(2, eq)] = a.slice(eq + 1);
  } else {
    flags[a.replace(/^--/, '')] = 'true';
  }
}

const dimension = flags.dimension || 'unknown';
const label = flags.label || dimension;
const phase = flags.phase || 'explore';
const dateSet = flags.dates || 'quick6';
const dates = dateSet === 'quick6' ? QUICK6
  : dateSet === 'full22' ? FULL22
  : dateSet.split(',');

async function main() {
  // Build config: baseline + delta
  let baseConfig: Config = { ...DEFAULT_CONFIG };
  const baselinePath = path.resolve(process.cwd(), 'autoresearch-config.json');
  if (fs.existsSync(baselinePath)) {
    baseConfig = mergeConfig(baseConfig, JSON.parse(fs.readFileSync(baselinePath, 'utf-8')));
  }

  let configDelta: Record<string, any> = {};
  if (flags.config) {
    configDelta = JSON.parse(flags.config);
  } else if (flags['config-file']) {
    configDelta = JSON.parse(fs.readFileSync(path.resolve(flags['config-file']), 'utf-8'));
  }

  const config = mergeConfig(baseConfig, configDelta);
  const configId = `opt-${dimension}-${Date.now()}`;
  config.id = configId;
  config.name = `Optimizer: ${label}`;

  // Save config for FK constraint
  const replayStore = new ReplayStore();
  replayStore.saveConfig(config);
  replayStore.close();

  // Run replays
  const startTime = Date.now();
  const daily: Array<{ date: string; trades: number; wins: number; pnl: number }> = [];
  let totalTrades = 0, totalWins = 0, totalPnl = 0;
  let worstDay = 0, bestDay = 0;

  for (const date of dates) {
    try {
      const result = await runReplay(config, date, { verbose: false, noJudge: true });
      daily.push({ date, trades: result.trades, wins: result.wins, pnl: result.totalPnl });
      totalTrades += result.trades;
      totalWins += result.wins;
      totalPnl += result.totalPnl;
      if (result.totalPnl < worstDay) worstDay = result.totalPnl;
      if (result.totalPnl > bestDay) bestDay = result.totalPnl;
    } catch {
      daily.push({ date, trades: 0, wins: 0, pnl: 0 });
    }
  }

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const avgDailyPnl = daily.length > 0 ? totalPnl / daily.length : 0;

  let sharpe = 0;
  if (daily.length > 1) {
    const pnls = daily.map(d => d.pnl);
    const mean = pnls.reduce((s, v) => s + v, 0) / pnls.length;
    const std = Math.sqrt(pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (pnls.length - 1));
    sharpe = std > 0 ? mean / std : 0;
  }

  const compositeScore =
    (winRate * 40) +
    (Math.max(0, Math.min(sharpe, 1)) * 30) +
    (avgDailyPnl > 0 ? 20 : 0) +
    (worstDay > -500 ? 10 : 0);

  const runtimeMs = Date.now() - startTime;

  // Store result
  const optResult = {
    id: `${dimension}-${label.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${Date.now()}`,
    dimension, label, configDelta, dateSet, phase,
    datesRun: daily.length, trades: totalTrades, wins: totalWins, winRate,
    totalPnl, avgDailyPnl, worstDay, bestDay, sharpe, compositeScore,
    daily, runtimeMs, createdAt: Date.now(),
  };

  const store = new OptimizerStore();
  store.insert(optResult);
  store.close();

  // Output JSON to stdout (agent reads this)
  console.log(JSON.stringify(optResult, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});
