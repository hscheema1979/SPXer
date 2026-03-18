import { describe, it, expect } from 'vitest';
import { computeMACD, computeStochastic, computeADX } from '../../../src/pipeline/indicators/tier2';

describe('tier2 indicators', () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5 + Math.sin(i) * 3);
  const highs = closes.map(c => c + 1.5);
  const lows = closes.map(c => c - 1.5);

  it('MACD returns finite values', () => {
    let fast: number | null = null, slow: number | null = null, signal: number | null = null;
    for (const c of closes) {
      const result = computeMACD(c, fast, slow, signal);
      fast = result.fastEma; slow = result.slowEma; signal = result.signalEma;
    }
    expect(fast).not.toBeNull();
    expect(isFinite(fast!)).toBe(true);
  });

  it('Stochastic %K is between 0 and 100', () => {
    const k = computeStochastic(highs, lows, closes, 14, 3);
    expect(k).not.toBeNull();
    expect(k!.k).toBeGreaterThanOrEqual(0);
    expect(k!.k).toBeLessThanOrEqual(100);
  });

  it('ADX is positive', () => {
    const adx = computeADX(highs, lows, closes, 14);
    expect(adx).not.toBeNull();
    expect(adx!).toBeGreaterThan(0);
  });
});
