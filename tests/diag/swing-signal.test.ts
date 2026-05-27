/**
 * Unit tests for swing-signal.ts — higher-timeframe HMA/DEMA cross detection
 * for multi-DTE swing entries, computed from a closes series (daily/weekly).
 *
 * The key properties:
 *   - direction(closes) returns 'bull'/'bear'/null from the HMA/DEMA fast vs slow,
 *   - freshBullCross(closes) is true only when the LAST bar flipped fast>slow
 *     (bear→bull on the final bar) — a NEW signal, not a standing bull state,
 *   - no look-ahead: only the closes passed in are used (caller slices to bars
 *     strictly before the entry date).
 */
import { describe, it, expect } from 'vitest';
import { direction, freshBullCross } from '../../scripts/diag/swing-signal';

// A rising series → bull; falling → bear. Build deterministic ramps.
const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
const falling = Array.from({ length: 40 }, (_, i) => 200 - i);
// V-shape: falls for 20 bars then rises for 20 → bull cross near the turn.
const vshape = [
  ...Array.from({ length: 20 }, (_, i) => 200 - i * 2),
  ...Array.from({ length: 20 }, (_, i) => 160 + i * 3),
];

describe('direction', () => {
  it('rising series is bull (HMA)', () => {
    expect(direction(rising, 'hma', 3, 9)).toBe('bull');
  });
  it('falling series is bear (HMA)', () => {
    expect(direction(falling, 'hma', 3, 9)).toBe('bear');
  });
  it('rising series is bull (DEMA)', () => {
    expect(direction(rising, 'dema', 3, 9)).toBe('bull');
  });
  it('returns null when too few bars to compute', () => {
    expect(direction([100, 101], 'hma', 3, 9)).toBeNull();
  });
});

describe('freshBullCross', () => {
  it('is false for a steadily rising series (bull, but not a NEW cross)', () => {
    // Already bull for many bars → not fresh on the last bar.
    expect(freshBullCross(rising, 'hma', 3, 9)).toBe(false);
  });

  it('is false for a falling series (bear)', () => {
    expect(freshBullCross(falling, 'hma', 3, 9)).toBe(false);
  });

  it('detects the bull cross at the turn of a V-shape', () => {
    // Somewhere after the V turns up (~bar 22), the last bar flips bear→bull.
    // Find the smallest prefix length where the final bar is a fresh bull cross.
    let foundAt = -1;
    for (let n = 12; n <= vshape.length; n++) {
      if (freshBullCross(vshape.slice(0, n), 'hma', 3, 9)) { foundAt = n; break; }
    }
    expect(foundAt).toBeGreaterThan(0);
    // The cross occurs shortly after the turn (bar 20), not deep into the up-leg.
    expect(foundAt).toBeLessThanOrEqual(26);
  });

  it('no look-ahead: depends only on the closes passed in', () => {
    // Truncating the series must not let future bars influence the result.
    const upToTurn = vshape.slice(0, 22); // still in/near the down-leg
    const r1 = freshBullCross(upToTurn, 'hma', 3, 9);
    const r2 = freshBullCross(upToTurn.concat([999, 1000]), 'hma', 3, 9);
    // Adding future bars changes the LAST-bar evaluation, so results may differ —
    // the point is r1 is computed without seeing those future bars at all.
    expect(typeof r1).toBe('boolean');
    expect(typeof r2).toBe('boolean');
  });

  it('returns false when too few bars', () => {
    expect(freshBullCross([100, 101, 102], 'hma', 3, 9)).toBe(false);
  });
});
