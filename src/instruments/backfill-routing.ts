/**
 * backfill-routing — vendor routing resolution for historical data fetch.
 *
 * See docs/UNIVERSAL-BACKFILL.md §"Discovery Service" step 8.
 *
 * This module is deliberately thin:
 *   - Vendor routing is stored on the profile (vendor_routing_json).
 *   - `resolveBackfillRouting()` is a typed getter + validator.
 *   - `defaultRoutingFor()` picks sensible defaults for a newly discovered
 *     ticker, used by the discovery service when authoring a profile.
 *
 * Why not put this on the profile itself? We keep it here so that vendor
 * choice can evolve (e.g., add Tradier or IB as a backfill source) without
 * churning the profile schema — the JSON blob absorbs additions.
 */

import type { AssetClass, StoredInstrumentProfile, VendorRouting } from './profile-store';

export type UnderlyingVendor = 'polygon' | 'tradier';
export type OptionVendor = 'polygon' | 'thetadata';

/**
 * Resolve the backfill routing for a profile. Validates that the stored
 * JSON parses to a recognized vendor pair; throws with a clear message
 * otherwise so mis-configured profiles fail loud.
 */
export function resolveBackfillRouting(profile: StoredInstrumentProfile): VendorRouting {
  const r = profile.vendorRouting;
  if (!r || !r.underlying || !r.options) {
    throw new Error(
      `[backfill-routing] Profile '${profile.id}' has malformed vendor_routing_json: ${JSON.stringify(r)}`,
    );
  }
  if (r.underlying.vendor !== 'polygon' && r.underlying.vendor !== 'tradier') {
    throw new Error(
      `[backfill-routing] Profile '${profile.id}' has unknown underlying vendor: ${r.underlying.vendor}`,
    );
  }
  if (!r.underlying.ticker || r.underlying.ticker.length === 0) {
    throw new Error(`[backfill-routing] Profile '${profile.id}' missing underlying.ticker`);
  }
  if (r.options.vendor !== 'polygon' && r.options.vendor !== 'thetadata') {
    throw new Error(
      `[backfill-routing] Profile '${profile.id}' has unknown option vendor: ${r.options.vendor}`,
    );
  }
  return r;
}

/**
 * Pick default backfill routing for a newly discovered ticker.
 *
 *   - Indexes (SPX, NDX, RUT, VIX): Polygon's `I:${ticker}` for underlying.
 *     Options: ThetaData if and only if the ticker is SPX (our subscription
 *     covers SPX only); everything else falls back to Polygon.
 *   - Equities / ETFs (SPY, QQQ, AAPL, etc.): `${ticker}` for underlying
 *     on Polygon; options always Polygon.
 *
 * The Polygon ticker convention matches what Polygon's /v2/aggs endpoint
 * expects: indexes are prefixed `I:`, equities/ETFs are plain.
 */
export function defaultRoutingFor(ticker: string, assetClass: AssetClass): VendorRouting {
  const upper = ticker.toUpperCase();
  if (assetClass === 'index') {
    return {
      underlying: { vendor: 'polygon', ticker: `I:${upper}` },
      options: { vendor: upper === 'SPX' ? 'thetadata' : 'polygon' },
    };
  }
  // equity or etf
  return {
    underlying: { vendor: 'polygon', ticker: upper },
    options: { vendor: 'polygon' },
  };
}

/**
 * Does this vendor pair require an optional API subscription that may not
 * be configured? Used by the UI to warn before kicking off a long backfill.
 * Returns a list of missing capability names; empty means ready.
 */
export function checkVendorReadiness(routing: VendorRouting): string[] {
  const missing: string[] = [];
  const polygonKey = process.env.POLYGON_API_KEY;
  const thetaBase = process.env.THETADATA_BASE_URL || 'http://127.0.0.1:25510';

  if (routing.underlying.vendor === 'polygon' && !polygonKey) {
    missing.push('POLYGON_API_KEY (underlying)');
  }
  if (routing.options.vendor === 'polygon' && !polygonKey) {
    missing.push('POLYGON_API_KEY (options)');
  }
  if (routing.options.vendor === 'thetadata' && !thetaBase) {
    missing.push('THETADATA_BASE_URL');
  }
  return missing;
}
