#!/usr/bin/env tsx
/**
 * Unified Replay CLI — single entry point for all replay/backtest operations.
 *
 * Subcommands:
 *   run <date>      Single-day replay
 *   backtest        Multi-day batch with composite score
 *   results         View/compare/export stored results
 *   days            List available replay dates
 *   configs         List/compare saved configs
 *
 * Usage:
 *   npx tsx src/replay/cli.ts run 2026-03-20
 *   npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge
 *   npx tsx src/replay/cli.ts backtest --no-scanners --no-judge
 *   npx tsx src/replay/cli.ts backtest --dates=2026-03-18,2026-03-19,2026-03-20
 *   npx tsx src/replay/cli.ts results
 *   npx tsx src/replay/cli.ts results --config=default
 *   npx tsx src/replay/cli.ts results --compare=default,aggressive
 *   npx tsx src/replay/cli.ts results --csv=default
 *   npx tsx src/replay/cli.ts days
 *   npx tsx src/replay/cli.ts configs
 *
 * Config override flags (all subcommands):
 *   --config-id=<id>           Load saved config from store
 *   --no-scanners              Disable scanner models (deterministic only)
 *   --no-judge                 Skip judge API calls
 *   --strikeSearchRange=N      Strike search range (20-200)
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
 *   --enableHmaCrosses=bool    Enable HMA cross signals
 *   --enableEmaCrosses=bool    Enable EMA cross signals
 *   --label=NAME               Label for results tracking
 *   --quiet                    Minimal output
 */

import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from './machine';
import type { ReplayOptions } from './machine';
import { runBasketReplay } from './basket-runner';
import { DEFAULT_CONFIG, mergeConfig } from '../config/defaults';
import type { Config } from '../config/types';
import { ReplayStore, createStore } from './store';
import { parseCliFlags, buildConfigFromFlags, parseDates } from './cli-config';
import { getAvailableDays } from './framework';
import { computeMetrics } from './metrics';
import type { ReplayConfig } from './types';

import { REPLAY_DB_DEFAULT } from '../storage/replay-db';

const DATA_DB_PATH = REPLAY_DB_DEFAULT;

// ── Arg parsing ────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const subcommand = rawArgs.find(a => !a.startsWith('--'));
const restArgs = rawArgs.filter(a => a !== subcommand);

const flagMap: Record<string, string> = {};
for (const a of restArgs) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > 0) {
      flagMap[a.slice(2, eq)] = a.slice(eq + 1);
    } else {
      flagMap[a.slice(2)] = 'true';
    }
  }
}

// ── Config resolution ──────────────────────────────────────────────────────

function resolveConfig(): ReplayConfig {
  if (flagMap['config-id']) {
    const store = createStore();
    const loaded = store.getConfig(flagMap['config-id']);
    store.close();
    if (!loaded) {
      console.error(`Config not found: ${flagMap['config-id']}`);
      process.exit(1);
    }
    return loaded;
  }

  const cliFlags = parseCliFlags(restArgs);
  return buildConfigFromFlags(cliFlags);
}

function getReplayOpts(): ReplayOptions {
  return {
    verbose: flagMap['quiet'] !== 'true',
    noJudge: flagMap['no-judge'] === 'true',
  };
}

// ── Subcommand: run ────────────────────────────────────────────────────────

async function cmdRun() {
  // Date is the subcommand arg — but for 'run', we need the next positional arg
  const dateArg = rawArgs.find(a => !a.startsWith('--') && a !== 'run');
  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error('Usage: npx tsx src/replay/cli.ts run <YYYY-MM-DD> [options]');
    process.exit(1);
  }

  const config = resolveConfig();

  // Ensure config is saved to store (FK constraint for results).
  // If --config-id was used and the ID already exists, skip saveConfig to
  // avoid auto-versioning from trivial DEFAULT_CONFIG merges.
  const store = createStore();
  const loadedId = flagMap['config-id'];
  if (!loadedId || !store.getConfigRaw(loadedId)) {
    store.saveConfig(config);
  }
  store.close();

  // Basket fan-out: run N isolated single-strike replays and aggregate.
  if (config.basket?.enabled && config.basket.members?.length) {
    const basketRun = await runBasketReplay(config, dateArg, getReplayOpts());
    const agg = basketRun.aggregate;
    console.log(`\nRESULT:${JSON.stringify({
      date: agg.date,
      configId: agg.configId,
      basket: true,
      members: basketRun.memberResults.length,
      trades: agg.trades,
      wins: agg.wins,
      winRate: agg.winRate,
      totalPnl: agg.totalPnl,
    })}`);
    return;
  }

  const result = await runReplay(config, dateArg, getReplayOpts());

  // Machine-readable summary
  console.log(`\nRESULT:${JSON.stringify({
    date: result.date,
    configId: result.configId,
    trades: result.trades,
    wins: result.wins,
    winRate: result.winRate,
    totalPnl: result.totalPnl,
  })}`);
}

