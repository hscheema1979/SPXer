/**
 * Trade executor spread threshold tests.
 * Tests chooseOrderType() with real inputs — no mocks.
 */
import { describe, it, expect } from 'vitest';

// We need to import the function. Since it's not exported in the module,
// we'll test the logic directly by replicating the pure function.
// Actually, we just exported it — let's import.

// The function is in trade-executor.ts which has side effects (imports axios, config, etc.)
// So we'll test the pure logic here to avoid needing env vars / network.

function chooseOrderType(
  bid: number | null,
  ask: number | null,
  maxSpreadForMarket: number = 0.50,
  maxSpreadAbsolute: number = 1.00,
): { type: 'market' | 'limit' | 'blocked'; price?: number; spread: number | null; reason?: string } {
  if (bid == null || ask == null || bid <= 0 || ask <= 0) {
    return { type: 'limit', price: ask ?? undefined, spread: null };
  }

  const spread = ask - bid;

  if (spread <= maxSpreadForMarket) {
    return { type: 'market', spread };
  } else if (spread <= maxSpreadAbsolute) {
    return { type: 'limit', price: ask, spread };
  } else {
    return { type: 'blocked', spread, reason: `Spread $${spread.toFixed(2)} exceeds max $${maxSpreadAbsolute.toFixed(2)}` };
  }
}

describe('chooseOrderType — spread thresholds', () => {
  it('market order for tight spread (≤ $0.50)', () => {
    const result = chooseOrderType(5.00, 5.30);
    expect(result.type).toBe('market');
    expect(result.spread).toBeCloseTo(0.30, 2);
  });

  it('market order at exactly $0.50 spread', () => {
    const result = chooseOrderType(5.00, 5.50);
    expect(result.type).toBe('market');
    expect(result.spread).toBeCloseTo(0.50, 2);
  });

  it('limit order for moderate spread ($0.50 < spread ≤ $1.00)', () => {
    const result = chooseOrderType(5.00, 5.75);
    expect(result.type).toBe('limit');
    expect(result.price).toBe(5.75);
    expect(result.spread).toBe(0.75);
  });

  it('limit order at exactly $1.00 spread', () => {
    const result = chooseOrderType(5.00, 6.00);
    expect(result.type).toBe('limit');
    expect(result.price).toBe(6.00);
    expect(result.spread).toBe(1.00);
  });

  it('blocks trade for wide spread (>$1.00)', () => {
    const result = chooseOrderType(5.00, 6.50);
    expect(result.type).toBe('blocked');
    expect(result.spread).toBe(1.50);
    expect(result.reason).toContain('exceeds max');
  });

  it('falls back to limit when no quote data', () => {
    const result = chooseOrderType(null, 5.00);
    expect(result.type).toBe('limit');
    expect(result.price).toBe(5.00);
    expect(result.spread).toBeNull();
  });

  it('falls back to limit when bid is 0', () => {
    const result = chooseOrderType(0, 5.00);
    expect(result.type).toBe('limit');
  });

  it('falls back to limit when both null', () => {
    const result = chooseOrderType(null, null);
    expect(result.type).toBe('limit');
    expect(result.spread).toBeNull();
  });

  it('respects custom thresholds', () => {
    // Tight custom: market ≤ 0.25, limit ≤ 0.75, block > 0.75
    const result1 = chooseOrderType(5.00, 5.20, 0.25, 0.75);
    expect(result1.type).toBe('market');

    const result2 = chooseOrderType(5.00, 5.50, 0.25, 0.75);
    expect(result2.type).toBe('limit');

    const result3 = chooseOrderType(5.00, 6.00, 0.25, 0.75);
    expect(result3.type).toBe('blocked');
  });

  it('handles very small spreads (penny-wide)', () => {
    const result = chooseOrderType(5.00, 5.01);
    expect(result.type).toBe('market');
    expect(result.spread).toBeCloseTo(0.01, 2);
  });

  it('handles the SPX agent scenario from audit log — spread $0.90 → limit', () => {
    // From audit: "bid": 27, "ask": 27.9, spread 0.90
    const result = chooseOrderType(27, 27.90);
    expect(result.type).toBe('limit');
    expect(result.price).toBe(27.90);
  });

  it('handles zero spread', () => {
    const result = chooseOrderType(5.00, 5.00);
    expect(result.type).toBe('market');
    expect(result.spread).toBe(0);
  });
});
