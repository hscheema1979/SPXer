import { describe, it, expect } from 'vitest';
import { aggregate } from '../../src/pipeline/aggregator';
import type { Bar } from '../../src/types';

function makeBar(ts: number, o: number, h: number, l: number, c: number, vol = 100, synthetic = false): Bar {
  return { symbol: 'SPX', timeframe: '1m', ts, open: o, high: h, low: l, close: c, volume: vol, synthetic, gapType: null, indicators: {} };
}

// 1699999800 is epoch-aligned to a 5-minute boundary (1699999800 % 300 === 0).
// Using epoch-aligned timestamps ensures all 5 consecutive 1m bars fall within
// the same 5m period under the epoch-based bucketing algorithm.
const BASE = 1699999800; // 2023-11-14T22:10:00Z — divisible by 300

describe('aggregator', () => {
  it('aggregates 5 x 1m bars into one 5m bar', () => {
    const bars = [
      makeBar(BASE + 0,   100, 103, 99,  101),
      makeBar(BASE + 60,  101, 104, 100, 102),
      makeBar(BASE + 120, 102, 105, 101, 103),
      makeBar(BASE + 180, 103, 106, 102, 104),
      makeBar(BASE + 240, 104, 107, 103, 105),
    ];
    const [agg] = aggregate(bars, '5m', 300);
    expect(agg.open).toBe(100);
    expect(agg.high).toBe(107);
    expect(agg.low).toBe(99);
    expect(agg.close).toBe(105);
    expect(agg.volume).toBe(500);
    expect(agg.timeframe).toBe('5m');
    expect(agg.synthetic).toBe(false);
  });

  it('marks aggregated bar synthetic if any constituent is synthetic', () => {
    const bars = [
      makeBar(BASE + 0,  100, 103, 99, 101, 100, false),
      makeBar(BASE + 60, 101, 104, 100, 102, 0, true),
    ];
    const [agg] = aggregate(bars.slice(0, 2), '5m', 300);
    expect(agg.synthetic).toBe(true);
  });

  it('puts bars in stable epoch-aligned buckets regardless of input origin', () => {
    // Two calls with different "origins" (different oldest bar) should produce
    // the same bucket timestamps for bars in the same 5m period.
    const barsA = [
      makeBar(BASE + 0,   100, 103, 99, 101),
      makeBar(BASE + 60,  101, 104, 100, 102),
      makeBar(BASE + 120, 102, 105, 101, 103),
    ];
    const barsB = [
      // "origin" starts 60s later — old code produced different bucket ts
      makeBar(BASE + 60,  101, 104, 100, 102),
      makeBar(BASE + 120, 102, 105, 101, 103),
    ];
    const [aggA] = aggregate(barsA, '5m', 300);
    const [aggB] = aggregate(barsB, '5m', 300);
    expect(aggA.ts).toBe(aggB.ts); // bucket timestamp must be identical
    expect(aggA.ts).toBe(BASE);    // and epoch-aligned
  });
});
