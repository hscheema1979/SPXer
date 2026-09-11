/**
 * backfill-etf-shares.ts feeds the backtest lab's share tickers. Pins: the
 * ticker list comes from sweep-registry.json (assetClass=shares) so the
 * nightly run cannot drift from what the lab offers, and a run that leaves a
 * trading day empty or errors exits non-zero (DATA-STORES rule 2).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { sharesTickersFromRegistry, failedTickers } from '../../scripts/backfill/backfill-etf-shares';

describe('sharesTickersFromRegistry', () => {
  it('returns the assetClass=shares symbols, upper-cased and de-duplicated', () => {
    const reg = JSON.stringify({ profiles: [
      { symbol: 'tqqq', assetClass: 'shares' }, { symbol: 'SOXL', assetClass: 'shares' },
      { symbol: 'SOXL', assetClass: 'shares' }, { symbol: 'SPX', dte: 1, class: 'index' },
    ] });
    expect(sharesTickersFromRegistry(reg)).toEqual(['TQQQ', 'SOXL']);
  });
  it('falls back when the registry is unreadable or has no share profiles', () => {
    expect(sharesTickersFromRegistry('not json', ['X'])).toEqual(['X']);
    expect(sharesTickersFromRegistry(JSON.stringify({ profiles: [{ symbol: 'SPX' }] }), ['X'])).toEqual(['X']);
  });
  it('matches the real registry: the five lab share tickers', () => {
    const real = fs.readFileSync(path.join(__dirname, '../../scripts/diag/sweep-registry.json'), 'utf8');
    expect(sharesTickersFromRegistry(real).sort()).toEqual(['FAS', 'SOXL', 'SQQQ', 'TNA', 'TQQQ']);
  });
});

describe('failedTickers', () => {
  it('is empty when every ticker wrote or skipped only', () => {
    expect(failedTickers([{ ticker: 'TQQQ', written: 3, skipped: 249, empty: 0, errors: 0 }])).toEqual([]);
  });
  it('flags an empty trading day and any error', () => {
    const bad = failedTickers([
      { ticker: 'TQQQ', written: 2, skipped: 0, empty: 1, errors: 0 },
      { ticker: 'FAS', written: 3, skipped: 0, empty: 0, errors: 0 },
      { ticker: 'TNA', written: 0, skipped: 0, empty: 0, errors: 3 },
    ]);
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/^TQQQ/);
    expect(bad[1]).toMatch(/^TNA/);
  });
});
