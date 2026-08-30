/**
 * Unit tests for time-iron-study.ts — TIME-based ATM iron-butterfly backtest.
 *
 * Covers the inherited 0DTE valuation (verbatim from iron-sweep) plus the new
 * per-trade emission helpers, so a regression in either is caught:
 *   - optPx() returns the last bar at-or-before a ts.
 *   - buildTrajectory() nets the four legs by sign + flags fresh shorts.
 *   - applyExit() hold-to-settle prices the fly at 0DTE intrinsic and caps the
 *     loss at the wing width; honours a TP fill when the shorts are fresh.
 *   - slugify() maps a "signal|structure|exit" key to a filesystem-safe dir.
 *   - buildTimeTradeRecord() produces the emitted per-trade record (entry/exit,
 *     intrinsic exit marks at expiry, net P&L after slippage, max risk).
 */
import { describe, it, expect } from 'vitest';
import {
  optPx, buildTrajectory, applyExit, slugify, buildTimeTradeRecord,
  type Leg, type TrajPoint,
} from '../../scripts/diag/time-iron-study';

// ATM fly centered at 5000, 30-wide wings. OCC type char is 9 chars from the end.
const sym = (cp: 'C' | 'P', k: number) => `SPXW260610${cp}${String(k * 1000).padStart(8, '0')}`;
function flyLegs(center = 5000, wing = 30): Leg[] {
  return [
    { symbol: sym('P', center),        strike: center,        sign: +1, bars: [] }, // short put
    { symbol: sym('P', center - wing), strike: center - wing, sign: -1, bars: [] }, // long put
    { symbol: sym('C', center),        strike: center,        sign: +1, bars: [] }, // short call
    { symbol: sym('C', center + wing), strike: center + wing, sign: -1, bars: [] }, // long call
  ];
}

describe('optPx', () => {
  it('returns the close of the last bar at or before ts', () => {
    const bars = [{ ts: 10, close: 1 }, { ts: 20, close: 2 }, { ts: 30, close: 3 }];
    expect(optPx(bars, 25)).toBe(2);
    expect(optPx(bars, 30)).toBe(3);
  });
  it('returns null when no bar is early enough', () => {
    expect(optPx([{ ts: 100, close: 9 }], 50)).toBeNull();
    expect(optPx([], 50)).toBeNull();
  });
});

describe('buildTrajectory nets legs by sign', () => {
  it('sums short(+) minus long(-) closes at each printed minute', () => {
    const legs: Leg[] = [
      { symbol: sym('P', 5000), strike: 5000, sign: +1, bars: [{ ts: 10, close: 3 }] },
      { symbol: sym('P', 4970), strike: 4970, sign: -1, bars: [{ ts: 10, close: 1 }] },
      { symbol: sym('C', 5000), strike: 5000, sign: +1, bars: [{ ts: 10, close: 3 }] },
      { symbol: sym('C', 5030), strike: 5030, sign: -1, bars: [{ ts: 10, close: 1 }] },
    ];
    const traj = buildTrajectory(legs, 0, 100);
    expect(traj).toHaveLength(1);
    expect(traj[0].V).toBe(4);              // 3 - 1 + 3 - 1
    expect(traj[0].shortsFresh).toBe(true); // a short leg printed at ts 10
  });
});

describe('applyExit — hold-to-settle 0DTE intrinsic', () => {
  const settle = 1_000_000;
  const run = (spxAtSettle: number) =>
    applyExit([], settle, settle, flyLegs(), /*credit*/ 12, /*tpFrac*/ 0, spxAtSettle, /*wing*/ 30, /*slRiskFrac*/ 0);

  it('keeps full credit when SPX settles on the body (max profit)', () => {
    const r = run(5000);
    expect(r.reason).toBe('expiry');
    expect(r.exitV).toBe(0);
  });
  it('prices intrinsic when SPX settles inside the wing', () => {
    expect(run(5005).exitV).toBe(5); // short call ITM by 5
    expect(run(4993).exitV).toBe(7); // short put ITM by 7
  });
  it('caps the loss at the wing width past a wing', () => {
    expect(run(4960).exitV).toBe(30); // below long put → capped at wing
    expect(run(5050).exitV).toBe(30); // above long call → capped at wing
  });
});

describe('applyExit — TP fires when shorts are fresh', () => {
  it('takes profit at the limit once net value decays past the trigger', () => {
    const settle = 1000;
    // credit 12, TP25 → tpV = 9; hard-mode trigger = 9 − 0.40 penalty = 8.60.
    const traj: TrajPoint[] = [{ ts: 500, V: 8.0, shortsFresh: true }];
    const r = applyExit(traj, settle, settle, flyLegs(), 12, 0.25, 5000, 30, 0);
    expect(r.reason).toBe('TP');
    expect(r.exitV).toBeCloseTo(9, 9); // hard fill at the limit, not the mid
  });
});

describe('slugify — emit dir name', () => {
  it('maps a variant key to a filesystem-safe slug', () => {
    expect(slugify('TIME 30m|IB w30|hold-to-settle')).toBe('TIME_30m__IB_w30__hold-to-settle');
  });
});

describe('buildTimeTradeRecord — emitted per-trade record', () => {
  it('builds intrinsic exit marks at expiry + net P&L after slippage', () => {
    const tr = buildTimeTradeRecord({
      legs: flyLegs(5000, 30), entryTs: 1_000, exitTs: 4_600, exitV: 5, exitReason: 'expiry',
      credit: 12, wingWidth: 30, center: 5000, tpFrac: 0, slRiskFrac: 0,
      spxAtEntry: 5000, spxAtExit: 5005, spxAtSettle: 5005, drift30: 1.5,
      entriesPx: [10, 2, 9, 1], slippage: 25,
    });
    expect(tr.durationSec).toBe(3600);
    expect(tr.dir).toBe('bull');                 // drift30 >= 0
    expect(tr.maxRisk).toBe((30 - 12) * 100);    // (width - credit) * 100
    expect(tr.pnlGross).toBe((12 - 5) * 100);    // (credit - exitV) * 100 = 700
    expect(tr.pnlNet).toBe(700 - 25);            // less slippage
    expect(tr.exitReason).toBe('expiry');
    // settle 5005: short call ITM 5, every other leg worthless at intrinsic.
    expect(tr.shortCallExitMark).toBe(5);
    expect(tr.shortPutExitMark).toBe(0);
    expect(tr.longCallExitMark).toBe(0);
    expect(tr.shortCallStrike).toBe(5000);
    expect(tr.longCallStrike).toBe(5030);
  });
  it('marks bear when 30-min drift is negative', () => {
    const tr = buildTimeTradeRecord({
      legs: flyLegs(), entryTs: 0, exitTs: 60, exitV: 0, exitReason: 'expiry',
      credit: 10, wingWidth: 30, center: 5000, tpFrac: 0, slRiskFrac: 0,
      spxAtEntry: 5000, spxAtExit: 5000, spxAtSettle: 5000, drift30: -2,
      entriesPx: [8, 1, 8, 1], slippage: 25,
    });
    expect(tr.dir).toBe('bear');
  });
});
