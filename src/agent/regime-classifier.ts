/**
 * Regime Classifier — determines current market regime every bar.
 *
 * The #1 recommendation from all 7 reviewing models (Haiku, Sonnet, Opus,
 * Kimi, GLM, MiniMax, Gemini 3.1 Pro): "Add a regime classifier as the
 * first gate before any signal fires."
 *
 * Regimes:
 *   MORNING_MOMENTUM  — 09:30-10:15 ET, or until opening range is established
 *   MEAN_REVERSION    — 10:15-14:00 ET when not trending
 *   TRENDING          — any time when slope > threshold (overrides time-of-day)
 *   GAMMA_EXPIRY      — 14:00-15:30 ET (last 90 minutes)
 *   NO_TRADE           — 15:30-16:00 ET (too close to expiry)
 *
 * Each regime defines which signals are allowed and which are suppressed.
 */

export type Regime =
  | 'MORNING_MOMENTUM'
  | 'MEAN_REVERSION'
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'GAMMA_EXPIRY'
  | 'NO_TRADE';

export interface RegimeState {
  regime: Regime;
  confidence: number;           // 0-1, how confident we are in the classification
  trendSlope: number;           // 20-bar linear regression slope (pts/bar)
  openingRangeHigh: number;     // first 15min high
  openingRangeLow: number;      // first 15min low
  openingRangeSet: boolean;     // true after 09:45
  sessionHigh: number;
  sessionLow: number;
  gapPct: number;               // |open - prior close| / prior close * 100
  barsProcessed: number;
}

export interface SignalGate {
  allowOverboughtFade: boolean;   // can we enter puts on RSI overbought?
  allowOversoldFade: boolean;     // can we enter calls on RSI oversold?
  allowBreakoutFollow: boolean;   // can we follow breakouts?
  allowVReversal: boolean;        // can we trade V-reversals?
  overboughtMeaning: 'reversal' | 'momentum';
  oversoldMeaning: 'reversal' | 'momentum';
}

// ── Internal state ──────────────────────────────────────────────────────────

let state: RegimeState = {
  regime: 'MORNING_MOMENTUM',
  confidence: 0.5,
  trendSlope: 0,
  openingRangeHigh: 0,
  openingRangeLow: Infinity,
  openingRangeSet: false,
  sessionHigh: 0,
  sessionLow: Infinity,
  gapPct: 0,
  barsProcessed: 0,
};

let priorClose: number | null = null;
const recentCloses: number[] = [];

// ── Public API ──────────────────────────────────────────────────────────────

/** Call once at session start with the prior day's close for gap classification */
export function initSession(priorDayClose: number): void {
  priorClose = priorDayClose;
  state = {
    regime: 'MORNING_MOMENTUM',
    confidence: 0.5,
    trendSlope: 0,
    openingRangeHigh: 0,
    openingRangeLow: Infinity,
    openingRangeSet: false,
    sessionHigh: 0,
    sessionLow: Infinity,
    gapPct: 0,
    barsProcessed: 0,
  };
  recentCloses.length = 0;
}

