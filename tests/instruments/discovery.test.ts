/**
 * Tests for discovery — focus on the pure inference helpers exposed via
 * `_internal`. The main `discoverProfile()` pipeline hits Polygon HTTP, so
 * we don't exercise it here (covered by the integration smoke in Phase 5).
 */
import { describe, it, expect } from 'vitest';
import { _internal, DiscoveryError } from '../../src/instruments/discovery';

const { inferStrikeInterval, inferExpiryCadences, computeBandHalfWidth } = _internal;

describe('discovery._internal.inferStrikeInterval', () => {
  it('returns 5 with a single strike (can\'t compute a diff)', () => {
    expect(inferStrikeInterval([5500])).toEqual({ interval: 5, sampleCount: 1 });
  });

  it('detects $5 index interval on SPX-like strikes', () => {
    const strikes = [5490, 5495, 5500, 5505, 5510];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 5, sampleCount: 5 });
  });

  it('detects $1 interval on equity-like strikes', () => {
    const strikes = [150, 151, 152, 153, 154];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 1, sampleCount: 5 });
  });

  it('detects $2.5 interval', () => {
    const strikes = [100, 102.5, 105, 107.5, 110];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 2.5, sampleCount: 5 });
  });

  it('detects $0.5 interval from cent-drift-prone floats', () => {
    const strikes = [100.0, 100.5, 101.0, 101.5, 102.0];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 0.5, sampleCount: 5 });
  });

  it('returns the GCD when the list mixes intervals (e.g. $5 and $10)', () => {
    const strikes = [100, 105, 110, 120, 130];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 5, sampleCount: 5 });
  });

  it('deduplicates repeated strikes before computing', () => {
    const strikes = [100, 100, 105, 105, 110];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 5, sampleCount: 3 });
  });

  it('ignores unsorted input', () => {
    const strikes = [110, 100, 105];
    expect(inferStrikeInterval(strikes)).toEqual({ interval: 5, sampleCount: 3 });
  });
});

describe('discovery._internal.computeBandHalfWidth', () => {
  it('equity always gets $10 flat regardless of avg range', () => {
    expect(computeBandHalfWidth('equity', null)).toBe(10);
    expect(computeBandHalfWidth('equity', 5)).toBe(10);
    expect(computeBandHalfWidth('equity', 999)).toBe(10);
  });

  it('etf always gets $10 flat', () => {
    expect(computeBandHalfWidth('etf', 2.5)).toBe(10);
  });

  it('index with null avgRange falls back to $100', () => {
    expect(computeBandHalfWidth('index', null)).toBe(100);
  });

  it('index avg $50 range → 50*1.5=75, rounded to nearest $5 = $75', () => {
    expect(computeBandHalfWidth('index', 50)).toBe(75);
  });

  it('index avg $67 range → 67*1.5=100.5 → rounded = $100', () => {
    expect(computeBandHalfWidth('index', 67)).toBe(100);
  });

  it('index with tiny avg range is clamped to $50 floor', () => {
    // 5 * 1.5 = 7.5 → rounds to 5 → clamped to 50
    expect(computeBandHalfWidth('index', 5)).toBe(50);
  });

  it('index with huge avg range is clamped to $500 ceiling', () => {
    // 1000 * 1.5 = 1500 → clamped to 500
    expect(computeBandHalfWidth('index', 1000)).toBe(500);
  });

  it('index avg range rounds to nearest $5 (not $1)', () => {
    // 23 * 1.5 = 34.5 → rounds to 35 → clamped up to 50 floor
    expect(computeBandHalfWidth('index', 23)).toBe(50);
    // 80 * 1.5 = 120 → stays 120
    expect(computeBandHalfWidth('index', 80)).toBe(120);
  });
});

describe('discovery._internal.inferExpiryCadences', () => {
  // Helpers to build ISO date strings relative to today (so tests don't rot).
  function isoPlusBdays(n: number): string {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    let added = 0;
    while (added < n) {
      d.setUTCDate(d.getUTCDate() + 1);
      const dow = d.getUTCDay();
      if (dow !== 0 && dow !== 6) added++;
    }
    return d.toISOString().slice(0, 10);
  }

  it('empty expirations list defaults to ["weekly"]', () => {
    expect(inferExpiryCadences([])).toEqual(['weekly']);
  });

  it('detects daily when the next 5 business days are all present', () => {
    const dates = [1, 2, 3, 4, 5].map(isoPlusBdays);
    const cadences = inferExpiryCadences(dates);
    expect(cadences).toContain('daily');
  });

  it('detects weekly when at least one Friday is in the window but not daily', () => {
    // Far-future Friday only.
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 14);
    while (future.getUTCDay() !== 5) future.setUTCDate(future.getUTCDate() + 1);
    const onlyFriday = [future.toISOString().slice(0, 10)];
    const cadences = inferExpiryCadences(onlyFriday);
    expect(cadences).toContain('weekly');
    expect(cadences).not.toContain('daily');
  });

  it('detects monthly when a third-Friday expiry is in the list', () => {
    // Find the 3rd Friday of next month.
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    // advance to first Friday
    while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1);
    // jump to 3rd Friday
    d.setUTCDate(d.getUTCDate() + 14);
    const thirdFriday = d.toISOString().slice(0, 10);
    const cadences = inferExpiryCadences([thirdFriday]);
    expect(cadences).toContain('monthly');
  });

  it('filters out past-only expirations', () => {
    // Only a date from ~5 years ago → treated as empty-future → fallback to weekly.
    expect(inferExpiryCadences(['2020-01-17'])).toEqual(['weekly']);
  });
});

describe('DiscoveryError', () => {
  it('carries a code field and subclasses Error', () => {
    const err = new DiscoveryError('nope', 'NOT_FOUND');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('DiscoveryError');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.message).toBe('nope');
  });
});
