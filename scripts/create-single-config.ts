#!/usr/bin/env tsx
/**
 * Create Single Config: SPX | HMA3x12 | ITM5 | TP30x | SL20% | 3m | 25c | $5000
 *
 * This script creates a simple single-strike config for live trading.
 */

import { createStore } from '../src/replay/store';
import type { Config } from '../src/config/types';
import { DEFAULT_CONFIG } from '../src/config/defaults';

const store = createStore();

// Config ID based on user requirements
const configId = 'spx-hma3x12-itm5-tp30x-sl20-3m-25c-$5000';

// Create config with user's specifications
const config: Config = {
  ...DEFAULT_CONFIG,
  id: configId,
  name: 'SPX HMA3x12 ITM5 TP30x SL20 3m',
  description: 'SPX single-strike: HMA 3x12, ITM5, TP30x, SL20%, 3m, 25c min, $5K per trade [10:00-16:00]',

  // Signal parameters
  signals: {
    enableHmaCrosses: true,
    hmaCrossFast: 3,
    hmaCrossSlow: 12,
    enableEmaCrosses: false,
    enableRsiOverbought: false,
    enableRsiOversold: false,
    rsiOverbought: 0,
    rsiOversold: 0,
    optionRsiOversold: 0,
    optionRsiOverbought: 0,
    targetOtmDistance: 5, // ITM5
    targetContractPrice: null,
    entryCooldownSec: 180, // 3 minutes
  },

  // Strike selection: ITM5 mode
  strikeSelector: {
    strikeSearchRange: 100,
    strikeMode: 'itm', // ITM mode
    atmOffset: null,
    contractPriceMin: 0.25,
    contractPriceMax: 15.00,
  },

  // Exit parameters
  exit: {
    takeProfitMultiplier: 30, // 30x
    stopLossPercent: 0.20, // 20%
    timeExitSeconds: null,
    signalReversalExit: true,
    scannerReverseExit: false,
    maxDurationSeconds: null,
    trailingStopPercent: null,
    reentryOnTakeProfit: {
      enabled: false,
    },
    exitPricing: 'intrabar',
    intrabarTieBreaker: 'tp',
  },

  // Position sizing
  sizing: {
    sizingMode: 'fixed_dollars',
    sizingValue: 5000, // $5000 per trade
    minContracts: 1,
    maxContracts: 25,
    baseDollarsPerTrade: 5000,
    sizeMultiplier: 1,
  },

  // Time window
  timeWindows: {
    activeStart: '10:00',
    activeEnd: '16:00',
    timezone: 'America/New_York',
  },

  // Position limits
  position: {
    maxPositionsOpen: 3,
    maxDailyLoss: 10000, // $10K daily loss limit
    forceCloseCutoff: '23:59',
  },

  // Risk gates
  risk: {
    maxTradesPerDay: 25,
    maxDailyLossPercent: 20,
    cooldownSec: 180,
  },

  // Execution
  execution: {
    symbol: 'SPX',
    optionPrefix: 'SPXW',
    strikeDivisor: 1,
    strikeInterval: 5,
    accountId: '6YA51425',
    disableBracketOrders: false,
  },

  // Scanners/judges (disabled for deterministic trading)
  judges: {
    enabled: false,
  },
};

// Save to database
store.saveConfig(config);

console.log(`\n✅ Created config: ${configId}`);
console.log(`\nConfig Details:`);
console.log(`  HMA: ${config.signals.hmaCrossFast}×${config.signals.hmaCrossSlow}`);
console.log(`  Strike Mode: ${config.strikeSelector.strikeMode} (ITM5)`);
console.log(`  TP: ${config.exit.takeProfitMultiplier}x`);
console.log(`  SL: ${config.exit.stopLossPercent * 100}%`);
console.log(`  Sizing: $${config.sizing.sizingValue.toLocaleString()} (${config.sizing.sizingMode})`);
console.log(`  Time Window: ${config.timeWindows.activeStart} - ${config.timeWindows.activeEnd} ET`);
console.log(`  Max Positions: ${config.position.maxPositionsOpen}`);
console.log(`  Max Daily Loss: $${config.position.maxDailyLoss.toLocaleString()}`);
console.log(`\nSaved to database. Ready to deploy!\n`);

store.close();
