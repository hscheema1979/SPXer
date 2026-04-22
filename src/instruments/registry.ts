/**
 * Instrument registry — DB-backed with code fallback.
 *
 * Lookup flow:
 *   1. db.ts calls refreshRegistryCache(db) after seedCodeProfiles on boot.
 *   2. Getters (getProfile, requireProfile, listProfiles, ...) read from the
 *      in-memory cache populated by refreshRegistryCache.
 *   3. If the cache has not been populated (e.g. unit tests that don't init
 *      the DB), we fall back to the code profiles in src/instruments/profiles/.
 *   4. Invariants (unique id, unique accountId) are enforced at cache build
 *      time; violations throw loudly.
 *
 * See docs/UNIVERSAL-BACKFILL.md §"Data Model" for the policy on when code vs
 * DB wins: live-tradable profiles are overwritten from code on every boot
 * (source of truth in git); backtest-only profiles are insert-if-absent so
 * UI edits persist.
 *
 * Callers that want the richer StoredInstrumentProfile (asset class, tier,
 * vendor routing) should import from './profile-store' directly. This module
 * only exposes the legacy InstrumentProfile shape for backward compatibility
 * with existing imports.
 */

import type { Database as DB } from 'better-sqlite3';
import type { InstrumentProfile } from './types';
import { SPX_0DTE_PROFILE } from './profiles/spx-0dte';
import { SPY_1DTE_PROFILE } from './profiles/spy-1dte';
import { NDX_0DTE_PROFILE } from './profiles/ndx-0dte';
import { listProfiles as listStoredProfiles, toInstrumentProfile } from './profile-store';

const CODE_PROFILES: readonly InstrumentProfile[] = Object.freeze([
  SPX_0DTE_PROFILE,
  SPY_1DTE_PROFILE,
  NDX_0DTE_PROFILE,
]);

function buildIndex(profiles: readonly InstrumentProfile[]): Map<string, InstrumentProfile> {
  const byId = new Map<string, InstrumentProfile>();
  const accountsSeen = new Map<string, string>(); // accountId -> profile id

  for (const p of profiles) {
    if (byId.has(p.id)) {
      throw new Error(`[instruments] Duplicate profile id: ${p.id}`);
    }
    const accountId = p.execution.accountId;
    if (accountId) {
      const owner = accountsSeen.get(accountId);
      if (owner) {
        throw new Error(
          `[instruments] Profile '${p.id}' routes to account ${accountId} ` +
            `which is already claimed by '${owner}'. Until account_allocations lands, ` +
            `each live profile must use a distinct account.`,
        );
      }
      accountsSeen.set(accountId, p.id);
    }
    byId.set(p.id, p);
  }

  return byId;
}

let cache: Map<string, InstrumentProfile> | null = null;

function ensureCache(): Map<string, InstrumentProfile> {
  if (cache == null) cache = buildIndex(CODE_PROFILES);
  return cache;
}

/**
 * Rebuild the registry cache from DB. Called by src/storage/db.ts after
 * instrument_profiles seeding. If the DB read fails, existing cache contents
 * (or the code-profile fallback) remain in place — we never leave the
 * registry in an empty state.
 */
export function refreshRegistryCache(db: DB): void {
  try {
    const stored = listStoredProfiles(db);
    if (stored.length === 0) {
      // DB is empty (e.g. fresh install, pre-seed). Keep code fallback.
      cache = buildIndex(CODE_PROFILES);
      return;
    }
    cache = buildIndex(stored.map(toInstrumentProfile));
  } catch (err) {
    console.error('[instruments] refreshRegistryCache failed, keeping fallback:', err);
    if (cache == null) cache = buildIndex(CODE_PROFILES);
  }
}

/**
 * Reset the cache (used by tests that want a clean slate between cases).
 */
export function resetRegistryCache(): void {
  cache = null;
}

/**
 * Look up an instrument profile by id. Returns undefined if unknown.
 * Callers that require the profile should use `requireProfile`.
 */
export function getProfile(id: string): InstrumentProfile | undefined {
  return ensureCache().get(id);
}

/**
 * Look up a profile by id, throwing if unknown. Use at agent boot.
 */
export function requireProfile(id: string): InstrumentProfile {
  const map = ensureCache();
  const p = map.get(id);
  if (!p) {
    throw new Error(
      `[instruments] Unknown profile id: '${id}'. Known: ${Array.from(map.keys()).join(', ')}`,
    );
  }
  return p;
}

/**
 * List all registered profiles. Useful for UI enumeration and health checks.
 */
export function listProfiles(): readonly InstrumentProfile[] {
  return Array.from(ensureCache().values());
}

/**
 * Reverse lookup: which profile (if any) routes to the given account?
 */
export function profileForAccount(accountId: string): InstrumentProfile | undefined {
  for (const p of ensureCache().values()) {
    if (p.execution.accountId === accountId) return p;
  }
  return undefined;
}

/**
 * Can this profile be run live? Requires an account binding. If false,
 * the profile is backtest/data-collection only.
 */
export function canGoLive(profile: InstrumentProfile): boolean {
  return typeof profile.execution.accountId === 'string' && profile.execution.accountId.length > 0;
}
