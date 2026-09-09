/**
 * preentry-range.ts — "has price already moved?" entry gate for credit spreads.
 *
 * Measures how far the underlying has travelled away from a reference price
 * between the session open and the entry slot, then answers whether that day
 * clears a directional threshold.
 *
 * The distinction that matters: a credit spread is exposed on ONE side only. A
 * put spread cares about a selloff that has already happened (gaps/trends
 * CONTINUE — see scripts/diag/gap-edge-multiyear.ts), and is largely indifferent
 * to a rally, which just walks the market away from the short strike. So the
 * risk-relevant gate is one-sided. A SYMMETRIC gate additionally throws away
 * days that moved the harmless way — that is not a risk filter, it is a
 * realized-vol / quiet-regime proxy, and it should be judged on its own merits
 * rather than smuggled in alongside the risk gate.
 *
 * Pure functions only — no I/O, no dates. See range-filter-study.ts for the
 * runner that joins these to trade rows.
 */

export interface Excursion {
  /** Max % ABOVE the reference price reached before the cutoff. Never negative. */
  upPct: number;
  /** Max % BELOW the reference price reached before the cutoff. Never negative. */
  downPct: number;
}

/** Directional mode. Named for what the gate BLOCKS, i.e. the risk it guards. */
export type FilterMode = 'none' | 'symmetric' | 'up-only' | 'down-only';

/** The one-sided gate that guards each structure's short side. */
export const GUARD_FOR: Record<'put' | 'call', FilterMode> = {
  put: 'down-only',   // bull put spread — a selloff is the threat
  call: 'up-only',    // bear call spread — a rally is the threat
};

interface RangeBar { ts: number; high: number; low: number }

/**
 * Max favourable/adverse excursion vs `refPrice` over bars at or before
 * `cutoffTs`. Bars after the cutoff are ignored — that boundary is the whole
 * point of the gate, so crossing it would be look-ahead.
 *
 * Returns null when the day has no bars before the cutoff or `refPrice` is not
 * a usable positive number; callers skip those days rather than guess.
 */
export function preEntryExcursion(
  bars: RangeBar[],
  refPrice: number,
  cutoffTs: number,
): Excursion | null {
  if (!(refPrice > 0) || !bars?.length) return null;
  let hi = -Infinity, lo = Infinity;
  for (const b of bars) {
    if (b.ts > cutoffTs) break;   // bars are time-ordered
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  if (hi === -Infinity) return null;
  return {
    upPct: Math.max(0, (hi - refPrice) / refPrice * 100),
    downPct: Math.max(0, (refPrice - lo) / refPrice * 100),
  };
}

/**
 * Does this day clear the gate? Threshold is a positive percentage (0.5 = 0.5%),
 * applied inclusively — a day that touched exactly the threshold still trades.
 */
export function passesRangeFilter(exc: Excursion, thresholdPct: number, mode: FilterMode): boolean {
  switch (mode) {
    case 'none': return true;
    case 'up-only': return exc.upPct <= thresholdPct;
    case 'down-only': return exc.downPct <= thresholdPct;
    case 'symmetric': return exc.upPct <= thresholdPct && exc.downPct <= thresholdPct;
  }
}
