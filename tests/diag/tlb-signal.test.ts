/**
 * Unit tests for tlb-signal.ts — LuxAlgo "Trendlines with Breaks" detector.
 *
 * The key properties verified here:
 *   - Pivot confirmation uses `length` bars on each side (no look-ahead): a
 *     pivot at bar i is only acted on at bar i+length.
 *   - An upper-trendline break fires when `close` first crosses the projected
 *     descending trendline upward (bull "B"), and likewise a bear "B" for the
 *     lower trendline.
 *   - The detector returns no events on a series with no pivots / no breaks.
 *   - freshBreakOnLast(...) is true only when the LAST bar is the break event.
 */
import { describe, it, expect } from 'vitest';
import { tlbBreaksOnSeries, freshBreakOnLast, type TlbBar } from '../../scripts/diag/tlb-signal';

function bar(ts: number, o: number, h: number, l: number, c: number): TlbBar {
  return { ts, open: o, high: h, low: l, close: c };
}

/**
 * Build a price sequence: monotone decline → pivot low → recovery → break ABOVE
 * the (descending) upper trendline anchored on an earlier pivot high.
 *
 *   bars[0..4]   slow rise to a clean pivot high at bar 4
 *   bars[5..18]  slide down (provides the descending upper trendline)
 *   bars[19..25] base / pivot low region
 *   bars[26..]   rip higher → upward break of the descending upper line
 *
 * length=4 keeps pivot confirmation cheap.
 */
function buildBullBreakSeries(): TlbBar[] {
  const bars: TlbBar[] = [];
  let ts = 1_700_000_000;
  // Rise to a pivot high at index 4 (high=120, isolated).
  const rise = [100, 105, 110, 115, 120];
  for (let i = 0; i < rise.length; i++) {
    const c = rise[i];
    bars.push(bar(ts, c - 1, c + 0.5, c - 1.5, c));
    ts += 60;
  }
  // Decline for 14 bars — provides the descending upper trendline.
  let p = 119;
  for (let i = 0; i < 14; i++) {
    const next = p - 1.0;
    bars.push(bar(ts, p, p + 0.3, next - 0.3, next));
    p = next;
    ts += 60;
  }
  // Base (pivot low region) — flat then small lift.
  for (let i = 0; i < 6; i++) {
    bars.push(bar(ts, p, p + 0.2, p - 0.5, p));
    ts += 60;
  }
  // Rip higher — large up-bars that clearly break the descending upper line.
  for (let i = 0; i < 10; i++) {
    const next = p + 4;
    bars.push(bar(ts, p, next + 0.2, p - 0.2, next));
    p = next;
    ts += 60;
  }
  return bars;
}

function buildBearBreakSeries(): TlbBar[] {
  // Mirror image: rise to a pivot high in the middle, then a sharp drop
  // crashing through the ascending lower trendline.
  const bars: TlbBar[] = [];
  let ts = 1_700_000_000;
  // Slow climb to a clean pivot LOW around index 4 (low=100, isolated).
  const setup = [108, 106, 104, 102, 100];
  for (let i = 0; i < setup.length; i++) {
    const c = setup[i];
    bars.push(bar(ts, c + 1, c + 1.5, c - 0.5, c));
    ts += 60;
  }
  // Rise for 14 bars — ascending lower trendline anchored at the pivot low.
  let p = 101;
  for (let i = 0; i < 14; i++) {
    const next = p + 1.0;
    bars.push(bar(ts, p, next + 0.3, p - 0.3, next));
    p = next;
    ts += 60;
  }
  // Top region.
  for (let i = 0; i < 6; i++) {
    bars.push(bar(ts, p, p + 0.5, p - 0.2, p));
    ts += 60;
  }
  // Crash — big down-bars clearly breaking the ascending lower line.
  for (let i = 0; i < 10; i++) {
    const next = p - 4;
    bars.push(bar(ts, p, p + 0.2, next - 0.2, next));
    p = next;
    ts += 60;
  }
  return bars;
}

