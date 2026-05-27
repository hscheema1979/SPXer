/**
 * Unit tests for sweep-geometry.ts — DTE-aware geometry tiers.
 *
 * Invariants under test:
 *   - every supported DTE returns a well-formed DteGeometry,
 *   - spread defs are short-ITM (soS < 0) with positive width (wS > 0),
 *   - friction (slippage, half-spread) scales monotonically up with DTE,
 *   - the 0DTE / 1DTE tiers keep the tight 'shorts-fresh' exit gate; longer
 *     DTEs default to 'none' (multi-day carry, no intraday liquidity gate),
 *   - geometryForDte is total: any non-negative dte resolves to a tier
 *     (out-of-table values fall through to the 40+ tier).
 */
import { describe, it, expect } from 'vitest';
import { geometryForDte, type DteGeometry } from '../../scripts/diag/sweep-geometry';

const SUPPORTED_DTES = [0, 1, 2, 3, 5, 10, 15, 20, 30, 40, 60];

function assertWellFormed(g: DteGeometry) {
  expect(Array.isArray(g.spreadDefs)).toBe(true);
  expect(g.spreadDefs.length).toBeGreaterThan(0);
  for (const { soS, wS } of g.spreadDefs) {
    expect(Number.isFinite(soS)).toBe(true);
    expect(Number.isFinite(wS)).toBe(true);
    expect(soS).toBeLessThan(0);   // short leg is ITM for short-put credit
    expect(wS).toBeGreaterThan(0); // width is a positive strike count
  }
  expect(g.wingWidths.every(w => w > 0)).toBe(true);
  expect(g.icOffsets.every(o => o > 0)).toBe(true);
  expect(g.closeHalfSpread).toBeGreaterThan(0);
  expect(g.entrySlippage2leg).toBeGreaterThan(0);
  expect(g.entrySlippage4leg).toBeGreaterThan(0);
  expect(g.entrySlippage4leg).toBeGreaterThanOrEqual(g.entrySlippage2leg);
  expect(['shorts-fresh', 'none']).toContain(g.exitGateDefault);
}

describe('geometryForDte — well-formed for every supported DTE', () => {
  for (const dte of SUPPORTED_DTES) {
    it(`DTE ${dte} returns valid geometry`, () => {
      assertWellFormed(geometryForDte(dte));
    });
  }
});

describe('geometryForDte — exit gate policy', () => {
  it('0DTE and 1DTE use the shorts-fresh intraday liquidity gate', () => {
    expect(geometryForDte(0).exitGateDefault).toBe('shorts-fresh');
    expect(geometryForDte(1).exitGateDefault).toBe('shorts-fresh');
  });

  it('DTE>=2 defaults to no intraday gate (multi-day carry)', () => {
    for (const dte of [2, 3, 5, 10, 20, 60]) {
      expect(geometryForDte(dte).exitGateDefault).toBe('none');
    }
  });
});

describe('geometryForDte — friction scales monotonically with DTE', () => {
  it('close half-spread is non-decreasing across DTE tiers', () => {
    const hs = SUPPORTED_DTES.map(d => geometryForDte(d).closeHalfSpread);
    for (let i = 1; i < hs.length; i++) {
      expect(hs[i]).toBeGreaterThanOrEqual(hs[i - 1]);
    }
  });

  it('2-leg entry slippage is non-decreasing across DTE tiers', () => {
    const slip = SUPPORTED_DTES.map(d => geometryForDte(d).entrySlippage2leg);
    for (let i = 1; i < slip.length; i++) {
      expect(slip[i]).toBeGreaterThanOrEqual(slip[i - 1]);
    }
  });

  it('max spread width grows with DTE (longer DTE allows wider spreads)', () => {
    const maxWidth = (d: number) => Math.max(...geometryForDte(d).spreadDefs.map(s => s.wS));
    expect(maxWidth(60)).toBeGreaterThan(maxWidth(5));
    expect(maxWidth(20)).toBeGreaterThan(maxWidth(2));
  });

  it('deepest ITM offset grows with DTE', () => {
    const deepest = (d: number) => Math.min(...geometryForDte(d).spreadDefs.map(s => s.soS));
    expect(deepest(60)).toBeLessThan(deepest(5));  // more negative = deeper ITM
    expect(deepest(20)).toBeLessThan(deepest(2));
  });
});

describe('geometryForDte — totality / range-based tier boundaries', () => {
  it('2 and 3 DTE share the same tier (<=3 bucket)', () => {
    expect(geometryForDte(2)).toEqual(geometryForDte(3));
  });

  it('out-of-table DTE above the top tier (45, 90) resolves to the 40+ tier', () => {
    const tier40 = geometryForDte(40);
    expect(geometryForDte(45)).toEqual(tier40);
    expect(geometryForDte(90)).toEqual(tier40);
  });

  it('an unlisted mid DTE resolves to the nearest higher tier, not 40+', () => {
    // 7 sits between the 5 and 10 tiers; range buckets put it in the <=10 tier.
    // It must NOT fall through to the 40+ tier (the old exact-match bug).
    expect(geometryForDte(7)).toEqual(geometryForDte(10));
    expect(geometryForDte(7)).not.toEqual(geometryForDte(40));
    assertWellFormed(geometryForDte(7));
  });

  it('DTE 4 takes the 5 tier; DTE 25 takes the 30 tier (upper-bound buckets)', () => {
    expect(geometryForDte(4)).toEqual(geometryForDte(5));
    expect(geometryForDte(25)).toEqual(geometryForDte(30));
  });
});
