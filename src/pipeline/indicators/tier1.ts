export function computeWMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  let num = 0, den = 0;
  for (let i = 0; i < period; i++) {
    const w = i + 1;
    num += slice[i] * w;
    den += w;
  }
  return num / den;
}

export function computeHMA(closes: number[], period: number): number | null {
  const half = Math.floor(period / 2);
  const sqrtP = Math.round(Math.sqrt(period));
  if (closes.length < period) return null;

  const raw: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    const wh = computeWMA(closes.slice(0, i + 1), half);
    const wf = computeWMA(closes.slice(0, i + 1), period);
    if (wh !== null && wf !== null) raw.push(2 * wh - wf);
  }
  return computeWMA(raw, sqrtP);
}

import type { WMAState, HMAState } from '../../types';

/**
 * Create a fresh WMAState for the given period.
 */
export function makeWMAState(period: number): WMAState {
  return { buf: new Array(period).fill(0), pos: 0, filled: false, period };
}

/**
 * Feed one new value into a WMAState and return the current WMA, or null if
 * the buffer has not yet been fully populated.
 * O(period) per call — not O(n²).
 */
export function wmaStep(state: WMAState, value: number): number | null {
  state.buf[state.pos] = value;
  state.pos = (state.pos + 1) % state.period;
  if (!state.filled && state.pos === 0) state.filled = true;
  if (!state.filled) return null;

  // Compute WMA over the circular buffer.
  // buf[pos] is the oldest value (weight 1), buf[pos-1 mod period] is the newest (weight period).
  let num = 0;
  const den = (state.period * (state.period + 1)) / 2;
  for (let i = 0; i < state.period; i++) {
    const idx = (state.pos + i) % state.period; // oldest→newest order
    num += state.buf[idx] * (i + 1);
  }
  return num / den;
}

/**
 * Create a fresh HMAState for the given period.
 */
export function makeHMAState(period: number): HMAState {
  const sqrtP = Math.round(Math.sqrt(period));
  return {
    wmaHalf: makeWMAState(Math.floor(period / 2)),
    wmaFull: makeWMAState(period),
    wmaSqrt: makeWMAState(sqrtP),
  };
}

/**
 * Incremental HMA: feed one new close price into the HMAState and return the
 * current HMA value, or null until enough bars have been seen.
 * Total cost: O(period) per call instead of O(n * period).
 */
export function hmaStep(state: HMAState, close: number): number | null {
  const wh = wmaStep(state.wmaHalf, close);
  const wf = wmaStep(state.wmaFull, close);
  if (wh === null || wf === null) return null;
  const diff = 2 * wh - wf;
  return wmaStep(state.wmaSqrt, diff);
}

export function computeEMA(price: number, prevEma: number | null, period: number): number {
  if (prevEma === null) return price;
  const k = 2 / (period + 1);
  return price * k + prevEma * (1 - k);
}

export function computeRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(-period - 1).map((c, i, arr) =>
    i === 0 ? 0 : c - arr[i - 1]
  ).slice(1);

  const gains = changes.map(c => c > 0 ? c : 0);
  const losses = changes.map(c => c < 0 ? -c : 0);
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function computeBB(
  closes: number[], period: number, stdMult: number
): { upper: number; middle: number; lower: number; width: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - middle) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + stdMult * std;
  const lower = middle - stdMult * std;
  return { upper, middle, lower, width: (upper - lower) / middle };
}

