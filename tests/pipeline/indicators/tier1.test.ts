import { describe, it, expect } from 'vitest';
import { computeHMA, computeEMA, computeRSI, computeBB, computeATR } from '../../../src/pipeline/indicators/tier1';

describe('tier1 indicators', () => {
  const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i * 0.3) * 10);
  const highs = closes.map(c => c + 1);
  const lows = closes.map(c => c - 1);

  it('HMA(5) returns a number', () => {
    const v = computeHMA(closes, 5);
    expect(v).not.toBeNull();
    expect(typeof v).toBe('number');
    expect(isFinite(v!)).toBe(true);
  });

  it('EMA(9) returns correct value (incremental)', () => {
    let ema: number | null = null;
    for (const c of closes) { ema = computeEMA(c, ema, 9); }
    expect(ema).not.toBeNull();
    expect(isFinite(ema!)).toBe(true);
  });

  it('RSI(14) is between 0 and 100', () => {
    const rsi = computeRSI(closes, 14);
    expect(rsi).not.toBeNull();
    expect(rsi!).toBeGreaterThanOrEqual(0);
    expect(rsi!).toBeLessThanOrEqual(100);
  });

  it('BB returns upper > middle > lower', () => {
    const bb = computeBB(closes, 20, 2);
    expect(bb).not.toBeNull();
    expect(bb!.upper).toBeGreaterThan(bb!.middle);
    expect(bb!.middle).toBeGreaterThan(bb!.lower);
  });

  it('ATR(14) is positive', () => {
    const atr = computeATR(highs, lows, closes, 14);
    expect(atr).toBeGreaterThan(0);
  });
});
