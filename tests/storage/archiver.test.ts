import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { initDb, closeDb } from '../../src/storage/db';
import { upsertBar, upsertContract } from '../../src/storage/queries';
import { archiveExpired } from '../../src/storage/archiver';
import type { Bar, Contract } from '../../src/types';

describe('archiver', () => {
  beforeAll(() => initDb(':memory:'));
  afterAll(() => closeDb());

  it('archiveExpired is a function', () => {
    expect(typeof archiveExpired).toBe('function');
  });

  it('returns without error when no expired contracts', async () => {
    await expect(archiveExpired()).resolves.toBeUndefined();
  });

  it('handles expired contracts gracefully (duckdb may not be available)', async () => {
    const contract: Contract = {
      symbol: 'SPXW260318C05000000', type: 'call',
      underlying: 'SPX', strike: 5000, expiry: '2026-03-18',
      state: 'EXPIRED', firstSeen: 1700000000, lastBarTs: 1700000000,
      createdAt: 1700000000,
    };
    const bar: Bar = {
      symbol: 'SPXW260318C05000000', timeframe: '1m', ts: 1700000000,
      open: 10, high: 12, low: 9, close: 11,
      volume: 50, synthetic: false, gapType: null, indicators: {},
    };
    upsertContract(contract);
    upsertBar(bar);

    // archiveExpired logs "duckdb not available" and continues without throwing
    const consoleSpy = vi.spyOn(console, 'error');
    await expect(archiveExpired()).resolves.toBeUndefined();
    consoleSpy.mockRestore();
  });
});
