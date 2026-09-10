/**
 * Promotion is where a backtest becomes real money, and two fields change units
 * on the way. These pin both, because a wrong conversion here is not a failed
 * test — it is a live position at the wrong strike.
 */
import { describe, it, expect } from 'vitest';
import { defaultSpec, specToLiveConfig, type BacktestSpec } from '../../scripts/backtest-lab/contract.ts';

function longSpec(over: (s: any) => void): BacktestSpec {
  const s: any = defaultSpec('long-option');
  s.name = 'promote test';
  s.underlying = { symbol: 'SPX', dte: 0 };
  s.entry = { ...s.entry, indicator: 'dema', fast: 3, slow: 9, timeframe: '1m', windowET: { start: '09:45', end: '15:45' } };
  s.structure = { kind: 'long-option', offset: -2 };
  s.exit = { ...s.exit, tp: { kind: 'priceMult', value: 1.5 }, sl: { kind: 'priceMult', value: 0.95 } };
  over(s);
  return s as BacktestSpec;
}

describe('specToLiveConfig — strike offset changes units', () => {
  it('SPX: -2 strikes becomes -$10, not -2', () => {
    const c: any = specToLiveConfig(longSpec(() => {}), { dollarsPerTrade: 2000 });
    expect(c.contract.symbol).toBe('SPX');
    expect(c.contract.strikeInterval).toBe(5);
    expect(c.contract.strikeOffset).toBe(-10);
    expect(c.contract.optionPrefix).toBe('SPXW');
    expect(c.contract.signalSymbol).toBeUndefined();   // SPX signals off itself
    expect(c.contract.strikeDivisor).toBeUndefined();
  });

  it('XSP: -2 strikes becomes -$2 on a $1 grid, with the SPX signal + divisor', () => {
    const c: any = specToLiveConfig(longSpec(s => { s.underlying = { symbol: 'XSP', dte: 0 } }), { dollarsPerTrade: 2000 });
    expect(c.contract.strikeInterval).toBe(1);
    expect(c.contract.strikeOffset).toBe(-2);
    expect(c.contract.signalSymbol).toBe('SPX');
    expect(c.contract.strikeDivisor).toBe(10);
  });

  it('ATM stays 0 whatever the grid', () => {
    for (const symbol of ['SPX', 'XSP', 'NDX']) {
      const c: any = specToLiveConfig(longSpec(s => { s.underlying = { symbol, dte: 0 }; s.structure = { kind: 'long-option', offset: 0 } }), { dollarsPerTrade: 1000 });
      expect(c.contract.strikeOffset).toBe(0);
    }
  });
});

describe('specToLiveConfig — TP/SL pass through as multipliers', () => {
  it('priceMult goes straight across', () => {
    const c: any = specToLiveConfig(longSpec(s => { s.exit.tp = { kind: 'priceMult', value: 4 } }), { dollarsPerTrade: 1000 });
    expect(c.risk.takeProfitMultiplier).toBe(4);
    expect(c.risk.stopLossMultiplier).toBe(0.95);
  });

  it('legacy pricePct converts to the same multipliers', () => {
    const a: any = specToLiveConfig(longSpec(s => { s.exit.tp = { kind: 'priceMult', value: 4 }; s.exit.sl = { kind: 'priceMult', value: 0.95 } }), { dollarsPerTrade: 1000 });
    const b: any = specToLiveConfig(longSpec(s => { s.exit.tp = { kind: 'pricePct', value: 300 }; s.exit.sl = { kind: 'pricePct', value: 5 } }), { dollarsPerTrade: 1000 });
    expect(b.risk.takeProfitMultiplier).toBeCloseTo(a.risk.takeProfitMultiplier, 10);
    expect(b.risk.stopLossMultiplier).toBeCloseTo(a.risk.stopLossMultiplier, 10);
  });
});

describe('specToLiveConfig — safety', () => {
  it('is created paused by default', () => {
    const c: any = specToLiveConfig(longSpec(() => {}), { dollarsPerTrade: 1000 });
    expect(c.disabled).toBe(true);           // the tick loop skips on disabled === true
  });

  it('carries the reversal exit, which is where this strategy makes its money', () => {
    const c: any = specToLiveConfig(longSpec(() => {}), { dollarsPerTrade: 1000 });
    expect(c.risk.useFlip).toBe(true);
  });

  it('sizes in dollars, not contracts', () => {
    const c: any = specToLiveConfig(longSpec(() => {}), { dollarsPerTrade: 2500 });
    expect(c.sizing).toEqual({ type: 'dollars', value: 2500 });
  });

  it('refuses spec types the live engine cannot run', () => {
    expect(() => specToLiveConfig(defaultSpec('shares'), { dollarsPerTrade: 1000 })).toThrow(/long-option/);
    expect(() => specToLiveConfig(defaultSpec('option-sweep'), { dollarsPerTrade: 1000 })).toThrow(/long-option/);
  });

  it('window and signal survive intact', () => {
    const c: any = specToLiveConfig(longSpec(() => {}), { dollarsPerTrade: 1000 });
    expect(c.active).toEqual({ start: '09:45', end: '15:45', timezone: 'America/New_York' });
    expect(c.signal).toMatchObject({ maType: 'dema', hmaFast: 3, hmaSlow: 9, timeframes: ['1m'] });
  });
});
