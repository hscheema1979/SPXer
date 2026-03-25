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
 *   npx tsx scripts/autoresearch/verify-metric.ts --no-scanners --strikeSearchRange=50 --activeStart=14:00 --activeEnd=15:45
 *
 * Config override flags (applied to DEFAULT_CONFIG):
 *   --strikeSearchRange=N    Strike search range (20-200)
 *   --rsiOversold=N          SPX RSI oversold threshold
 *   --rsiOverbought=N        SPX RSI overbought threshold
 *   --optionRsiOversold=N    Option RSI oversold threshold
 *   --optionRsiOverbought=N  Option RSI overbought threshold
 *   --stopLossPercent=N      Stop loss % (0-100, 0=disabled)
 *   --takeProfitMultiplier=N TP multiplier
 *   --activeStart=HH:MM      Trading window start (ET)
 *   --activeEnd=HH:MM        Trading window end (ET)
 *   --cooldownSec=N          Escalation cooldown seconds
 *   --maxDailyLoss=N         Max daily loss limit
 *   --enableHmaCrosses       Enable HMA cross signals
 *   --enableEmaCrosses       Enable EMA cross signals
 *   --label=NAME             Label for results tracking
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/replay/config';
import { ReplayStore } from '../../src/replay/store';
import type { ReplayConfig } from '../../src/replay/types';

const ALL_DATES = [
  '2026-02-20',
  '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27',
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
];

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : ALL_DATES;

async function main() {
  // Start with DEFAULT_CONFIG — autoresearch modifies this file directly
  let config: ReplayConfig = { ...DEFAULT_CONFIG };

  // Override promptId if provided via flag
  if (flags.promptId) {
    config = mergeConfig(config, {
      scanners: { ...config.scanners, enabled: true, defaultPromptId: flags.promptId },
    });
  }

  // Use --no-scanners for deterministic-only fast runs.
  const noScanners = flags['no-scanners'] === 'true';
  if (noScanners) {
    config = mergeConfig(config, {
      scanners: { ...config.scanners, enabled: false },
    });
  } else if (!config.scanners.enabled) {
    config = mergeConfig(config, {
      scanners: { ...config.scanners, enabled: true },
      escalation: {
        ...config.escalation,
        scannerTriggersJudge: true,
        signalTriggersJudge: true,
      },
    });
  }

  // Apply config overrides from CLI flags
  const overrides: Partial<ReplayConfig> = {};
  if (flags.strikeSearchRange) overrides.strikeSelector = { ...config.strikeSelector, strikeSearchRange: Number(flags.strikeSearchRange) };
  // SPX RSI thresholds
  if (flags.rsiOversold || flags.rsiOverbought) overrides.signals = {
    ...config.signals,
    ...(flags.rsiOversold ? { rsiOversold: Number(flags.rsiOversold) } : {}),
    ...(flags.rsiOverbought ? { rsiOverbought: Number(flags.rsiOverbought) } : {}),
  };
  // Option RSI signal thresholds + HMA/EMA crosses (merged with any SPX RSI overrides above)
  if (flags.optionRsiOversold || flags.optionRsiOverbought || flags.enableHmaCrosses || flags.enableEmaCrosses) {
    overrides.signals = {
      ...(overrides.signals || config.signals),
      ...(flags.optionRsiOversold ? { optionRsiOversold: Number(flags.optionRsiOversold) } : {}),
      ...(flags.optionRsiOverbought ? { optionRsiOverbought: Number(flags.optionRsiOverbought) } : {}),
      ...(flags.enableHmaCrosses ? { enableHmaCrosses: flags.enableHmaCrosses === 'true' } : {}),
      ...(flags.enableEmaCrosses ? { enableEmaCrosses: flags.enableEmaCrosses === 'true' } : {}),
    };
  }
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

  if (Object.keys(overrides).length > 0) {
    config = mergeConfig(config, overrides);
  }

  // Set config ID from label flag for results tracking
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
      const dateConfig = { ...config, date };
      const result = await runReplay(dateConfig, date, {
        verbose: false,
        // No noJudge flag — scanners run the full pipeline
        // Judges are disabled separately via config.judges.enabled if needed
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

  // Compute metrics
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const avgDailyPnl = completedDates > 0 ? totalPnl / completedDates : 0;

  // Sharpe ratio (daily)
  let sharpe = 0;
  if (dailyPnls.length > 1) {
    const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
    const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
    const std = Math.sqrt(variance);
    sharpe = std > 0 ? mean / std : 0;
  }

  // Composite score: 0-100
  const score =
    (winRate * 40) +                          // 0-40 points for win rate
    (Math.max(0, Math.min(sharpe, 1)) * 30) + // 0-30 points for Sharpe (capped at 1.0)
    (avgDailyPnl > 0 ? 20 : 0) +             // 20 points if profitable
    (worstDay > -500 ? 10 : 0);              // 10 points if no day loses >$500

  // Print details to stderr (so autoresearch can read them but metric is clean on stdout)
  console.error(`dates=${completedDates} trades=${totalTrades} wins=${totalWins} wr=${(winRate * 100).toFixed(1)}% sharpe=${sharpe.toFixed(3)} pnl=$${totalPnl.toFixed(0)} avg=$${avgDailyPnl.toFixed(0)}/day worst=$${worstDay.toFixed(0)}`);

  // Single number to stdout — this is what autoresearch reads
  console.log(score.toFixed(2));
}

main().catch(err => {
  console.error(`FATAL: ${err.message}`);
  console.log('0.00');
  process.exit(1);
});
