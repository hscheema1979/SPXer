/**
 * discovery — auto-detection of instrument metadata for new tickers.
 *
 * See docs/UNIVERSAL-BACKFILL.md §"Symbol Discovery Service".
 *
 * Given a ticker string (e.g. "AAPL"), this module queries Polygon's
 * reference endpoints and daily aggregates to infer:
 *   - Asset class (index / equity / etf)
 *   - Option root prefix
 *   - Strike interval (by computing gcd of consecutive strikes)
 *   - Band half-width in dollars (avg daily range for indexes; $10 for
 *     equities/ETFs per user spec)
 *   - Expiry cadences available on the chain
 *   - Tier (indexes = 2, else 1)
 *   - Vendor routing defaults (see backfill-routing.ts)
 *
 * The returned DiscoveredProfile is a *preview* — the UI shows it, user
 * confirms or overrides fields, then POSTs back to create the profile
 * row. This service itself never writes to the DB.
 *
 * Result caching: in-memory 24h per-ticker to keep the modal snappy.
 */

import type { ExpiryCadence } from './types';
import type { AssetClass, Tier, VendorRouting } from './profile-store';
import { defaultRoutingFor } from './backfill-routing';

const POLYGON_BASE = 'https://api.polygon.io';
const POLYGON_KEY = process.env.POLYGON_API_KEY || '';

/** Overrides: tickers whose option chain uses a non-standard root. */
const OPTION_PREFIX_OVERRIDES: Record<string, string> = {
  SPX: 'SPXW',
  NDX: 'NDXP',
};

/** Output of a discovery run, ready for UI display + user confirmation. */
export interface DiscoveredProfile {
  /** Lowercased ticker; used as stable profile id. */
  id: string;
  /** Original user input, uppercased. */
  ticker: string;
  displayName: string;
  assetClass: AssetClass;
  underlyingSymbol: string;
  optionPrefix: string;
  strikeDivisor: number;
  strikeInterval: number;
  bandHalfWidthDollars: number;
  avgDailyRange: number | null;
  expiryCadences: ExpiryCadence[];
  vendorRouting: VendorRouting;
  tier: Tier;
  /** Non-blocking caveats surfaced in the UI (e.g. low-sample inferences). */
  warnings: string[];
}

export class DiscoveryError extends Error {
  constructor(message: string, public readonly code: 'NOT_FOUND' | 'NO_API_KEY' | 'API_ERROR') {
    super(message);
    this.name = 'DiscoveryError';
  }
}

// ── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry { ts: number; value: DiscoveredProfile }
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function cacheGet(key: string): DiscoveredProfile | null {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return e.value;
}

function cachePut(key: string, value: DiscoveredProfile): void {
  CACHE.set(key, { ts: Date.now(), value });
}

/** Clear the discovery cache. Exposed for tests. */
export function clearDiscoveryCache(): void {
  CACHE.clear();
}

// ── Polygon fetch helpers ──────────────────────────────────────────────────

