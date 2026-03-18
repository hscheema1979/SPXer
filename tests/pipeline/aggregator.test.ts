import { describe, it, expect } from 'vitest';
import { aggregate } from '../../src/pipeline/aggregator';
import type { Bar } from '../../src/types';

function makeBar(ts: number, o: number, h: number, l: number, c: number, vol = 100, synthetic = false): Bar {
  return { symbol: 'SPX', timeframe: '1m', ts, open: o, high: h, low: l, close: c, volume: vol, synthetic, gapType: null, indicators: {} };
}

describe('aggregator', () => {
  it('aggregates 5 x 1m bars into one 5m bar', () => {
    const bars = [
      makeBar(1700000000, 100, 103, 99,  101),
      makeBar(1700000060, 101, 104, 100, 102),
      makeBar(1700000120, 102, 105, 101, 103),
      makeBar(1700000180, 103, 106, 102, 104),
      makeBar(1700000240, 104, 107, 103, 105),
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
      makeBar(1700000000, 100, 103, 99, 101, 100, false),
      makeBar(1700000060, 101, 104, 100, 102, 0, true),
    ];
    const [agg] = aggregate(bars.slice(0, 2), '5m', 300);
    expect(agg.synthetic).toBe(true);
  });
});
