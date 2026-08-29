/**
 * Unit tests for delta-grid.ts — pick the listed put strike whose BS-computed
 * delta is nearest a target |delta|.
 *
 * Each candidate carries its strike + observed put price; the selector inverts
 * IV from price (black-scholes) → delta, then picks the nearest to the target.
 * Candidates whose price can't yield a real IV (≤ intrinsic) are skipped.
 */
import { describe, it, expect } from 'vitest';
import { selectStrikeByDelta, type DeltaCandidate } from '../../scripts/diag/delta-grid';
import { bsPutPrice } from '../../scripts/diag/black-scholes';

const SPOT = 20000;
const T = 5 / 252;   // 5 trading days, in years (252 trading days)
const RATE = 0;
const VOL = 0.20;    // generate prices at a known flat vol

/** Build a candidate at a strike with its true BS put price at VOL. */
function cand(strike: number): DeltaCandidate {
  return { strike, price: bsPutPrice(SPOT, strike, T, VOL, RATE) };
}

describe('selectStrikeByDelta', () => {
  // A ladder of put strikes around spot (NDX-like, $50 grid near ATM).
  const strikes = [];
  for (let k = SPOT - 2000; k <= SPOT + 2000; k += 50) strikes.push(k);
  const candidates = strikes.map(cand);

  it('selects ATM-ish strike for target |delta| ~0.5', () => {
    const r = selectStrikeByDelta(candidates, 0.50, SPOT, T, RATE);
    expect(r).not.toBeNull();
    // ATM 5DTE put delta ≈ -0.49..-0.50, so the chosen strike sits near spot.
    expect(Math.abs(r!.strike - SPOT)).toBeLessThanOrEqual(150);
    expect(Math.abs(Math.abs(r!.delta) - 0.50)).toBeLessThanOrEqual(0.05);
  });

  it('lower target |delta| (0.30) → an OTM put (strike below spot)', () => {
    const r = selectStrikeByDelta(candidates, 0.30, SPOT, T, RATE)!;
    expect(r.strike).toBeLessThan(SPOT);
    expect(Math.abs(Math.abs(r.delta) - 0.30)).toBeLessThanOrEqual(0.05);
  });

  it('higher target |delta| (0.70) → an ITM put (strike above spot)', () => {
    const r = selectStrikeByDelta(candidates, 0.70, SPOT, T, RATE)!;
    expect(r.strike).toBeGreaterThan(SPOT);
    expect(Math.abs(Math.abs(r.delta) - 0.70)).toBeLessThanOrEqual(0.05);
  });

  it('monotonic: higher target delta selects a higher (or equal) strike', () => {
    const lo = selectStrikeByDelta(candidates, 0.30, SPOT, T, RATE)!;
    const mid = selectStrikeByDelta(candidates, 0.50, SPOT, T, RATE)!;
    const hi = selectStrikeByDelta(candidates, 0.70, SPOT, T, RATE)!;
    expect(lo.strike).toBeLessThanOrEqual(mid.strike);
    expect(mid.strike).toBeLessThanOrEqual(hi.strike);
  });

  it('returns the chosen strike, its delta, and its price', () => {
    const r = selectStrikeByDelta(candidates, 0.50, SPOT, T, RATE)!;
    expect(r).toHaveProperty('strike');
    expect(r).toHaveProperty('delta');
    expect(r).toHaveProperty('price');
    expect(r.delta).toBeLessThan(0); // put delta is negative
  });

  it('returns null when there are no usable candidates', () => {
    expect(selectStrikeByDelta([], 0.5, SPOT, T, RATE)).toBeNull();
  });

  it('skips candidates whose price is below intrinsic (no real IV)', () => {
    // One bad candidate (price far below intrinsic) plus good ones.
    const good = cand(SPOT - 100);
    const bad: DeltaCandidate = { strike: SPOT + 500, price: 1 }; // intrinsic ~500, price 1 → no IV
    const r = selectStrikeByDelta([bad, good], 0.5, SPOT, T, RATE);
    expect(r).not.toBeNull();
    expect(r!.strike).toBe(good.strike); // bad one skipped
  });

  it('excludeStrikes lets the long leg avoid reusing the short strike', () => {
    const short = selectStrikeByDelta(candidates, 0.50, SPOT, T, RATE)!;
    const long = selectStrikeByDelta(candidates, 0.50, SPOT, T, RATE, new Set([short.strike]))!;
    expect(long.strike).not.toBe(short.strike);
  });
});
