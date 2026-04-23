import { createStore } from '../src/replay/store';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config/defaults';
import type { Config } from '../src/config/types';

const TEST_CONFIG_ID = 'e2e-test-safe-otm25';

const overrides: Partial<Config> = {
  id: TEST_CONFIG_ID,
  name: 'E2E Test Safe — OTM25, 1 contract, ≤$5, TP10x SL10%',
  description: 'Safe test config. OTM25 cheap 0DTE. 1 contract. Paper unless E2E_LIVE=true.',
  createdAt: Date.now(),
  updatedAt: Date.now(),

  scanners: { enabled: false } as any,
  judges: { enabled: false } as any,
  regime: { enabled: false } as any,

  signals: {
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    enableRsiCrosses: false,
    enablePriceCrossHma: false,
    requireUnderlyingHmaCross: false,
    hmaCrossFast: 3,
    hmaCrossSlow: 12,
    signalTimeframe: '1m',
    directionTimeframe: '1m',
    exitTimeframe: '',
    hmaCrossTimeframe: null,
    rsiCrossTimeframe: null,
    emaCrossTimeframe: null,
    priceCrossHmaTimeframe: null,
    allowedSides: 'both',
    reverseSignals: false,
    targetOtmDistance: 25,
    targetContractPrice: null,
    maxEntryPrice: 5.00,
    rsiOversold: 20,
    rsiOverbought: 80,
    optionRsiOversold: 40,
    optionRsiOverbought: 60,
    enableKeltnerGate: false,
    kcEmaPeriod: 20,
    kcAtrPeriod: 14,
    kcMultiplier: 2.5,
    kcSlopeLookback: 5,
    kcSlopeThreshold: 0.3,
    mtfConfirmation: { enabled: false, timeframe: '5m', requireAgreement: true },
    minWarmupBars: 0,
  },

  position: {
    stopLossPercent: 10,
    takeProfitMultiplier: 10,
    maxPositionsOpen: 1,
    defaultQuantity: 1,
    positionSizeMultiplier: 1.0,
  },

  risk: {
    maxDailyLoss: 500,
    maxTradesPerDay: 100,
    maxRiskPerTrade: 500,
    cutoffTimeET: '16:00',
    minMinutesToClose: 15,
    maxSignalsPerSession: 100,
  },

  strikeSelector: {
    strikeSearchRange: 100,
    contractPriceMin: 0.10,
    contractPriceMax: 5.00,
    strikeMode: 'otm',
  },

  timeWindows: {
    sessionStart: '00:00',
    sessionEnd: '23:59',
    activeStart: '00:00',
    activeEnd: '23:59',
    skipWeekends: false,
    skipHolidays: false,
  },

  exit: {
    strategy: 'takeProfit',
    trailingStopEnabled: false,
    trailingStopPercent: 20,
    timeBasedExitEnabled: false,
    timeBasedExitMinutes: 30,
    reversalSizeMultiplier: 1.0,
  },

  sizing: {
    sizingMode: 'fixed_contracts',
    sizingValue: 1,
    startingAccountValue: 1000,
    baseDollarsPerTrade: 500,
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 1,
  },
};

const store = createStore();
const config = mergeConfig(DEFAULT_CONFIG, overrides);
config.id = TEST_CONFIG_ID;
config.name = overrides.name!;
config.description = overrides.description;
config.createdAt = Date.now();
config.updatedAt = Date.now();

const savedId = store.saveConfig(config);
const loaded = store.getConfig(savedId);

console.log(`✅ Config saved: ${savedId}`);
console.log(`   HMA: ${loaded!.signals.hmaCrossFast}x${loaded!.signals.hmaCrossSlow}`);
console.log(`   Sizing: ${loaded!.sizing.sizingMode}=${loaded!.sizing.sizingValue} (max ${loaded!.sizing.maxContracts})`);
console.log(`   Strike: ${loaded!.strikeSelector.strikeMode}, price ${loaded!.strikeSelector.contractPriceMin}-$${loaded!.strikeSelector.contractPriceMax}`);
console.log(`   OTM target: ${loaded!.signals.targetOtmDistance}$`);
console.log(`   Max entry price: $${loaded!.signals.maxEntryPrice}`);
console.log(`   Time window: ${loaded!.timeWindows.activeStart}-${loaded!.timeWindows.activeEnd}`);
console.log(`   Max daily loss: $${loaded!.risk.maxDailyLoss}`);
console.log(`   Max trades/day: ${loaded!.risk.maxTradesPerDay}`);
console.log(`\nUse: AGENT_CONFIG_ID="${savedId}" AGENT_PAPER=true npm run handler`);

store.close();
