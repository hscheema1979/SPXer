#!/usr/bin/env tsx
/**
 * Run the two questionnaire-configured replays:
 * 1. takeProfit exits (all judges in one run)
 * 2. scannerReverse exits (all judges in one run)
 *
 * Across 3 dates: 2026-03-18, 2026-03-19, 2026-03-20
 */

import { runReplay } from '../../src/replay/machine';
import { ReplayStore } from '../../src/replay/store';
import type { ReplayConfig } from '../../src/replay/types';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/replay/config';

// Base config from questionnaire answers — mapped to unified Config type
const baseConfig: Partial<ReplayConfig> = {
  // Scanners: Disabled for now (timeouts on Agent SDK calls)
  scanners: {
    enabled: false,
    models: [],
    cycleIntervalSec: 30,
    minConfidenceToEscalate: 0.5,
    promptAssignments: {},
    defaultPromptId: 'scanner-baseline-v1',
  },

  // Judges: All 3 models evaluate each setup (advisory only, don't execute)
  judges: {
    enabled: true,
    models: ['haiku', 'sonnet', 'opus'],
    activeJudge: 'sonnet',
    consensusRule: 'primary-decides',
    confidenceThreshold: 0.5,
    entryCooldownSec: 600,
    promptId: 'judge-regime-advisor-v1',
  },

  // Escalation: Deterministic signals trigger judges (all 3 models evaluate)
  escalation: {
    signalTriggersJudge: true,
    scannerTriggersJudge: false,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  // Signals (includes RSI thresholds + crosses)
  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    rsiOversold: 25,
    rsiOverbought: 75,
    optionRsiOversold: 25,
    optionRsiOverbought: 75,
  },

  // Position Sizing (Aggressive preset)
  position: {
    maxPositionsOpen: 3,
    stopLossPercent: 70,
    takeProfitMultiplier: 5,
    defaultQuantity: 1,
    positionSizeMultiplier: 1.0,
  },

  // Time windows: 9:45 start (after morning chaos), end at 15:00 (before close)
  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '16:15',
    activeStart: '09:45',
    activeEnd: '15:00',
    skipWeekends: true,
    skipHolidays: true,
  },

  // Strike selector: 0DTE only
  strikeSelector: {
    strikeSearchRange: 200,
    otmDistanceMin: 10,
    otmDistanceMax: 60,
    emergencyStrikeRange: 100,
    emergencyOtmMin: 5,
    emergencyOtmMax: 30,
  },
};

// Config 1: Deterministic signals with judges
const configTakeProfit = mergeConfig(DEFAULT_CONFIG, {
  ...baseConfig,
  id: 'aggressive-withjudges',
  name: 'Aggressive + Judge Advisory',
  description: 'Deterministic signals. All 3 judges (Haiku, Sonnet, Opus) evaluate each trade (advisory only).',
  createdAt: Date.now(),
} as Partial<ReplayConfig>) as ReplayConfig;

// Config 2: Same as Config 1 (both use same settings, just different run)
const configScannerReverse = mergeConfig(DEFAULT_CONFIG, {
  ...baseConfig,
  id: 'aggressive-withjudges-2',
  name: 'Aggressive + Judge Advisory (Run 2)',
  description: 'Identical config to Run 1. Tests consistency of judge decisions.',
  createdAt: Date.now(),
} as Partial<ReplayConfig>) as ReplayConfig;

// Dates to test
const dates = ['2026-03-18', '2026-03-19', '2026-03-20'];

async function runAll() {
  const store = new ReplayStore();

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   Running Questionnaire Configurations                     ║');
  console.log('║   Config 1: TakeProfit Exits (3 dates)                     ║');
  console.log('║   Config 2: Scanner Reversal (3 dates)                     ║');
  console.log('║   Total: 6 replays                                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Save configs to store (required for foreign key constraint)
  console.log('💾 Saving configs to store...');
  store.saveConfig(configTakeProfit);
  store.saveConfig(configScannerReverse);
  console.log('✅ Configs saved\n');

  const allRuns: Array<{ date: string; config: string; promise: Promise<any> }> = [];

  // Queue all 6 replays
  for (const date of dates) {
    console.log(`\n🚀 Queuing ${date}...`);

    // Run 1: TakeProfit
    console.log(`   → Config: TakeProfit`);
    const p1 = runReplay(configTakeProfit, date).then(result => {
      console.log(`   ✅ ${date} TakeProfit complete`);
      return result;
    });
    allRuns.push({ date, config: 'takeprofit', promise: p1 });

    // Run 2: ScannerReverse
    console.log(`   → Config: ScannerReverse`);
    const p2 = runReplay(configScannerReverse, date).then(result => {
      console.log(`   ✅ ${date} ScannerReverse complete`);
      return result;
    });
    allRuns.push({ date, config: 'reversal', promise: p2 });
  }

  console.log('\n⏳ Running all 6 replays in parallel...\n');

  // Wait for all to complete
  const results = await Promise.allSettled(allRuns.map(r => r.promise));

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║                    Results Summary                         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  results.forEach((result, i) => {
    const run = allRuns[i];
    if (result.status === 'fulfilled') {
      const output = result.value;
      console.log(`✅ ${run.date} [${run.config}]`);
      console.log(`   Trades: ${output.tradesExecuted || 0}`);
      console.log(`   P&L: $${(output.totalPnL || 0).toFixed(2)}`);
      if (output.stats) {
        console.log(`   Win Rate: ${((output.stats.winRate || 0) * 100).toFixed(1)}%`);
      }
    } else {
      console.log(`❌ ${run.date} [${run.config}] — Error`);
      console.log(`   ${result.reason?.message || 'Unknown error'}`);
    }
  });

  console.log('\n📊 Full results saved to replay store (SQLite)\n');
  console.log('Next: Query replay store for detailed analysis\n');
}

runAll().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
