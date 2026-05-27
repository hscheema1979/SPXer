/**
 * delta-grid.ts
 *
 * Select the listed put strike whose BS-computed delta is nearest a target
 * |delta|. For each candidate (strike + observed put price) we invert implied
 * vol from the price (black-scholes), evaluate the put delta, and pick the
 * nearest match. Candidates whose price can't yield a real IV (≤ intrinsic) are
 * skipped. This is how the multi-DTE sweep targets constant-delta short legs
 * without greeks in the data feed.
 */
import { impliedVolFromPut, bsPutDelta } from './black-scholes';

export interface DeltaCandidate {
  strike: number;
  price: number;   // observed put mark at entry
}

export interface DeltaSelection {
  strike: number;
  delta: number;   // signed (negative for puts)
  price: number;
}

/**
 * Pick the candidate whose |delta| is closest to targetAbsDelta.
 * @param targetAbsDelta absolute target delta (e.g. 0.30, 0.50, 0.70)
 * @param spot underlying price at entry
 * @param T time to expiry in YEARS
 * @param rate flat risk-free rate (decimal)
 * @param excludeStrikes strikes to skip (e.g. the short strike when picking the long)
 */
export function selectStrikeByDelta(
  candidates: DeltaCandidate[],
  targetAbsDelta: number,
  spot: number,
  T: number,
  rate: number,
  excludeStrikes?: ReadonlySet<number>
): DeltaSelection | null {
  let best: DeltaSelection | null = null;
  let bestDist = Infinity;

  for (const c of candidates) {
    if (excludeStrikes && excludeStrikes.has(c.strike)) continue;
    const iv = impliedVolFromPut(c.price, spot, c.strike, T, rate);
    if (iv === null) continue; // price not arbitrage-consistent → skip
    const delta = bsPutDelta(spot, c.strike, T, iv, rate);
    const dist = Math.abs(Math.abs(delta) - targetAbsDelta);
    if (dist < bestDist) {
      bestDist = dist;
      best = { strike: c.strike, delta, price: c.price };
    }
  }

  return best;
}
