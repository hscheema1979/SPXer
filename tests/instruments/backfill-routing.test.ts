/**
 * Tests for backfill-routing — pure vendor-routing helpers.
 *
 * These are synchronous, no DB, no network.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveBackfillRouting,
  defaultRoutingFor,
  checkVendorReadiness,
} from '../../src/instruments/backfill-routing';
import type { StoredInstrumentProfile, VendorRouting } from '../../src/instruments/profile-store';

function stub(routing: VendorRouting | unknown): StoredInstrumentProfile {
  return {
    id: 'stub',
    displayName: 'STUB',
    underlyingSymbol: 'STUB',
    assetClass: 'equity',
    optionPrefix: 'STUB',
    strikeDivisor: 1,
    strikeInterval: 1,
    bandHalfWidthDollars: 10,
    avgDailyRange: null,
    expiryCadences: ['weekly'],
    session: { preMarket: '04:00', rthStart: '09:30', rthEnd: '16:00', postMarket: '20:00' },
    // Cast deliberately — some tests pass malformed values on purpose.
    vendorRouting: routing as VendorRouting,
    tier: 1,
    canGoLive: false,
    executionAccountId: null,
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('backfill-routing', () => {
  describe('resolveBackfillRouting', () => {
    it('returns routing unchanged for a valid profile', () => {
      const routing: VendorRouting = {
        underlying: { vendor: 'polygon', ticker: 'AAPL' },
        options: { vendor: 'polygon' },
      };
      expect(resolveBackfillRouting(stub(routing))).toBe(routing);
    });

    it('accepts tradier underlying + thetadata options', () => {
      const routing: VendorRouting = {
        underlying: { vendor: 'tradier', ticker: 'SPX' },
        options: { vendor: 'thetadata' },
      };
      expect(resolveBackfillRouting(stub(routing))).toEqual(routing);
    });

    it('throws on null routing blob', () => {
      expect(() => resolveBackfillRouting(stub(null))).toThrow(/malformed vendor_routing_json/);
    });

    it('throws when underlying block is missing', () => {
      expect(() => resolveBackfillRouting(stub({ options: { vendor: 'polygon' } }))).toThrow(
        /malformed vendor_routing_json/,
      );
    });

    it('throws when options block is missing', () => {
      expect(() =>
        resolveBackfillRouting(stub({ underlying: { vendor: 'polygon', ticker: 'AAPL' } })),
      ).toThrow(/malformed vendor_routing_json/);
    });

    it('throws on unknown underlying vendor', () => {
      expect(() =>
        resolveBackfillRouting(
          stub({
            underlying: { vendor: 'yahoo', ticker: 'AAPL' },
            options: { vendor: 'polygon' },
          }),
        ),
      ).toThrow(/unknown underlying vendor: yahoo/);
    });

    it('throws on unknown option vendor', () => {
      expect(() =>
        resolveBackfillRouting(
          stub({
            underlying: { vendor: 'polygon', ticker: 'AAPL' },
            options: { vendor: 'barchart' },
          }),
        ),
      ).toThrow(/unknown option vendor: barchart/);
    });

    it('throws on empty underlying ticker', () => {
      expect(() =>
        resolveBackfillRouting(
          stub({
            underlying: { vendor: 'polygon', ticker: '' },
            options: { vendor: 'polygon' },
          }),
        ),
      ).toThrow(/missing underlying.ticker/);
    });
  });

  describe('defaultRoutingFor', () => {
    it('routes SPX index to Polygon underlying (I:SPX) + ThetaData options', () => {
      expect(defaultRoutingFor('SPX', 'index')).toEqual({
        underlying: { vendor: 'polygon', ticker: 'I:SPX' },
        options: { vendor: 'thetadata' },
      });
    });

    it('routes non-SPX indexes (NDX) to Polygon for both sides', () => {
      expect(defaultRoutingFor('NDX', 'index')).toEqual({
        underlying: { vendor: 'polygon', ticker: 'I:NDX' },
        options: { vendor: 'polygon' },
      });
    });

    it('routes RUT index to Polygon for both sides', () => {
      expect(defaultRoutingFor('RUT', 'index')).toEqual({
        underlying: { vendor: 'polygon', ticker: 'I:RUT' },
        options: { vendor: 'polygon' },
      });
    });

    it('routes equities to Polygon for both sides with plain ticker', () => {
      expect(defaultRoutingFor('AAPL', 'equity')).toEqual({
        underlying: { vendor: 'polygon', ticker: 'AAPL' },
        options: { vendor: 'polygon' },
      });
    });

    it('routes ETFs to Polygon for both sides with plain ticker', () => {
      expect(defaultRoutingFor('SPY', 'etf')).toEqual({
        underlying: { vendor: 'polygon', ticker: 'SPY' },
        options: { vendor: 'polygon' },
      });
    });

    it('uppercases lower/mixed-case input tickers', () => {
      expect(defaultRoutingFor('spx', 'index').underlying.ticker).toBe('I:SPX');
      expect(defaultRoutingFor('Aapl', 'equity').underlying.ticker).toBe('AAPL');
    });
  });

  describe('checkVendorReadiness', () => {
    const origPoly = process.env.POLYGON_API_KEY;
    const origTheta = process.env.THETADATA_BASE_URL;

    beforeEach(() => {
      delete process.env.POLYGON_API_KEY;
      delete process.env.THETADATA_BASE_URL;
    });

    afterEach(() => {
      if (origPoly === undefined) delete process.env.POLYGON_API_KEY;
      else process.env.POLYGON_API_KEY = origPoly;
      if (origTheta === undefined) delete process.env.THETADATA_BASE_URL;
      else process.env.THETADATA_BASE_URL = origTheta;
    });

    it('reports missing POLYGON_API_KEY for polygon-only routing', () => {
      const missing = checkVendorReadiness({
        underlying: { vendor: 'polygon', ticker: 'AAPL' },
        options: { vendor: 'polygon' },
      });
      expect(missing).toContain('POLYGON_API_KEY (underlying)');
      expect(missing).toContain('POLYGON_API_KEY (options)');
    });

    it('returns empty when polygon key is set and options use polygon', () => {
      process.env.POLYGON_API_KEY = 'test-key';
      const missing = checkVendorReadiness({
        underlying: { vendor: 'polygon', ticker: 'AAPL' },
        options: { vendor: 'polygon' },
      });
      expect(missing).toEqual([]);
    });

    it('does not require polygon key when underlying is tradier and options are thetadata', () => {
      // thetadata defaults to localhost base URL, so it's effectively always ready
      const missing = checkVendorReadiness({
        underlying: { vendor: 'tradier', ticker: 'SPX' },
        options: { vendor: 'thetadata' },
      });
      expect(missing).toEqual([]);
    });

    it('requires polygon key for underlying even if options are thetadata', () => {
      const missing = checkVendorReadiness({
        underlying: { vendor: 'polygon', ticker: 'I:SPX' },
        options: { vendor: 'thetadata' },
      });
      expect(missing).toContain('POLYGON_API_KEY (underlying)');
      expect(missing).not.toContain('POLYGON_API_KEY (options)');
    });
  });
});
