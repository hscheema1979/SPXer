/**
 * Unit tests for regime-classify.ts — the playbook's regime measurement layer.
 * Verifies feature math (gap%, trendiness, OR break, gap-fill) and that the
 * coarse regime labels fire on hand-built archetype days.
 */
import { describe, it, expect } from 'vitest';
import { aggDay, computeFeatures, classify, type DayBar } from '../../scripts/diag/regime-classify';

const OPEN = 1_700_000_000; // session open ts
function bar(minute: number, o: number, h: number, l: number, c: number): DayBar {
  return { ts: OPEN + minute * 60, open: o, high: h, low: l, close: c };
}

// A clean gap-up trend day: opens above prevClose, rallies all session, never
// fills the gap. open 101 → close 104, range 100.8..104.2.
function gapUpTrendDay(): DayBar[] {
  const bars: DayBar[] = [];
  let p = 101;
  for (let m = 0; m < 60; m++) { const n = p + 0.05; bars.push(bar(m, p, n + 0.1, p - 0.05, n)); p = n; }
  return bars;
}

describe('aggDay + computeFeatures', () => {
  it('computes gap%, body, trendiness and gap-not-filled for a gap-up trend day', () => {
    const bars = gapUpTrendDay();
    const a = aggDay(bars, OPEN);
    const f = computeFeatures('2026-01-02', a, /*prevClose*/ 100, /*sma20*/ 99, /*rvolPctile*/ 0.5);
    expect(f.gapPct).toBeCloseTo(1.0, 1);          // (101-100)/100 = +1%
    expect(f.gapDir).toBe('up');
    expect(f.gapBucket).toBe('up_large');           // ~1% → large bucket (>=1.0)
    expect(f.bodyPct).toBeGreaterThan(0);           // close > open
    expect(f.trendiness).toBeGreaterThan(0.6);      // strong directional day
    expect(f.gapFilled).toBe(false);                // low never reached prevClose=100
    expect(f.trend20).toBe('above');                // open 101 >= sma20 99
  });

  it('flags gap_filled when price trades back through prevClose', () => {
    const bars = gapUpTrendDay();
    // force an early dip below prevClose (100) then recover
    bars[2] = bar(2, 101.1, 101.2, 99.8, 100.5);
    const a = aggDay(bars, OPEN);
    const f = computeFeatures('2026-01-02', a, 100, 99, 0.5);
    expect(f.gapFilled).toBe(true);
  });

  it('detects an opening-range upside break', () => {
    const bars = gapUpTrendDay();
    const a = aggDay(bars, OPEN, /*orMinutes*/ 30);
    const f = computeFeatures('2026-01-02', a, 100, 99, 0.5);
    expect(f.orBreak).toBe('up'); // close (~104) is above the first-30-min high
  });
});

describe('classify', () => {
  it('labels a gap-up continuation day as gap_go', () => {
    const f = computeFeatures('2026-01-02', aggDay(gapUpTrendDay(), OPEN), 100, 99, 0.5);
    expect(classify(f).primary).toBe('gap_go');
  });

  it('labels a chop day (no gap, low trendiness) as chop or quiet_range', () => {
    // flat oscillation around 100, tiny gap, low realized vol percentile
    const bars: DayBar[] = [];
    for (let m = 0; m < 60; m++) { const up = m % 2 === 0; bars.push(bar(m, 100, 100.3, 99.7, up ? 100.1 : 99.9)); }
    const f = computeFeatures('2026-01-02', aggDay(bars, OPEN), 100, 100, /*rvolPctile*/ 0.2);
    expect(['chop', 'quiet_range']).toContain(classify(f).primary);
  });

  it('labels a gap-up that fully reverses as gap_fade', () => {
    // open 101 (gap +1%), sell off through prevClose, close 99.5 (red body)
    const bars: DayBar[] = [];
    let p = 101;
    for (let m = 0; m < 60; m++) { const n = p - 0.03; bars.push(bar(m, p, p + 0.05, n - 0.05, n)); p = n; }
    const f = computeFeatures('2026-01-02', aggDay(bars, OPEN), 100, 100, 0.5);
    expect(f.gapFilled).toBe(true);
    expect(f.bodyPct).toBeLessThan(0);
    expect(classify(f).primary).toBe('gap_fade');
  });
});
