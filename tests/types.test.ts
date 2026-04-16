import { describe, it, expect } from 'vitest';
import type { Bar, Contract, ContractState, Timeframe } from '../src/types';

describe('types', () => {
  it('Bar has required fields', () => {
    const bar: Bar = {
      symbol: 'SPX', timeframe: '1m', ts: 1700000000,
      open: 100, high: 101, low: 99, close: 100.5,
      volume: 0, synthetic: false, gapType: null, indicators: {}
    };
    expect(bar.symbol).toBe('SPX');
  });

  it('ContractState enum has expected values', () => {
    const state: ContractState = 'ACTIVE';
    expect(['UNSEEN','ACTIVE','STICKY','EXPIRED']).toContain(state);
  });
});
