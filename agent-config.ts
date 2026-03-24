/**
 * Agent Configuration for Overnight/Morning Trading Readiness
 * 
 * Based on best param-search combo: 100% WR, $17,324 P&L
 * Scanner prompt: original-1 (neutral, no regime guidance)
 * Paper mode: no trade execution
 */

import { ReplayConfig } from './src/replay/types';

export const AGENT_CONFIG: ReplayConfig = {
  id: 'paper-mode-live',
  
  // Signal detection — autoresearch session 2,7,8 findings
  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,   // Essential (s7: off drops score 83→49)
    enableEmaCrosses: false,  // Hurts (s8: on drops score 83→54)
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
  },

  // Time restrictions
  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '15:45',
    activeStart: '09:30',  // Power hour only
    activeEnd: '15:45',
    skipWeekends: true,
    skipHolidays: true,
  },

  // Risk limits
  risk: {
    maxDailyLoss: 500,
    maxTradesPerDay: 10,
    maxRiskPerTrade: 2000,
  },

  // Scanners: enabled for overnight narrative building
  scanners: {
    enabled: true,
    enableKimi: true,
    enableGlm: true,
    enableMinimax: false,  // Disabled — empty responses (API issue)
    enableHaiku: true,     // Fast scanner + judge fallback
    promptId: 'original-1',
    cycleIntervalSec: 60,
    minConfidenceToEscalate: 0.5,
  },

  // Escalation: scanners feed judge, enabled to test judge reactions
  escalation: {
    signalTriggersJudge: true,     // Deterministic signals escalate to judge
    scannerTriggersJudge: true,    // Scanners escalate to judge
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  // Judge: enabled to observe and test judge reactions
  judge: {
    enabled: true,
    activeJudge: 'sonnet',
    escalationCooldownSec: 180,  // s6: 180s is optimal (92.73 score, 81.8% WR)
  },

  // Prompts
  prompts: {
    scannerPrompts: {},
    judgeSystemPrompt: '',
  },

  // Regime system — ALL parameters configurable, nothing hardcoded
  regime: {
    enabled: true,
    mode: 'enforce',

    classification: {
      trendThreshold: 0.15,        // pts/bar — ~$9/5min sustained move
      lookbackBars: 20,            // Number of bars for trend slope calculation
      openingRangeMinutes: 15,     // Opening range duration (09:30-09:45)
    },

    timeWindows: {
      morningEnd: '10:15',         // When MORNING_MOMENTUM ends
      middayEnd: '14:00',          // When MEAN_REVERSION period ends
      gammaExpiryStart: '14:00',   // When GAMMA_EXPIRY starts
      noTradeStart: '15:30',       // When NO_TRADE period starts
    },

    emergencyRsi: {
      oversold: 15,                // Forces gates open for calls
      overbought: 85,              // Forces gates open for puts
      morningOversold: 10,         // More stringent during morning
      morningOverbought: 92,
    },

    signalGates: {
      MORNING_MOMENTUM: {
        allowOverboughtFade: false,   // Don't short morning momentum
        allowOversoldFade: false,     // Don't buy dips until range established
        allowBreakoutFollow: true,    // Follow opening drive
        allowVReversal: false,        // Too early for reversals
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      },
      MEAN_REVERSION: {
        allowOverboughtFade: true,    // Puts OK at extremes
        allowOversoldFade: true,      // Calls OK at extremes
        allowBreakoutFollow: false,   // Suppress breakouts in chop
        allowVReversal: true,         // Reversals work in ranges
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'reversal',
      },
      TRENDING_UP: {
        allowOverboughtFade: false,   // Don't short uptrend
        allowOversoldFade: true,      // Buy the dip
        allowBreakoutFollow: true,    // Follow momentum
        allowVReversal: false,        // Don't catch top
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'reversal',
      },
      TRENDING_DOWN: {
        allowOverboughtFade: true,    // Sell the rip
        allowOversoldFade: false,     // Don't buy in downtrend
        allowBreakoutFollow: true,    // Follow breakdown
        allowVReversal: false,        // Don't catch bottom
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'momentum',
      },
      GAMMA_EXPIRY: {
        allowOverboughtFade: false,   // Don't fade gamma moves
        allowOversoldFade: false,     // Don't fade gamma moves
        allowBreakoutFollow: true,    // Follow gamma squeeze
        allowVReversal: false,        // Too dangerous
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
