/**
 * Tests for profile-store (DB-backed InstrumentProfile repo).
 *
 * Uses an in-memory SQLite DB per test so there's no cross-test state leak.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import {
  loadProfile,
  listProfiles,
  saveProfile,
  deleteProfile,
  profileExists,
  fromInstrumentProfile,
  toInstrumentProfile,
  type StoredInstrumentProfile,
} from '../../src/instruments/profile-store';
import { SPX_0DTE_PROFILE } from '../../src/instruments/profiles/spx-0dte';
import { NDX_0DTE_PROFILE } from '../../src/instruments/profiles/ndx-0dte';

function makeDb(): DB {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE instrument_profiles (
      id                      TEXT PRIMARY KEY,
      display_name            TEXT NOT NULL,
      underlying_symbol       TEXT NOT NULL,
      asset_class             TEXT NOT NULL,
      option_prefix           TEXT NOT NULL,
      strike_divisor          INTEGER NOT NULL DEFAULT 1,
      strike_interval         REAL NOT NULL,
      band_half_width_dollars REAL NOT NULL,
      avg_daily_range         REAL,
      expiry_cadence_json     TEXT NOT NULL DEFAULT '[]',
      session_json            TEXT NOT NULL,
      vendor_routing_json     TEXT NOT NULL,
      tier                    INTEGER NOT NULL DEFAULT 1,
      can_go_live             INTEGER NOT NULL DEFAULT 0,
      execution_account_id    TEXT,
      source                  TEXT NOT NULL,
      created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  return db;
}

function makeProfile(id: string, overrides: Partial<StoredInstrumentProfile> = {}): StoredInstrumentProfile {
  return {
    id,
    displayName: id.toUpperCase(),
    underlyingSymbol: id.toUpperCase(),
    assetClass: 'equity',
    optionPrefix: id.toUpperCase(),
    strikeDivisor: 1,
    strikeInterval: 1,
    bandHalfWidthDollars: 10,
    avgDailyRange: null,
    expiryCadences: ['weekly'],
    session: { preMarket: '04:00', rthStart: '09:30', rthEnd: '16:00', postMarket: '20:00' },
    vendorRouting: {
      underlying: { vendor: 'polygon', ticker: id.toUpperCase() },
      options: { vendor: 'polygon' },
    },
    tier: 1,
    canGoLive: false,
    executionAccountId: null,
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('profile-store', () => {
  let db: DB;
  beforeEach(() => { db = makeDb(); });

  it('saveProfile + loadProfile round-trips all fields', () => {
    const p = makeProfile('aapl', {
      assetClass: 'equity',
      strikeInterval: 2.5,
      bandHalfWidthDollars: 10,
      avgDailyRange: 4.2,
      expiryCadences: ['weekly', 'monthly'],
      tier: 1,
    });
    saveProfile(db, p);
    const loaded = loadProfile(db, 'aapl');
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe('aapl');
    expect(loaded!.assetClass).toBe('equity');
    expect(loaded!.strikeInterval).toBe(2.5);
    expect(loaded!.bandHalfWidthDollars).toBe(10);
    expect(loaded!.avgDailyRange).toBe(4.2);
    expect(loaded!.expiryCadences).toEqual(['weekly', 'monthly']);
    expect(loaded!.vendorRouting.underlying.vendor).toBe('polygon');
  });

  it('loadProfile returns null for unknown ids', () => {
    expect(loadProfile(db, 'nope')).toBeNull();
  });

  it('profileExists matches DB contents', () => {
    expect(profileExists(db, 'x')).toBe(false);
    saveProfile(db, makeProfile('x'));
    expect(profileExists(db, 'x')).toBe(true);
  });

  it('saveProfile upserts by id (second save overwrites)', () => {
    saveProfile(db, makeProfile('x', { displayName: 'first', bandHalfWidthDollars: 10 }));
    saveProfile(db, makeProfile('x', { displayName: 'second', bandHalfWidthDollars: 15 }));
    const loaded = loadProfile(db, 'x');
    expect(loaded!.displayName).toBe('second');
    expect(loaded!.bandHalfWidthDollars).toBe(15);
  });

  it('deleteProfile removes the row', () => {
    saveProfile(db, makeProfile('x'));
    expect(profileExists(db, 'x')).toBe(true);
    deleteProfile(db, 'x');
    expect(profileExists(db, 'x')).toBe(false);
  });

  it('listProfiles returns all rows ordered by display_name', () => {
    saveProfile(db, makeProfile('c', { displayName: 'Charlie' }));
    saveProfile(db, makeProfile('a', { displayName: 'Alpha' }));
    saveProfile(db, makeProfile('b', { displayName: 'Beta' }));
    const all = listProfiles(db);
    expect(all.map(p => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('fromInstrumentProfile upgrades legacy SPX to stored form', () => {
    const stored = fromInstrumentProfile(SPX_0DTE_PROFILE, {
      assetClass: 'index',
      tier: 2,
      vendorRouting: {
        underlying: { vendor: 'polygon', ticker: 'I:SPX' },
        options: { vendor: 'thetadata' },
      },
      source: 'seed',
    });
    expect(stored.id).toBe('spx-0dte');
    expect(stored.assetClass).toBe('index');
    expect(stored.tier).toBe(2);
    expect(stored.canGoLive).toBe(true);
    expect(stored.executionAccountId).toBe(SPX_0DTE_PROFILE.execution.accountId);
    expect(stored.optionPrefix).toBe('SPXW');
    expect(stored.bandHalfWidthDollars).toBe(100);
  });

  it('toInstrumentProfile converts back losslessly for the legacy-shape fields', () => {
    const stored = fromInstrumentProfile(NDX_0DTE_PROFILE, {
      assetClass: 'index',
      tier: 2,
      vendorRouting: {
        underlying: { vendor: 'polygon', ticker: 'I:NDX' },
        options: { vendor: 'polygon' },
      },
      source: 'seed',
    });
    const legacy = toInstrumentProfile(stored);
    expect(legacy.id).toBe(NDX_0DTE_PROFILE.id);
    expect(legacy.options.prefix).toBe(NDX_0DTE_PROFILE.options.prefix);
    expect(legacy.options.strikeInterval).toBe(NDX_0DTE_PROFILE.options.strikeInterval);
    expect(legacy.execution.underlyingSymbol).toBe(NDX_0DTE_PROFILE.execution.underlyingSymbol);
    expect(legacy.bandWidthDollars).toBe(NDX_0DTE_PROFILE.bandWidthDollars);
    // NDX has no accountId in the code profile — should round-trip as undefined.
    expect(legacy.execution.accountId).toBeUndefined();
  });
});
