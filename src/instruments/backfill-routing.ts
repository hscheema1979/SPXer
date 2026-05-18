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
// Options backfill is Polygon-only. ThetaData was removed 2026-05-17 — it was
// SPX-only, the historical /v3/option/history endpoint carried no field the
// credit/iron/long sweeps consume (no bid/ask; volume unused in P&L), Polygon
// was already the dominant source post-fallback, and Polygon's aggregates have
// no 50k-row truncation. Re-add a vendor here if a future ticker/strategy
// genuinely needs a non-Polygon options feed.
export type OptionVendor = 'polygon';

/**
 * Resolve the backfill routing for a profile. Validates that the stored
 * JSON parses to a recognized vendor pair; throws with a clear message
 * otherwise so mis-configured profiles fail loud.
 *
 * Legacy `options.vendor === 'thetadata'` profiles (stored before the Theta
 * removal) are transparently coerced to 'polygon' so no DB migration is
 * needed — the resolved routing is mutated in place and returned.
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
  // Coerce retired ThetaData routing to Polygon (no DB migration required).
  if ((r.options.vendor as string) === 'thetadata') {
    r.options.vendor = 'polygon';
  }
  if (r.options.vendor !== 'polygon') {
    throw new Error(
      `[backfill-routing] Profile '${profile.id}' has unknown option vendor: ${r.options.vendor}`,
    );
  }
  return r;
}

/**
 * Pick default backfill routing for a newly discovered ticker.
 *
 *   - Indexes (SPX, NDX, RUT, VIX): Polygon's `I:${ticker}` for underlying;
 *     options always Polygon.
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
      options: { vendor: 'polygon' },
    };
  }
  // equity or etf
  return {
    underlying: { vendor: 'polygon', ticker: upper },
    options: { vendor: 'polygon' },
  };
}

/**
 * Number of distinct option contracts (calls + puts) a fully-backfilled
 * date should have for this profile, based on band width × strike interval.
 *
 *   strikesInBand = floor(2 × bandHalfWidth / strikeInterval) + 1
 *   contracts     = 2 × strikesInBand    (calls + puts)
 *
 * Used by `findMissingDates({ options: { expectedContractsPerDate } })`
 * to flag dates where the underlying is present but the option chain is
 * thin — symptom of a half-failed backfill (Polygon 429 storm mid-day,
 * strike list mismatch, etc.).
 */
export function expectedContractsForProfile(profile: StoredInstrumentProfile): number {
  const strikesInBand = Math.floor(
    (2 * profile.bandHalfWidthDollars) / profile.strikeInterval
  ) + 1;
  return 2 * strikesInBand;
}

/**
 * Does this vendor pair require an optional API subscription that may not
 * be configured? Used by the UI to warn before kicking off a long backfill.
 * Returns a list of missing capability names; empty means ready.
 */
export function checkVendorReadiness(routing: VendorRouting): string[] {
  const missing: string[] = [];
  const polygonKey = process.env.POLYGON_API_KEY;

  if (routing.underlying.vendor === 'polygon' && !polygonKey) {
    missing.push('POLYGON_API_KEY (underlying)');
  }
  if (routing.options.vendor === 'polygon' && !polygonKey) {
    missing.push('POLYGON_API_KEY (options)');
  }
  return missing;
}
