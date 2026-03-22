/**
 * replay-configurator.ts — Helper functions for replay configuration and execution
 * Create, run, view, and compare configurations without a CLI
 */

import { createStore } from '../../src/replay';
import { DEFAULT_CONFIG, CONFIG_PRESETS, ReplayConfig, mergeConfig, validateConfig } from '../../src/replay';
import { runReplay } from './replay-machine';

/**
 * Create a configuration by merging defaults with overrides
 */
export async function createConfig(overrides: Partial<ReplayConfig>): Promise<ReplayConfig> {
  const config = mergeConfig(DEFAULT_CONFIG, overrides);
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new Error(`Invalid config: ${validation.errors.join(', ')}`);
  }

  const store = createStore();
  store.saveConfig(config);
  store.close();

  console.log(`✅ Saved config: ${config.id}`);
  return config;
}

/**
 * Run a configuration across multiple dates (sequentially or parallel)
 */
export async function runConfigAcrossDates(
  configId: string,
  dates: string[],
  options: { parallel?: number; verbose?: boolean } = {}
): Promise<void> {
  const store = createStore();
  const config = store.getConfig(configId);
  store.close();

  if (!config) {
    throw new Error(`Config not found: ${configId}`);
  }

  console.log(`🚀 Running config: ${config.id}`);
  console.log(`   Dates: ${dates.length} days`);
  console.log('');

  const parallel = options.parallel || 1;
  let completed = 0;
  let failed = 0;

  if (parallel === 1) {
    // Sequential execution
    for (const date of dates) {
      try {
        await runReplay(config, date);
        completed++;
      } catch (error) {
        console.error(`❌ ${date}: ${error}`);
        failed++;
      }
    }
  } else {
    // Parallel execution with concurrency limit
    const chunks = [];
    for (let i = 0; i < dates.length; i += parallel) {
      chunks.push(dates.slice(i, i + parallel));
    }

    for (const chunk of chunks) {
      await Promise.allSettled(
        chunk.map(date =>
          runReplay(config, date)
            .then(() => completed++)
            .catch(e => {
              console.error(`❌ ${date}: ${e}`);
              failed++;
            })
        )
      );
    }
  }

  console.log(`\n✅ Backtest complete: ${completed} completed, ${failed} failed`);
}

/**
 * Get summary statistics for a config
 */
export function getConfigSummary(configId: string) {
  const store = createStore();
  const summary = store.getConfigSummary(configId);
  const results = store.getResultsByConfig(configId);
  store.close();

  console.log(`\n📊 Summary for: ${configId}`);
  console.log(`   Completed Runs: ${summary?.completedRuns || 0}`);
  console.log(`   Total Trades: ${summary?.totalTrades || 0}`);
  console.log(`   Win Rate: ${((summary?.avgWinRate || 0) * 100).toFixed(1)}%`);
  console.log(`   Cumulative P&L: $${summary?.cumulativePnl?.toFixed(0) || 0}`);
  console.log(`   Best Day: $${summary?.bestDay?.toFixed(0) || 0}`);
  console.log(`   Worst Day: $${summary?.worstDay?.toFixed(0) || 0}`);

  if (results.length > 0) {
    console.log('\n   Daily results:');
    results.forEach(r => {
      const emoji = r.totalPnl >= 0 ? '📈' : '📉';
      console.log(
        `     ${emoji} ${r.date}: ${r.trades} trades | ${(r.winRate * 100).toFixed(0)}% win | $${r.totalPnl.toFixed(0)}`
      );
    });
  }

  return summary;
}

/**
 * Compare two configurations
 */
export function compareConfigs(configId1: string, configId2: string) {
  const store = createStore();
  const comparison = store.compareConfigs(configId1, configId2);
  store.close();

  const c1 = comparison.config1;
  const c2 = comparison.config2;
  const diff = comparison.difference;

  console.log(`\n⚖️ Comparison: ${configId1} vs ${configId2}`);
  console.log('');
  console.log(`  Metric              ${configId1.padEnd(15)} ${configId2.padEnd(15)} Difference`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(
    `  Total Trades        ${String(c1.totalTrades || 0).padEnd(15)} ${String(c2.totalTrades || 0).padEnd(15)} ${diff.totalTrades > 0 ? '+' : ''}${diff.totalTrades}`
  );
  console.log(
    `  Win Rate            ${((c1.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${((c2.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${(diff.winRateDiff * 100 > 0 ? '+' : '')}${(diff.winRateDiff * 100).toFixed(1)}%`
  );
  console.log(
    `  Cumulative P&L      $${String(c1.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${String(c2.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${diff.pnlDiff > 0 ? '+' : ''}${diff.pnlDiff.toFixed(0)}`
  );

  return comparison;
}

/**
 * List all saved configurations
 */
export function listConfigs() {
  const store = createStore();
  const configs = store.listConfigs();
  store.close();

  console.log(`\n📋 Saved Configurations (${configs.length}):`);
  configs.forEach(c => {
    const summary = store.getConfigSummary(c.id);
    console.log(`   ${c.id}`);
    console.log(`     Name: ${c.name}`);
    if (summary?.completedRuns) {
      console.log(`     Runs: ${summary.completedRuns} | P&L: $${summary.cumulativePnl?.toFixed(0) || 0}`);
    }
  });

  return configs;
}

/**
 * Export results to CSV
 */
export function exportToCsv(configId: string): string {
  const store = createStore();
  const csv = store.exportResultsToCsv(configId);
  store.close();
  return csv;
}
