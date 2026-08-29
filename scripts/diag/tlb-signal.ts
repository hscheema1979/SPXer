/**
 * tlb-signal.ts
 *
 * "Trendlines with Breaks" (LuxAlgo) breakout detector for credit-spread entries.
 *
 * Mirrors the public Pine v5 indicator behaviour: pivot highs/lows anchor an
 * upper and lower trendline that decay each bar by `slope = atr/length * mult`
 * (ATR variant — the LuxAlgo default). A break event fires when `close` first
 * crosses the projected trendline:
 *   • Upper Break (bullish "B" in the Pine plot) → close > upper − slope*length
 *   • Lower Break (bearish "B" in the Pine plot) → close < lower + slope*length
 *
 * Mapping to credit spreads:
 *   bullish break → short PUT credit spread (sell premium below)
 *   bearish break → short CALL credit spread (sell premium above)
 *
 * The Pine `upos`/`dnos` state arms once and re-arms only on a fresh pivot, so
 * each direction emits at most one event between pivots. We expose the discrete
 * event stream (`tlbBreaksOnSeries`) plus a "did a bull/bear break fire on the
 * last bar" helper (`freshBreakOnLast`) modelled on swing-signal's API.
 *
 * No look-ahead: pivots use `ta.pivothigh(length,length)` semantics — a pivot
 * at bar i is only confirmed at bar i+length. The detector reflects this: a
 * pivot's slope/anchor only take effect at bar (pivotIdx + length), never
 * earlier, even when iterating offline.
 */

export type TlbBar = { ts: number; open: number; high: number; low: number; close: number };

export interface TlbParams {
  length: number;     // LuxAlgo "Swing Detection Lookback" — default 14
  mult: number;       // LuxAlgo "Slope" multiplier — default 1.0
}

export const TLB_DEFAULTS: TlbParams = { length: 14, mult: 1.0 };

export type TlbDirection = 'bull' | 'bear';
export interface TlbBreak { ts: number; barIdx: number; dir: TlbDirection; }

/** ATR over the prior `period` bars using Wilder's true range. RMA seeded as SMA. */
function atrSeries(bars: TlbBar[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (bars.length === 0 || period <= 0) return out;
  const tr: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low;
    if (i === 0) { tr[i] = h - l; continue; }
    const pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // Wilder's RMA: first ATR = SMA(tr, period); after that, rma = (prev*(p-1) + tr) / p
  if (bars.length < period) return out;
  let sum = 0; for (let i = 0; i < period; i++) sum += tr[i];
  let rma = sum / period;
  out[period - 1] = rma;
  for (let i = period; i < bars.length; i++) {
    rma = (rma * (period - 1) + tr[i]) / period;
    out[i] = rma;
  }
  return out;
}

/**
 * Detect ALL TLB break events across a bar series. Returns events ordered by
 * `barIdx` (the bar where the cross was observed — no look-ahead).
 *
 * Implementation mirrors the Pine reference loop literally so the events match
 * the LuxAlgo plot 1:1:
 *   upper := ph ? ph : upper - slope_ph
 *   lower := pl ? pl : lower + slope_pl
 *   upos  := ph ? 0 : close > upper - slope_ph * length ? 1 : upos
 *   dnos  := pl ? 0 : close < lower + slope_pl * length ? 1 : dnos
 * A break fires when upos / dnos transitions 0 → 1.
 */
export function tlbBreaksOnSeries(bars: TlbBar[], p: TlbParams = TLB_DEFAULTS): TlbBreak[] {
  const out: TlbBreak[] = [];
  const n = bars.length;
  if (n < 2 * p.length + 2) return out;
  const atr = atrSeries(bars, p.length);

  // Confirmed pivots: ph at bar i means bars[i] is a pivot high with `length`
  // bars on each side. Confirmation only happens at bar i+length.
  let upper = 0, lower = 0;
  let slope_ph = 0, slope_pl = 0;
  let upos = 0, dnos = 0;

  // Track the LAST confirmed pivot value/bar so we can prime upper/lower the
  // first time they're needed (before the first pivot, upper/lower are 0 in
  // Pine — but that produces nonsense `close > -slope_ph*length` triggers; we
  // therefore skip break detection until the first confirmed pivot of that
  // side).
  let hadUpperPivot = false;
  let hadLowerPivot = false;

  for (let i = p.length; i < n; i++) {
    // Pivot CONFIRMED at bar (i - length) and applied at bar i (Pine's
    // ta.pivothigh(length, length) returns the pivot at the bar +length later).
    const pi = i - p.length;
    const wL = pi - p.length;
    if (wL >= 0) {
      const center = bars[pi];
      let isPH = true, isPL = true;
      for (let k = wL; k <= pi + p.length && k < n; k++) {
        if (k === pi) continue;
        if (bars[k].high >= center.high) isPH = false;
        if (bars[k].low  <= center.low)  isPL = false;
        if (!isPH && !isPL) break;
      }
      const slopeNow = (atr[i] ?? 0) / p.length * p.mult;
      if (isPH) {
        upper = center.high;
        slope_ph = slopeNow;
        upos = 0;
        hadUpperPivot = true;
      } else if (hadUpperPivot) {
        upper = upper - slope_ph;
      }
      if (isPL) {
        lower = center.low;
        slope_pl = slopeNow;
        dnos = 0;
        hadLowerPivot = true;
      } else if (hadLowerPivot) {
        lower = lower + slope_pl;
      }
    }

    const c = bars[i].close;
    // Pine evaluates `close > upper - slope_ph * length` — the projected
    // trendline value `length` bars AHEAD of the anchor. Only meaningful once
    // a real pivot has primed `upper`.
    if (hadUpperPivot) {
      const trig = upper - slope_ph * p.length;
      const prev = upos;
      if (c > trig) upos = 1;
      if (upos > prev) out.push({ ts: bars[i].ts, barIdx: i, dir: 'bull' });
    }
    if (hadLowerPivot) {
      const trig = lower + slope_pl * p.length;
      const prev = dnos;
      if (c < trig) dnos = 1;
      if (dnos > prev) out.push({ ts: bars[i].ts, barIdx: i, dir: 'bear' });
    }
  }
  return out;
}

/**
 * True when the LAST bar of `bars` is the moment a fresh break of the given
 * direction occurred. Mirrors swing-signal's `freshBullCross`/`direction` API
 * so the sweep engine consumes it the same way.
 */
export function freshBreakOnLast(bars: TlbBar[], dir: TlbDirection, p: TlbParams = TLB_DEFAULTS): boolean {
  const evs = tlbBreaksOnSeries(bars, p);
  if (evs.length === 0) return false;
  const last = evs[evs.length - 1];
  return last.barIdx === bars.length - 1 && last.dir === dir;
}
