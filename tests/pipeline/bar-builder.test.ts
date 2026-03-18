import { describe, it, expect } from 'vitest';
import { buildBars, interpolateGap } from '../../src/pipeline/bar-builder';
import type { OHLCVRaw } from '../../src/types';

describe('bar-builder', () => {
  it('converts raw OHLCV to Bar format', () => {
    const raw: OHLCVRaw = { ts: 1700000000, open: 100, high: 101, low: 99, close: 100.5, volume: 500 };
    const [bar] = buildBars('SPX', '1m', [raw]);
    expect(bar.symbol).toBe('SPX');
    expect(bar.synthetic).toBe(false);
    expect(bar.gapType).toBeNull();
    expect(bar.close).toBe(100.5);
  });

  it('interpolates a 3-minute gap linearly', () => {
    const filled = interpolateGap(1700000000, 100, 1700000240, 104, 60);
    expect(filled).toHaveLength(3);
    expect(filled[0].close).toBeCloseTo(101, 4);
    expect(filled[1].close).toBeCloseTo(102, 4);
    expect(filled[2].close).toBeCloseTo(103, 4);
    expect(filled[0].synthetic).toBe(true);
    expect(filled[0].gapType).toBe('interpolated');
    expect(filled[0].volume).toBe(0);
  });

  it('uses flat/stale fill for gaps over 60 minutes', () => {
    const filled = interpolateGap(1700000000, 100, 1700007200, 110, 60);
    expect(filled.length).toBeGreaterThan(0);
    expect(filled[0].gapType).toBe('stale');
    filled.forEach(b => expect(b.close).toBe(100));
  });
});
