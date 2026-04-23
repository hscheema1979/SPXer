import { describe, it, expect } from 'vitest';
import {
  frictionEntry, frictionCommission, computeRealisticPnl,
  frictionTpExit, frictionSlExit, frictionMarketExit,
} from '../../src/core/friction';

describe('friction', () => {
  it('adjusts entry price up by half-spread', () => {
    expect(frictionEntry(1.00)).toBeCloseTo(1.05);
    expect(frictionEntry(3.50)).toBeCloseTo(3.55);
  });

  it('adjusts exit price down by half-spread', () => {
    expect(frictionMarketExit(1.00)).toBeCloseTo(0.95);
    expect(frictionMarketExit(3.50)).toBeCloseTo(3.45);
  });

  it('exit price floors at $0.01', () => {
    expect(frictionMarketExit(0.03)).toBeCloseTo(0.01);
    expect(frictionMarketExit(0.01)).toBeCloseTo(0.01);
  });

  it('computes round-trip commission', () => {
    // $0.35/contract × 2 sides
    expect(frictionCommission(1)).toBeCloseTo(0.70);
    expect(frictionCommission(3)).toBeCloseTo(2.10);
    expect(frictionCommission(10)).toBeCloseTo(7.00);
  });

  it('computes realistic P&L for a winning trade', () => {
    // Buy at $1.00 mid → eff entry $1.05, sell at $2.00 mid → eff exit $1.95
    // P&L = (1.95 - 1.05) * 3 * 100 - 2.10 = $267.90
    const result = computeRealisticPnl(1.00, 2.00, 3);
    expect(result.effectiveEntry).toBeCloseTo(1.05);
    expect(result.effectiveExit).toBeCloseTo(1.95);
    expect(result['pnl$']).toBeCloseTo(267.90);
    expect(result.pnlPct).toBeCloseTo(85.71, 1); // (1.95-1.05)/1.05 * 100
  });

  it('computes realistic P&L for a losing trade', () => {
    // Buy at $0.92 mid → eff entry $0.97, sell at $0.65 mid → eff exit $0.60
    // P&L = (0.60 - 0.97) * 3 * 100 - 2.10 = -$113.10
    const result = computeRealisticPnl(0.92, 0.65, 3);
    expect(result.effectiveEntry).toBeCloseTo(0.97);
    expect(result.effectiveExit).toBeCloseTo(0.60);
    expect(result['pnl$']).toBeCloseTo(-113.10);
    expect(result.pnlPct).toBeLessThan(0);
  });

  it('friction makes winning trades smaller and losing trades bigger', () => {
    // Raw: (2.00 - 1.00) * 3 * 100 = $300
    // Friction: $267.90 — winner shrinks by ~$32
    const win = computeRealisticPnl(1.00, 2.00, 3);
    expect(win['pnl$']).toBeLessThan(300);

    // Raw: (0.65 - 0.92) * 3 * 100 = -$81
    // Friction: -$113.10 — loser grows by ~$32
    const loss = computeRealisticPnl(0.92, 0.65, 3);
    expect(loss['pnl$']).toBeLessThan(-81);
  });
});

describe('typed exit friction (Task 2.1)', () => {
  it('frictionTpExit preserves the limit price (no half-spread)', () => {
    expect(frictionTpExit(2.00)).toBeCloseTo(2.00);
    expect(frictionTpExit(5.00)).toBeCloseTo(5.00);
  });

  it('frictionSlExit subtracts full half-spread', () => {
    expect(frictionSlExit(2.00)).toBeCloseTo(1.95);
    expect(frictionSlExit(5.00)).toBeCloseTo(4.95);
  });

  it('frictionMarketExit subtracts full half-spread', () => {
    expect(frictionMarketExit(2.00)).toBeCloseTo(1.95);
  });

  it('TP exit yields better P&L than market exit at same price', () => {
    const tpResult = computeRealisticPnl(1.00, 2.00, 3, 'tp');
    const marketResult = computeRealisticPnl(1.00, 2.00, 3, 'market');
    // TP saves half-spread on exit: $0.05 * 3 contracts * 100 = $15 more
    expect(tpResult['pnl$']).toBeGreaterThan(marketResult['pnl$']);
    expect(tpResult['pnl$'] - marketResult['pnl$']).toBeCloseTo(15, 1);
  });

  it('SL exit matches market exit (both pay full half-spread)', () => {
    const slResult = computeRealisticPnl(1.00, 0.80, 3, 'sl');
    const marketResult = computeRealisticPnl(1.00, 0.80, 3, 'market');
    expect(slResult['pnl$']).toBeCloseTo(marketResult['pnl$']);
  });

  it('default exitKind is market (backwards compat)', () => {
    const defaulted = computeRealisticPnl(1.00, 2.00, 3);
    const explicit = computeRealisticPnl(1.00, 2.00, 3, 'market');
    expect(defaulted['pnl$']).toBeCloseTo(explicit['pnl$']);
  });
});
