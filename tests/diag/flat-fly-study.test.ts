/**
 * Unit tests for flat-fly-study.ts — Option Alpha "Flat Fly" backtest.
 *
 * Covers the ONE thing that differs from time-iron-study (the prev-close
 * anchor) plus the inherited 0DTE intrinsic-settle valuation, so a regression
 * in either is caught:
 *   - prevClose() returns the prior session's last bar close (the fly anchor).
 *   - applyExit() hold-to-settle prices a 0-wide fly at intrinsic and caps the
 *     loss at the wing width.
 *   - buildTrajectory() nets the four legs by sign.
 *   - applyExit() honours a TP fill when the short legs are fresh.
 */
import { describe, it, expect } from 'vitest';
import { prevClose, applyExit, buildTrajectory, buildLegs, type Leg, type TrajPoint } from '../../scripts/diag/flat-fly-study';

// 0-wide fly centered at 5000, 10-wide wings. OCC type char is 9 from the end.
const sym = (cp: 'C' | 'P', k: number) => `SPXW260610${cp}${String(k * 1000).padStart(8, '0')}`;

// Mock contract universe: P and C listed every 5pts over [4800,5200], for buildLegs.
function mockChain(): any {
  const contractBars = new Map<string, any[]>(), contractStrikes = new Map<string, number>();
  for (let k = 4800; k <= 5200; k += 5) for (const cp of ['P', 'C'] as const) {
    const s = sym(cp, k); contractBars.set(s, [{ ts: 1, close: 1 }]); contractStrikes.set(s, k);
  }
  return { contractBars, contractStrikes };
}
function flyLegs(center = 5000, wing = 10): Leg[] {
  return [
    { symbol: sym('P', center),        strike: center,        sign: +1, bars: [] }, // short put
    { symbol: sym('P', center - wing), strike: center - wing, sign: -1, bars: [] }, // long put
    { symbol: sym('C', center),        strike: center,        sign: +1, bars: [] }, // short call
    { symbol: sym('C', center + wing), strike: center + wing, sign: -1, bars: [] }, // long call
  ];
}

describe('prevClose (the fly anchor)', () => {
  it('returns the last bar close of the prior day', () => {
    expect(prevClose([{ ts: 1, close: 4990 }, { ts: 2, close: 5001.25 }])).toBe(5001.25);
  });
  it('returns null when there is no prior-day data', () => {
    expect(prevClose([])).toBeNull();
    expect(prevClose(null)).toBeNull();
    expect(prevClose(undefined)).toBeNull();
  });
});

describe('applyExit — hold-to-settle 0DTE intrinsic (prev-close fly)', () => {
  const settle = 1_000_000;
  const run = (spxAtSettle: number) =>
    applyExit([], settle, settle, flyLegs(), /*credit*/ 2, /*tpFrac*/ 0, spxAtSettle, /*wing*/ 10, /*slRiskFrac*/ 0);

  it('keeps full credit when SPX settles exactly on the anchor (max profit)', () => {
    const r = run(5000);
    expect(r.reason).toBe('expiry');
    expect(r.exitV).toBe(0); // both shorts + both longs worthless → debit to close = 0
  });

  it('prices intrinsic when SPX settles inside the wing', () => {
    // settle 5005 → short call ITM by 5, everything else worthless → V = 5
    expect(run(5005).exitV).toBe(5);
    // settle 4997 → short put ITM by 3 → V = 3
    expect(run(4997).exitV).toBe(3);
  });

  it('caps the loss at the wing width when SPX blows past a wing', () => {
    // settle 4985 (below the 4990 long put): short put 15 − long put 5 = 10 = wing
    expect(run(4985).exitV).toBe(10);
    // settle 5025 (above the 5010 long call): short call 25 − long call 15 = 10 = wing
    expect(run(5025).exitV).toBe(10);
  });
});

describe('buildTrajectory nets legs by sign', () => {
  it('sums short(+) minus long(-) closes at each printed minute', () => {
    const legs: Leg[] = [
      { symbol: sym('P', 5000), strike: 5000, sign: +1, bars: [{ ts: 10, close: 3 }] },
      { symbol: sym('P', 4990), strike: 4990, sign: -1, bars: [{ ts: 10, close: 1 }] },
      { symbol: sym('C', 5000), strike: 5000, sign: +1, bars: [{ ts: 10, close: 3 }] },
      { symbol: sym('C', 5010), strike: 5010, sign: -1, bars: [{ ts: 10, close: 1 }] },
    ];
    const traj = buildTrajectory(legs, 0, 100);
    expect(traj).toHaveLength(1);
    expect(traj[0].V).toBe(4);              // 3 - 1 + 3 - 1
    expect(traj[0].shortsFresh).toBe(true); // a short leg printed at ts 10
  });
});

describe('applyExit — TP fires when shorts are fresh', () => {
  it('takes profit at the limit once net value decays past the trigger', () => {
    const settle = 1000;
    // credit 2, TP25 → tpV = 1.5; hard-mode trigger = 1.5 − 0.40 penalty = 1.10.
    const traj: TrajPoint[] = [{ ts: 500, V: 1.0, shortsFresh: true }];
    const r = applyExit(traj, settle, settle, flyLegs(), 2, 0.25, 5000, 10, 0);
    expect(r.reason).toBe('TP');
    expect(r.exitV).toBeCloseTo(1.5, 9); // hard fill at the limit, not the mid
  });
});

describe('buildLegs — shortOffset toggles fly vs OTM condor', () => {
  it('offset 0 builds an ATM iron butterfly (both shorts at center)', () => {
    const legs = buildLegs(mockChain(), 5000, 25, 0)!;
    expect(legs.map(l => l.strike)).toEqual([5000, 4975, 5000, 5025]); // sp, lp, sc, lc
    expect(legs.map(l => l.sign)).toEqual([1, -1, 1, -1]);
  });
  it('offset 50 builds an iron condor: shorts 50pt OTM each side, wings beyond', () => {
    const legs = buildLegs(mockChain(), 5000, 25, 50)!;
    // short put 4950, long put 4925; short call 5050, long call 5075
    expect(legs.map(l => l.strike)).toEqual([4950, 4925, 5050, 5075]);
    expect(legs[0].symbol[legs[0].symbol.length - 9]).toBe('P'); // first leg is the short put
    expect(legs[2].symbol[legs[2].symbol.length - 9]).toBe('C'); // third leg is the short call
  });
  it('returns null if a required strike is not listed', () => {
    expect(buildLegs(mockChain(), 5000, 25, 250)).toBeNull(); // 5250 long call out of [4800,5200]
  });
});
