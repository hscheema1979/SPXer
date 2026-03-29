/**
 * Core indicator engine — shared by both live pipeline and replay.
 * Computes HMA, EMA, RSI, BB, ATR, VWAP, KC and tier-2 indicators incrementally.
 */
import type { Bar, IndicatorState, Timeframe } from '../types';
import { computeEMA, computeRSI, computeBB, computeATR, computeVWAP, makeHMAState, hmaStep, makeKCState, kcStep } from '../pipeline/indicators/tier1';
import { computeMACD, computeStochastic, computeADX, computeMomentum, computeCCI } from '../pipeline/indicators/tier2';
import { MAX_BARS_MEMORY } from '../config';

const states = new Map<string, IndicatorState>();

function key(symbol: string, tf: Timeframe): string { return `${symbol}:${tf}`; }

function getState(symbol: string, tf: Timeframe): IndicatorState {
  const k = key(symbol, tf);
  if (!states.has(k)) {
    states.set(k, {
      closes: [], highs: [], lows: [], volumes: [], typicalPrices: [],
      cumulativeTPV: 0, cumulativeVol: 0,
      emaState: {}, macdState: { fastEma: null, slowEma: null, signalEma: null },
      atrState: null, adxState: { plusDM: null, minusDM: null, tr: null, adx: null },
      hmaState: {},
      kcState: null,
    });
  }
  return states.get(k)!;
}

export function resetVWAP(symbol: string, tf: Timeframe): void {
  const s = getState(symbol, tf);
  s.cumulativeTPV = 0;
  s.cumulativeVol = 0;
}

export function seedIndicatorState(symbol: string, tf: Timeframe, bars: Bar[]): void {
  const s = getState(symbol, tf);
  s.closes = bars.map(b => b.close).slice(-MAX_BARS_MEMORY);
  s.highs = bars.map(b => b.high).slice(-MAX_BARS_MEMORY);
  s.lows = bars.map(b => b.low).slice(-MAX_BARS_MEMORY);
  s.volumes = bars.map(b => b.volume).slice(-MAX_BARS_MEMORY);
  // Re-seed incremental HMA state by replaying closes through hmaStep
  for (const period of [5, 19, 25]) {
    const hma = makeHMAState(period);
    for (const c of s.closes) hmaStep(hma, c);
    s.hmaState[period] = hma;
  }
}

export function computeIndicators(bar: Bar, tier: 1 | 2 = 1): Record<string, number | null> {
  const s = getState(bar.symbol, bar.timeframe as Timeframe);

  s.closes.push(bar.close);
  s.highs.push(bar.high);
  s.lows.push(bar.low);
  s.volumes.push(bar.volume);
  if (s.closes.length > MAX_BARS_MEMORY) {
    s.closes.shift(); s.highs.shift(); s.lows.shift(); s.volumes.shift();
  }

  const vwapResult = computeVWAP(bar.close, bar.high, bar.low, bar.volume, s.cumulativeTPV, s.cumulativeVol);
  s.cumulativeTPV = vwapResult.cumTPV;
  s.cumulativeVol = vwapResult.cumVol;

  for (const p of [9, 21]) {
    s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
  }

  // Incremental HMA — O(period) per call, not O(n²)
  // Includes all periods used by top replay configs: 3, 5, 15, 17, 19, 25
  for (const period of [3, 5, 15, 17, 19, 25]) {
    if (!s.hmaState[period]) s.hmaState[period] = makeHMAState(period);
  }
  const hma3  = hmaStep(s.hmaState[3],  bar.close);
  const hma5  = hmaStep(s.hmaState[5],  bar.close);
  const hma15 = hmaStep(s.hmaState[15], bar.close);
  const hma17 = hmaStep(s.hmaState[17], bar.close);
  const hma19 = hmaStep(s.hmaState[19], bar.close);
  const hma25 = hmaStep(s.hmaState[25], bar.close);

  const bb = computeBB(s.closes, 20, 2);

  // Incremental Keltner Channel computation
  if (!s.kcState) s.kcState = makeKCState(20, 14, 2.5, 5);
  const prevClose = s.closes.length > 1 ? s.closes[s.closes.length - 2] : null;
  const kc = kcStep(s.kcState, bar.close, bar.high, bar.low, prevClose);

  const ind: Record<string, number | null> = {
    hma3,
    hma5,
    hma15,
    hma17,
    hma19,
    hma25,
    ema9:  s.emaState[9],
    ema21: s.emaState[21],
    rsi14: computeRSI(s.closes, 14),
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    bbWidth: bb?.width ?? null,
    atr14: computeATR(s.highs, s.lows, s.closes, 14),
    atrPct: s.closes.length > 1 ? (computeATR(s.highs, s.lows, s.closes, 14) / bar.close) * 100 : null,
    vwap: vwapResult.vwap,
    kcUpper: kc?.upper ?? null,
    kcMiddle: kc?.middle ?? null,
    kcLower: kc?.lower ?? null,
    kcWidth: kc?.width ?? null,
    kcSlope: kc?.slope ?? null,
  };

  if (tier === 2) {
    for (const p of [50, 200]) {
      s.emaState[p] = computeEMA(bar.close, s.emaState[p] ?? null, p);
    }
    const macdResult = computeMACD(bar.close, s.macdState.fastEma, s.macdState.slowEma, s.macdState.signalEma);
    s.macdState = { fastEma: macdResult.fastEma, slowEma: macdResult.slowEma, signalEma: macdResult.signalEma };

    ind['ema50'] = s.emaState[50];
    ind['ema200'] = s.emaState[200];
    ind['macd'] = macdResult.macd;
    ind['macdSignal'] = macdResult.signalEma;
    ind['macdHistogram'] = macdResult.histogram;
    ind['stochK'] = computeStochastic(s.highs, s.lows, s.closes, 14, 3)?.k ?? null;
    ind['cci20'] = computeCCI(s.highs, s.lows, s.closes, 20);
    ind['momentum10'] = computeMomentum(s.closes, 10);
    ind['adx14'] = computeADX(s.highs, s.lows, s.closes, 14);
  }

  return ind;
}
