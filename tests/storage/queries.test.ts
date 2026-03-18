import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { upsertBar, getBars, upsertContract, getContractsByState } from '../../src/storage/queries';
import type { Bar, Contract } from '../../src/types';

const testBar: Bar = {
  symbol: 'SPX', timeframe: '1m', ts: 1700000000,
  open: 5000, high: 5010, low: 4990, close: 5005,
  volume: 100, synthetic: false, gapType: null,
  indicators: { rsi: 55.5 }
};

describe('queries', () => {
  beforeAll(() => initDb(':memory:'));
  afterAll(() => closeDb());

  it('upserts and retrieves a bar', () => {
    upsertBar(testBar);
    const bars = getBars('SPX', '1m', 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(5005);
    expect(bars[0].indicators.rsi).toBe(55.5);
  });

  it('upsert is idempotent (same ts)', () => {
    upsertBar(testBar);
    upsertBar({ ...testBar, close: 5010 });
    const bars = getBars('SPX', '1m', 10);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(5010);
  });

  it('retrieves contracts by state', () => {
    const contract: Contract = {
      symbol: 'SPXW260318C06700000', type: 'call',
      underlying: 'SPX', strike: 6700, expiry: '2026-03-18',
      state: 'ACTIVE', firstSeen: 1700000000, lastBarTs: 1700000000,
      createdAt: 1700000000,
    };
    upsertContract(contract);
    const active = getContractsByState('ACTIVE');
    expect(active.some(c => c.symbol === 'SPXW260318C06700000')).toBe(true);
  });
});