/** Call every 1m bar. Returns the current regime classification. */
export function classify(bar: { close: number; high: number; low: number; ts: number }): RegimeState {
  state.barsProcessed++;

  // Track session extremes
  if (bar.high > state.sessionHigh) state.sessionHigh = bar.high;
  if (bar.low < state.sessionLow) state.sessionLow = bar.low;

  // Track recent closes for slope calculation
  recentCloses.push(bar.close);
  if (recentCloses.length > 30) recentCloses.shift();

  // Compute gap on first bar
  if (state.barsProcessed === 1 && priorClose !== null) {
    state.gapPct = Math.abs(bar.close - priorClose) / priorClose * 100;
  }

  // Build opening range (first 15 bars = 09:30-09:45)
  if (state.barsProcessed <= 15) {
    if (bar.high > state.openingRangeHigh) state.openingRangeHigh = bar.high;
    if (bar.low < state.openingRangeLow) state.openingRangeLow = bar.low;
    if (state.barsProcessed === 15) state.openingRangeSet = true;
  }

  // Compute trend slope (20-bar linear regression)
  state.trendSlope = linearRegressionSlope(recentCloses, 20);

  // Get ET hour and minute from timestamp
  const etDate = new Date(bar.ts * 1000);
  const etStr = etDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const timePart = etStr.split(', ')[1] || etStr;
  const [h, m] = timePart.split(':').map(Number);
  const minuteOfDay = h * 60 + m;

  // ── Classification logic ────────────────────────────────────────────────

  const TREND_THRESHOLD = 0.15;  // pts/bar — ~$9/5min sustained move
  const isTrendingUp = state.trendSlope > TREND_THRESHOLD;
  const isTrendingDown = state.trendSlope < -TREND_THRESHOLD;

  // 15:30-16:00 — NO_TRADE
  if (minuteOfDay >= 15 * 60 + 30) {
    state.regime = 'NO_TRADE';
    state.confidence = 0.9;
  }
  // 14:00-15:30 — GAMMA_EXPIRY (unless strongly trending)
  else if (minuteOfDay >= 14 * 60) {
    if (isTrendingUp) {
      state.regime = 'TRENDING_UP';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else if (isTrendingDown) {
      state.regime = 'TRENDING_DOWN';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else {
      state.regime = 'GAMMA_EXPIRY';
      state.confidence = 0.7;
    }
  }
  // 09:30-10:15 — MORNING_MOMENTUM (unless opening range already broken both ways)
  else if (minuteOfDay < 10 * 60 + 15) {
    if (isTrendingUp || isTrendingDown) {
      state.regime = isTrendingUp ? 'TRENDING_UP' : 'TRENDING_DOWN';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else {
      state.regime = 'MORNING_MOMENTUM';
      state.confidence = 0.7;
    }
  }
  // 10:15-14:00 — MEAN_REVERSION or TRENDING
  else {
    if (isTrendingUp) {
      state.regime = 'TRENDING_UP';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else if (isTrendingDown) {
      state.regime = 'TRENDING_DOWN';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else {
      state.regime = 'MEAN_REVERSION';
      state.confidence = 0.6;
    }
  }

  return { ...state };
}

/** Get the signal gate rules for the current regime.
 *  rsi parameter enables emergency overrides — RSI <15 or >85 forces the gate open
 *  regardless of regime, because those extremes statistically mean-revert on 0DTE. */
export function getSignalGate(regime: Regime, rsi: number | null = null): SignalGate {
  // Morning requires MORE extreme readings to override (momentum dominates early)
  const isMorning = regime === 'MORNING_MOMENTUM';
  const isEmergencyOversold = rsi !== null && rsi < (isMorning ? 10 : 15);
  const isEmergencyOverbought = rsi !== null && rsi > (isMorning ? 92 : 85);

  // Emergency override: RSI <15 or >85 forces the gate open
  if (isEmergencyOversold && regime !== 'NO_TRADE') {
    return {
      allowOverboughtFade: false,
      allowOversoldFade: true,        // FORCED OPEN — emergency oversold
      allowBreakoutFollow: true,
      allowVReversal: true,
      overboughtMeaning: 'momentum',
      oversoldMeaning: 'reversal',    // emergency = mean reversion
    };
  }
  if (isEmergencyOverbought && regime !== 'NO_TRADE') {
    return {
      allowOverboughtFade: true,      // FORCED OPEN — emergency overbought
      allowOversoldFade: false,
      allowBreakoutFollow: true,
      allowVReversal: true,
      overboughtMeaning: 'reversal',  // emergency = mean reversion
      oversoldMeaning: 'momentum',
    };
  }
  switch (regime) {
    case 'MORNING_MOMENTUM':
      return {
        allowOverboughtFade: false,   // do NOT short morning momentum
        allowOversoldFade: false,     // do NOT buy dips until range established
        allowBreakoutFollow: true,    // follow the opening drive
        allowVReversal: false,        // too early for reversals
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      };

    case 'MEAN_REVERSION':
      return {
        allowOverboughtFade: true,    // puts OK at extremes
        allowOversoldFade: true,      // calls OK at extremes
        allowBreakoutFollow: false,   // suppress breakouts in chop
        allowVReversal: true,         // reversals work in ranges
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'reversal',
      };

    case 'TRENDING_UP':
      return {
        allowOverboughtFade: false,   // do NOT short an uptrend
        allowOversoldFade: true,      // buy the dip
        allowBreakoutFollow: true,    // follow momentum
        allowVReversal: false,        // don't try to catch the top
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'reversal',  // oversold in uptrend = buy opportunity
      };

    case 'TRENDING_DOWN':
      return {
        allowOverboughtFade: true,    // sell the rip
        allowOversoldFade: false,     // do NOT buy in a downtrend
        allowBreakoutFollow: true,    // follow breakdown
        allowVReversal: false,        // don't try to catch the bottom
        overboughtMeaning: 'reversal',
        oversoldMeaning: 'momentum',  // oversold in downtrend = continuation
      };

    case 'GAMMA_EXPIRY':
      return {
        allowOverboughtFade: false,   // do NOT fade gamma moves
        allowOversoldFade: false,     // do NOT fade gamma moves
        allowBreakoutFollow: true,    // follow the gamma squeeze
        allowVReversal: false,        // too dangerous
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      };

    case 'NO_TRADE':
      return {
        allowOverboughtFade: false,
        allowOversoldFade: false,
        allowBreakoutFollow: false,
        allowVReversal: false,
        overboughtMeaning: 'momentum',
        oversoldMeaning: 'momentum',
      };
  }
}

/** Format regime for prompt injection */
export function formatRegimeContext(rs: RegimeState): string {
  const gate = getSignalGate(rs.regime);
  const trendDir = rs.trendSlope > 0 ? 'UP' : rs.trendSlope < 0 ? 'DOWN' : 'FLAT';
  const orRange = rs.openingRangeSet
    ? `${rs.openingRangeLow.toFixed(2)}-${rs.openingRangeHigh.toFixed(2)}`
    : 'not yet established';

  return `CURRENT REGIME: ${rs.regime} (confidence=${(rs.confidence * 100).toFixed(0)}%)
  Trend slope: ${rs.trendSlope.toFixed(3)} pts/bar (${trendDir})
  Opening range: ${orRange}
  Session range: ${rs.sessionLow.toFixed(2)}-${rs.sessionHigh.toFixed(2)}
  Gap: ${rs.gapPct.toFixed(2)}%

REGIME RULES:
  RSI overbought = ${gate.overboughtMeaning.toUpperCase()} → ${gate.allowOverboughtFade ? 'puts ALLOWED' : 'puts BLOCKED'}
  RSI oversold = ${gate.oversoldMeaning.toUpperCase()} → ${gate.allowOversoldFade ? 'calls ALLOWED' : 'calls BLOCKED'}
  Breakout follow: ${gate.allowBreakoutFollow ? 'ALLOWED' : 'BLOCKED'}
  V-reversal: ${gate.allowVReversal ? 'ALLOWED' : 'BLOCKED'}`;
}

/** Get current state (read-only) */
export function getState(): Readonly<RegimeState> {
  return { ...state };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function linearRegressionSlope(values: number[], period: number): number {
  const n = Math.min(values.length, period);
  if (n < 5) return 0;

  const slice = values.slice(-n);
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += slice[i];
    sumXY += i * slice[i];
    sumX2 += i * i;
  }
  return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}
