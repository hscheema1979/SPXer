/**
 * Default configuration values and deep merge utility.
 * These are used to seed the DB on first run.
 */

import type { Config, ModelRecord, PromptRecord } from './types';

// ── Default Config ─────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Config = {
  id: 'default',
  name: 'Default Configuration',
  description: 'Baseline 0DTE trading config — conservative defaults',
  createdAt: 0,  // set on save
  updatedAt: 0,

  scanners: {
    enabled: true,
    models: ['kimi', 'glm', 'haiku'],
    cycleIntervalSec: 60,
    minConfidenceToEscalate: 0.5,
    promptAssignments: {},
    defaultPromptId: 'scanner-rsi-extremes-v2',
  },

  judges: {
    enabled: true,
    models: ['sonnet'],
    activeJudge: 'sonnet',
    consensusRule: 'primary-decides',
    confidenceThreshold: 0.5,
    entryCooldownSec: 0,
    promptId: 'judge-regime-advisor-v1',
  },

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
      noTradeStart: '15:55',
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

  signals: {
    enableRsiCrosses: true,
    enableHmaCrosses: true,
    enablePriceCrossHma: true,
    enableEmaCrosses: false,
    requireUnderlyingHmaCross: false,
    hmaCrossFast: 5,
    hmaCrossSlow: 19,
    emaCrossFast: 9,
    emaCrossSlow: 21,
    signalTimeframe: '1m',
    directionTimeframe: '1m',
    exitTimeframe: '',              // empty = same as directionTimeframe
    hmaCrossTimeframe: null,        // null = use signalTimeframe
    rsiCrossTimeframe: null,
    emaCrossTimeframe: null,
    priceCrossHmaTimeframe: null,
    allowedSides: 'both' as const,
    targetOtmDistance: null,
    targetContractPrice: null,
    maxEntryPrice: null,           // Filter: skip trades above this price
    rsiOversold: 20,
    rsiOverbought: 80,
    optionRsiOversold: 40,
    optionRsiOverbought: 60,

    // Keltner Channel trend filter
    enableKeltnerGate: false,
    kcEmaPeriod: 20,
    kcAtrPeriod: 14,
    kcMultiplier: 2.5,
    kcSlopeLookback: 5,
    kcSlopeThreshold: 0.3,

    // Multi-timeframe confirmation gate (disabled by default)
    mtfConfirmation: {
      enabled: false,
      timeframe: '5m',
      requireAgreement: true,
    },

    // Warm-up bar guard (0 = disabled, rely on activeStart for warm-up)
    minWarmupBars: 0,
  },

  position: {
    stopLossPercent: 80,
    takeProfitMultiplier: 5,
    maxPositionsOpen: 100,
    defaultQuantity: 1,
    positionSizeMultiplier: 1.0,
  },

  risk: {
    maxDailyLoss: 999999,
    maxTradesPerDay: 999,
    maxRiskPerTrade: 2000,
    cutoffTimeET: '16:00',
    minMinutesToClose: 15,
  },

  strikeSelector: {
    strikeSearchRange: 80,
    contractPriceMin: 0.2,
    contractPriceMax: 9999,  // no ceiling — all contracts eligible; filter at analysis time
    strikeMode: 'otm',      // 'otm' | 'atm' | 'itm' | 'any'
  },

  timeWindows: {
    sessionStart: '09:30',
    sessionEnd: '15:45',
    activeStart: '10:00',    // No trades in first 30 min — let indicators warm up
    activeEnd: '15:45',
    skipWeekends: true,
    skipHolidays: true,
  },

  escalation: {
    signalTriggersJudge: true,
    scannerTriggersJudge: true,
    requireScannerAgreement: false,
    requireSignalAgreement: false,
  },

  exit: {
    strategy: 'takeProfit',
    trailingStopEnabled: false,
    trailingStopPercent: 20,
    timeBasedExitEnabled: false,
    timeBasedExitMinutes: 30,
    reversalSizeMultiplier: 1.0,
  },

  narrative: {
    buildOvernightContext: true,
    barHistoryDepth: 60,
    trackTrajectory: true,
  },

  pipeline: {
    pollUnderlyingMs: 60_000,
    pollOptionsRthMs: 30_000,
    pollOptionsOvernightMs: 300_000,
    pollScreenerMs: 60_000,
    strikeBand: 100,
    strikeInterval: 5,
    gapInterpolateMaxMins: 60,
    maxBarsMemory: 2000,
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
      '2027-01-01','2027-01-18','2027-02-15','2027-03-26',
      '2027-05-31','2027-06-18','2027-07-05','2027-09-06',
      '2027-11-25','2027-12-24',
    ],
    earlyCloseDays: [
      '2025-07-03','2025-11-28',
      '2026-07-02','2026-11-27',
      '2027-07-02','2027-11-26',
    ],
  },

  sizing: {
    sizingMode: 'fixed_dollars',
    sizingValue: 10000,
    startingAccountValue: 10000,
    baseDollarsPerTrade: 10000,
    sizeMultiplier: 1.0,
    minContracts: 1,
    maxContracts: 99,
  },
};

