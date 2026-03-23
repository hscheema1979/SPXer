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
};
