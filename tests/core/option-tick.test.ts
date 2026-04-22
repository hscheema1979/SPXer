import { describe, it, expect } from 'vitest';
import { roundToOptionTick, isValidOptionTick } from '../../src/core/option-tick';

describe('roundToOptionTick', () => {
  it('rounds to $0.05 ticks below $3.00', () => {
    expect(roundToOptionTick(0.07)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(0.13)).toBeCloseTo(0.15, 10);
    expect(roundToOptionTick(1.47)).toBeCloseTo(1.45, 10);
    expect(roundToOptionTick(1.48)).toBeCloseTo(1.50, 10);
    expect(roundToOptionTick(2.99)).toBeCloseTo(3.00, 10); // rounds up at boundary
  });

  it('rounds to $0.10 ticks at or above $3.00', () => {
    expect(roundToOptionTick(3.00)).toBeCloseTo(3.00, 10);
    expect(roundToOptionTick(3.04)).toBeCloseTo(3.00, 10);
    expect(roundToOptionTick(3.05)).toBeCloseTo(3.10, 10); // .05 rounds up
    expect(roundToOptionTick(3.06)).toBeCloseTo(3.10, 10);
    expect(roundToOptionTick(9.94)).toBeCloseTo(9.90, 10);
    expect(roundToOptionTick(9.95)).toBeCloseTo(10.00, 10);
  });

  it('enforces minimum tick floor', () => {
    expect(roundToOptionTick(0.00)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(0.01)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(0.02)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(-1.50)).toBeCloseTo(0.05, 10);
  });

  it('handles NaN and Infinity defensively', () => {
    expect(roundToOptionTick(NaN)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(Infinity)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(-Infinity)).toBeCloseTo(0.05, 10);
  });

  it('avoids floating-point drift', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in IEEE 754
    const result = roundToOptionTick(0.1 + 0.2);
    expect(result.toFixed(2)).toBe('0.30');
  });

  it('preserves valid ticks as-is', () => {
    expect(roundToOptionTick(0.05)).toBeCloseTo(0.05, 10);
    expect(roundToOptionTick(1.50)).toBeCloseTo(1.50, 10);
    expect(roundToOptionTick(5.20)).toBeCloseTo(5.20, 10);
  });
});

describe('isValidOptionTick', () => {
  it('identifies valid ticks', () => {
    expect(isValidOptionTick(0.05)).toBe(true);
    expect(isValidOptionTick(1.45)).toBe(true);
    expect(isValidOptionTick(3.00)).toBe(true);
    expect(isValidOptionTick(3.10)).toBe(true);
  });

  it('identifies invalid ticks', () => {
    expect(isValidOptionTick(0.07)).toBe(false);
    expect(isValidOptionTick(3.04)).toBe(false);
    expect(isValidOptionTick(3.05)).toBe(false); // $0.05 invalid above $3
  });

  it('rejects non-positive / non-finite input', () => {
    expect(isValidOptionTick(0)).toBe(false);
    expect(isValidOptionTick(-1)).toBe(false);
    expect(isValidOptionTick(NaN)).toBe(false);
  });
});
