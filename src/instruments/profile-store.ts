/**
 * profile-store — DB-backed repository for InstrumentProfile records.
 *
 * See docs/UNIVERSAL-BACKFILL.md §"Data Model".
 *
 * Storage layer: `instrument_profiles` table in spxer.db (migration in
 * src/storage/db.ts). Code profiles in src/instruments/profiles/*.ts are
 * seeds — they get upserted on first boot via seedCodeProfiles().
 *
 * Adapter shape: StoredInstrumentProfile is the DB-native representation
 * (flat, with JSON blobs for sub-structures). toInstrumentProfile() converts
 * back to the legacy InstrumentProfile type so existing callers that import
 * from 'src/instruments/types' keep working without edits.
 */
import type { Database as DB } from 'better-sqlite3';
import type { InstrumentProfile, SessionHoursET, ExpiryCadence } from './types';

export type AssetClass = 'index' | 'equity' | 'etf';
export type ProfileSource = 'seed' | 'ui-discovered' | 'manual';
export type Tier = 1 | 2;

export interface VendorRouting {
  underlying: { vendor: 'polygon' | 'tradier'; ticker: string };
  options: { vendor: 'polygon' | 'thetadata' };
}

/**
 * DB-native profile record. This is the shape returned from the DB and
 * written back via saveProfile(). UI code talks to this type; framework
 * code that expects the legacy InstrumentProfile uses toInstrumentProfile().
 */
export interface StoredInstrumentProfile {
  id: string;
  displayName: string;
  underlyingSymbol: string;
  assetClass: AssetClass;
  optionPrefix: string;
  strikeDivisor: number;
  strikeInterval: number;
  bandHalfWidthDollars: number;
  avgDailyRange: number | null;
  expiryCadences: ExpiryCadence[];
  session: SessionHoursET;
  vendorRouting: VendorRouting;
  tier: Tier;
  canGoLive: boolean;
  executionAccountId: string | null;
  source: ProfileSource;
  createdAt: number;
  updatedAt: number;
}

interface ProfileRow {
  id: string;
  display_name: string;
  underlying_symbol: string;
  asset_class: string;
  option_prefix: string;
  strike_divisor: number;
  strike_interval: number;
  band_half_width_dollars: number;
  avg_daily_range: number | null;
  expiry_cadence_json: string;
  session_json: string;
  vendor_routing_json: string;
  tier: number;
  can_go_live: number;
  execution_account_id: string | null;
  source: string;
  created_at: number;
  updated_at: number;
}

function rowToProfile(row: ProfileRow): StoredInstrumentProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    underlyingSymbol: row.underlying_symbol,
    assetClass: row.asset_class as AssetClass,
    optionPrefix: row.option_prefix,
    strikeDivisor: row.strike_divisor,
    strikeInterval: row.strike_interval,
    bandHalfWidthDollars: row.band_half_width_dollars,
    avgDailyRange: row.avg_daily_range,
    expiryCadences: JSON.parse(row.expiry_cadence_json) as ExpiryCadence[],
    session: JSON.parse(row.session_json) as SessionHoursET,
    vendorRouting: JSON.parse(row.vendor_routing_json) as VendorRouting,
    tier: (row.tier === 2 ? 2 : 1) as Tier,
    canGoLive: row.can_go_live === 1,
    executionAccountId: row.execution_account_id,
    source: row.source as ProfileSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Look up a single profile by id. */
