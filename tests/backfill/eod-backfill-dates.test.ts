/**
 * eod-backfill's date roster must be holiday-aware. Before 2026-09-10 it
 * skipped weekends only, so the nightly cron asked Polygon for a holiday, got
 * a soft "no underlying — skip" and still reported Done (docs/DATA-STORES.md).
 */
import { describe, it, expect } from 'vitest';
import { tradingDays } from '../../scripts/backfill/eod-backfill';
import { expiryForDate } from '../../scripts/backfill/backfill-replay-options';

describe('eod-backfill tradingDays', () => {
  it('drops weekends', () => {
    // Fri 2026-09-11 → Mon 2026-09-14
    expect(tradingDays('2026-09-11', '2026-09-14')).toEqual(['2026-09-11', '2026-09-14']);
  });

  it('drops market holidays from the configured set (Labor Day 2026 = Mon 09-07)', () => {
    expect(tradingDays('2026-09-04', '2026-09-08')).toEqual(['2026-09-04', '2026-09-08']);
  });

  it('keeps Mon 2026-08-31 — the date the config previously mislabelled as Labor Day', () => {
    expect(tradingDays('2026-08-31', '2026-08-31')).toEqual(['2026-08-31']);
  });

  it('returns [] for a range that is only weekend/holiday (caller treats as SKIP, not failure)', () => {
    expect(tradingDays('2026-09-07', '2026-09-07')).toEqual([]);
    expect(tradingDays('2026-09-12', '2026-09-13')).toEqual([]);
  });

  it('honours an injected holiday set', () => {
    expect(tradingDays('2026-09-10', '2026-09-10', new Set(['2026-09-10']))).toEqual([]);
    expect(tradingDays('2026-09-10', '2026-09-10', new Set())).toEqual(['2026-09-10']);
  });
});

describe('backfill expiryForDate — holiday-aware', () => {
  it('0DTE expires on the trade date', () => {
    expect(expiryForDate('2026-09-04', 0)).toBe('2026-09-04');
  });
  it('1DTE on Fri 2026-09-04 is Tue 09-08 (Mon 09-07 is Labor Day)', () => {
    expect(expiryForDate('2026-09-04', 1)).toBe('2026-09-08');
  });
  it('1DTE on Thu 2026-07-02 is Mon 07-06 (Fri 07-03 observed holiday)', () => {
    expect(expiryForDate('2026-07-02', 1)).toBe('2026-07-06');
  });
  it('honours an injected holiday set (third argument is not ignored)', () => {
    expect(expiryForDate('2026-09-10', 1, new Set(['2026-09-11']))).toBe('2026-09-14');
  });
});
