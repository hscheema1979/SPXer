/**
 * backfill-etf-shares.ts feeds the backtest lab's share tickers. Pins: the
 * ticker list comes from sweep-registry.json (assetClass=shares) so the
 * nightly run cannot drift from what the lab offers, and a run that leaves a
 * trading day empty or errors exits non-zero (DATA-STORES rule 2).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { sharesTickersFromRegistry, failedTickers, thinTickers, unionTickers } from '../../scripts/backfill/backfill-etf-shares';

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

describe('failedTickers / thinTickers', () => {
  it('is empty when every ticker wrote or skipped only', () => {
    expect(failedTickers([{ ticker: 'TQQQ', written: 3, skipped: 249, empty: 0, errors: 0 }])).toEqual([]);
  });
  it('any error fails', () => {
    expect(failedTickers([{ ticker: 'TNA', written: 0, skipped: 0, empty: 0, errors: 3 }])).toHaveLength(1);
  });
  it('a fully blank run fails only while Polygon lists the ticker active (LCDL delisted → not a failure)', () => {
    const blank = [{ ticker: 'LCDL', written: 0, skipped: 0, empty: 3, errors: 0 }];
    expect(failedTickers(blank)).toHaveLength(1);                         // default: assume active
    expect(failedTickers(blank, () => false)).toEqual([]);               // delisted
  });
  it('thin tickers (some empty days, some written) are warnings, not failures (SPOG 58/76)', () => {
    const runs = [{ ticker: 'SPOG', written: 18, skipped: 0, empty: 58, errors: 0 }];
    expect(failedTickers(runs)).toEqual([]);
    expect(thinTickers(runs)).toEqual(['SPOG (58 empty of 76)']);
  });
});

describe('unionTickers', () => {
  it('upper-cases, de-duplicates, keeps first-seen order (registry first, lab discovery second)', () => {
    expect(unionTickers(['tqqq', 'SOXL'], ['soxl', 'ASTX', 'gdxu', ''])).toEqual(['TQQQ', 'SOXL', 'ASTX', 'GDXU']);
  });
});