export function loadProfile(db: DB, id: string): StoredInstrumentProfile | null {
  const row = db.prepare(`SELECT * FROM instrument_profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

/** List all profiles. Ordered by display_name for stable UI rendering. */
export function listProfiles(db: DB): StoredInstrumentProfile[] {
  const rows = db.prepare(`SELECT * FROM instrument_profiles ORDER BY display_name ASC`).all() as ProfileRow[];
  return rows.map(rowToProfile);
}

/** Upsert a profile by id. Updates `updated_at` automatically. */
export function saveProfile(db: DB, p: StoredInstrumentProfile): void {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO instrument_profiles (
      id, display_name, underlying_symbol, asset_class, option_prefix,
      strike_divisor, strike_interval, band_half_width_dollars, avg_daily_range,
      expiry_cadence_json, session_json, vendor_routing_json, tier,
      can_go_live, execution_account_id, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name            = excluded.display_name,
      underlying_symbol       = excluded.underlying_symbol,
      asset_class             = excluded.asset_class,
      option_prefix           = excluded.option_prefix,
      strike_divisor          = excluded.strike_divisor,
      strike_interval         = excluded.strike_interval,
      band_half_width_dollars = excluded.band_half_width_dollars,
      avg_daily_range         = excluded.avg_daily_range,
      expiry_cadence_json     = excluded.expiry_cadence_json,
      session_json            = excluded.session_json,
      vendor_routing_json     = excluded.vendor_routing_json,
      tier                    = excluded.tier,
      can_go_live             = excluded.can_go_live,
      execution_account_id    = excluded.execution_account_id,
      source                  = excluded.source,
      updated_at              = excluded.updated_at
  `).run(
    p.id,
    p.displayName,
    p.underlyingSymbol,
    p.assetClass,
    p.optionPrefix,
    p.strikeDivisor,
    p.strikeInterval,
    p.bandHalfWidthDollars,
    p.avgDailyRange,
    JSON.stringify(p.expiryCadences),
    JSON.stringify(p.session),
    JSON.stringify(p.vendorRouting),
    p.tier,
    p.canGoLive ? 1 : 0,
    p.executionAccountId,
    p.source,
    p.createdAt || now,
    now,
  );
}

/** Delete a profile. Does NOT purge replay_bars — that's a separate opt-in. */
export function deleteProfile(db: DB, id: string): void {
  db.prepare(`DELETE FROM instrument_profiles WHERE id = ?`).run(id);
}

/** Cheap existence check for validation paths. */
export function profileExists(db: DB, id: string): boolean {
  const row = db.prepare(`SELECT 1 FROM instrument_profiles WHERE id = ?`).get(id);
  return row != null;
}

// ── Legacy-type adapter ────────────────────────────────────────────────────
//
// The old InstrumentProfile type (src/instruments/types.ts) is structurally
// poorer — no asset class, no tier, no vendor routing, no indicator prefs.
// We keep it working for existing callers via this adapter so the migration
// to StoredInstrumentProfile is incremental.

/**
 * Convert a DB-stored profile to the legacy InstrumentProfile shape. Loses
 * information (asset class, tier, vendor routing) that the old type can't
 * represent. For new code, prefer the StoredInstrumentProfile type directly.
 */
export function toInstrumentProfile(p: StoredInstrumentProfile): InstrumentProfile {
  return {
    id: p.id,
    displayName: p.displayName,
    execution: {
      accountId: p.executionAccountId ?? undefined,
      underlyingSymbol: p.underlyingSymbol,
    },
    options: {
      prefix: p.optionPrefix,
      strikeDivisor: p.strikeDivisor,
      strikeInterval: p.strikeInterval,
    },
    session: p.session,
    offeredExpiryCadences: p.expiryCadences,
    baseTimeframe: '1m',
    bandWidthDollars: p.bandHalfWidthDollars,
  };
}

/**
 * Upgrade a legacy InstrumentProfile to StoredInstrumentProfile. Required
 * fields that the legacy type lacks (asset class, tier, vendor routing,
 * source) must be supplied by the caller. Used by seedCodeProfiles().
 */
export function fromInstrumentProfile(
  p: InstrumentProfile,
  extras: {
    assetClass: AssetClass;
    tier: Tier;
    vendorRouting: VendorRouting;
    source: ProfileSource;
    avgDailyRange?: number | null;
  },
): StoredInstrumentProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: p.id,
    displayName: p.displayName,
    underlyingSymbol: p.execution.underlyingSymbol,
    assetClass: extras.assetClass,
    optionPrefix: p.options.prefix,
    strikeDivisor: p.options.strikeDivisor,
    strikeInterval: p.options.strikeInterval,
    bandHalfWidthDollars: p.bandWidthDollars,
    avgDailyRange: extras.avgDailyRange ?? null,
    expiryCadences: [...p.offeredExpiryCadences],
    session: p.session,
    vendorRouting: extras.vendorRouting,
    tier: extras.tier,
    canGoLive: typeof p.execution.accountId === 'string' && p.execution.accountId.length > 0,
    executionAccountId: p.execution.accountId ?? null,
    source: extras.source,
    createdAt: now,
    updatedAt: now,
  };
}