export function computeATR(highs: number[], lows: number[], closes: number[], period: number): number {
  if (highs.length < 2) return highs[0] - lows[0];
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

export function computeVWAP(
  close: number, high: number, low: number, volume: number,
  cumTPV: number, cumVol: number
): { vwap: number; cumTPV: number; cumVol: number } {
  const tp = (high + low + close) / 3;
  const newTPV = cumTPV + tp * volume;
  const newVol = cumVol + volume;
  return { vwap: newVol > 0 ? newTPV / newVol : close, cumTPV: newTPV, cumVol: newVol };
}

/**
 * Keltner Channel computation for trend filtering.
 * - Middle line = EMA(period)
 * - Bands = middle ± multiplier × ATR
 * - Slope = rate of change of middle line (pts/bar)
 */
export interface KeltnerChannel {
  upper: number;
  middle: number;  // EMA(period)
  lower: number;
  width: number;   // (upper - lower) / middle (normalized)
  slope: number;   // rate of change of middle line (pts/bar)
}

export function computeKeltnerChannel(
  closes: number[],
  highs: number[],
  lows: number[],
  emaPeriod: number = 20,
  atrPeriod: number = 14,
  multiplier: number = 2.5,
  slopeLookback: number = 5
): KeltnerChannel | null {
  if (closes.length < Math.max(emaPeriod, atrPeriod, slopeLookback + 1)) return null;

  // Compute EMA for middle line
  const k = 2 / (emaPeriod + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }

  // Compute ATR
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  const atr = trs.slice(-atrPeriod).reduce((a, b) => a + b, 0) / atrPeriod;

  // Compute bands
  const upper = ema + multiplier * atr;
  const lower = ema - multiplier * atr;
  const width = (upper - lower) / ema;

  // Compute slope: look back N bars and calculate rate of change of EMA
  // We need to compute historical EMA values for slope
  const emaHistory: number[] = [];
  let histEma = closes[0];
  for (let i = 1; i < closes.length; i++) {
    histEma = closes[i] * k + histEma * (1 - k);
    emaHistory.push(histEma);
  }

  const slope = emaHistory.length >= slopeLookback
    ? (emaHistory[emaHistory.length - 1] - emaHistory[emaHistory.length - 1 - slopeLookback]) / slopeLookback
    : 0;

  return { upper, middle: ema, lower, width, slope };
}

/** State for incremental Keltner Channel computation */
export interface KCState {
  emaValue: number | null;
  emaHistory: number[];  // circular buffer for slope calculation
  atrValues: number[];   // circular buffer for ATR
  emaPeriod: number;
  atrPeriod: number;
  multiplier: number;
  slopeLookback: number;
}

export function makeKCState(
  emaPeriod: number = 20,
  atrPeriod: number = 14,
  multiplier: number = 2.5,
  slopeLookback: number = 5
): KCState {
  return {
    emaValue: null,
    emaHistory: [],
    atrValues: [],
    emaPeriod,
    atrPeriod,
    multiplier,
    slopeLookback,
  };
}

/**
 * Incremental Keltner Channel step.
 * Feed one bar at a time, returns null until enough data.
 */
export function kcStep(state: KCState, close: number, high: number, low: number, prevClose: number | null): KeltnerChannel | null {
  const k = 2 / (state.emaPeriod + 1);

  // Update EMA
  if (state.emaValue === null) {
    state.emaValue = close;
  } else {
    state.emaValue = close * k + state.emaValue * (1 - k);
  }

  // Track EMA history for slope
  state.emaHistory.push(state.emaValue);
  if (state.emaHistory.length > state.slopeLookback + 1) {
    state.emaHistory.shift();
  }

  // Compute and track TR
  if (prevClose !== null) {
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    state.atrValues.push(tr);
    if (state.atrValues.length > state.atrPeriod) {
      state.atrValues.shift();
    }
  }

  // Need enough data
  if (state.emaHistory.length < state.slopeLookback + 1 || state.atrValues.length < state.atrPeriod) {
    return null;
  }

  const atr = state.atrValues.reduce((a, b) => a + b, 0) / state.atrValues.length;
  const middle = state.emaValue;
  const upper = middle + state.multiplier * atr;
  const lower = middle - state.multiplier * atr;
  const width = (upper - lower) / middle;
  const slope = (state.emaHistory[state.emaHistory.length - 1] - state.emaHistory[0]) / (state.emaHistory.length - 1);

  return { upper, middle, lower, width, slope };
}
