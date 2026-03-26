/**
 * verify-metric.ts — Mechanical metric for autoresearch loop.
 *
 * Runs the backtest with current DEFAULT_CONFIG (+ any overrides from flags)
 * and outputs a single composite score to stdout. Autoresearch reads this number
 * to decide keep/discard.
 *
 * Composite score = (winRate * 40) + (sharpe * 30) + (avgDailyPnl > 0 ? 20 : 0) + (maxLoss > -500 ? 10 : 0)
 * Range: 0-100. Higher is better.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/verify-metric.ts --no-scanners
 *   npx tsx scripts/autoresearch/verify-metric.ts --dates=2026-03-19,2026-03-20 --no-scanners
 *   npx tsx scripts/autoresearch/verify-metric.ts --no-scanners --strikeSearchRange=50 --hmaCrossFast=5 --hmaCrossSlow=25
 *
 * Config override flags (applied to DEFAULT_CONFIG):
 *   --strikeSearchRange=N      Strike search range (20-200)
 *   --contractPriceMin=N       Min contract premium ($)
 *   --contractPriceMax=N       Max contract premium ($)
 *   --rsiOversold=N            SPX RSI oversold threshold
 *   --rsiOverbought=N          SPX RSI overbought threshold
 *   --optionRsiOversold=N      Option RSI oversold threshold
 *   --optionRsiOverbought=N    Option RSI overbought threshold
 *   --stopLossPercent=N        Stop loss % (0-100, 0=disabled)
 *   --takeProfitMultiplier=N   TP multiplier
 *   --activeStart=HH:MM        Trading window start (ET)
 *   --activeEnd=HH:MM          Trading window end (ET)
 *   --cooldownSec=N            Escalation cooldown seconds
 *   --maxDailyLoss=N           Max daily loss limit
 *   --enableHmaCrosses         Enable HMA cross signals (true/false)
 *   --enableEmaCrosses         Enable EMA cross signals (true/false)
 *   --hmaCrossFast=N           HMA fast period (5, 19, 25)
 *   --hmaCrossSlow=N           HMA slow period (5, 19, 25)
 *   --emaCrossFast=N           EMA fast period (9, 21, 50)
 *   --emaCrossSlow=N           EMA slow period (21, 50, 200)
 *   --timeframe=TF             Bar timeframe (1m, 2m, 3m, 5m)
 *   --label=NAME               Label for results tracking
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config/defaults';
import { ReplayStore } from '../../src/replay/store';
import type { Config } from '../../src/config/types';

const ALL_DATES = [
  '2026-02-20',
  '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27',
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
  '2026-03-23',
];

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : ALL_DATES;

async function main() {
  let config: Config = { ...DEFAULT_CONFIG };

  // Load config from file if --config-file is specified
  // This is the primary mode for autoresearch: the loop modifies the JSON file,
  // then runs this command to measure the score.
  if (flags['config-file']) {
    const configPath = path.resolve(flags['config-file']);
    const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config = mergeConfig(config, fileConfig);
  }

  // Scanner/judge control
  const noScanners = flags['no-scanners'] === 'true';
  if (noScanners) {
    config = mergeConfig(config, {
      scanners: { ...config.scanners, enabled: false },
    });
  }

  // Apply config overrides from CLI flags
  const signalOverrides: Partial<Config['signals']> = {};
  if (flags.rsiOversold) signalOverrides.rsiOversold = Number(flags.rsiOversold);
  if (flags.rsiOverbought) signalOverrides.rsiOverbought = Number(flags.rsiOverbought);
  if (flags.optionRsiOversold) signalOverrides.optionRsiOversold = Number(flags.optionRsiOversold);
  if (flags.optionRsiOverbought) signalOverrides.optionRsiOverbought = Number(flags.optionRsiOverbought);
  if (flags.enableHmaCrosses) signalOverrides.enableHmaCrosses = flags.enableHmaCrosses === 'true';
  if (flags.enableEmaCrosses) signalOverrides.enableEmaCrosses = flags.enableEmaCrosses === 'true';
  if (flags.hmaCrossFast) signalOverrides.hmaCrossFast = Number(flags.hmaCrossFast);
  if (flags.hmaCrossSlow) signalOverrides.hmaCrossSlow = Number(flags.hmaCrossSlow);
  if (flags.emaCrossFast) signalOverrides.emaCrossFast = Number(flags.emaCrossFast);
  if (flags.emaCrossSlow) signalOverrides.emaCrossSlow = Number(flags.emaCrossSlow);

  const overrides: Partial<Config> = {};
  if (Object.keys(signalOverrides).length > 0) overrides.signals = { ...config.signals, ...signalOverrides };
  if (flags.strikeSearchRange) overrides.strikeSelector = { ...config.strikeSelector, strikeSearchRange: Number(flags.strikeSearchRange) };
  if (flags.contractPriceMin || flags.contractPriceMax) overrides.strikeSelector = {
    ...(overrides.strikeSelector || config.strikeSelector),
    ...(flags.contractPriceMin ? { contractPriceMin: Number(flags.contractPriceMin) } : {}),
    ...(flags.contractPriceMax ? { contractPriceMax: Number(flags.contractPriceMax) } : {}),
  };
  if (flags.stopLossPercent || flags.takeProfitMultiplier) overrides.position = {
    ...config.position,
    ...(flags.stopLossPercent ? { stopLossPercent: Number(flags.stopLossPercent) } : {}),
    ...(flags.takeProfitMultiplier ? { takeProfitMultiplier: Number(flags.takeProfitMultiplier) } : {}),
  };
  if (flags.activeStart || flags.activeEnd) overrides.timeWindows = {
    ...(config.timeWindows || {}),
    ...(flags.activeStart ? { activeStart: flags.activeStart } : {}),
    ...(flags.activeEnd ? { activeEnd: flags.activeEnd } : {}),
  };
  if (flags.cooldownSec) overrides.judges = { ...config.judges, escalationCooldownSec: Number(flags.cooldownSec) };
  if (flags.maxDailyLoss) overrides.risk = { ...config.risk, maxDailyLoss: Number(flags.maxDailyLoss) };
  if (flags.timeframe) overrides.pipeline = { ...config.pipeline, timeframe: flags.timeframe as any };

  if (Object.keys(overrides).length > 0) {
    config = mergeConfig(config, overrides);
  }

  if (flags.label) config = { ...config, id: flags.label };

  // Save config to store (FK constraint)
  const store = new ReplayStore();
  store.saveConfig(config);
  store.close();

  let totalTrades = 0;
  let totalWins = 0;
  let totalPnl = 0;
  let completedDates = 0;
  const dailyPnls: number[] = [];
  let worstDay = 0;

  for (const date of DATES) {
    try {
      const result = await runReplay(config, date, {
        verbose: false,
        noJudge: noScanners,
      });

      totalTrades += result.trades;
      totalWins += result.wins;
      totalPnl += result.totalPnl;
      dailyPnls.push(result.totalPnl);
      if (result.totalPnl < worstDay) worstDay = result.totalPnl;
      completedDates++;
    } catch {
      // Skip failed dates
    }
  }

  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const avgDailyPnl = completedDates > 0 ? totalPnl / completedDates : 0;

  let sharpe = 0;
  if (dailyPnls.length > 1) {
    const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
    const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : 0;
  }

  const score =
    (winRate * 40) +
    (Math.max(0, Math.min(sharpe, 1)) * 30) +
    (avgDailyPnl > 0 ? 20 : 0) +
    (worstDay > -500 ? 10 : 0);

  console.error(`dates=${completedDates} trades=${totalTrades} wins=${totalWins} wr=${(winRate * 100).toFixed(1)}% sharpe=${sharpe.toFixed(3)} pnl=$${totalPnl.toFixed(0)} avg=$${avgDailyPnl.toFixed(0)}/day worst=$${worstDay.toFixed(0)}`);
  console.log(score.toFixed(2));
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.log('0.00');
  process.exit(1);
});
