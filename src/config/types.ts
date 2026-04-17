/**
 * Unified configuration types — single source of truth for all subsystems.
 *
 * Config: the main config blob stored in `replay_configs` table as JSON.
 * Used by both replay and live agents via ReplayStore.
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

// ── Config (stored as JSON in replay_configs table) ────────────────────────

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
    /** Entry cooldown in seconds between trades.
     *  Renamed from escalationCooldownSec. Both names are supported for backward compat. */
    entryCooldownSec: number;
    /** @deprecated Use entryCooldownSec instead */
    escalationCooldownSec?: number;
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

    // ── Multi-timeframe control ──────────────────────────────────────
    // Each signal type can read from a different TF bar cache.
    // 'signalTimeframe' is the default for option contract signal detection.
    // 'directionTimeframe' is for SPX HMA direction filter (entry gate).
    // 'exitTimeframe' is for SPX HMA used in exit reversal detection.
    // Per-indicator TF overrides let you mix: e.g. RSI from 1m + HMA from 5m.
    signalTimeframe: string;        // default TF for option contract signals (default '1m')
    directionTimeframe: string;     // TF for SPX HMA direction filter on entry (default '1m')
    exitTimeframe: string;          // TF for SPX HMA reversal detection on exit (default same as directionTimeframe)

    // Per-signal-type TF overrides (null = use signalTimeframe)
    hmaCrossTimeframe: string | null;     // TF for HMA cross signals (null = signalTimeframe)
    rsiCrossTimeframe: string | null;     // TF for RSI cross signals (null = signalTimeframe)
    emaCrossTimeframe: string | null;     // TF for EMA cross signals (null = signalTimeframe)
    priceCrossHmaTimeframe: string | null; // TF for price-cross-HMA signals (null = signalTimeframe)

    /** Filter which sides are allowed for entry.
     *  'both' (default) = calls + puts. 'calls' = long only (bullish signals only).
     *  'puts' = short only (bearish signals only). */
    allowedSides: 'both' | 'calls' | 'puts';

    targetOtmDistance: number | null;
    targetContractPrice: number | null;
    maxEntryPrice: number | null;        // Filter: skip trades above this price
    rsiOversold: number;
    rsiOverbought: number;
    optionRsiOversold: number;
    optionRsiOverbought: number;

    // ── Keltner Channel Trend Filter ──────────────────────────────────────
    enableKeltnerGate: boolean;           // master toggle for KC trend gate
    kcEmaPeriod: number;                  // default 20
    kcAtrPeriod: number;                  // default 14
    kcMultiplier: number;                 // default 2.5
    kcSlopeLookback: number;              // default 5 (bars)
    kcSlopeThreshold: number;             // default 0.3 (pts/bar) — below this = range

    // ── Multi-Timeframe Confirmation Gate ─────────────────────────────────
    /** When enabled, require a higher timeframe HMA direction to agree with
     *  the signal before entering. Filters choppy single-timeframe signals. */
    mtfConfirmation?: {
      enabled: boolean;                   // false by default
      timeframe: string;                  // higher TF to check, e.g. '5m', '15m'
      requireAgreement: boolean;          // HMA direction must agree with signal direction
    };

    // ── Warm-up Bar Guard ─────────────────────────────────────────────────
    /** Minimum number of closed bars required before signal detection fires.
     *  Prevents garbage signals on startup/restart when indicators haven't warmed up.
     *  Default: 0 (disabled — rely on activeStart for warm-up timing).
     *  Recommended: >= hmaCrossSlow (e.g. 19 for HMA(5)×HMA(19)). */
    minWarmupBars?: number;
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
    /** Strike moneyness mode: 'otm' (default), 'atm', 'itm', 'any'.
     *  - 'otm': only OTM strikes (calls > SPX, puts < SPX)
     *  - 'atm': prefer strikes nearest to SPX price
     *  - 'itm': prefer ITM strikes (calls < SPX, puts > SPX)
     *  - 'any': no moneyness filter — score purely on price band + volume */
    strikeMode?: 'otm' | 'atm' | 'itm' | 'any';
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
    /** How to price exits in replay/backtest.
     *  'close' = use bar close price (legacy, can overshoot TP/SL).
     *  'intrabar' = use bar high/low to detect TP/SL breach, exit at the limit price.
     *  Live agents with bracket orders always fill at exact TP/SL regardless.
     *  Default: 'close' for backward compat. */
    exitPricing?: 'close' | 'intrabar';
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
    timeframe: '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '1h';
  };

  contracts: {
    stickyBandWidth: number;
  };

  calendar: {
    holidays: string[];              // ['2026-01-01', ...]
    earlyCloseDays: string[];
  };

  sizing: {
    /**
     * Sizing mode determines how position size is calculated:
     *   'fixed_dollars'    — spend up to `sizingValue` dollars per trade (default)
     *   'fixed_contracts'  — always trade exactly `sizingValue` contracts
     *   'percent_of_account' — spend `sizingValue`% of account value per trade
     *                          (live: Tradier buying power; replay: startingAccountValue + cumulative P&L)
     */
    sizingMode: 'fixed_dollars' | 'fixed_contracts' | 'percent_of_account';
    /** The value whose meaning depends on sizingMode:
     *   fixed_dollars → dollars per trade (e.g. 500)
     *   fixed_contracts → number of contracts (e.g. 10)
     *   percent_of_account → percentage (e.g. 15 for 15%)
     */
    sizingValue: number;
    /** Starting account value for replay simulations.
     *  Live agents ignore this — they fetch real buying power from Tradier.
     *  Default: 10000 */
    startingAccountValue?: number;
    minContracts: number;
    maxContracts: number;
    // ── Legacy fields (still read for backward compat) ──
    baseDollarsPerTrade: number;
    sizeMultiplier: number;
    accountPercentPerTrade?: number | null;
    /** @deprecated Use sizingMode='percent_of_account' instead */
    riskPercentOfAccount?: number;
  };

  /** Execution target — controls which symbol/account orders are placed against.
   *  If omitted, defaults to SPX options on the primary TRADIER_ACCOUNT_ID. */
  execution?: {
    /** Root symbol for order placement: 'SPX' (default), 'XSP', 'SPY' */
    symbol: string;
    /** Option symbol prefix: 'SPXW' (default), 'XSP', 'SPY' */
    optionPrefix: string;
    /** Strike divisor relative to SPX: 1 for SPX, 10 for XSP, ~10 for SPY */
    strikeDivisor: number;
    /** Strike interval in the target product: 5 for SPX, 1 for XSP/SPY */
    strikeInterval: number;
    /** Tradier account ID override (for multi-account setups) */
    accountId?: string;
    /** Use 1DTE instead of 0DTE */
    use1dte?: boolean;
    /** Wider friction for less-liquid products */
    halfSpread?: number;
    /** Skip OTOCO bracket orders — use simple market entry, agent monitors exits */
    disableBracketOrders?: boolean;
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

/** Resolve the entry cooldown from config, supporting both old and new field names.
 *  Prefers `entryCooldownSec`, falls back to `escalationCooldownSec` for backward compat. */
export function getEntryCooldownSec(config: Config): number {
  return config.judges.entryCooldownSec ?? config.judges.escalationCooldownSec ?? 0;
}
