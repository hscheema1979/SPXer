/**
 * run-replay.ts — CLI entry point for config-driven replay.
 *
 * One instance = one config + one date. Parallelizable.
 *
 * Usage:
 *   npx tsx scripts/backtest/run-replay.ts <date>                    # default config
 *   npx tsx scripts/backtest/run-replay.ts <date> --config=aggressive
 *   npx tsx scripts/backtest/run-replay.ts <date> --config-id=my-custom
 *   npx tsx scripts/backtest/run-replay.ts <date> --no-judge         # deterministic only
 *   npx tsx scripts/backtest/run-replay.ts <date> --quiet            # minimal output
 *
 * Parallel multi-day:
 *   for d in 2026-03-{18,19,20}; do npx tsx scripts/backtest/run-replay.ts $d & done; wait
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { DEFAULT_CONFIG, CONFIG_PRESETS, createStore, runReplay, type ReplayConfig } from '../../src/replay';
import { interactiveConfigBuilder } from '../../src/replay/cli-config';

const args = process.argv.slice(2);
const targetDate = args.find(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  })
);

if (!targetDate && flags['interactive'] !== 'true') {
  console.error('Usage: npx tsx scripts/backtest/run-replay.ts <YYYY-MM-DD> [options]');
  console.error('   or: npx tsx scripts/backtest/run-replay.ts --interactive [options]');
  console.error('');
  console.error('Options:');
  console.error('  --interactive        Launch interactive config builder (skip date arg)');
  console.error('  --config=<preset>    Use a preset: aggressive, conservative, balanced');
  console.error('  --config-id=<id>     Load a saved config from the store');
  console.error('  --no-judge           Skip judge API calls (deterministic signals only)');
  console.error('  --quiet              Minimal output');
  console.error('');
  console.error('Presets:', Object.keys(CONFIG_PRESETS).join(', '));
  process.exit(1);
}

async function main() {
  let config: ReplayConfig;
  let date = targetDate;

  // Interactive mode: launch config builder
  if (flags['interactive'] === 'true') {
    config = await interactiveConfigBuilder();
    date = config.date;
  } else if (flags['config-id']) {
    // Load from store
    const store = createStore();
    const loaded = store.getConfig(flags['config-id']);
    store.close();
    if (!loaded) {
      console.error(`Config not found in store: ${flags['config-id']}`);
      process.exit(1);
    }
    config = loaded;
  } else if (flags['config'] && flags['config'] in CONFIG_PRESETS) {
    config = CONFIG_PRESETS[flags['config'] as keyof typeof CONFIG_PRESETS]();
    config.date = targetDate!;
  } else {
    config = { ...DEFAULT_CONFIG };
    config.date = targetDate!;
  }

  // Ensure config is saved to store so results can reference it
  const store = createStore();
  store.saveConfig(config);
  store.close();

  const result = await runReplay(config, date!, {
    verbose: flags['quiet'] !== 'true',
    noJudge: flags['no-judge'] === 'true',
  });

  // Machine-readable summary on last line for parallel orchestration
  console.log(`\nRESULT:${JSON.stringify({
    date: result.date,
    configId: result.configId,
    trades: result.trades,
    wins: result.wins,
    winRate: result.winRate,
    totalPnl: result.totalPnl,
  })}`);
}

main().catch(err => {
  console.error(`FAILED: ${targetDate} — ${err.message || err}`);
  process.exit(1);
});
