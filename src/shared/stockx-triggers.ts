/**
 * stockx-triggers.ts — StockX trigger evaluators + moving averages.
 *
 * COPIED VERBATIM from /home/ubuntu/optionx/src/shared/signals.ts (Phase B).
 * These pure functions are the SINGLE SOURCE OF TRUTH shared by the OptionX
 * LIVE engine (event-handler.ts stock entry/monitor) and this SPXer BACKTEST
 * (scripts/diag/stockx-backtest.ts) so backtest == live. Do not edit here —
 * edit optionx and re-copy, or the regression gate's parity guarantee breaks.
 */

/**
 * Selectable moving-average type for the cross/alignment detectors. 'hma' is the
 * historical default and keeps every existing config byte-identical. The others
 * let a config trade EMA / DEMA / SMA / WMA crossovers instead (selected in the
 * studio UI via `signal.maType`).
 */
export type MaType = 'hma' | 'ema' | 'dema' | 'sma' | 'wma';

/**
 * Compute HMA (Hull Moving Average).
 *
 * HMA(p) = WMA( 2·WMA(prices, p/2) - WMA(prices, p), sqrt(p) )
 *
 * The wma2 (half-period) and wma1 (full-period) values must be aligned to the
 * SAME closes index before subtracting. wma1[k] corresponds to closes[k+p-1];
 * wma2[k] corresponds to closes[k+half-1]. To align both at closes[k+p-1] we
 * read wma2[k+offset] (offset = p − half) and wma1[k].
 *
 * Matches SPXer's reference implementation in src/pipeline/indicators/tier1.ts.
 */
export function computeHMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];

  function wma(arr: number[], p: number): number[] {
    const result: number[] = [];
    for (let i = p - 1; i < arr.length; i++) {
      let sum = 0;
      let weight = 0;
      for (let j = 0; j < p; j++) {
        sum += arr[i - j] * (p - j);
        weight += (p - j);
      }
      result.push(sum / weight);
    }
    return result;
  }

  const halfPeriod = Math.floor(period / 2);
  // Must be floor (not round) to match TradingView's ta.hma() runtime.
  // Pine docs say round; TV truncates. SPXer's tier1.ts does the same.
  const sqrtPeriod = Math.floor(Math.sqrt(period));

  const wma1 = wma(prices, period);
  const wma2 = wma(prices, halfPeriod);

  const raw: number[] = [];
  const offset = period - halfPeriod;
  for (let i = 0; i < wma1.length && (i + offset) < wma2.length; i++) {
    raw.push(2 * wma2[i + offset] - wma1[i]);
  }

  return wma(raw, sqrtPeriod);
}

/**
 * Simple Moving Average. Returns a trimmed series (no NaN warmup) in
 * chronological order — same contract as computeHMA so the cross detectors can
 * index `length-1` / `length-2` uniformly across MA types.
 */
export function computeSMA(prices: number[], period: number): number[] {
  if (period < 1 || prices.length < period) return [];
  const out: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += prices[i - j];
    out.push(sum / period);
  }
  return out;
}

/**
 * Linearly-Weighted Moving Average (weight = period..1, newest heaviest).
 * Trimmed, chronological — same contract as computeHMA.
 */
export function computeWMA(prices: number[], period: number): number[] {
  if (period < 1 || prices.length < period) return [];
  const denom = (period * (period + 1)) / 2;
  const out: number[] = [];
  for (let i = period - 1; i < prices.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += prices[i - j] * (period - j);
    out.push(sum / denom);
  }
  return out;
}

/**
 * Exponential Moving Average. Seeded with the SMA of the first `period` closes
 * (the standard TradingView/ta.ema warmup), then recursively smoothed with
 * k = 2/(period+1). Trimmed so out[0] corresponds to prices[period-1]; same
 * chronological contract as computeHMA.
 */
