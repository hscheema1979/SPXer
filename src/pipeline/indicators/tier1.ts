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
