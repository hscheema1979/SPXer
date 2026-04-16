import { describe, it, expect } from 'vitest';
import { computeIndicators, seedState } from '../../src/pipeline/indicator-engine';
import type { Bar } from '../../src/types';

function makeBar(ts: number, close: number): Bar {
  return { symbol: 'SPX', timeframe: '1m', ts, open: close, high: close+1, low: close-1, close, volume: 1000, synthetic: false, gapType: null, indicators: {} };
}

describe('indicator-engine', () => {
  it('returns tier1 indicators after 30 bars', () => {
    const bars = Array.from({ length: 30 }, (_, i) => makeBar(1700000000 + i * 60, 5000 + i));
    for (const bar of bars.slice(0, -1)) computeIndicators(bar, 1);
    const ind = computeIndicators(bars[bars.length - 1], 1);
    expect(ind.ema9).not.toBeNull();
    expect(ind.vwap).not.toBeNull();
  });
});