export function computeEMA(prices: number[], period: number): number[] {
  if (period < 1 || prices.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let j = 0; j < period; j++) prev += prices[j];
  prev /= period;
  const out: number[] = [prev];
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Double Exponential Moving Average: DEMA(p) = 2·EMA(p) − EMA(EMA(p)).
 * The inner EMA(EMA) is shorter than EMA by (period−1) values; we align EMA's
 * tail to it before subtracting. Trimmed, chronological — same contract as
 * computeHMA. Needs ≳ 2·period closes to produce any output.
 */
export function computeDEMA(prices: number[], period: number): number[] {
  const ema1 = computeEMA(prices, period);
  if (ema1.length < period) return [];
  const ema2 = computeEMA(ema1, period);
  if (ema2.length < 1) return [];
  const offset = ema1.length - ema2.length; // = period - 1
  const out: number[] = [];
  for (let i = 0; i < ema2.length; i++) {
    out.push(2 * ema1[i + offset] - ema2[i]);
  }
  return out;
}

/**
 * Moving-average dispatcher. Defaults to HMA so every call site that omits the
 * type keeps the historical (byte-identical) behavior.
 */
export function computeMA(prices: number[], period: number, type: MaType = 'hma'): number[] {
  switch (type) {
    case 'ema':  return computeEMA(prices, period);
    case 'dema': return computeDEMA(prices, period);
    case 'sma':  return computeSMA(prices, period);
    case 'wma':  return computeWMA(prices, period);
    case 'hma':
    default:     return computeHMA(prices, period);
  }
}

// ── Stock framework: pluggable entry/exit triggers ──
//
// Pure functions shared by the LIVE engine (event-handler.ts monitor +
// processConfigTickFn) and the SPXer BACKTEST (scripts/diag/stockx-backtest.ts)
// so live behavior is guaranteed to match the validated backtest. Both callers
// supply ALIGNED, trimmed, chronological series (same contract as computeHMA):
// closes[i], fastMA[i], slowMA[i] all describe the SAME bar. The callers are
// responsible for alignment (the live path and the backtest already align by
// trailing length — see astx_bt.js / usd_bt.js reference).

export type StockEntryTrigger =
  | 'ma_cross_up' | 'ma_cross_down'
  | 'price_cross_fast_up' | 'price_cross_fast_down';
export type StockExitTrigger = 'tp' | 'sl' | 'ma_cross_down' | 'ma_cross_up';

/**
 * TP/SL exit price levels for a stock position. Single source of truth for the
 * entry×mult convention so the backtest's intrabar-extreme checks use the exact
 * same levels the live monitor tests quotes against.
 *   long  (side= 1): tpLevel = entry × tpMult (tpMult>1, e.g. 1.15); slLevel = entry × slMult (slMult∈(0,1)).
 *   short (side=-1): tpLevel = entry × (2−tpMult), slLevel = entry × (2−slMult)
 *   (profit when price falls → TP below entry, SL above; mirrored from long).
 *   Short support is LIVE (direction:'short'), not future work.
 */
export function tpSlLevels(entry: number, side: 1 | -1, tpMult: number, slMult: number): { tpLevel: number; slLevel: number } {
  if (side === 1) return { tpLevel: entry * tpMult, slLevel: entry * slMult };
  // short: profit when price falls; TP below entry, SL above.
  return { tpLevel: entry * (2 - tpMult), slLevel: entry * (2 - slMult) };
}

/**
 * Did a stock entry fire on bar `i` (evaluated at bar CLOSE)?
 *
 *   'ma_cross_up'        — fast crossed ABOVE slow: fast[i-1] ≤ slow[i-1] ∧ fast[i] > slow[i].
 *   'price_cross_fast_up'— close crossed ABOVE fast: closes[i-1] ≤ fast[i-1] ∧ closes[i] > fast[i].
 *
 * `match:'all'` (default) requires every listed trigger on bar i; `'any'` fires
 * on the first. Defaults to ['ma_cross_up'] (back-compat with the option engine
 * cross). The caller enters at the NEXT bar open (the validated next-open
 * convention) — this function only detects the signal at bar close.
 */
export function evaluateEntryTriggers(args: {
  closes: number[];
  fastMA: number[];
  slowMA: number[];
  triggers?: StockEntryTrigger[];
  match?: 'all' | 'any';
  i: number;
}): boolean {
  const { closes, fastMA, slowMA, i } = args;
  const triggers = args.triggers ?? ['ma_cross_up'];
  if (i < 1 || i >= closes.length || i >= fastMA.length || i >= slowMA.length) return false;
  const fire = (t: StockEntryTrigger): boolean => {
    if (t === 'ma_cross_up')           return fastMA[i - 1] <= slowMA[i - 1] && fastMA[i] > slowMA[i];
    if (t === 'ma_cross_down')         return fastMA[i - 1] >= slowMA[i - 1] && fastMA[i] < slowMA[i];
    if (t === 'price_cross_fast_up')   return closes[i - 1] <= fastMA[i - 1] && closes[i] > fastMA[i];
    if (t === 'price_cross_fast_down') return closes[i - 1] >= fastMA[i - 1] && closes[i] < fastMA[i];
    return false;
  };
  return args.match === 'any' ? triggers.some(fire) : triggers.every(fire);
}

/**
 * Which exit trigger fires for an open stock position? Returns the FIRST listed
 * trigger that holds (logical OR — any fires the close), or null.
 *
 *   'tp'            — `price` reached the TP level (long: price ≥ tpLevel).
 *   'sl'            — `price` reached the SL level (long: price ≤ slLevel).
 *   'ma_cross_down' — fast crossed BELOW slow at bar i: fast[i-1] ≥ slow[i-1] ∧ fast[i] < slow[i].
 *
 * `price` is whatever the caller is testing: the LIVE monitor passes the latest
 * quote (so tp/sl fire the instant the level trades); the BACKTEST passes the
 * bar close for the ma_cross_down check and applies the conservative intrabar
 * SL-before-TP rule itself using `tpSlLevels` (worst-case if both extremes hit).
 * ma_cross_down requires `fastMA`/`slowMA` + `i`; tp/sl need only `price`.
 */
export function evaluateExitTriggers(args: {
  price: number;
  entry: number;
  side: 1 | -1;
  tpMult: number;
  slMult: number;
  fastMA?: number[];
  slowMA?: number[];
  triggers?: StockExitTrigger[];
  i?: number;
}): StockExitTrigger | null {
  const { price, entry, side, triggers = ['tp', 'sl', 'ma_cross_down'] as StockExitTrigger[] } = args;
  const { tpLevel, slLevel } = tpSlLevels(entry, side, args.tpMult, args.slMult);
  for (const t of triggers) {
    if (t === 'tp') {
      if (side === 1 ? price >= tpLevel : price <= tpLevel) return 'tp';
    } else if (t === 'sl') {
      if (side === 1 ? price <= slLevel : price >= slLevel) return 'sl';
    } else if (t === 'ma_cross_down') {
      const i = args.i;
      const f = args.fastMA, s = args.slowMA;
      if (i !== undefined && f && s && i >= 1 && i < f.length && i < s.length) {
        if (f[i - 1] >= s[i - 1] && f[i] < s[i]) return 'ma_cross_down';
      }
    } else if (t === 'ma_cross_up') {
      const i = args.i;
      const f = args.fastMA, s = args.slowMA;
      if (i !== undefined && f && s && i >= 1 && i < f.length && i < s.length) {
        if (f[i - 1] <= s[i - 1] && f[i] > s[i]) return 'ma_cross_up';
      }
    }
  }
  return null;
}

