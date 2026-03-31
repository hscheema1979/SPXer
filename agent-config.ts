/**
 * Agent Configuration — HMA3x17 ScannerReverse
 *
 * Backtested config: hma3x17-undhma-otm15-tp14x-sl70
 * Full year results (249 days, with friction):
 *   $2,008,890 total P&L | 59.2% win rate | 88% green days
 *   2,862 trades | 2.17:1 avg win/loss ratio
 *   Sharpe 16.39 | Max DD $11,904
 *
 * Strategy:
 *   - HMA 3×17 fast crossover on SPX underlying (catches small moves)
 *   - scannerReverse exit (flip on HMA reversal — always in a trade)
 *   - TP 1.4x (small take-profit), SL 70% (deep stop, rarely hit)
 *   - $15 OTM contracts, $10k base sizing, max 10 contracts
 *   - No scanners/judges/regime — pure deterministic signal execution
 */

import type { Config } from './src/config/types';

export const AGENT_CONFIG: Config = {
  id: 'hma3x17-scannerReverse-live',
  name: 'HMA3x17 ScannerReverse Live',
  description: 'Backtested winner: HMA3x17 | UndHMA | OTM15 | TP1.4x | SL70% | scannerReverse',
  createdAt: Date.now(),
  updatedAt: Date.now(),

  // Signal detection — HMA 3×17 cross with underlying confirmation
  signals: {
    enableRsiCrosses: false,
    enableHmaCrosses: true,
    enablePriceCrossHma: false,
    enableEmaCrosses: false,
    requireUnderlyingHmaCross: true,   // Key: must see SPX HMA3 cross HMA17
    hmaCrossFast: 3,                   // HMA(3) — very fast
    hmaCrossSlow: 17,                  // HMA(17) — medium
    emaCrossFast: 9,
    emaCrossSlow: 21,
    signalTimeframe: '1m',
    directionTimeframe: '3m',          // Direction from 3m bars
    exitTimeframe: '5m',               // Exit reversal from 5m bars (not in Config type yet, tracked in agent)
    targetOtmDistance: 15,             // $15 OTM contracts
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

  // Strike selection
  strikeSelector: {
    strikeSearchRange: 80,
    contractPriceMin: 0.2,
    contractPriceMax: 99,              // No upper limit — OTM distance handles targeting
  },

  // Position management — TP 1.4x, SL 70%
  position: {
    stopLossPercent: 70,               // Deep stop — rarely hit with scannerReverse exits
    takeProfitMultiplier: 1.4,         // Small take-profit — compound many small wins
    defaultQuantity: 1,
    maxPositionsOpen: 1,               // One position at a time (flip model)
    positionSizeMultiplier: 1.0,
  },

  // Time restrictions
  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '15:45',
    activeStart: '09:45',
    activeEnd: '15:45',
    skipWeekends: true,
    skipHolidays: true,
  },

  // Risk limits
  risk: {
    maxDailyLoss: 9999,               // Match backtest: no daily loss cap
    maxTradesPerDay: 999,              // Match backtest: no trade limit
    maxRiskPerTrade: 2000,
    cutoffTimeET: '15:45',
    minMinutesToClose: 15,
  },

  // Scanners: DISABLED — pure deterministic execution
  scanners: {
    enabled: false,
    models: [],
    cycleIntervalSec: 60,
    minConfidenceToEscalate: 0.5,
    promptAssignments: {},
    defaultPromptId: 'scanner-baseline-v1',
  },

  // Escalation: disabled
  escalation: {
    signalTriggersJudge: false,
    scannerTriggersJudge: false,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  // Judge: DISABLED — no LLM in the loop
  judges: {
    enabled: false,
    models: [],
    activeJudge: 'sonnet',
    consensusRule: 'primary-decides',
    confidenceThreshold: 0.5,
    escalationCooldownSec: 180,
    promptId: 'judge-regime-advisor-v1',
  },

  // Exit strategy — scannerReverse: exit on HMA reversal, then flip to opposite side
  exit: {
    strategy: 'scannerReverse',
    trailingStopEnabled: false,
    trailingStopPercent: 20,
    timeBasedExitEnabled: false,
    timeBasedExitMinutes: 30,
    reversalSizeMultiplier: 1.0,
  },

  // Narrative: disabled (no scanners)
  narrative: {
    buildOvernightContext: false,
    barHistoryDepth: 60,
    trackTrajectory: false,
  },

  // Pipeline defaults
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

  // Contracts
  contracts: {
    stickyBandWidth: 100,
  },

  // Calendar
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

  // Sizing — 15% of account buying power, max 10 contracts
  sizing: {
    baseDollarsPerTrade: 10000,        // fallback if account balance fetch fails
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 10,
    riskPercentOfAccount: 15,          // 15% of margin buying power per trade
  },

  // Regime: DISABLED — trade all conditions
  regime: {
    enabled: false,
    mode: 'disabled',

    classification: {
      trendThreshold: 0.15,
      lookbackBars: 20,
      openingRangeMinutes: 15,
    },

    timeWindows: {
      morningEnd: '10:15',
      middayEnd: '14:00',
      gammaExpiryStart: '14:00',
      noTradeStart: '15:30',
    },

    signalGates: {
      MORNING_MOMENTUM: {
        allowOverboughtFade: false, allowOversoldFade: false,
        allowBreakoutFollow: true, allowVReversal: false,
        overboughtMeaning: 'momentum', oversoldMeaning: 'momentum',
      },
      MEAN_REVERSION: {
        allowOverboughtFade: true, allowOversoldFade: true,
        allowBreakoutFollow: false, allowVReversal: true,
        overboughtMeaning: 'reversal', oversoldMeaning: 'reversal',
      },
      TRENDING_UP: {
        allowOverboughtFade: false, allowOversoldFade: true,
        allowBreakoutFollow: true, allowVReversal: false,
        overboughtMeaning: 'momentum', oversoldMeaning: 'reversal',
      },
      TRENDING_DOWN: {
        allowOverboughtFade: true, allowOversoldFade: false,
        allowBreakoutFollow: true, allowVReversal: false,
        overboughtMeaning: 'reversal', oversoldMeaning: 'momentum',
      },
      GAMMA_EXPIRY: {
        allowOverboughtFade: false, allowOversoldFade: false,
        allowBreakoutFollow: true, allowVReversal: false,
        overboughtMeaning: 'momentum', oversoldMeaning: 'momentum',
      },
      NO_TRADE: {
        allowOverboughtFade: false, allowOversoldFade: false,
        allowBreakoutFollow: false, allowVReversal: false,
        overboughtMeaning: 'momentum', oversoldMeaning: 'momentum',
      },
    },
  },

  // SPX execution on margin account
  // NOTE: Account requires PDT exemption on file with Tradier — without it,
  // day trades are blocked even with $25k+ equity (day_trade_buying_power = $0).
  execution: {
    symbol: 'SPX',
    optionPrefix: 'SPXW',
    accountId: '6YA51425',
    disableBracketOrders: true,   // Use simple market orders — OTOCO cancel broken
  },
};
