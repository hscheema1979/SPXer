/**
 * Barrel export for the instruments framework.
 *
 * Import surface:
 *   import { requireProfile, listProfiles, InstrumentProfile } from 'src/instruments';
 */
export type {
  InstrumentProfile,
  OptionSymbolSpec,
  ExecutionTarget,
  SessionHoursET,
  ExpiryCadence,
  StreamPhases,
} from './types';

export {
  getProfile,
  requireProfile,
  listProfiles,
  profileForAccount,
  canGoLive,
  refreshRegistryCache,
  resetRegistryCache,
} from './registry';

export { SPX_0DTE_PROFILE } from './profiles/spx-0dte';
export { SPY_1DTE_PROFILE } from './profiles/spy-1dte';
export { NDX_0DTE_PROFILE } from './profiles/ndx-0dte';

// DB-backed profile store — richer type than legacy InstrumentProfile.
export {
  loadProfile,
  listProfiles as listStoredProfiles,
  saveProfile,
  deleteProfile,
  profileExists,
  toInstrumentProfile,
  fromInstrumentProfile,
} from './profile-store';
export type {
  StoredInstrumentProfile,
  AssetClass,
  ProfileSource,
  Tier,
  VendorRouting,
} from './profile-store';

// Vendor routing helpers.
export { resolveBackfillRouting, defaultRoutingFor, checkVendorReadiness } from './backfill-routing';
export type { UnderlyingVendor, OptionVendor } from './backfill-routing';

// Discovery service.
export { discoverProfile, clearDiscoveryCache, DiscoveryError } from './discovery';
export type { DiscoveredProfile } from './discovery';

// Seeding helpers (exported for tests).
export { seedCodeProfiles } from './seed-profiles';

export {
  roundStrike,
  formatExpiryCode,
  formatStrikeCode,
  formatOptionSymbol,
  parseOptionSymbol,
} from './symbol-format';
export type { CallOrPut, ParsedOptionSymbol } from './symbol-format';

export {
  addDays,
  dateDiffDays,
  dayOfWeek,
  isMarketHoliday,
  isTradingDay,
  nextTradingDay,
  tradingDayOnOrAfter,
  resolveExpiry,
} from './expiry-resolver';
export type {
  ExpiryPolicy,
  ExpiryPolicyOptions,
  ResolveExpiryContext,
  ResolvedExpiry,
} from './expiry-resolver';
