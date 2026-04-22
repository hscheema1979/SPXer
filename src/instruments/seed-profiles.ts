/**
 * seed-profiles — one-shot upsert of code-defined profiles into the DB.
 *
 * See docs/UNIVERSAL-BACKFILL.md §"Open Questions" — live-tradable policy.
 *
 * Policy:
 *   - Live-tradable profiles (canGoLive=true, i.e. accountId is set in code):
 *     ALWAYS overwrite the DB row on every boot. Code is the source of truth
 *     for anything that can move real money.
 *   - Backtest-only profiles (no accountId): insert-if-absent only. The UI
 *     can edit these freely and edits survive across reboots.
 *
 * This function is called from src/storage/db.ts on DB init.
 */

import type { Database as DB } from 'better-sqlite3';
import type { InstrumentProfile } from './types';
import type { AssetClass, Tier, VendorRouting } from './profile-store';
import { saveProfile, loadProfile, fromInstrumentProfile } from './profile-store';
import { defaultRoutingFor } from './backfill-routing';
import { SPX_0DTE_PROFILE } from './profiles/spx-0dte';
import { NDX_0DTE_PROFILE } from './profiles/ndx-0dte';
import { SPY_1DTE_PROFILE } from './profiles/spy-1dte';

/**
 * Per-code-profile extras that the legacy InstrumentProfile type doesn't
 * carry. One entry per profile we seed.
 */
interface SeedExtras {
  assetClass: AssetClass;
  tier: Tier;
  /** Optional override; else derived from assetClass + ticker. */
  vendorRouting?: VendorRouting;
}

const SEEDS: Array<{ profile: InstrumentProfile; extras: SeedExtras }> = [
  {
    profile: SPX_0DTE_PROFILE,
    extras: {
      assetClass: 'index',
      tier: 2,
      vendorRouting: {
        underlying: { vendor: 'polygon', ticker: 'I:SPX' },
        options: { vendor: 'thetadata' }, // SPX is ThetaData primary
      },
    },
  },
  {
    profile: NDX_0DTE_PROFILE,
    extras: {
      assetClass: 'index',
      tier: 2,
      vendorRouting: {
        underlying: { vendor: 'polygon', ticker: 'I:NDX' },
        options: { vendor: 'polygon' },
      },
    },
  },
  {
    profile: SPY_1DTE_PROFILE,
    extras: {
      assetClass: 'etf',
      tier: 1,
      // vendorRouting omitted → defaultRoutingFor('SPY', 'etf')
    },
  },
];

/**
 * Upsert code profiles into instrument_profiles. See module header for policy.
 * Idempotent — safe to call on every boot.
 */
export function seedCodeProfiles(db: DB): void {
  for (const { profile, extras } of SEEDS) {
    const vendorRouting = extras.vendorRouting ?? defaultRoutingFor(profile.execution.underlyingSymbol, extras.assetClass);
    const canGoLive = typeof profile.execution.accountId === 'string' && profile.execution.accountId.length > 0;

    const existing = loadProfile(db, profile.id);

    // Backtest-only profile that already exists in DB — leave it alone so
    // UI edits persist.
    if (existing && !canGoLive) continue;

    const stored = fromInstrumentProfile(profile, {
      assetClass: extras.assetClass,
      tier: extras.tier,
      vendorRouting,
      source: 'seed',
    });
    saveProfile(db, stored);
  }
}