describe('tlbBreaksOnSeries', () => {
  it('detects a bull break after a descending trendline is crossed upward', () => {
    const bars = buildBullBreakSeries();
    const evs = tlbBreaksOnSeries(bars, { length: 4, mult: 1.0 });
    const bulls = evs.filter(e => e.dir === 'bull');
    expect(bulls.length).toBeGreaterThan(0);
    // The break must happen during/after the rip phase (well after the pivot
    // high at index 4 and after the decline that builds the trendline).
    const firstBull = bulls[0];
    expect(firstBull.barIdx).toBeGreaterThan(20);
  });

  it('detects a bear break after an ascending trendline is crossed downward', () => {
    const bars = buildBearBreakSeries();
    const evs = tlbBreaksOnSeries(bars, { length: 4, mult: 1.0 });
    const bears = evs.filter(e => e.dir === 'bear');
    expect(bears.length).toBeGreaterThan(0);
    const firstBear = bears[0];
    expect(firstBear.barIdx).toBeGreaterThan(20);
  });

  it('returns no events on a perfectly flat series (no pivots)', () => {
    const bars: TlbBar[] = [];
    let ts = 1_700_000_000;
    for (let i = 0; i < 60; i++) {
      bars.push(bar(ts, 100, 100, 100, 100));
      ts += 60;
    }
    const evs = tlbBreaksOnSeries(bars, { length: 4, mult: 1.0 });
    expect(evs.length).toBe(0);
  });

  it('returns no events when the series is too short to confirm any pivot', () => {
    const bars: TlbBar[] = [];
    let ts = 1_700_000_000;
    for (let i = 0; i < 8; i++) {
      bars.push(bar(ts, 100 + i, 101 + i, 99 + i, 100 + i));
      ts += 60;
    }
    // length=14 needs 2*14+2 = 30 bars before any work happens
    const evs = tlbBreaksOnSeries(bars, { length: 14, mult: 1.0 });
    expect(evs.length).toBe(0);
  });

  it('no look-ahead: events at bar i only depend on bars 0..i', () => {
    // Detecting on the full series, then on a prefix, must agree on every event
    // whose barIdx fits inside the prefix.
    const bars = buildBullBreakSeries();
    const full = tlbBreaksOnSeries(bars, { length: 4, mult: 1.0 });
    if (full.length === 0) return; // skip — series didn't produce a break here
    const firstBreakIdx = full[0].barIdx;
    const prefix = bars.slice(0, firstBreakIdx + 1);
    const prefEvs = tlbBreaksOnSeries(prefix, { length: 4, mult: 1.0 });
    const prefFirst = prefEvs.find(e => e.dir === 'bull');
    expect(prefFirst).toBeDefined();
    expect(prefFirst!.barIdx).toBe(firstBreakIdx);
    expect(prefFirst!.ts).toBe(full[0].ts);
  });
});

describe('freshBreakOnLast', () => {
  it('true exactly when the last bar of the prefix is the bull break', () => {
    const bars = buildBullBreakSeries();
    const full = tlbBreaksOnSeries(bars, { length: 4, mult: 1.0 });
    if (full.length === 0) return;
    const e = full.find(x => x.dir === 'bull');
    if (!e) return;
    const at = bars.slice(0, e.barIdx + 1);
    expect(freshBreakOnLast(at, 'bull', { length: 4, mult: 1.0 })).toBe(true);
    const before = bars.slice(0, e.barIdx);
    expect(freshBreakOnLast(before, 'bull', { length: 4, mult: 1.0 })).toBe(false);
  });

  it('false on a flat series', () => {
    const bars: TlbBar[] = [];
    let ts = 1_700_000_000;
    for (let i = 0; i < 60; i++) {
      bars.push(bar(ts, 100, 100, 100, 100));
      ts += 60;
    }
    expect(freshBreakOnLast(bars, 'bull', { length: 4, mult: 1.0 })).toBe(false);
    expect(freshBreakOnLast(bars, 'bear', { length: 4, mult: 1.0 })).toBe(false);
  });
});