// ── Subcommand: backtest ───────────────────────────────────────────────────

async function cmdBacktest() {
  const config = resolveConfig();

  // Get available dates from DB — scoped to the config's underlying symbol.
  const underlyingSymbol = config.execution?.symbol || 'SPX';
  const db = new Database(DATA_DB_PATH, { readonly: true });
  const allDates = getAvailableDays(db, underlyingSymbol);
  db.close();

  // Parse date filter
  const cliFlags = parseCliFlags(restArgs);
  const dates = parseDates(cliFlags, allDates);

  // Save config to store — skip if loading an existing config by ID
  // to avoid auto-versioning from DEFAULT_CONFIG merge drift.
  const store = createStore();
  const loadedId = flagMap['config-id'];
  if (!loadedId || !store.getConfigRaw(loadedId)) {
    store.saveConfig(config);
  }
  store.close();

  const verbose = flagMap['quiet'] !== 'true';
  const noJudge = flagMap['no-judge'] === 'true';
  const parallel = parseInt(flagMap['parallel'] || '0', 10);

  if (verbose) {
    const basketTag = (config.basket?.enabled && config.basket.members?.length)
      ? ` | BASKET (${config.basket.members.length} members)` : '';
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  BACKTEST: ${dates.length} days | config: ${config.id}${basketTag}`);
    console.log(`  Scanners: ${config.scanners.enabled ? 'ON' : 'OFF'} | Judge: ${noJudge ? 'OFF' : 'ON'}${parallel > 1 ? ` | Parallel: ${parallel}` : ''}`);
    console.log(`${'='.repeat(60)}\n`);
  }

  let totalTrades = 0;
  let totalWins = 0;
  let totalPnl = 0;
  let completedDates = 0;
  const dailyPnls: number[] = [];
  let worstDay = 0;

  // Collect results for sorted display in parallel mode
  const dateResults: { date: string; result?: { trades: number; wins: number; totalPnl: number }; error?: string }[] = [];

  const isBasket = !!(config.basket?.enabled && config.basket.members?.length);
  // Per-date runner: basket fan-out or single replay.
  const runOne = async (date: string) => {
    if (isBasket) {
      const br = await runBasketReplay(config, date, { verbose: false, noJudge });
      return br.aggregate;
    }
    return runReplay(config, date, { verbose: false, noJudge });
  };

  if (parallel > 1 && dates.length > 1) {
    // ── Parallel execution: run N dates concurrently ──
    // Process in batches to limit memory usage
    const batchSize = parallel;
    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(date => runOne(date))
      );

      for (let j = 0; j < results.length; j++) {
        const date = batch[j];
        const r = results[j];
        if (r.status === 'fulfilled') {
          totalTrades += r.value.trades;
          totalWins += r.value.wins;
          totalPnl += r.value.totalPnl;
          dailyPnls.push(r.value.totalPnl);
          if (r.value.totalPnl < worstDay) worstDay = r.value.totalPnl;
          completedDates++;
          dateResults.push({ date, result: r.value });
        } else {
          dateResults.push({ date, error: r.reason?.message || String(r.reason) });
        }
      }
    }

    // Print results in date order
    if (verbose) {
      for (const dr of dateResults) {
        if (dr.result) {
          const wr = dr.result.trades > 0 ? ((dr.result.wins / dr.result.trades) * 100).toFixed(0) : '-';
          console.log(`  ${dr.date}  ${String(dr.result.trades).padEnd(3)} trades  ${wr.padEnd(3)}% WR  $${dr.result.totalPnl.toFixed(0)}`);
        } else {
          console.log(`  ${dr.date}  SKIPPED — ${dr.error}`);
        }
      }
    }
  } else {
    // ── Sequential execution (original path) ──
    for (const date of dates) {
      try {
        const result = await runOne(date);
        totalTrades += result.trades;
        totalWins += result.wins;
        totalPnl += result.totalPnl;
        dailyPnls.push(result.totalPnl);
        if (result.totalPnl < worstDay) worstDay = result.totalPnl;
        completedDates++;

        if (verbose) {
          const wr = result.trades > 0 ? ((result.wins / result.trades) * 100).toFixed(0) : '-';
          console.log(`  ${date}  ${String(result.trades).padEnd(3)} trades  ${wr.padEnd(3)}% WR  $${result.totalPnl.toFixed(0)}`);
        }
      } catch (err: any) {
        if (verbose) console.log(`  ${date}  SKIPPED — ${err.message}`);
      }
    }
  }

  // Compute composite score
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

  if (verbose) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESULTS: ${completedDates}/${dates.length} days completed`);
    console.log(`  ${'─'.repeat(56)}`);
    console.log(`  Trades: ${totalTrades} | Wins: ${totalWins} | WR: ${(winRate * 100).toFixed(1)}%`);
    console.log(`  P&L: $${totalPnl.toFixed(0)} | Avg/Day: $${avgDailyPnl.toFixed(0)} | Worst: $${worstDay.toFixed(0)}`);
    console.log(`  Sharpe: ${sharpe.toFixed(3)} | Composite Score: ${score.toFixed(2)}/100`);
    console.log(`${'='.repeat(60)}\n`);
  }

  // Machine-readable score on stderr (for autoresearch compat)
  console.error(`dates=${completedDates} trades=${totalTrades} wins=${totalWins} wr=${(winRate * 100).toFixed(1)}% sharpe=${sharpe.toFixed(3)} pnl=$${totalPnl.toFixed(0)} avg=$${avgDailyPnl.toFixed(0)}/day worst=$${worstDay.toFixed(0)}`);

  // Score on stdout
  console.log(score.toFixed(2));
}

