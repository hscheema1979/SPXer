import type { Bar, IndicatorState, Timeframe } from '../types';
import { computeHMA, computeEMA, computeRSI, computeBB, computeATR, computeVWAP } from './indicators/tier1';
import { computeMACD, computeStochastic, computeADX, computeMomentum, computeCCI } from './indicators/tier2';
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
    });
  }
  return states.get(k)!;
}

export function resetVWAP(symbol: string, tf: Timeframe): void {
  const s = getState(symbol, tf);
  s.cumulativeTPV = 0;
  s.cumulativeVol = 0;
}

export function seedState(symbol: string, tf: Timeframe, bars: Bar[]): void {
  const s = getState(symbol, tf);
  s.closes = bars.map(b => b.close).slice(-MAX_BARS_MEMORY);
  s.highs = bars.map(b => b.high).slice(-MAX_BARS_MEMORY);
  s.lows = bars.map(b => b.low).slice(-MAX_BARS_MEMORY);
  s.volumes = bars.map(b => b.volume).slice(-MAX_BARS_MEMORY);
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

  const bb = computeBB(s.closes, 20, 2);

  const ind: Record<string, number | null> = {
    hma5:  computeHMA(s.closes, 5),
    hma19: computeHMA(s.closes, 19),
    hma25: computeHMA(s.closes, 25),
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
