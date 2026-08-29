/**
 * Unit tests for preentry-range.ts — the "has price already moved?" entry gate.
 *
 * The gate asks: between the session open and the entry slot (e.g. 13:45 ET),
 * how far has the underlying travelled away from a reference price (prior close
 * or session open)? A credit spread is only exposed on ONE side, so the gate has
 * a directional mode:
 *
 *   - 'down-only'  blocks days that already sold off  → guards a PUT credit spread
 *   - 'up-only'    blocks days that already rallied   → guards a CALL credit spread
 *   - 'symmetric'  blocks both (a quiet-day / realized-vol proxy)
 *   - 'none'       no gate (control arm)
 *
 * Excursions are reported as POSITIVE percentages in both directions: upPct is
 * how far above ref price ran, downPct how far below. Never negative — a day
 * that only ever rallied has downPct = 0, not a negative number.
 */
import { describe, it, expect } from 'vitest';
import { preEntryExcursion, passesRangeFilter, type Excursion } from '../../scripts/diag/preentry-range';

/** Minimal bar factory — the study only reads ts/high/low. */
const bar = (ts: number, low: number, high: number) =>
  ({ ts, open: low, high, low, close: high, volume: 0 });

describe('preEntryExcursion', () => {
  const REF = 100;

  it('measures up and down excursion as positive percentages', () => {
    const bars = [bar(10, 99, 101), bar(20, 98, 100.5), bar(30, 99.5, 102)];
    const e = preEntryExcursion(bars, REF, 30)!;
    expect(e.upPct).toBeCloseTo(2.0, 6);   // high 102 → +2%
    expect(e.downPct).toBeCloseTo(2.0, 6); // low 98   → -2% reported as +2
  });

  it('reports 0 for a direction price never travelled', () => {
    const bars = [bar(10, 100, 101), bar(20, 100.5, 103)];
    const e = preEntryExcursion(bars, REF, 20)!;
    expect(e.upPct).toBeCloseTo(3.0, 6);
    expect(e.downPct).toBe(0); // never traded below ref — not negative
  });

  it('ignores bars at or after the cutoff (no look-ahead)', () => {
    // The 15:00 bar is a 5% crash. Entering at 13:45 we must not see it.
    const bars = [bar(1000, 99, 101), bar(2000, 95, 100)];
    const e = preEntryExcursion(bars, REF, 1500)!;
    expect(e.downPct).toBeCloseTo(1.0, 6); // only the first bar counts
    expect(e.upPct).toBeCloseTo(1.0, 6);
  });

  it('includes a bar exactly at the cutoff timestamp', () => {
    const bars = [bar(1000, 97, 100)];
    const e = preEntryExcursion(bars, REF, 1000)!;
    expect(e.downPct).toBeCloseTo(3.0, 6);
  });

  it('returns null when no bars precede the cutoff', () => {
    expect(preEntryExcursion([bar(5000, 90, 110)], REF, 1000)).toBeNull();
  });

  it('returns null for a non-positive reference price', () => {
    expect(preEntryExcursion([bar(10, 99, 101)], 0, 20)).toBeNull();
  });

  it('measures against the supplied ref, not the first bar', () => {
    // Gap-down open: ref = prior close 100, session opens at 98 and stays there.
    const bars = [bar(10, 97.5, 98.2), bar(20, 97.8, 98.5)];
    const e = preEntryExcursion(bars, REF, 20)!;
    expect(e.downPct).toBeCloseTo(2.5, 6); // gap counts against the gate
    expect(e.upPct).toBe(0);
  });
});

describe('passesRangeFilter', () => {
  const quiet: Excursion = { upPct: 0.2, downPct: 0.2 };
  const ranUp: Excursion = { upPct: 0.9, downPct: 0.1 };
  const ranDown: Excursion = { upPct: 0.1, downPct: 0.9 };
  const TH = 0.5;

  it('none admits everything', () => {
    for (const e of [quiet, ranUp, ranDown]) expect(passesRangeFilter(e, TH, 'none')).toBe(true);
  });

  it('symmetric admits only the quiet day', () => {
    expect(passesRangeFilter(quiet, TH, 'symmetric')).toBe(true);
    expect(passesRangeFilter(ranUp, TH, 'symmetric')).toBe(false);
    expect(passesRangeFilter(ranDown, TH, 'symmetric')).toBe(false);
  });

  it('down-only ignores a rally but blocks a selloff (put-spread guard)', () => {
    expect(passesRangeFilter(ranUp, TH, 'down-only')).toBe(true);
    expect(passesRangeFilter(ranDown, TH, 'down-only')).toBe(false);
  });

  it('up-only ignores a selloff but blocks a rally (call-spread guard)', () => {
    expect(passesRangeFilter(ranDown, TH, 'up-only')).toBe(true);
    expect(passesRangeFilter(ranUp, TH, 'up-only')).toBe(false);
  });

  it('is inclusive at the threshold', () => {
    const at: Excursion = { upPct: 0.5, downPct: 0.5 };
    expect(passesRangeFilter(at, 0.5, 'symmetric')).toBe(true);
  });

  it('symmetric is exactly the conjunction of up-only and down-only', () => {
    for (const e of [quiet, ranUp, ranDown, { upPct: 0.6, downPct: 0.6 }]) {
      expect(passesRangeFilter(e, TH, 'symmetric'))
        .toBe(passesRangeFilter(e, TH, 'up-only') && passesRangeFilter(e, TH, 'down-only'));
    }
  });
});