// ── Subcommand: results ────────────────────────────────────────────────────

function cmdResults() {
  const store = createStore();

  if (flagMap['csv']) {
    console.log(store.exportResultsToCsv(flagMap['csv']));
  } else if (flagMap['compare']) {
    const [id1, id2] = flagMap['compare'].split(',');
    const cmp = store.compareConfigs(id1, id2);
    const c1 = cmp.config1;
    const c2 = cmp.config2;
    const diff = cmp.difference;

    console.log(`\n  Comparison: ${id1} vs ${id2}`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  Metric              ${id1.padEnd(15)} ${id2.padEnd(15)} Diff`);
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  Total Trades        ${String(c1.totalTrades || 0).padEnd(15)} ${String(c2.totalTrades || 0).padEnd(15)} ${diff.totalTrades > 0 ? '+' : ''}${diff.totalTrades}`);
    console.log(`  Win Rate            ${((c1.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${((c2.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${(diff.winRateDiff * 100 > 0 ? '+' : '')}${(diff.winRateDiff * 100).toFixed(1)}%`);
    console.log(`  Cumulative P&L      $${String(c1.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${String(c2.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${diff.pnlDiff > 0 ? '+' : ''}${diff.pnlDiff.toFixed(0)}`);
    console.log(`  Avg Daily P&L       $${(c1.avgDailyPnl || 0).toFixed(0).padEnd(14)} $${(c2.avgDailyPnl || 0).toFixed(0).padEnd(14)}`);
    console.log(`  Best Day            $${(c1.bestDay || 0).toFixed(0).padEnd(14)} $${(c2.bestDay || 0).toFixed(0).padEnd(14)}`);
    console.log(`  Worst Day           $${(c1.worstDay || 0).toFixed(0).padEnd(14)} $${(c2.worstDay || 0).toFixed(0).padEnd(14)}`);
  } else if (flagMap['config']) {
    const results = store.getResultsByConfig(flagMap['config']);
    const summary = store.getConfigSummary(flagMap['config']);

    console.log(`\n  Config: ${flagMap['config']}`);
    console.log(`  ${'─'.repeat(70)}`);

    if (results.length === 0) {
      console.log('  No results found.');
    } else {
      console.log(`  ${'Date'.padEnd(12)} ${'Trades'.padEnd(8)} ${'Wins'.padEnd(6)} ${'WR%'.padEnd(8)} ${'P&L'.padEnd(10)} ${'Max Win'.padEnd(10)} ${'Max Loss'.padEnd(10)}`);
      console.log(`  ${'─'.repeat(70)}`);
      for (const r of results) {
        console.log(`  ${r.date.padEnd(12)} ${String(r.trades).padEnd(8)} ${String(r.wins).padEnd(6)} ${(r.winRate * 100).toFixed(0).padEnd(7)}% $${r.totalPnl.toFixed(0).padStart(8)} $${(r.maxWin || 0).toFixed(0).padStart(8)} $${(r.maxLoss || 0).toFixed(0).padStart(8)}`);
      }
      console.log(`  ${'─'.repeat(70)}`);
      console.log(`  TOTAL: ${summary.totalTrades} trades | ${(summary.avgWinRate * 100).toFixed(1)}% WR | $${summary.cumulativePnl?.toFixed(0)} cumulative P&L`);
    }
  } else {
    // List all configs with summaries
    const configs = store.listConfigs();
    if (configs.length === 0) {
      console.log('\n  No configs found. Run a replay first to create one.');
    } else {
      console.log(`\n  Saved Configurations (${configs.length}):`);
      console.log(`  ${'─'.repeat(70)}`);
      for (const c of configs) {
        const s = store.getConfigSummary(c.id);
        const runs = s?.totalRuns || 0;
        const pnl = s?.cumulativePnl?.toFixed(0) || '0';
        const wr = s?.avgWinRate ? (s.avgWinRate * 100).toFixed(1) + '%' : '-';
        console.log(`  ${c.id.padEnd(20)} ${c.name.padEnd(25)} ${String(runs).padEnd(5)} runs | WR ${wr.padEnd(6)} | P&L $${pnl}`);
      }
    }
  }

  store.close();
}

