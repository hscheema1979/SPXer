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
  
  // Signal detection
  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    rsiOversold: 20,      // Aggressive
    rsiOverbought: 80,    // Aggressive
    optionRsiOversold: 30,
    optionRsiOverbought: 70,
  },

  // Strike selection (±150 from SPX)
  strikeSelector: {
    strikeSearchRange: 80,
    otmDistanceMin: 0.2,
    otmDistanceMax: 8.0,
    emergencyStrikeRange: 200,
    emergencyOtmMin: 1.0,
    emergencyOtmMax: 10.0,
  },

  // Position management
  position: {
    stopLossPercent: 50,   // Hold for max drawdown
    takeProfitMultiplier: 5,
    defaultQuantity: 1,
    maxPositionsOpen: 3,   // Power hour aggressiveness
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
    escalationCooldownSec: 180,  // 3 minutes between judge calls
  },

  // Prompts
  prompts: {
    scannerPrompts: {},
    judgeSystemPrompt: '',
  },
};
