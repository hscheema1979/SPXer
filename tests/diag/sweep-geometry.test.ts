/**
 * Unit tests for sweep-geometry.ts — DTE-aware geometry tiers.
 *
 * The short leg is selected by DELTA (shortDeltas), the long leg by width in
 * strike counts (widths). The engine sweeps their cross-product. Delta band is
 * the same 0.30–0.70 across DTEs (delta normalizes for time); widths grow with
 * DTE; friction grows with DTE.
 */
import { describe, it, expect } from 'vitest';
import { geometryForDte, type DteGeometry } from '../../scripts/diag/sweep-geometry';

const SUPPORTED_DTES = [0, 1, 2, 3, 5, 10, 15, 20, 30, 40, 60];

function assertWellFormed(g: DteGeometry) {
  expect(Array.isArray(g.shortDeltas)).toBe(true);
  expect(Array.isArray(g.widths)).toBe(true);
  expect(g.shortDeltas.length).toBeGreaterThan(0);
  expect(g.widths.length).toBeGreaterThan(0);
  // Deltas are absolute targets in (0,1), spanning OTM(<0.5) to ITM(>0.5).
  for (const d of g.shortDeltas) {
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  }
  expect(g.shortDeltas.some(d => d < 0.5)).toBe(true);  // OTM
  expect(g.shortDeltas.some(d => d > 0.5)).toBe(true);  // ITM
  expect(g.shortDeltas).toContain(0.50);                // ATM
  expect(g.widths.every(w => Number.isFinite(w) && w > 0)).toBe(true);
  expect(g.wingWidths.every(w => w > 0)).toBe(true);
  expect(g.icOffsets.every(o => o > 0)).toBe(true);
  expect(g.closeHalfSpread).toBeGreaterThan(0);
  expect(g.entrySlippage2leg).toBeGreaterThan(0);
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

describe('geometryForDte — short-delta band', () => {
  it('uses the 0.30–0.70 band (0.05 steps) at every DTE', () => {
    const expected = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
    for (const dte of SUPPORTED_DTES) {
      expect(geometryForDte(dte).shortDeltas).toEqual(expected);
    }
  });
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

describe('geometryForDte — friction & width scale monotonically with DTE', () => {
  it('close half-spread is non-decreasing across DTE tiers', () => {
    const hs = SUPPORTED_DTES.map(d => geometryForDte(d).closeHalfSpread);
    for (let i = 1; i < hs.length; i++) expect(hs[i]).toBeGreaterThanOrEqual(hs[i - 1]);
  });

  it('2-leg entry slippage is non-decreasing across DTE tiers', () => {
    const slip = SUPPORTED_DTES.map(d => geometryForDte(d).entrySlippage2leg);
    for (let i = 1; i < slip.length; i++) expect(slip[i]).toBeGreaterThanOrEqual(slip[i - 1]);
  });

  it('max spread width grows with DTE (longer DTE allows wider spreads)', () => {
    const maxWidth = (d: number) => Math.max(...geometryForDte(d).widths);
    expect(maxWidth(60)).toBeGreaterThan(maxWidth(5));
    expect(maxWidth(20)).toBeGreaterThan(maxWidth(2));
  });

  it('widths stay reasonable strike counts (snap to real listed strikes)', () => {
    for (const dte of SUPPORTED_DTES) {
      expect(Math.max(...geometryForDte(dte).widths)).toBeLessThanOrEqual(20);
    }
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
    expect(geometryForDte(7)).toEqual(geometryForDte(10));
    expect(geometryForDte(7)).not.toEqual(geometryForDte(40));
    assertWellFormed(geometryForDte(7));
  });

  it('DTE 4 takes the 5 tier; DTE 25 takes the 30 tier (upper-bound buckets)', () => {
    expect(geometryForDte(4)).toEqual(geometryForDte(5));
    expect(geometryForDte(25)).toEqual(geometryForDte(30));
  });
});