// ── Subcommand: days ───────────────────────────────────────────────────────

function cmdDays() {
  const db = new Database(DATA_DB_PATH, { readonly: true });
  const days = getAvailableDays(db);
  db.close();

  console.log(`\n  Available replay dates (${days.length}):`);
  console.log(`  ${'─'.repeat(40)}`);
  for (const d of days) {
    console.log(`  ${d}`);
  }
  console.log();
}

// ── Subcommand: configs ────────────────────────────────────────────────────

function cmdConfigs() {
  const store = createStore();
  const configs = store.listConfigs();

  if (configs.length === 0) {
    console.log('\n  No configs saved yet.');
    store.close();
    return;
  }

  console.log(`\n  Saved Configurations (${configs.length}):`);
  console.log(`  ${'─'.repeat(80)}`);

  for (const c of configs) {
    console.log(`\n  ID: ${c.id}`);
    console.log(`  Name: ${c.name}`);
    if (c.description) console.log(`  Desc: ${c.description}`);
    console.log(`  Strike: ±$${c.strikeSelector?.strikeSearchRange || '?'} | SL: ${c.position?.stopLossPercent || 0}% | TP: ${c.position?.takeProfitMultiplier || '?'}x`);
    console.log(`  RSI: ${c.signals?.rsiOversold || '?'}/${c.signals?.rsiOverbought || '?'} | HMA: ${c.signals?.enableHmaCrosses ? 'ON' : 'OFF'} | EMA: ${c.signals?.enableEmaCrosses ? 'ON' : 'OFF'}`);
    console.log(`  Cooldown: ${c.judges?.entryCooldownSec ?? c.judges?.escalationCooldownSec ?? '?'}s | Window: ${c.timeWindows?.activeStart || '?'}-${c.timeWindows?.activeEnd || '?'}`);
  }

  console.log(`\n  ${'─'.repeat(80)}\n`);
  store.close();
}

// ── Usage ──────────────────────────────────────────────────────────────────

function printUsage() {
  console.log(`
  SPXer Replay CLI

  Usage:
    npx tsx src/replay/cli.ts <command> [options]

  Commands:
    run <date>      Run single-day replay
    backtest        Run multi-day backtest with composite score
    results         View/compare/export stored results
    days            List available replay dates
    configs         List saved configurations

  Examples:
    npx tsx src/replay/cli.ts run 2026-03-20 --no-scanners --no-judge
    npx tsx src/replay/cli.ts backtest --no-scanners --no-judge
    npx tsx src/replay/cli.ts backtest --dates=2026-03-18,2026-03-20 --no-judge
    npx tsx src/replay/cli.ts results --config=default
    npx tsx src/replay/cli.ts results --compare=config1,config2

  Config flags:
    --config-id=<id>           Load saved config
    --no-scanners              Disable AI scanners
    --no-judge                 Skip judge calls
    --quiet                    Minimal output
    --parallel=N               Run N days concurrently (backtest only)
    --strikeSearchRange=N      Strike range
    --cooldownSec=N            Escalation cooldown
    --stopLossPercent=N        Stop loss %
    --takeProfitMultiplier=N   TP multiplier
    --label=NAME               Config label
`);
}

// ── Router ─────────────────────────────────────────────────────────────────

async function main() {
  switch (subcommand) {
    case 'run':
      await cmdRun();
      break;
    case 'backtest':
      await cmdBacktest();
      break;
    case 'results':
      cmdResults();
      break;
    case 'days':
      cmdDays();
      break;
    case 'configs':
      cmdConfigs();
      break;
    default:
      printUsage();
      process.exit(subcommand ? 1 : 0);
  }
}

main().catch(err => {
  console.error(`FATAL: ${err.message || err}`);
  process.exit(1);
});
