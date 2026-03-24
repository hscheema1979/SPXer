/**
 * Replay configuration — defaults, presets, merge, and validation.
 */

import type { ReplayConfig } from './types';
import { validateScannerPromptId } from './prompt-library';

export const DEFAULT_CONFIG: ReplayConfig = {
  id: 'default',
  name: 'Default Configuration',
  description: 'Baseline settings for 0DTE trading',
  createdAt: Date.now(),

  rsi: {
    oversoldThreshold: 20,
    overboughtThreshold: 80,
  },

  indicators: {
    hma: true,
    ema: true,
    rsi: true,
    bollingerBands: false,
  },

  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    optionRsiOversold: 30,
    optionRsiOverbought: 70,
  },

  position: {
    stopLossPercent: 50,
    takeProfitMultiplier: 5,
    maxPositionsOpen: 3,
    positionSizeMultiplier: 1.0,
  },

  regime: {
    enabled: true,
    mode: 'enforce',

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

  judge: {
    enabled: true,
    models: ['sonnet'], // Default: single Sonnet judge
    consensusRule: 'primary-decides',
    primaryModel: 'sonnet',
    confidenceThreshold: 0.5,
    escalationCooldownSec: 600,
  },

  prompts: {
    contextBrief: 'standard',
  },

  strikeSelector: {
    minOtmDollar: 0.20,
    maxOtmDollar: 8.00,
    minOtmPoints: 10,
    maxOtmPoints: 60,
    strikeSearchRange: 60,
  },

  sizing: {
    baseDollarsPerTrade: 250,
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 10,
  },

  scanners: {
    enabled: false,
    enableKimi: true,
    enableGlm: true,
    enableMinimax: true,
    enableHaiku: false,
    cycleIntervalSec: 30,
    minConfidenceToEscalate: 0.5,
    promptId: 'rsi-extremes-2026-03-19-v2.0',
  },

  escalation: {
    signalTriggersJudge: true,
    scannerTriggersJudge: false,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  timing: {
    tradingStartEt: '09:30',
    tradingEndEt: '15:45',
    noTradeAfterEt: '15:30',
  },

  risk: {
    maxDailyLoss: 500,
    maxTradesPerDay: 10,
    maxRiskPerTrade: 0.02,
  },

  exit: {
    strategy: 'takeProfit', // Standard: exit on TP or stop
    reversalSizeMultiplier: 1.0, // (for scannerReverse mode)
  },
};

export const CONFIG_PRESETS = {
  aggressive: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'aggressive',
    name: 'Aggressive Configuration',
    description: 'Tighter RSI thresholds, wider stops, higher targets',
    rsi: { oversoldThreshold: 15, overboughtThreshold: 85 },
    signals: { ...DEFAULT_CONFIG.signals, optionRsiOversold: 25, optionRsiOverbought: 75 },
    position: { stopLossPercent: 70, takeProfitMultiplier: 8, maxPositionsOpen: 5, positionSizeMultiplier: 1.2 },
    sizing: { baseDollarsPerTrade: 400, sizeMultiplier: 1.5, minContracts: 1, maxContracts: 15 },
  }),

  conservative: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'conservative',
    name: 'Conservative Configuration',
    description: 'Looser RSI thresholds, tighter stops, moderate targets',
    rsi: { oversoldThreshold: 25, overboughtThreshold: 75 },
    signals: { ...DEFAULT_CONFIG.signals, optionRsiOversold: 35, optionRsiOverbought: 65 },
    position: { stopLossPercent: 40, takeProfitMultiplier: 3, maxPositionsOpen: 2, positionSizeMultiplier: 0.8 },
    sizing: { baseDollarsPerTrade: 150, sizeMultiplier: 0.8, minContracts: 1, maxContracts: 5 },
  }),

  momentumOnly: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'momentum-only',
    name: 'Momentum Only',
    description: 'Trade only MORNING_MOMENTUM regime',
    regime: {
      ...DEFAULT_CONFIG.regime,
      signalGates: {
        MORNING_MOMENTUM: DEFAULT_CONFIG.regime.signalGates.MORNING_MOMENTUM,
        MEAN_REVERSION: { ...DEFAULT_CONFIG.regime.signalGates.MEAN_REVERSION, allowOverboughtFade: false, allowOversoldFade: false, allowBreakoutFollow: false, allowVReversal: false },
        TRENDING_UP: { ...DEFAULT_CONFIG.regime.signalGates.TRENDING_UP, allowOversoldFade: false },
        TRENDING_DOWN: { ...DEFAULT_CONFIG.regime.signalGates.TRENDING_DOWN, allowOverboughtFade: false },
        GAMMA_EXPIRY: { ...DEFAULT_CONFIG.regime.signalGates.GAMMA_EXPIRY, allowBreakoutFollow: false },
        NO_TRADE: DEFAULT_CONFIG.regime.signalGates.NO_TRADE,
      },
    },
  }),

  reversals: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'reversals',
    name: 'Reversals Focus',
    description: 'Trade mean reversion and extremes',
    regime: {
      ...DEFAULT_CONFIG.regime,
      signalGates: {
        MORNING_MOMENTUM: { ...DEFAULT_CONFIG.regime.signalGates.MORNING_MOMENTUM, allowBreakoutFollow: false },
        MEAN_REVERSION: DEFAULT_CONFIG.regime.signalGates.MEAN_REVERSION,
        TRENDING_UP: { ...DEFAULT_CONFIG.regime.signalGates.TRENDING_UP, allowOversoldFade: false, allowVReversal: false },
        TRENDING_DOWN: { ...DEFAULT_CONFIG.regime.signalGates.TRENDING_DOWN, allowOverboughtFade: false, allowVReversal: false },
        GAMMA_EXPIRY: DEFAULT_CONFIG.regime.signalGates.GAMMA_EXPIRY,
        NO_TRADE: DEFAULT_CONFIG.regime.signalGates.NO_TRADE,
      },
    },
  }),

  scannersEnabled: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'scanners-enabled',
    name: 'Full Scanner Pipeline',
    description: 'Enable Tier 1 scanners (Kimi, GLM, MiniMax) with judges',
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: true, enableHaiku: false },
  }),

  haikuScanner: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'haiku-scanner',
    name: 'Haiku Scanner + Judge',
    description: 'Use Haiku as a Tier 1 scanner via Agent SDK (parallel execution)',
    judge: { ...DEFAULT_CONFIG.judge, models: ['haiku', 'sonnet'] },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: true, enableKimi: false, enableGlm: false, enableMinimax: false, enableHaiku: true },
  }),

  allScannersParallel: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'all-scanners-parallel',
    name: 'All Scanners + Parallel Judges',
    description: 'Haiku, Kimi, GLM, MiniMax scanners; all judges run in parallel',
    judge: { ...DEFAULT_CONFIG.judge, models: ['haiku', 'sonnet', 'opus'] },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: true, enableHaiku: true, enableKimi: true, enableGlm: true, enableMinimax: true },
  }),

  wideStrike: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'wide-strike',
    name: 'Wide Strike Range',
    description: 'Increased strike search range (±150) to capture 2-3x more contracts',
    strikeSelector: { ...DEFAULT_CONFIG.strikeSelector, strikeSearchRange: 150 },
  }),

  aggressiveWideStrike: (): ReplayConfig => ({
    ...DEFAULT_CONFIG,
    id: 'aggressive-wide-strike',
    name: 'Aggressive + Wide Strike',
    description: 'Aggressive config with ±150 strike range for maximum coverage',
    rsi: { oversoldThreshold: 15, overboughtThreshold: 85 },
    signals: { ...DEFAULT_CONFIG.signals, optionRsiOversold: 25, optionRsiOverbought: 75 },
    position: { stopLossPercent: 70, takeProfitMultiplier: 8, maxPositionsOpen: 5, positionSizeMultiplier: 1.2 },
    sizing: { baseDollarsPerTrade: 400, sizeMultiplier: 1.5, minContracts: 1, maxContracts: 15 },
    strikeSelector: { ...DEFAULT_CONFIG.strikeSelector, strikeSearchRange: 150 },
  }),
};

