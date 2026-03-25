/**
 * Agent Configuration for Overnight/Morning Trading Readiness
 *
 * Based on best param-search combo: 100% WR, $17,324 P&L
 * Scanner prompt: original-1 (neutral, no regime guidance)
 * Paper mode: no trade execution
 *
 * TODO: migrate to DB-backed config via ConfigManager.
 * This file exists as a transitional bridge — agent.ts will
 * eventually load config via getConfigManager().loadForSubsystem('live-agent').
 */

import type { Config } from './src/config/types';

export const AGENT_CONFIG: Config = {
  id: 'paper-mode-live',
  name: 'Paper Mode Live',
  description: 'Live agent paper mode config from autoresearch findings',
  createdAt: Date.now(),
  updatedAt: Date.now(),

  // Signal detection — autoresearch session 2,7,8 findings
  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,   // Essential (s7: off drops score 83→49)
    enablePriceCrossHma: true,
    enableEmaCrosses: false,  // Hurts (s8: on drops score 83→54)
    requireUnderlyingHmaCross: false,
    targetOtmDistance: null,
    targetContractPrice: null,
    rsiOversold: 20,          // RSI threshold doesn't matter much (s2: all equal)
    rsiOverbought: 80,
    optionRsiOversold: 40,    // Tighter = better quality (s5: 86.67 score)
    optionRsiOverbought: 60,
  },

  // Strike selection — s1: morning ±75-100 is optimal
  strikeSelector: {
    strikeSearchRange: 80,
    otmDistanceMin: 0.2,
    otmDistanceMax: 8.0,
    emergencyStrikeRange: 200,
    emergencyOtmMin: 1.0,
    emergencyOtmMax: 10.0,
  },

  // Position management — s3: SL 80% slightly better, s4: TP 2x highest WR
  position: {
    stopLossPercent: 80,      // Hold winners longer (s3: 85.26 score)
    takeProfitMultiplier: 5,  // 5x is baseline; 2x has highest WR but lower P&L per trade
    defaultQuantity: 1,
    maxPositionsOpen: 3,
    positionSizeMultiplier: 1.0,
  },

  // Time restrictions
  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '15:45',
    activeStart: '09:30',
    activeEnd: '15:45',
    skipWeekends: true,
    skipHolidays: true,
  },

  // Risk limits
  risk: {
    maxDailyLoss: 500,
    maxTradesPerDay: 10,
    maxRiskPerTrade: 2000,
    cutoffTimeET: '15:30',
    minMinutesToClose: 15,
  },

  // Scanners: enabled for overnight narrative building
  scanners: {
    enabled: true,
    models: ['kimi', 'glm', 'haiku'],  // minimax disabled — empty responses
    cycleIntervalSec: 60,
    minConfidenceToEscalate: 0.5,
    promptAssignments: {},
    defaultPromptId: 'scanner-baseline-v1',
  },

  // Escalation: scanners feed judge, enabled to test judge reactions
  escalation: {
    signalTriggersJudge: true,
    scannerTriggersJudge: true,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  // Judge: enabled to observe and test judge reactions
  judges: {
    enabled: true,
    models: ['sonnet'],
    activeJudge: 'sonnet',
    consensusRule: 'primary-decides',
    confidenceThreshold: 0.5,
    escalationCooldownSec: 180,  // s6: 180s is optimal (92.73 score, 81.8% WR)
    promptId: 'judge-regime-advisor-v1',
  },

  // Exit strategy
  exit: {
    strategy: 'takeProfit',
    trailingStopEnabled: false,
    trailingStopPercent: 20,
    timeBasedExitEnabled: false,
    timeBasedExitMinutes: 30,
    reversalSizeMultiplier: 1.0,
  },

  // Narrative
  narrative: {
    buildOvernightContext: true,
    barHistoryDepth: 60,
    trackTrajectory: true,
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
    holidays: [],
    earlyCloseDays: [],
  },

  // Sizing
  sizing: {
    baseDollarsPerTrade: 500,
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 10,
  },

  // Regime system — ALL parameters configurable, nothing hardcoded
  regime: {
    enabled: true,
    mode: 'enforce',

    classification: {
      trendThreshold: 0.15,        // pts/bar — ~$9/5min sustained move
      lookbackBars: 20,
      openingRangeMinutes: 15,     // Opening range duration (09:30-09:45)
    },

    timeWindows: {
      morningEnd: '10:15',
      middayEnd: '14:00',
      gammaExpiryStart: '14:00',
      noTradeStart: '15:30',
    },

    emergencyRsi: {
      oversold: 15,
      overbought: 85,
      morningOversold: 10,
      morningOverbought: 92,
    },

    signalGates: {
      MORNING_MOMENTUM: {
        allowOverboughtFade: false,
        allowOversoldFade: false,
        allowBreakoutFollow: true,
        allowVReversal: false,
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      },
      MEAN_REVERSION: {
        allowOverboughtFade: true,
        allowOversoldFade: true,
        allowBreakoutFollow: false,
        allowVReversal: true,
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'reversal',
      },
      TRENDING_UP: {
        allowOverboughtFade: false,
        allowOversoldFade: true,
        allowBreakoutFollow: true,
        allowVReversal: false,
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'reversal',
      },
      TRENDING_DOWN: {
        allowOverboughtFade: true,
        allowOversoldFade: false,
        allowBreakoutFollow: true,
        allowVReversal: false,
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'momentum',
      },
      GAMMA_EXPIRY: {
        allowOverboughtFade: false,
        allowOversoldFade: false,
        allowBreakoutFollow: true,
        allowVReversal: false,
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      },
      NO_TRADE: {
        allowOverboughtFade: false,
        allowOversoldFade: false,
        allowBreakoutFollow: false,
        allowVReversal: false,
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      },
    },
  },
};
