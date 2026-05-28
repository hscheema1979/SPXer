/**
 * strike-grid.ts
 *
 * Data-driven strike interval: derive the LOCAL strike grid from the actual
 * listed strikes near spot, instead of a hardcoded per-symbol/per-DTE constant.
 *
 * NDXP spacing varies by both moneyness (tighter ATM) and DTE (10pt near-dated,
 * 25pt+ for quarterlies), so any fixed constant is wrong somewhere. Because the
 * sweep already snaps geometry targets to the nearest listed contract
 * (findStrike), measuring the real grid near spot makes offset->dollar sizing
 * correct automatically for any symbol / DTE / moneyness.
 */

/**
 * Median adjacent-strike gap among the `k` strikes closest to `spot`.
 *
 * @param strikes  available strike prices (any order, may contain dups)
 * @param spot     reference price (entry-day underlying)
 * @param k        window size — how many near-spot strikes to measure (default 8)
 * @returns the local strike interval, or null if fewer than 2 distinct strikes
 */
export function deriveStrikeInterval(
  strikes: number[],
  spot: number,
  k = 8
): number | null {
  const uniq = [...new Set(strikes)].sort((a, b) => a - b);
  if (uniq.length < 2) return null;

  // Take the k strikes closest to spot (by absolute distance), then restore
  // ascending order so adjacent gaps are meaningful.
  const window = [...uniq]
    .sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot))
    .slice(0, Math.max(2, k))
    .sort((a, b) => a - b);

  const gaps: number[] = [];
  for (let i = 1; i < window.length; i++) {
    gaps.push(window[i] - window[i - 1]);
  }
  if (gaps.length === 0) return null;

  return median(gaps);
}

/** Median of a numeric array (lower-middle for even length, matching the data tests). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid];
  // Even length: average the two middle values, then round to the nearest
  // listed-strike-plausible integer (grids are whole dollars).
  return Math.round((s[mid - 1] + s[mid]) / 2);
}
