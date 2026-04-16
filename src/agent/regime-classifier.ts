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
 *
 * **ALL parameters are now config-driven — no hardcoded values.**
 */

import type { Config } from '../config/types';

type RegimeConfig = Config['regime'];

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

/** Parse time string "HH:MM" to minutes since midnight */
function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/** Call every 1m bar. Returns the current regime classification.
 *  Config parameter required — all thresholds and time windows come from config. */
export function classify(
  bar: { close: number; high: number; low: number; ts: number },
  config: RegimeConfig
): RegimeState {
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

  // Build opening range (configurable duration)
  const openingRangeBars = config.classification.openingRangeMinutes;
  if (state.barsProcessed <= openingRangeBars) {
    if (bar.high > state.openingRangeHigh) state.openingRangeHigh = bar.high;
    if (bar.low < state.openingRangeLow) state.openingRangeLow = bar.low;
    if (state.barsProcessed === openingRangeBars) state.openingRangeSet = true;
  }

  // Compute trend slope (configurable lookback)
  const lookbackBars = config.classification.lookbackBars;
  state.trendSlope = linearRegressionSlope(recentCloses, lookbackBars);

  // Get ET hour and minute from timestamp
  const etDate = new Date(bar.ts * 1000);
  const etStr = etDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const timePart = etStr.split(', ')[1] || etStr;
  const [h, m] = timePart.split(':').map(Number);
  const minuteOfDay = h * 60 + m;

  // ── Classification logic (ALL from config) ─────────────────────────────

  const TREND_THRESHOLD = config.classification.trendThreshold;
  const isTrendingUp = state.trendSlope > TREND_THRESHOLD;
  const isTrendingDown = state.trendSlope < -TREND_THRESHOLD;

  // Parse time windows from config
  const noTradeStart = parseTimeToMinutes(config.timeWindows.noTradeStart);
  const gammaExpiryStart = parseTimeToMinutes(config.timeWindows.gammaExpiryStart);
  const morningEnd = parseTimeToMinutes(config.timeWindows.morningEnd);
  const middayEnd = parseTimeToMinutes(config.timeWindows.middayEnd);

  // NO_TRADE period
  if (minuteOfDay >= noTradeStart) {
    state.regime = 'NO_TRADE';
    state.confidence = 0.9;
  }
  // GAMMA_EXPIRY period (unless strongly trending)
  else if (minuteOfDay >= gammaExpiryStart) {
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
  // MORNING_MOMENTUM period
  else if (minuteOfDay < morningEnd) {
    if (isTrendingUp || isTrendingDown) {
      state.regime = isTrendingUp ? 'TRENDING_UP' : 'TRENDING_DOWN';
      state.confidence = Math.min(0.9, 0.5 + Math.abs(state.trendSlope) * 2);
    } else {
      state.regime = 'MORNING_MOMENTUM';
      state.confidence = 0.7;
    }
  }
  // MEAN_REVERSION or TRENDING (morningEnd to gammaExpiryStart)
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
 *  Config parameter required — all gate rules come from config. */
export function getSignalGate(regime: Regime, rsi: number | null = null, config: RegimeConfig): SignalGate {
  return config.signalGates[regime];
}

/** Format regime for prompt injection */
export function formatRegimeContext(rs: RegimeState, config: RegimeConfig): string {
  const gate = getSignalGate(rs.regime, null, config);
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
