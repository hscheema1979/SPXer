/**
 * Unit tests for sweep-dates.ts — trading-day math for multi-DTE carry.
 *
 * DTE is counted in TRADING days (skips weekends + market holidays). The key
 * correctness property: a multi-day position's expiry must land on a real
 * trading session, otherwise the sweep fetches a missing/empty S3 day-file.
 */
import { describe, it, expect } from 'vitest';
import { tradingDaysBetween, expiryForDate } from '../../scripts/diag/sweep-dates';

// A small injected holiday set so tests don't depend on the full MARKET_HOLIDAYS
// staying fixed. 2026-01-19 is MLK Day (a Monday) in the real set too.
const HOLIDAYS = new Set(['2026-01-19']);

describe('tradingDaysBetween', () => {
  it('includes both endpoints when they are weekdays', () => {
    // Mon 2026-01-05 .. Wed 2026-01-07
    expect(tradingDaysBetween('2026-01-05', '2026-01-07', new Set())).toEqual([
      '2026-01-05', '2026-01-06', '2026-01-07',
    ]);
  });

  it('skips the weekend between two weeks', () => {
    // Fri 2026-01-09 .. Mon 2026-01-12 → drops Sat 10 + Sun 11
    expect(tradingDaysBetween('2026-01-09', '2026-01-12', new Set())).toEqual([
      '2026-01-09', '2026-01-12',
    ]);
  });

  it('skips a market holiday inside the range', () => {
    // Fri 2026-01-16 .. Tue 2026-01-20, with Mon 19 a holiday
    expect(tradingDaysBetween('2026-01-16', '2026-01-20', HOLIDAYS)).toEqual([
      '2026-01-16', '2026-01-20', // Sat 17, Sun 18, Mon 19 (holiday) all dropped
    ]);
  });

  it('returns [] when end is before start', () => {
    expect(tradingDaysBetween('2026-01-07', '2026-01-05', new Set())).toEqual([]);
  });

  it('returns a single day when start === end and it is a trading day', () => {
    expect(tradingDaysBetween('2026-01-05', '2026-01-05', new Set())).toEqual(['2026-01-05']);
  });

  it('returns [] when start === end but that day is a weekend', () => {
    expect(tradingDaysBetween('2026-01-10', '2026-01-10', new Set())).toEqual([]); // Saturday
  });
});

describe('expiryForDate', () => {
  it('dte=0 returns the entry day itself', () => {
    expect(expiryForDate('2026-01-05', 0, new Set())).toBe('2026-01-05');
  });

  it('dte=1 from a Monday is the next day (Tuesday)', () => {
    expect(expiryForDate('2026-01-05', 1, new Set())).toBe('2026-01-06');
  });

  it('dte=1 from a Friday rolls over the weekend to Monday', () => {
    // Fri 2026-01-09 + 1 trading day → Mon 2026-01-12
    expect(expiryForDate('2026-01-09', 1, new Set())).toBe('2026-01-12');
  });

  it('dte=5 from a Monday is the following Monday (5 sessions)', () => {
    // Mon 01-05 → Tue 06, Wed 07, Thu 08, Fri 09, Mon 12
    expect(expiryForDate('2026-01-05', 5, new Set())).toBe('2026-01-12');
  });

  it('counts trading days, skipping a holiday', () => {
    // Fri 2026-01-16 + 1 trading day, with Mon 19 a holiday → Tue 20
    expect(expiryForDate('2026-01-16', 1, HOLIDAYS)).toBe('2026-01-20');
  });

  it('a 5DTE spanning the MLK holiday week lands on a real session', () => {
    // Tue 2026-01-13 + 5 trading days, Mon 19 holiday:
    //   Wed 14, Thu 15, Fri 16, (Sat/Sun), (Mon 19 holiday), Tue 20, Wed 21
    expect(expiryForDate('2026-01-13', 5, HOLIDAYS)).toBe('2026-01-21');
  });

  it('matches tradingDaysBetween length: dte+1 sessions inclusive', () => {
    const entry = '2026-01-05';
    const exp = expiryForDate(entry, 5, new Set());
    const span = tradingDaysBetween(entry, exp, new Set());
    expect(span.length).toBe(6); // entry + 5 carried sessions
    expect(span[0]).toBe(entry);
    expect(span[span.length - 1]).toBe(exp);
  });
});
