/**
 * swing-signal.ts
 *
 * Higher-timeframe HMA/DEMA cross detection for multi-DTE swing entries,
 * computed from a closes series (daily or weekly aggregated bars). Minute
 * crosses are noise over a 5-60 day hold; these signals fire on swing-scale
 * trend flips instead.
 *
 * HMA uses Math.floor(Math.sqrt(period)) to match TradingView's ta.hma runtime
 * (see the project's HMA convention). No look-ahead: the caller passes only the
 * closes of bars strictly before the entry date.
 */

export type Signal = 'hma' | 'dema';

function wma(arr: number[], end: number, p: number): number | null {
  if (end < p - 1) return null;
  let s = 0, w = 0;
  for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i); }
  return s / w;
}

/** Full HMA series for `period` over closes (null until enough data). */
function hmaSeries(closes: number[], period: number): (number | null)[] {
  const half = Math.floor(period / 2);
  const sq = Math.floor(Math.sqrt(period));
  const raw: number[] = [];
  const out: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const a = wma(closes, i, half), b = wma(closes, i, period);
    if (a != null && b != null) {
      raw.push(2 * a - b);
      out.push(raw.length >= sq ? wma(raw, raw.length - 1, sq) : null);
    } else {
      out.push(null);
    }
  }
  return out;
}

/** Full DEMA series for `period` over closes. */
function demaSeries(closes: number[], period: number): (number | null)[] {
  const a = 2 / (period + 1);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  // EMA1
  let e1 = 0; for (let i = 0; i < period; i++) e1 += closes[i]; e1 /= period;
  const e1s: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) { e1s.push(e1); continue; }
    e1 = a * closes[i] + (1 - a) * e1;
    e1s.push(e1);
  }
  // EMA2 of EMA1
  let e2 = 0; for (let i = 0; i < period; i++) e2 += e1s[i]; e2 /= period;
  for (let i = 0; i < e1s.length; i++) {
    if (i >= period) e2 = a * e1s[i] + (1 - a) * e2;
    if (i >= period) out[i] = 2 * e1s[i] - e2;
  }
  return out;
}

function series(closes: number[], signal: Signal, period: number): (number | null)[] {
  return signal === 'dema' ? demaSeries(closes, period) : hmaSeries(closes, period);
}

/** Direction at the LAST bar: fast vs slow. null if not computable. */
export function direction(
  closes: number[], signal: Signal, fast: number, slow: number
): 'bull' | 'bear' | null {
  const f = series(closes, signal, fast);
  const s = series(closes, signal, slow);
  const fa = f[f.length - 1], sa = s[s.length - 1];
  if (fa == null || sa == null) return null;
  return fa > sa ? 'bull' : 'bear';
}

/**
 * True when the LAST bar is a FRESH bull cross: fast>slow on the last bar AND
 * fast<=slow on the prior bar (a bear→bull flip), not a standing bull state.
 */
export function freshBullCross(
  closes: number[], signal: Signal, fast: number, slow: number
): boolean {
  const f = series(closes, signal, fast);
  const s = series(closes, signal, slow);
  const n = closes.length;
  if (n < 2) return false;
  const fLast = f[n - 1], sLast = s[n - 1];
  const fPrev = f[n - 2], sPrev = s[n - 2];
  if (fLast == null || sLast == null || fPrev == null || sPrev == null) return false;
  return fLast > sLast && fPrev <= sPrev;
}