export function mergeConfig(base: ReplayConfig, overrides: Partial<ReplayConfig>): ReplayConfig {
  return {
    ...base,
    ...overrides,
    rsi: { ...base.rsi, ...overrides.rsi },
    indicators: { ...base.indicators, ...overrides.indicators },
    signals: { ...base.signals, ...overrides.signals },
    position: { ...base.position, ...overrides.position },
    regime: { ...base.regime, ...overrides.regime },
    judge: { ...base.judge, ...overrides.judge },
    prompts: { ...base.prompts, ...overrides.prompts },
    strikeSelector: { ...base.strikeSelector, ...overrides.strikeSelector },
    sizing: { ...base.sizing, ...overrides.sizing },
    scanners: { ...base.scanners, ...overrides.scanners },
    escalation: { ...base.escalation, ...overrides.escalation },
    timing: { ...base.timing, ...overrides.timing },
    risk: { ...base.risk, ...overrides.risk },
    exit: { ...base.exit, ...overrides.exit },
    timeWindows: overrides.timeWindows !== undefined
      ? { ...(base.timeWindows || {}), ...overrides.timeWindows }
      : base.timeWindows,
  };
}

export function validateConfig(config: ReplayConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (config.rsi.oversoldThreshold < 0 || config.rsi.oversoldThreshold > 50)
    errors.push('RSI oversold threshold must be between 0-50');
  if (config.rsi.overboughtThreshold < 50 || config.rsi.overboughtThreshold > 100)
    errors.push('RSI overbought threshold must be between 50-100');
  if (config.rsi.oversoldThreshold >= config.rsi.overboughtThreshold)
    errors.push('RSI oversold must be less than overbought');
  if (config.signals.optionRsiOversold < 5 || config.signals.optionRsiOversold > 50)
    errors.push('Option RSI oversold must be between 5-50');
  if (config.signals.optionRsiOverbought < 50 || config.signals.optionRsiOverbought > 95)
    errors.push('Option RSI overbought must be between 50-95');
  if (config.position.stopLossPercent < 0 || config.position.stopLossPercent > 100)
    errors.push('Stop loss must be between 0-100% (0 = no stop)');
  if (config.position.takeProfitMultiplier < 1 || config.position.takeProfitMultiplier > 50)
    errors.push('Take profit multiplier must be between 1-50x');
  if (config.judge.confidenceThreshold < 0 || config.judge.confidenceThreshold > 1)
    errors.push('Confidence threshold must be between 0-1');
  if (config.sizing.baseDollarsPerTrade < 50 || config.sizing.baseDollarsPerTrade > 5000)
    errors.push('Base dollars per trade must be between $50-$5000');
  if (config.sizing.minContracts < 1)
    errors.push('Min contracts must be >= 1');
  if (config.sizing.maxContracts < config.sizing.minContracts)
    errors.push('Max contracts must be >= min contracts');
  if (config.strikeSelector.strikeSearchRange < 20 || config.strikeSelector.strikeSearchRange > 200)
    errors.push('Strike search range must be between 20-200 points');

  // Validate scanner promptId if scanners are enabled
  if (config.scanners.enabled && !validateScannerPromptId(config.scanners.promptId)) {
    errors.push(`Invalid scanner promptId: ${config.scanners.promptId}`);
  }

  // Validate escalation logic
  if (!config.escalation.signalTriggersJudge && !config.escalation.scannerTriggersJudge) {
    errors.push('At least one of signalTriggersJudge or scannerTriggersJudge must be true');
  }
  if (config.escalation.minScannersToEscalate !== undefined) {
    if (config.escalation.minScannersToEscalate < 1 || config.escalation.minScannersToEscalate > 4) {
      errors.push('minScannersToEscalate must be between 1-4');
    }
  }

  return { valid: errors.length === 0, errors };
}
