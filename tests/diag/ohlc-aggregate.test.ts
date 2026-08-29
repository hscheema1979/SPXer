/**
 * Unit tests for ohlc-aggregate.ts — aggregate 1m bars into higher timeframes
 * for multi-DTE swing signals (2h/4h/daily/weekly).
 *
 * Bucketing rules:
 *   - intraday (2h/4h): buckets anchored to each session's 09:30 ET open, so a
 *     2h bucket = 09:30-11:30, 11:30-13:30, ... (NOT wall-clock 2h boundaries,
 *     which would split the open oddly). Bars from different sessions never
 *     share a bucket.
 *   - daily: one bar per trading date (OHLC of that session).
 *   - weekly: one bar per ISO week (Mon-anchored).
 * Each aggregated bar: open=first, close=last, high=max, low=min, volume=sum,
 * ts = bucket start (open bar's ts).
 */
import { describe, it, expect } from 'vitest';
import { aggregateIntraday, aggregateDaily, aggregateWeekly, type OHLCBar } from '../../scripts/diag/ohlc-aggregate';

// Helper: build a 1m bar at a given unix ts.
function bar(ts: number, o: number, h: number, l: number, c: number, v = 1): OHLCBar {
  return { ts, open: o, high: h, low: l, close: c, volume: v };
}

// 09:30 ET on 2025-05-15 (EDT) = 13:30 UTC.
const OPEN_0515 = Math.floor(new Date('2025-05-15T13:30:00Z').getTime() / 1000);
const OPEN_0516 = Math.floor(new Date('2025-05-16T13:30:00Z').getTime() / 1000);

describe('aggregateIntraday — 2h buckets anchored to 09:30 open', () => {
  it('groups the first two hours into one bar (OHLC + volume)', () => {
    // Bars at 09:30, 10:30, 11:29 (all in first 2h bucket), then 11:30 (next).
    const bars: OHLCBar[] = [
      bar(OPEN_0515, 100, 105, 99, 104, 10),
      bar(OPEN_0515 + 60 * 60, 104, 110, 103, 108, 20),
      bar(OPEN_0515 + 119 * 60, 108, 109, 100, 101, 5),
      bar(OPEN_0515 + 120 * 60, 101, 102, 100, 101, 7), // 11:30 → new bucket
    ];
    const out = aggregateIntraday(bars, 120, OPEN_0515);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ ts: OPEN_0515, open: 100, high: 110, low: 99, close: 101, volume: 35 });
    expect(out[1]).toMatchObject({ open: 101, close: 101, volume: 7 });
  });

  it('does not merge bars from two different sessions into one bucket', () => {
    const bars: OHLCBar[] = [
      bar(OPEN_0515, 100, 100, 100, 100),
      bar(OPEN_0516, 200, 200, 200, 200), // next day, same time-of-day
    ];
    // sessionOpen anchors per the FIRST session; the helper must still split by day.
    const out = aggregateIntraday(bars, 120, OPEN_0515);
    expect(out).toHaveLength(2);
    expect(out[0].open).toBe(100);
    expect(out[1].open).toBe(200);
  });

  it('4h bucket merges the first four hours', () => {
    const bars: OHLCBar[] = [
      bar(OPEN_0515, 100, 100, 100, 100),
      bar(OPEN_0515 + 200 * 60, 110, 115, 90, 95), // 12:50, still in first 4h
    ];
    const out = aggregateIntraday(bars, 240, OPEN_0515);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ open: 100, high: 115, low: 90, close: 95 });
  });
});

describe('aggregateDaily — one bar per trading date', () => {
  it('collapses a full session into a single daily bar', () => {
    const bars: OHLCBar[] = [
      bar(OPEN_0515, 100, 100, 100, 100, 3),
      bar(OPEN_0515 + 60 * 60, 101, 120, 95, 110, 4),
      bar(OPEN_0515 + 6 * 60 * 60, 110, 112, 108, 109, 5), // ~15:30
    ];
    const out = aggregateDaily(bars);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ open: 100, high: 120, low: 95, close: 109, volume: 12 });
  });

  it('produces one bar per date across multiple sessions, in order', () => {
    const bars: OHLCBar[] = [
      bar(OPEN_0515, 100, 100, 100, 100),
      bar(OPEN_0515 + 3600, 100, 105, 100, 103),
      bar(OPEN_0516, 200, 200, 200, 200),
      bar(OPEN_0516 + 3600, 200, 210, 199, 205),
    ];
    const out = aggregateDaily(bars);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(103);
    expect(out[1]).toMatchObject({ open: 200, high: 210, low: 199, close: 205 });
    expect(out[1].ts).toBeGreaterThan(out[0].ts);
  });
});

describe('aggregateWeekly — one bar per ISO week (Mon-anchored)', () => {
  it('groups a Mon-Fri week into one bar', () => {
    // 2025-05-12 is a Monday; 2025-05-16 a Friday — same ISO week.
    const mon = Math.floor(new Date('2025-05-12T13:30:00Z').getTime() / 1000);
    const fri = Math.floor(new Date('2025-05-16T13:30:00Z').getTime() / 1000);
    const bars: OHLCBar[] = [
      bar(mon, 100, 102, 99, 101, 5),
      bar(fri, 101, 130, 90, 120, 6),
    ];
    const out = aggregateWeekly(bars);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ open: 100, high: 130, low: 90, close: 120, volume: 11 });
  });

  it('splits across a week boundary (Fri vs the next Mon)', () => {
    const fri = Math.floor(new Date('2025-05-16T13:30:00Z').getTime() / 1000);     // wk A
    const nextMon = Math.floor(new Date('2025-05-19T13:30:00Z').getTime() / 1000); // wk B
    const bars: OHLCBar[] = [bar(fri, 100, 100, 100, 100), bar(nextMon, 200, 200, 200, 200)];
    const out = aggregateWeekly(bars);
    expect(out).toHaveLength(2);
    expect(out[0].close).toBe(100);
    expect(out[1].open).toBe(200);
  });
});

describe('edge cases', () => {
  it('empty input → empty output', () => {
    expect(aggregateIntraday([], 120, OPEN_0515)).toEqual([]);
    expect(aggregateDaily([])).toEqual([]);
    expect(aggregateWeekly([])).toEqual([]);
  });
  it('single bar → single aggregated bar', () => {
    expect(aggregateDaily([bar(OPEN_0515, 1, 2, 0, 1)])).toHaveLength(1);
  });
});