async function polygonGet<T = unknown>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  if (!POLYGON_KEY) {
    throw new DiscoveryError('POLYGON_API_KEY not configured', 'NO_API_KEY');
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `${POLYGON_BASE}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${POLYGON_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) {
    throw new DiscoveryError(`Polygon 404 for ${path}`, 'NOT_FOUND');
  }
  if (!res.ok) {
    throw new DiscoveryError(`Polygon ${res.status} for ${path}: ${await res.text()}`, 'API_ERROR');
  }
  return res.json() as Promise<T>;
}

// ── Step 1: asset classification ───────────────────────────────────────────

interface TickerDetails {
  results?: {
    ticker: string;
    name?: string;
    market?: string;      // 'stocks' | 'indices' | 'fx' | ...
    type?: string;        // 'CS' | 'ETF' | 'ETV' | 'ADRC' | 'INDEX' | ...
    active?: boolean;
  };
}

async function classifyAsset(ticker: string): Promise<{ assetClass: AssetClass; name: string }> {
  // Indexes are queried with the I: prefix on the reference endpoint.
  // We probe indexes first because plain 'SPX' returns stock-side results.
  const upper = ticker.toUpperCase();
  try {
    const idx = await polygonGet<TickerDetails>(`/v3/reference/tickers/I:${upper}`);
    if (idx.results && (idx.results.market === 'indices' || idx.results.type === 'INDEX')) {
      return { assetClass: 'index', name: idx.results.name || upper };
    }
  } catch (e) {
    if (!(e instanceof DiscoveryError) || e.code !== 'NOT_FOUND') throw e;
    // fall through to stock probe
  }

  const eq = await polygonGet<TickerDetails>(`/v3/reference/tickers/${upper}`);
  if (!eq.results) {
    throw new DiscoveryError(`Ticker '${upper}' not found on Polygon`, 'NOT_FOUND');
  }
  const type = (eq.results.type || '').toUpperCase();
  if (type === 'ETF' || type === 'ETV' || type === 'ETN') {
    return { assetClass: 'etf', name: eq.results.name || upper };
  }
  if (type === 'CS' || type === 'ADRC' || type === 'ADRW' || type === 'GDR') {
    return { assetClass: 'equity', name: eq.results.name || upper };
  }
  throw new DiscoveryError(`Ticker '${upper}' has unsupported type '${type}'`, 'NOT_FOUND');
}

// ── Step 4: strike interval detection ──────────────────────────────────────

interface OptionContract {
  strike_price?: number;
  expiration_date?: string;
}
interface ContractsPage {
  results?: OptionContract[];
  next_url?: string;
}

/**
 * Infer the minimum strike interval by computing the GCD-of-consecutive-diffs
 * on distinct strike prices near ATM. Returns {interval, sampleCount}.
 * Rounds to nearest cent to absorb Polygon's occasional floating drift.
 */
function inferStrikeInterval(strikes: number[]): { interval: number; sampleCount: number } {
  const unique = Array.from(new Set(strikes.map(s => Math.round(s * 100) / 100))).sort((a, b) => a - b);
  if (unique.length < 2) return { interval: 5, sampleCount: unique.length };

  // Compute diffs in cents to keep math integer.
  const diffs: number[] = [];
  for (let i = 1; i < unique.length; i++) {
    const d = Math.round((unique[i] - unique[i - 1]) * 100);
    if (d > 0) diffs.push(d);
  }
  if (diffs.length === 0) return { interval: 5, sampleCount: unique.length };

  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const cents = diffs.reduce((acc, d) => gcd(acc, d), diffs[0]);
  return { interval: cents / 100, sampleCount: unique.length };
}

async function detectStrikeIntervalAndExpiries(
  underlyingTicker: string,
): Promise<{ interval: number; sampleCount: number; expirations: string[] }> {
  // Pull up to 250 contracts from the nearest few expirations. Polygon paginates.
  const first = await polygonGet<ContractsPage>(`/v3/reference/options/contracts`, {
    underlying_ticker: underlyingTicker,
    expired: 'false',
    limit: 250,
  });
  const contracts = first.results ?? [];
  const strikes = contracts.map(c => c.strike_price ?? NaN).filter(v => Number.isFinite(v));
  const expirations = Array.from(new Set(contracts.map(c => c.expiration_date).filter(Boolean))).sort() as string[];
  const { interval, sampleCount } = inferStrikeInterval(strikes);
  return { interval, sampleCount, expirations };
}

// ── Step 5: band half-width for indexes (avg daily H-L × 1.5) ──────────────

interface AggsResponse { results?: Array<{ h: number; l: number; c: number }> }

async function fetchDailyRangeStats(polygonTicker: string, days: number): Promise<{ avgRange: number; samples: number } | null> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const res = await polygonGet<AggsResponse>(
      `/v2/aggs/ticker/${encodeURIComponent(polygonTicker)}/range/1/day/${fmt(start)}/${fmt(end)}`,
      { adjusted: 'true', sort: 'desc', limit: days },
    );
    const rows = res.results ?? [];
    if (rows.length === 0) return null;
    const ranges = rows.map(r => r.h - r.l).filter(v => Number.isFinite(v) && v > 0);
    if (ranges.length === 0) return null;
    const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    return { avgRange: avg, samples: ranges.length };
  } catch (e) {
    if (e instanceof DiscoveryError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

function roundToNearest(v: number, step: number): number {
  return Math.round(v / step) * step;
}

function computeBandHalfWidth(assetClass: AssetClass, avgRange: number | null): number {
  if (assetClass === 'index') {
    if (avgRange == null) return 100; // conservative fallback matching SPX
    return Math.max(50, Math.min(500, roundToNearest(avgRange * 1.5, 5)));
  }
  // equity / ETF — user spec: $10
  return 10;
}

// ── Step 6: expiry cadence inference ───────────────────────────────────────

function inferExpiryCadences(expirations: string[]): ExpiryCadence[] {
  if (expirations.length === 0) return ['weekly'];
  const today = new Date().toISOString().slice(0, 10);
  const future = expirations.filter(d => d >= today).sort();
  const cadences = new Set<ExpiryCadence>();

  if (future[0] === today) cadences.add('daily'); // 0DTE available today

  // Check daily cadence: next 5 business days all present?
  const next5Bdays: string[] = [];
  const cursor = new Date(today + 'T00:00:00Z');
  while (next5Bdays.length < 5) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) next5Bdays.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const dailyHits = next5Bdays.filter(d => future.includes(d)).length;
  if (dailyHits >= 4) cadences.add('daily');

  // MWF pattern — Mondays, Wednesdays, Fridays only in the first 10 bdays
  if (!cadences.has('daily')) {
    const mwfSet = future.slice(0, 10).filter(d => {
      const dow = new Date(d + 'T00:00:00Z').getUTCDay();
      return dow === 1 || dow === 3 || dow === 5;
    });
    if (mwfSet.length >= 3) cadences.add('mwf');
  }

  // Weeklies — any Friday expiry in the next 60 days
  const hasFriday = future.slice(0, 20).some(d => new Date(d + 'T00:00:00Z').getUTCDay() === 5);
  if (hasFriday) cadences.add('weekly');

  // Monthly — third-Friday present
  const hasThirdFriday = future.some(d => {
    const dt = new Date(d + 'T00:00:00Z');
    return dt.getUTCDay() === 5 && dt.getUTCDate() >= 15 && dt.getUTCDate() <= 21;
  });
  if (hasThirdFriday) cadences.add('monthly');

  if (cadences.size === 0) cadences.add('weekly');
  return Array.from(cadences);
}

// ── Main discovery entry point ─────────────────────────────────────────────

/**
 * Discover a profile for the given ticker. Returns a preview DiscoveredProfile
 * without persisting anything. UI should show the preview, let user override
 * fields, then POST to /api/symbols to create the row.
 */
export async function discoverProfile(ticker: string): Promise<DiscoveredProfile> {
  const upper = ticker.trim().toUpperCase();
  if (!/^[A-Z.]{1,10}$/.test(upper)) {
    throw new DiscoveryError(`Invalid ticker '${ticker}'`, 'NOT_FOUND');
  }

  const cached = cacheGet(upper);
  if (cached) return cached;

  const warnings: string[] = [];

  // Step 1: classify
  const { assetClass, name } = await classifyAsset(upper);

  // Step 2: option prefix — override table, else ticker itself
  const optionPrefix = OPTION_PREFIX_OVERRIDES[upper] ?? upper;

  // Step 3 (vendor routing) — deferred to end; need asset class

  // Step 4: strike interval + expirations (queried together)
  // For Polygon's options-contracts endpoint, indexes need the bare ticker
  // (e.g. 'SPX' not 'I:SPX') on this particular endpoint.
  let strikeInterval = assetClass === 'index' ? 5 : 1;
  let sampleCount = 0;
  let expirations: string[] = [];
  try {
    const r = await detectStrikeIntervalAndExpiries(upper);
    strikeInterval = r.interval || strikeInterval;
    sampleCount = r.sampleCount;
    expirations = r.expirations;
    if (sampleCount < 10) {
      warnings.push(
        `Strike interval inferred from only ${sampleCount} contracts — verify before use`,
      );
    }
  } catch (e) {
    warnings.push(`Could not list option contracts; defaulting strike interval to ${strikeInterval}`);
    if (!(e instanceof DiscoveryError) || e.code !== 'NOT_FOUND') throw e;
  }

  // Step 5: band half-width — indexes need avg daily range
  const polygonUnderlying = assetClass === 'index' ? `I:${upper}` : upper;
  const rangeStats = assetClass === 'index' ? await fetchDailyRangeStats(polygonUnderlying, 30) : null;
  const avgDailyRange = rangeStats?.avgRange ?? null;
  if (assetClass === 'index' && avgDailyRange == null) {
    warnings.push('Could not fetch daily OHLC for index band calculation — using fallback $100');
  }
  const bandHalfWidth = computeBandHalfWidth(assetClass, avgDailyRange);

  // Step 6: expiry cadences
  const expiryCadences = inferExpiryCadences(expirations);
  if (expirations.length === 0) {
    warnings.push('No option expirations found — chain may be empty or unsupported');
  }

  // Step 7: tier
  const tier: Tier = assetClass === 'index' ? 2 : 1;

  // Step 8: vendor routing
  const vendorRouting = defaultRoutingFor(upper, assetClass);

  const result: DiscoveredProfile = {
    id: upper.toLowerCase().replace(/\./g, '-'),
    ticker: upper,
    displayName: name,
    assetClass,
    underlyingSymbol: upper,
    optionPrefix,
    strikeDivisor: 1,
    strikeInterval,
    bandHalfWidthDollars: bandHalfWidth,
    avgDailyRange,
    expiryCadences,
    vendorRouting,
    tier,
    warnings,
  };
  cachePut(upper, result);
  return result;
}

/** Exported for unit tests. */
export const _internal = {
  inferStrikeInterval,
  inferExpiryCadences,
  computeBandHalfWidth,
};
