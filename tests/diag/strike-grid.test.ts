/**
 * Unit tests for strike-grid.ts — data-driven strike interval.
 *
 * The real NDXP grid is not a constant: it's ~10pt ATM for near expiries and
 * 25pt+ for far/quarterly expiries, and tighter ATM than deep-OTM within one
 * expiry. Rather than hardcode a DTE->interval table, deriveStrikeInterval
 * computes the LOCAL grid from the actual listed strikes near spot (the same
 * strikes findStrike() will snap to), so it is automatically correct for any
 * symbol / DTE / moneyness.
 *
 * deriveStrikeInterval(strikes, spot, k?) -> median adjacent gap among the k
 * strikes closest to spot. Returns null when fewer than 2 strikes exist.
 */
import { describe, it, expect } from 'vitest';
import { deriveStrikeInterval } from '../../scripts/diag/strike-grid';

/** Build an evenly spaced strike ladder. */
function ladder(start: number, end: number, step: number): number[] {
  const out: number[] = [];
  for (let s = start; s <= end; s += step) out.push(s);
  return out;
}

describe('deriveStrikeInterval — uniform grids', () => {
  it('SPX 5-point grid → 5', () => {
    expect(deriveStrikeInterval(ladder(5000, 6000, 5), 5500)).toBe(5);
  });

  it('NDX near-dated 10-point ATM grid → 10', () => {
    expect(deriveStrikeInterval(ladder(19000, 21000, 10), 20000)).toBe(10);
  });

  it('NDX far-dated 25-point grid → 25', () => {
    expect(deriveStrikeInterval(ladder(18000, 22000, 25), 20000)).toBe(25);
  });

  it('QQQ 1-point grid → 1', () => {
    expect(deriveStrikeInterval(ladder(400, 500, 1), 450)).toBe(1);
  });
});

describe('deriveStrikeInterval — mixed-density grids (ATM tighter than OTM)', () => {
  it('uses the LOCAL grid near spot, ignoring coarse far-OTM strikes', () => {
    // Tight 10-pt grid 19500-20500 (ATM), coarse 100-pt grid far out.
    const tightAtm = ladder(19500, 20500, 10);
    const coarseFar = [...ladder(15000, 19400, 100), ...ladder(20600, 25000, 100)];
    const strikes = [...coarseFar, ...tightAtm].sort((a, b) => a - b);
    // Near spot=20000 the local grid is 10, not 100.
    expect(deriveStrikeInterval(strikes, 20000)).toBe(10);
  });

  it('picks the coarse grid when spot sits in the coarse region', () => {
    const tightAtm = ladder(19500, 20500, 10);
    const coarseFar = [...ladder(15000, 19400, 100), ...ladder(20600, 25000, 100)];
    const strikes = [...coarseFar, ...tightAtm].sort((a, b) => a - b);
    // Spot far below the tight ATM cluster → local grid is the 100-pt one.
    expect(deriveStrikeInterval(strikes, 16000)).toBe(100);
  });

  it('takes the MEDIAN gap so a single odd fill strike does not skew it', () => {
    // Mostly 25-pt, with one stray 5-pt fill near spot.
    const strikes = [19900, 19925, 19950, 19955, 19975, 20000, 20025, 20050, 20075];
    // Adjacent gaps near spot: 25,25,5,20,25,25,25,25 → median 25.
    expect(deriveStrikeInterval(strikes, 20000)).toBe(25);
  });
});

describe('deriveStrikeInterval — edge cases', () => {
  it('returns null for fewer than 2 strikes', () => {
    expect(deriveStrikeInterval([], 20000)).toBeNull();
    expect(deriveStrikeInterval([20000], 20000)).toBeNull();
  });

  it('handles unsorted input', () => {
    expect(deriveStrikeInterval([20020, 20000, 20010, 20030], 20015)).toBe(10);
  });

  it('dedupes identical strikes before measuring gaps', () => {
    expect(deriveStrikeInterval([20000, 20000, 20010, 20010, 20020], 20010)).toBe(10);
  });

  it('respects a custom window size k', () => {
    // 5-pt cluster of 3 near spot, rest 50-pt. With k=4 the window is the 5-pt
    // cluster; with a large k the 50-pt strikes dominate the median.
    const strikes = [19000, 19050, 19100, 19995, 20000, 20005, 20500, 21000];
    expect(deriveStrikeInterval(strikes, 20000, 3)).toBe(5);
  });
});
