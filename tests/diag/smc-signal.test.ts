/**
 * Unit tests for smc-signal.ts — TJR / Smart-Money "liquidity sweep + break of
 * structure" detector (the V1 setup Revelio Trading found to be the profitable
 * core of the strategy).
 *
 * Properties verified:
 *   - A BULL setup fires only after price (a) sweeps sell-side liquidity by
 *     wicking BELOW a confirmed swing low, then (b) breaks structure UP by
 *     CLOSING above the prior confirmed swing high. The event sits on the BOS
 *     bar, and stopLow == the lowest wick of the sweep.
 *   - No event when the BOS close never clears the reference swing high.
 *   - No event on a flat series (no pivots).
 *   - No look-ahead: pivots confirm `right` bars after their center, so an
 *     event at bar i depends only on bars 0..i (prefix agreement).
 */
import { describe, it, expect } from 'vitest';
import { smcSetupsOnSeries, type SmcBar } from '../../scripts/diag/smc-signal';

function bar(ts: number, o: number, h: number, l: number, c: number): SmcBar {
  return { ts, open: o, high: h, low: l, close: c };
}

/**
 * Hand-built series (left=3, right=2):
 *   idx 3  → swing HIGH (high 110.5), confirmed at idx 5
 *   idx 7  → swing LOW  (low 98),     confirmed at idx 9
 *   idx 10 → SWEEP: wick to low 95 (< 98)
 *   idx 11 → BOS: close 113 (> 110.5) → bull setup, stopLow = 95
 */
function buildBullSweepBosSeries(): SmcBar[] {
  return [
    bar(0,  99.5, 100.5, 99.0, 100), // 0
    bar(60, 101.5, 102.5, 101.0, 102), // 1
    bar(120, 103.5, 104.5, 103.0, 104), // 2
    bar(180, 105.0, 110.5, 104.5, 110), // 3  swing high (high 110.5)
    bar(240, 109.0, 109.5, 105.5, 106), // 4
    bar(300, 104.0, 104.5, 102.5, 103), // 5
    bar(360, 102.0, 102.5, 100.5, 101), // 6
    bar(420, 99.0, 99.5, 98.0, 98.5),   // 7  swing low (low 98)
    bar(480, 99.5, 100.5, 99.0, 100),   // 8
    bar(540, 101.5, 102.5, 101.0, 102), // 9
    bar(600, 99.0, 99.5, 95.0, 96),     // 10 SWEEP (low 95 < 98)
    bar(660, 100.0, 113.0, 99.5, 113),  // 11 BOS (close 113 > 110.5)
  ];
}

const P = { left: 3, right: 2, maxWait: 12 };

describe('smcSetupsOnSeries — bull liquidity sweep + break of structure', () => {
  it('fires on the BOS bar with stopLow at the sweep wick', () => {
    const bars = buildBullSweepBosSeries();
    const evs = smcSetupsOnSeries(bars, P);
    const bulls = evs.filter(e => e.dir === 'bull');
    expect(bulls.length).toBe(1);
    expect(bulls[0].barIdx).toBe(11);
    expect(bulls[0].ts).toBe(660);
    expect(bulls[0].stopLow).toBe(95);
    expect(bulls[0].refHigh).toBe(110.5);
  });

  it('does NOT fire when the BOS close never clears the swing high', () => {
    const bars = buildBullSweepBosSeries();
    // Knock the BOS close back below the reference swing high (110.5).
    bars[11] = bar(660, 100.0, 109.0, 99.5, 108);
    const evs = smcSetupsOnSeries(bars, P).filter(e => e.dir === 'bull');
    expect(evs.length).toBe(0);
  });

  it('does NOT fire when there is no sweep below the swing low', () => {
    const bars = buildBullSweepBosSeries();
    // Remove the sweep: keep bar 10 above the swing low (98).
    bars[10] = bar(600, 100.0, 101.0, 99.0, 100.5);
    const evs = smcSetupsOnSeries(bars, P).filter(e => e.dir === 'bull');
    expect(evs.length).toBe(0);
  });

  it('returns no events on a flat series (no pivots)', () => {
    const bars: SmcBar[] = [];
    for (let i = 0; i < 40; i++) bars.push(bar(i * 60, 100, 100, 100, 100));
    expect(smcSetupsOnSeries(bars, P).length).toBe(0);
  });

  it('no look-ahead: prefix up to the BOS bar yields the same event', () => {
    const bars = buildBullSweepBosSeries();
    // Append trailing bars; detection on the prefix [0..BOS] must agree.
    let ts = 720;
    for (let i = 0; i < 6; i++) { bars.push(bar(ts, 113, 114, 112, 113)); ts += 60; }
    const full = smcSetupsOnSeries(bars, P).filter(e => e.dir === 'bull');
    expect(full.length).toBeGreaterThan(0);
    const idx = full[0].barIdx;
    const prefix = bars.slice(0, idx + 1);
    const pref = smcSetupsOnSeries(prefix, P).filter(e => e.dir === 'bull');
    expect(pref.length).toBe(1);
    expect(pref[0].barIdx).toBe(idx);
    expect(pref[0].stopLow).toBe(full[0].stopLow);
  });
});
