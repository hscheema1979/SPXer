import { computeEMA } from './tier1';

export function computeMACD(
  price: number,
  fastEma: number | null, slowEma: number | null, signalEma: number | null
): { fastEma: number; slowEma: number; signalEma: number; macd: number; histogram: number } {
  const newFast = computeEMA(price, fastEma, 12);
  const newSlow = computeEMA(price, slowEma, 26);
  const macd = newFast - newSlow;
  const newSignal = computeEMA(macd, signalEma, 9);
  return { fastEma: newFast, slowEma: newSlow, signalEma: newSignal, macd, histogram: macd - newSignal };
}

export function computeStochastic(
  highs: number[], lows: number[], closes: number[], kPeriod: number, _dPeriod: number
): { k: number; d: number } | null {
  if (closes.length < kPeriod) return null;
  const hh = Math.max(...highs.slice(-kPeriod));
  const ll = Math.min(...lows.slice(-kPeriod));
  if (hh === ll) return { k: 50, d: 50 };
  const k = ((closes[closes.length - 1] - ll) / (hh - ll)) * 100;
  return { k, d: k };
}

export function computeADX(
  highs: number[], lows: number[], closes: number[], period: number
): number | null {
  if (highs.length < period + 1) return null;
  const trs: number[] = [], plusDMs: number[] = [], minusDMs: number[] = [];

  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(tr);
  }

  const sliceTR = trs.slice(-period);
  const slicePlus = plusDMs.slice(-period);
  const sliceMinus = minusDMs.slice(-period);
  const atr = sliceTR.reduce((a, b) => a + b) / period;
  if (atr === 0) return 0;
  const plusDI = (slicePlus.reduce((a, b) => a + b) / period / atr) * 100;
  const minusDI = (sliceMinus.reduce((a, b) => a + b) / period / atr) * 100;
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0;
  return Math.abs(plusDI - minusDI) / diSum * 100;
}

export function computeMomentum(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  return closes[closes.length - 1] - closes[closes.length - 1 - period];
}

export function computeCCI(highs: number[], lows: number[], closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const tps = closes.slice(-period).map((c, i) => (highs.slice(-period)[i] + lows.slice(-period)[i] + c) / 3);
  const mean = tps.reduce((a, b) => a + b) / period;
  const meanDev = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
  if (meanDev === 0) return 0;
  return (tps[tps.length - 1] - mean) / (0.015 * meanDev);
}