// ── Default Model Registry ─────────────────────────────────────────────────

export const DEFAULT_MODELS: ModelRecord[] = [
  {
    id: 'kimi',
    name: 'Kimi K2.5',
    provider: 'moonshot',
    role: 'scanner',
    baseUrl: 'https://api.kimi.com/coding/',
    modelName: 'kimi-k2',
    apiKeyEnv: 'KIMI_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 1024,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'glm',
    name: 'ZAI GLM-5',
    provider: 'zhipu',
    role: 'scanner',
    baseUrl: 'https://api.z.ai/api/anthropic',
    modelName: 'glm-5',
    apiKeyEnv: 'GLM_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 1024,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'minimax',
    name: 'MiniMax M2.7',
    provider: 'minimax',
    role: 'scanner',
    baseUrl: 'https://api.minimax.io/anthropic',
    modelName: 'MiniMax-M2.7',
    apiKeyEnv: 'MINIMAX_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 1024,
    enabled: false,  // disabled — API returns empty body on direct HTTP
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku',
    provider: 'anthropic',
    role: 'both',
    baseUrl: 'anthropic',
    modelName: 'claude-haiku-4-5-20251001',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 1024,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'sonnet',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    role: 'both',
    baseUrl: 'anthropic',
    modelName: 'claude-sonnet-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 2048,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: 'opus',
    name: 'Claude Opus',
    provider: 'anthropic',
    role: 'both',
    baseUrl: 'anthropic',
    modelName: 'claude-opus-4-6',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    timeoutMs: 180_000,
    maxTokens: 4096,
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

// ── Deep Merge ─────────────────────────────────────────────────────────────

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === 'object' && !Array.isArray(val);
}

/** Deep merge overrides into base. Arrays are replaced, not merged. */
export function mergeConfig(base: Config, overrides: Partial<Config>): Config {
  const result: any = { ...base };
  for (const key of Object.keys(overrides) as (keyof Config)[]) {
    const baseVal = (base as any)[key];
    const overVal = (overrides as any)[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = { ...baseVal, ...overVal };
    } else if (overVal !== undefined) {
      result[key] = overVal;
    }
  }
  return result;
}

// ── Validation ─────────────────────────────────────────────────────────────

export function validateConfig(config: Config): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config.id) errors.push('id is required');
  if (!config.name) errors.push('name is required');

  // Signals
  if (config.signals.rsiOversold >= config.signals.rsiOverbought) {
    errors.push(`rsiOversold (${config.signals.rsiOversold}) must be < rsiOverbought (${config.signals.rsiOverbought})`);
  }
  if (config.signals.optionRsiOversold >= config.signals.optionRsiOverbought) {
    errors.push(`optionRsiOversold (${config.signals.optionRsiOversold}) must be < optionRsiOverbought (${config.signals.optionRsiOverbought})`);
  }

  // Position
  if (config.position.stopLossPercent < 0 || config.position.stopLossPercent > 100) {
    errors.push(`stopLossPercent must be 0-100, got ${config.position.stopLossPercent}`);
  }
  if (config.position.takeProfitMultiplier <= 0) {
    errors.push(`takeProfitMultiplier must be > 0, got ${config.position.takeProfitMultiplier}`);
  }

  // Risk
  if (config.risk.maxDailyLoss <= 0) errors.push('maxDailyLoss must be > 0');
  if (config.risk.maxTradesPerDay <= 0) errors.push('maxTradesPerDay must be > 0');

  // Judges
  if (config.judges.enabled && config.judges.models.length === 0) {
    errors.push('judges.enabled is true but no judge models selected');
  }
  if (config.judges.enabled && !config.judges.models.includes(config.judges.activeJudge)) {
    errors.push(`activeJudge '${config.judges.activeJudge}' is not in judges.models`);
  }

  // Cooldown
  const cooldown = config.judges.entryCooldownSec ?? config.judges.escalationCooldownSec ?? 0;
  if (cooldown < 0) {
    errors.push('entryCooldownSec must be >= 0');
  }

  // Regime
  if (config.regime.enabled && Object.keys(config.regime.signalGates).length === 0) {
    errors.push('regime.enabled is true but no signalGates defined');
  }

  return { valid: errors.length === 0, errors };
}
