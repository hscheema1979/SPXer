/**
 * Agent Configuration — XSP 1DTE on Cash Account
 *
 * Same HMA3x17 scannerReverse strategy as SPX, but:
 *   - Executes on XSP (Mini-SPX, 1/10th size, European/cash-settled)
 *   - Uses 1DTE options (next-day expiry for better premium)
 *   - 1 contract at a time (cash account: funds locked until T+1)
 *   - Max 1 trade per day (cash settlement constraint)
 *   - Targets cash account 6YA58635 ($1,200)
 *
 * Signal source is still SPX HMA(3)×HMA(17) from the data pipeline.
 * Strikes are converted: SPX 5700 → XSP 570.
 */

import type { Config } from './src/config/types';

export const AGENT_XSP_CONFIG: Config = {
  id: 'hma3x17-xsp-cash',
  name: 'HMA3x17 XSP Cash Account',
  description: 'XSP 1DTE on cash account — 1 contract, 1 trade/day',
  createdAt: Date.now(),
  updatedAt: Date.now(),

  // Signal detection — same as SPX config
  signals: {
    enableRsiCrosses: false,
    enableHmaCrosses: true,
    enablePriceCrossHma: false,
    enableEmaCrosses: false,
    requireUnderlyingHmaCross: true,
    hmaCrossFast: 3,
    hmaCrossSlow: 17,
    emaCrossFast: 9,
    emaCrossSlow: 21,
    signalTimeframe: '1m',
    directionTimeframe: '3m',
    exitTimeframe: '5m',
    targetOtmDistance: 10,        // $10 OTM on SPX = $1 OTM on XSP
    targetContractPrice: null,
    maxEntryPrice: null,
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
  },

  strikeSelector: {
    strikeSearchRange: 80,
    contractPriceMin: 0.2,
    contractPriceMax: 99,
  },

  // 1 contract, 1 position — cash account constraint
  position: {
    stopLossPercent: 70,
    takeProfitMultiplier: 1.4,
    defaultQuantity: 1,
    maxPositionsOpen: 1,
    positionSizeMultiplier: 1.0,
  },

  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '15:45',
    activeStart: '09:30',
    activeEnd: '15:45',
    skipWeekends: true,
    skipHolidays: true,
  },

  // Cash account: 1 trade per day, conservative risk
  risk: {
    maxDailyLoss: 500,           // Protect the $1,200 account
    maxTradesPerDay: 1,          // Cash account: funds locked after sell
    maxRiskPerTrade: 500,
    cutoffTimeET: '15:45',
    minMinutesToClose: 15,
  },

  scanners: {
    enabled: false,
    models: [],
    cycleIntervalSec: 60,
    minConfidenceToEscalate: 0.5,
    promptAssignments: {},
    defaultPromptId: 'scanner-baseline-v1',
  },

  escalation: {
    signalTriggersJudge: false,
    scannerTriggersJudge: false,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  judges: {
    enabled: false,
    models: [],
    activeJudge: 'sonnet',
    consensusRule: 'primary-decides',
    confidenceThreshold: 0.5,
    escalationCooldownSec: 180,
    promptId: 'judge-regime-advisor-v1',
  },

  // NO scannerReverse flipping — cash account can only do 1 trade
  // Use takeProfit: enter once, ride to TP or SL, done for the day
  exit: {
    strategy: 'takeProfit',
    trailingStopEnabled: false,
    trailingStopPercent: 20,
    timeBasedExitEnabled: false,
    timeBasedExitMinutes: 30,
    reversalSizeMultiplier: 1.0,
  },

  narrative: {
    buildOvernightContext: false,
    barHistoryDepth: 60,
    trackTrajectory: false,
  },

  pipeline: {
    pollUnderlyingMs: 5000,
    pollOptionsRthMs: 15000,
    pollOptionsOvernightMs: 60000,
    pollScreenerMs: 300000,
    strikeBand: 100,
    strikeInterval: 5,
    gapInterpolateMaxMins: 60,
    maxBarsMemory: 5000,
    timeframe: '1m',
  },

  contracts: {
    stickyBandWidth: 100,
  },

  calendar: {
    holidays: [
      '2025-01-01','2025-01-20','2025-02-17','2025-04-18',
      '2025-05-26','2025-06-19','2025-07-04','2025-09-01',
      '2025-11-27','2025-12-25',
      '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
      '2026-05-25','2026-06-19','2026-07-03','2026-08-31',
      '2026-11-26','2026-12-25',
    ],
    earlyCloseDays: [
      '2025-07-03','2025-11-28',
      '2026-07-02','2026-11-27',
    ],
  },

  // $1,200 account — 1 contract only
  sizing: {
    baseDollarsPerTrade: 1200,
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 1,
  },

  // XSP execution on cash account
  execution: {
    symbol: 'XSP',
    optionPrefix: 'XSP',
    strikeDivisor: 10,            // SPX 5700 → XSP 570
    strikeInterval: 1,            // XSP strikes in $1 increments
    accountId: '6YA58635',        // Cash account
    use1dte: true,                // 1DTE for better premium
    halfSpread: 0.10,             // XSP wider spreads than SPX
  },
};
