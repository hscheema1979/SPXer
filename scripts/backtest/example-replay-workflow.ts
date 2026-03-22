/**
 * example-replay-workflow.ts — How to use the replay system
 * Run with: npx tsx example-replay-workflow.ts
 */

import { createConfig, runConfigAcrossDates, compareConfigs, getConfigSummary } from './replay-configurator';
import { DEFAULT_CONFIG } from '../../src/replay';

async function main() {
  // 1. Create a custom config based on defaults
  console.log('📝 Creating a custom config...\n');
  const customConfig = await createConfig({
    id: 'test-aggressive',
    name: 'Test Aggressive',
    description: 'Tighter RSI thresholds for testing',
    rsi: {
      oversoldThreshold: 15,
      overboughtThreshold: 85,
    },
    position: {
      stopLossPercent: 70,
      takeProfitMultiplier: 8,
      maxPositionsOpen: 5,
      positionSizeMultiplier: 1.0,
    },
  });

  // 2. Run the config across a few test dates
  console.log('\n🚀 Running backtest...\n');
  const testDates = ['2026-03-18', '2026-03-19', '2026-03-20'];
  await runConfigAcrossDates('test-aggressive', testDates, { parallel: 1, verbose: true });

  // 3. View results for the config
  console.log('\n📊 Viewing results...\n');
  getConfigSummary('test-aggressive');

  // 4. Compare against default config (if it exists)
  console.log('\n⚖️ Comparing configs...\n');
  try {
    compareConfigs('default', 'test-aggressive');
  } catch (e) {
    console.log('(Default config not yet run)');
  }

  console.log('\n✅ Workflow complete!');
}

main().catch(console.error);
