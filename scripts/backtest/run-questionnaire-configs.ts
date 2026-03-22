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

// Base config from questionnaire answers
const baseConfig: Partial<ReplayConfig> = {
  // Scanners: Disabled for now (timeouts on Agent SDK calls)
  // Will enable once askModel() is stable
  scanners: {
    enabled: false,
    models: [],
    cycleIntervalSec: 30,
    minConfidenceToEscalate: 0.5,
    promptId: 'baseline-2026-03-18-v1.0',
  },

  // Judges: Disabled for deterministic testing
  // Once Agent SDK is stable, enable and test with all 3
  judge: {
    enabled: false,
    models: [],
    primaryModel: 'sonnet',
    confidenceThreshold: 0.5,
    escalationCooldownSec: 600,
  },

  // Signal-only escalation (scanners disabled for now)
  escalation: {
    signalTriggersJudge: true,
    scannerTriggersJudge: false,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  // RSI Thresholds
  rsi: {
    oversoldThreshold: 25,
    overboughtThreshold: 75,
  },

  // HMA Crosses enabled
  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    optionRsiOversold: 25,
    optionRsiOverbought: 75,
  },

  // Position Sizing (Aggressive preset)
  position: {
    maxPositionsOpen: 3,
    stopLossPercent: 70,
    takeProfitMultiplier: 5, // 500% = 5x risk (user said "700%" = 7x, but let's use 5x as typical aggressive)
    positionSizeMultiplier: 1.0,
  },

  // Regime: Allow morning (after 9:45), midday, afternoon. No close.
  regime: {
    allowMorningMomentum: true,
    allowMeanReversion: true,
    allowTrendingUp: true,
    allowTrendingDown: true,
    allowGammaExpiry: true,
  },

  // Timing: 9:45 start (after morning chaos), end at 15:00 (before close)
  timing: {
    tradingStartEt: '09:45',
    tradingEndEt: '15:00',
    noTradeAfterEt: '15:00',
  },

  // Narrative enabled, brief detail level
  prompts: {
    contextBrief: 'brief',
  },

  // 0DTE only
  strikeSelector: {
    minOtmDollar: 0.20,
    maxOtmDollar: 8.00,
    minOtmPoints: 10,
    maxOtmPoints: 60,
    strikeSearchRange: 200,
  },
};

// Config 1: Standard takeProfit exits
const configTakeProfit: ReplayConfig = mergeConfig(DEFAULT_CONFIG, {
  ...baseConfig,
  id: 'aggressive-takeprofit',
  name: 'Aggressive + TakeProfit Exits',
  description: 'All 4 scanners, all 3 judges, exit on TP or stop',
  exit: {
    strategy: 'takeProfit',
    reversalSizeMultiplier: 1.0,
  },
});

// Config 2: Scanner-driven reversal exits
const configScannerReverse: ReplayConfig = mergeConfig(DEFAULT_CONFIG, {
  ...baseConfig,
  id: 'aggressive-reversal',
  name: 'Aggressive + Scanner Reversal Exits',
  description: 'All 4 scanners, all 3 judges, exit/reverse on opposite scanner signal',
  exit: {
    strategy: 'scannerReverse',
    reversalSizeMultiplier: 1.0,
  },
});

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
