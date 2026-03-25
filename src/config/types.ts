/**
 * Unified configuration types — single source of truth for all subsystems.
 *
 * Config: the main config blob stored in `configs` table as JSON
 * ModelRecord: row in `models` table (model registry)
 * PromptRecord: row in `prompts` table (prompt library)
 *
 * API keys stay in .env — never stored in DB.
 */

// ── Signal Gate (per-regime rules) ─────────────────────────────────────────

export interface SignalGate {
  allowOverboughtFade: boolean;
  allowOversoldFade: boolean;
  allowBreakoutFollow: boolean;
  allowVReversal: boolean;
  overboughtMeaning: 'reversal' | 'momentum';
  oversoldMeaning: 'reversal' | 'momentum';
}

// ── Config (stored as JSON in configs table) ───────────────────────────────

export interface Config {
  id: string;
  name: string;
  description?: string;
  baselineId?: string;      // parent config this was derived from
  createdAt: number;
  updatedAt: number;

  scanners: {
    enabled: boolean;
    /** Model IDs from models table, e.g. ['kimi', 'glm', 'haiku'] */
    models: string[];
    cycleIntervalSec: number;
    minConfidenceToEscalate: number;
    /** Per-model prompt assignment: model ID → prompt ID. Falls back to defaultPromptId. */
    promptAssignments: Record<string, string>;
    /** Default prompt ID if model not in promptAssignments */
    defaultPromptId: string;
  };

  judges: {
    enabled: boolean;
    /** Model IDs from models table, e.g. ['sonnet'] */
    models: string[];
    /** Which judge's decision to execute on */
    activeJudge: string;
    consensusRule: 'primary-decides' | 'majority' | 'unanimous' | 'first-agree';
    confidenceThreshold: number;
    escalationCooldownSec: number;
    /** Prompt ID for judge system prompt */
    promptId: string;
  };

  regime: {
    enabled: boolean;
    mode: 'enforce' | 'advisory' | 'disabled';
    classification: {
      trendThreshold: number;        // pts/bar — ~0.15 = $9/5min sustained move
      lookbackBars: number;
      openingRangeMinutes: number;
    };
    timeWindows: {
      morningEnd: string;            // 'HH:MM' ET
      middayEnd: string;
      gammaExpiryStart: string;
      noTradeStart: string;
    };
    signalGates: Record<string, SignalGate>;
  };

  signals: {
    enableRsiCrosses: boolean;
    enableHmaCrosses: boolean;
    enablePriceCrossHma: boolean;   // price crossing HMA5 (noisy — separate from HMA5×HMA19 cross)
    enableEmaCrosses: boolean;
    requireUnderlyingHmaCross: boolean;  // require SPX HMA cross in same direction
    hmaCrossFast: number;   // fast HMA period for cross detection (default 5)
    hmaCrossSlow: number;   // slow HMA period for cross detection (default 19)
    emaCrossFast: number;   // fast EMA period for cross detection (default 9)
    emaCrossSlow: number;   // slow EMA period for cross detection (default 21)
    targetOtmDistance: number | null;    // if set, only trade the strike closest to this OTM distance (e.g. 25 = $25 OTM)
    targetContractPrice: number | null;  // if set, only trade contracts priced near this $ (e.g. 3.00 = ~$3.00 premium)
    rsiOversold: number;
    rsiOverbought: number;
    optionRsiOversold: number;
    optionRsiOverbought: number;
  };

  position: {
    stopLossPercent: number;
    takeProfitMultiplier: number;
    maxPositionsOpen: number;
    defaultQuantity: number;
    positionSizeMultiplier: number;
  };

  risk: {
    maxDailyLoss: number;
    maxTradesPerDay: number;
    maxRiskPerTrade: number;
    cutoffTimeET: string;            // 'HH:MM'
    minMinutesToClose: number;
  };

  strikeSelector: {
    strikeSearchRange: number;
    contractPriceMin: number;        // min option premium to consider ($)
    contractPriceMax: number;        // max option premium to consider ($)
  };

  timeWindows: {
    sessionStart: string;            // 'HH:MM' ET
    sessionEnd: string;
    activeStart: string;
    activeEnd: string;
    skipWeekends: boolean;
    skipHolidays: boolean;
  };

  escalation: {
    signalTriggersJudge: boolean;
    scannerTriggersJudge: boolean;
    requireScannerAgreement: boolean;
    requireSignalAgreement: boolean;
    minScannersToEscalate?: number;
  };

  exit: {
    strategy: 'takeProfit' | 'scannerReverse';
    trailingStopEnabled: boolean;
    trailingStopPercent: number;
    timeBasedExitEnabled: boolean;
    timeBasedExitMinutes: number;
    reversalSizeMultiplier: number;
  };

  narrative: {
    buildOvernightContext: boolean;
    barHistoryDepth: number;
    trackTrajectory: boolean;
  };

  pipeline: {
    pollUnderlyingMs: number;
    pollOptionsRthMs: number;
    pollOptionsOvernightMs: number;
    pollScreenerMs: number;
    strikeBand: number;
    strikeInterval: number;
    gapInterpolateMaxMins: number;
    maxBarsMemory: number;
    timeframe: '1m' | '3m' | '5m' | '10m' | '15m' | '1h';
  };

  contracts: {
    stickyBandWidth: number;
  };

  calendar: {
    holidays: string[];              // ['2026-01-01', ...]
    earlyCloseDays: string[];
  };

  sizing: {
    baseDollarsPerTrade: number;
    sizeMultiplier: number;
    minContracts: number;
    maxContracts: number;
  };
}

// ── Model Registry (models table) ──────────────────────────────────────────

export interface ModelRecord {
  id: string;                        // 'kimi', 'glm', 'sonnet', etc.
  name: string;                      // 'Kimi K2.5', 'Claude Sonnet'
  provider: string;                  // 'moonshot', 'zhipu', 'minimax', 'anthropic'
  role: 'scanner' | 'judge' | 'both';
  baseUrl: string;                   // 'https://api.kimi.com/coding/' or 'anthropic' for native
  modelName: string;                 // 'kimi-k2', 'claude-sonnet-4-6'
  apiKeyEnv: string;                 // env var name: 'KIMI_API_KEY' (never the actual key)
  /** Timeout in ms. Default 180000 (3 min). Sensible range: 120000-300000 (2-5 min). */
  timeoutMs: number;
  maxTokens: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Prompt Library (prompts table) ─────────────────────────────────────────

export interface PromptRecord {
  id: string;                        // 'scanner-baseline-v1', 'judge-regime-v2'
  role: 'scanner' | 'judge';
  name: string;
  content: string;                   // full prompt text
  version?: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Active Config Binding (active_configs table) ───────────────────────────

export interface ActiveConfigBinding {
  subsystem: string;                 // 'live-agent', 'replay', 'autoresearch', 'monitor'
  configId: string;
  loadedAt: number;
}

// ── Resolved Config (Config + models + prompts hydrated) ───────────────────

export interface ResolvedConfig extends Config {
  /** Hydrated model records for scanner models */
  resolvedScanners: ModelRecord[];
  /** Hydrated model records for judge models */
  resolvedJudges: ModelRecord[];
  /** Hydrated prompt records keyed by prompt ID */
  resolvedPrompts: Record<string, PromptRecord>;
}
