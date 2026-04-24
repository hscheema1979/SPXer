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
    /** Entry cooldown in seconds between trades. */
    entryCooldownSec: number;
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

    /** Which contract side provides the HMA cross trigger.
     *  'both' (default) = subscribe to call and put signals, trade direction directly.
     *  'call' = only subscribe to call signals; bearish call cross → buy put at offset.
     *  'put' = only subscribe to put signals; bullish put cross → buy call at offset. */
    signalSource?: 'both' | 'call' | 'put';

    /** Reverse all signal directions — bullish becomes bearish, bearish becomes bullish.
     *  Useful for trading chop: fade every cross instead of following it. */
    reverseSignals: boolean;

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
    /** Intrabar tie-breaker when bar.low <= SL AND bar.high >= TP in the same bar.
     *  'sl_wins'  — conservative default (current behavior); assume SL hit first.
     *  'tp_wins'  — assume TP hit first (aggressive).
     *  'by_open'  — if bar.open is closer to TP than SL, TP wins; else SL wins.
     *               Best live-realism: mirrors most common fill order.
     *  Defaults to 'sl_wins' when unset to preserve existing replay behavior. */
    intrabarTieBreaker?: 'sl_wins' | 'tp_wins' | 'by_open';
  };

  risk: {
    maxDailyLoss: number;
    maxTradesPerDay: number;
    maxRiskPerTrade: number;
    cutoffTimeET: string;            // 'HH:MM'
    minMinutesToClose: number;
    /** Circuit breaker: max HMA cross signals per session before halting entries.
     *  Normal sessions produce ~5-15 signals. If noisy/corrupted bar data causes
     *  HMA to oscillate wildly, signal count can spike to 50-100+, racking up
     *  losses. When sessionSignalCount >= this threshold, all new entries are blocked.
     *  Default: 30. Set to 0 to disable. */
    maxSignalsPerSession?: number;
  };

  strikeSelector: {
    strikeSearchRange: number;
    contractPriceMin: number;        // min option premium to consider ($)
    contractPriceMax: number;        // max option premium to consider ($)
    /** Strike moneyness mode: 'otm' (default), 'atm', 'itm', 'any', 'atm-offset'.
     *  - 'otm': only OTM strikes (calls > SPX, puts < SPX)
     *  - 'atm': prefer strikes nearest to SPX price
     *  - 'itm': prefer ITM strikes (calls < SPX, puts > SPX)
     *  - 'any': no moneyness filter — score purely on price band + volume
     *  - 'atm-offset': target exact $ offset from ATM (used by basket members).
     *                   Requires `atmOffset` field. Bypasses price band. */
    strikeMode?: 'otm' | 'atm' | 'itm' | 'any' | 'atm-offset';
    /** For strikeMode='atm-offset': signed $ offset from ATM.
     *    0  = ATM
     *   +5  = OTM5  (call strike > SPX, put strike < SPX)
     *   -5  = ITM5  (call strike < SPX, put strike > SPX)
     *   +10 = OTM10, -10 = ITM10, etc.
     *  Aligns with basket member conventions. */
    atmOffset?: number;
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

    /** Re-entry on take-profit: when a position closes via TP, optionally
     *  open a follow-on position in the same direction to ride continuing momentum.
     *  Disabled by default — must be opted into per-config. */
    reentryOnTakeProfit?: {
      enabled: boolean;
      /** 'same_direction'         — re-enter same side at a fresh OTM strike, no signal re-confirm
       *  'fresh_signal_required'  — re-enter only if the option contract HMA still confirms the side */
      strategy: 'same_direction' | 'fresh_signal_required';
      /** Hard cap on TP re-entries per session. */
      maxReentriesPerDay: number;
      /** Max chained re-entries from a single original entry (1 = one re-entry only). */
      maxReentriesPerSignal: number;
      /** Cooldown in seconds between TP exit and re-entry. Independent of judges.entryCooldownSec. */
      cooldownSec: number;
      /** Multiplier on computeQty() for re-entry size. 1.0 = same size, 0.5 = half. */
      sizeMultiplier: number;
      /** If true, require option contract HMA direction to still match the re-entered side. */
      requireOptionHmaConfirm: boolean;
    };
  };

  /** Fill-model parameters — realistic execution simulation.
   *
   *  Phase 2 adds stop-market slippage on top of the existing half-spread in
   *  friction.ts. TPs are limit orders and fill at the limit price (no extra
   *  slippage beyond friction). SLs are stop-market orders and walk the book
   *  for large sizes.
   *
   *  All fields optional for backward compat. When undefined, behaves exactly
   *  like Phase 1 (clamp to TP/SL level, then apply friction).
   */
  fill?: {
    slippage?: {
      /** Additional $ per contract knocked off SL fills (on top of friction
       *  half-spread). Models book depth consumed by a market order. Default 0.
       *  Conservative starting value: 0.002 ($0.02/contract for a 10-lot). */
      slSlipPerContract?: number;
      /** Absolute cap on total SL slippage dollars. Prevents a 1000-contract
       *  backtest from subtracting $20/option. Default 0.50. */
      slSlipMax?: number;
      /** Additional $ per contract added to entry fills (on top of friction
       *  half-spread). Models the ask side walking up when a market buy sweeps
       *  the book. Default 0. Conservative: 0.002 ($0.02/contract for a 10-lot). */
      entrySlipPerContract?: number;
      /** Absolute cap on total entry slippage dollars. Default 0.50. */
      entrySlipMax?: number;
      /** Multiplier applied to the bar's observed bid-ask spread when pricing
       *  SL fills. Models wider spreads meaning worse stop-out prices.
       *  Effective extra slip = spread * slSpreadFactor (per contract-agnostic,
       *  dollar-per-option). Default 0 (disabled). Recommended: 0.5. */
      slSpreadFactor?: number;
      /** Additional $ penalty applied to SL fills during the last
       *  `slEodWindowMin` minutes before `risk.cutoffTimeET`. Models the
       *  terminal-hour liquidity drought on 0DTE SPX options. Default 0. */
      slEodPenalty?: number;
      /** Window in minutes before cutoff during which `slEodPenalty` applies.
       *  Default 15. Only relevant when slEodPenalty > 0. */
      slEodWindowMin?: number;
    };
    /** Participation-rate liquidity gate (Phase 4).
     *  Caps fills to barVolume × participationRate. Trades where the capped qty
     *  would fall below minContracts are skipped entirely.
     *  undefined = no cap (old behavior). */
    participationRate?: number;
    /** Minimum contracts required to enter a trade after the liquidity cap.
     *  If capped qty < minContracts, the trade is skipped. Default 1. */
    minContracts?: number;
    /** Bid-ask spread model for friction cost estimation.
     *
     *  'flat'   — constant $0.05 half-spread for all contracts (legacy default).
     *  'scaled' — half-spread scales with option price:
     *             halfSpread = max(spreadFloor, optionPrice × spreadPct)
     *             Models the real-world observation that ITM/expensive options
     *             have wider spreads while cheap OTM options stay at the minimum.
     *
     *  Default: 'flat' (backward compatible). New configs should use 'scaled'. */
    spreadModel?: {
      /** 'flat' = constant half-spread, 'scaled' = price-proportional. Default 'flat'. */
      mode: 'flat' | 'scaled';
      /** Minimum half-spread in dollars. Default $0.05. */
      spreadFloor?: number;
      /** Fraction of option price used as half-spread in 'scaled' mode.
       *  Default 0.01 (1%). A $15 ITM option gets $0.15 half-spread;
       *  a $2 OTM option gets $0.05 (floor). */
      spreadPct?: number;
    };
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
  };

  /** Execution target — controls which symbol/account orders are placed against.
   *  If omitted, defaults to SPX options on the primary TRADIER_ACCOUNT_ID. */
  execution?: {
    /** Root symbol for order placement: 'SPX' (default) */
    symbol: string;
    /** Option symbol prefix: 'SPXW' (default) */
    optionPrefix: string;
    /** Strike divisor relative to SPX: 1 for SPX */
    strikeDivisor: number;
    /** Strike interval in the target product: 5 for SPX */
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

  /** Basket mode — when enabled, this config describes a multi-strike strategy.
   *  Each member runs as an isolated single-strike replay; results aggregate
   *  under a composite configId `${id}:_basket`. Derive live single-strike
   *  configs via `scripts/derive-live-from-basket.ts`. */
  basket?: {
    enabled: boolean;
    members: BasketMember[];
  };
}

// ── Basket Member (replay-time fan-out unit) ─────────────────────────────────

export interface BasketMember {
  /** Short identifier for this member — used in derived configIds and labels.
   *  Examples: 'itm10', 'itm5', 'atm', 'otm5', 'otm10'. */
  id: string;
  /** Strike offset from ATM in $.
   *    0  = ATM
   *   +5  = OTM5  (call strike > SPX, put strike < SPX)
   *   -5  = ITM5  (call strike < SPX, put strike > SPX)
   *   +10 = OTM10, -10 = ITM10, etc. */
  strikeOffset: number;
  /** Optional per-member overrides — deep-merged onto the base config before
   *  the replay runs. Typical use: tighten `sizing.sizingValue` for illiquid
   *  wings (e.g., OTM10 at 8% instead of the shared 11%). */
  overrides?: Partial<Config>;
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
  return config.judges.entryCooldownSec ?? 0;
}
