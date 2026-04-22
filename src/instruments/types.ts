/**
 * InstrumentProfile — the structural description of a tradable instrument.
 *
 * Design principle: profile = WHERE, config = HOW.
 *
 *   Profile describes the instrument itself: symbol, option prefix, strike
 *   geometry, which account it routes to, which provider feeds its data,
 *   and what expiry cadences the market offers.
 *
 *   Config (src/config/types.ts) describes the *strategy* applied to the
 *   instrument: signal rules, exit rules, risk knobs, expiry policy,
 *   ITM/OTM gating, strike selection method, etc. Every strategy choice
 *   lives in Config so it is testable via replay.
 *
 * The parity contract stays unchanged: same Config + same core/ functions
 * produce identical output in live and replay, regardless of which
 * InstrumentProfile they run against.
 *
 * This file introduces types only. Nothing here runs in the live SPX
 * agent yet — spx_agent.ts continues to hardcode its execution target.
 * Phase 2 will migrate the agent onto the profile registry.
 */

import type { Timeframe } from '../types';

/**
 * How option symbols are formatted for this instrument's options chain.
 *
 * Examples (OCC/Tradier canonical form: ROOT + YYMMDD + C/P + strike×1000 zero-padded to 8):
 *   SPX  (SPXW 0DTE): prefix='SPXW', strikeDivisor=1,  strikeInterval=5
 *   SPY  weekly:      prefix='SPY',  strikeDivisor=1,  strikeInterval=1
 *   QQQ  weekly:      prefix='QQQ',  strikeDivisor=1,  strikeInterval=1
 *   TSLA weekly:      prefix='TSLA', strikeDivisor=1,  strikeInterval varies by price
 *   NDX  weekly:      prefix='NDX',  strikeDivisor=1,  strikeInterval=25
 */
export interface OptionSymbolSpec {
  /** Root symbol used in option contract identifiers (e.g. 'SPXW', 'SPY'). */
  prefix: string;

  /**
   * Divisor applied before formatting strike into the symbol. 1 for most
   * instruments. Present for forward compatibility with instruments that
   * may need fractional strike handling.
   */
  strikeDivisor: number;

  /**
   * Canonical strike increment for this instrument's chain ($).
   * SPX=5, SPY=1, QQQ=1, NDX=25, etc.
   */
  strikeInterval: number;
}

/**
 * Session hours in 24h ET. Covers when we poll data for this instrument.
 * Bar-building and indicator computation obey these windows.
 */
export interface SessionHoursET {
  /** Pre-market start, e.g. '04:00' (stocks) or '08:00' (SPX index). */
  preMarket: string;
  /** Regular trading hours start, '09:30'. */
  rthStart: string;
  /** Regular trading hours end, '16:00' for indices, '16:00' for stocks. */
  rthEnd: string;
  /** Post-market end, e.g. '20:00' or '17:00'. */
  postMarket: string;
}

/**
 * Expiry cadences this instrument's options chain *offers* at the venue.
 * This is structural (what the market provides), not a strategy choice.
 * Which of these the strategy *uses* is decided in Config.expiryPolicy.
 */
export type ExpiryCadence =
  | 'daily'      // M-F 0DTE available (SPX, SPY, QQQ, IWM, NDX)
  | 'mwf'        // M/W/F only (some index products)
  | 'weekly'     // Friday weeklies (most single stocks)
  | 'monthly';   // Third-Friday standard (legacy);

/**
 * Execution routing: where orders for this instrument go.
 *
 * accountId is *optional*. A profile without an accountId can still have
 * its data collected and be replayed — it just cannot go live. This
 * matches the UI rule: "if no account is assigned, the symbol is
 * backtest-only." `canGoLive(profile)` is the canonical check.
 *
 * When accounts are shared across multiple instruments (Phase 4), the
 * one-profile-per-account invariant relaxes and allocation percentages
 * live in the account_allocations table.
 */
export interface ExecutionTarget {
  /**
   * Broker account ID that trades this instrument. Omit for
   * backtest-only / data-collection-only profiles.
   */
  accountId?: string;
  /**
   * Underlying symbol the data service keys on — distinct from the option
   * prefix (SPX's underlying is 'SPX', but its options prefix is 'SPXW').
   */
  underlyingSymbol: string;
}

/**
 * Optional two-phase stream setup. SPX uses this today:
 *   - Phase 1 at 08:00 ET connects the option stream with a preliminary band
 *   - Phase 2 at 09:30 ET "locks" the band around the RTH open price
 * For equities that trade pre-market without a meaningful settle-price
 * handoff, `twoPhase` can be omitted.
 */
export interface StreamPhases {
  phase1StartET?: string;
  phase2LockET?: string;
}

/**
 * The canonical structural description of a tradable instrument.
 *
 * This type is intentionally *free of strategy knobs*. It describes the
 * instrument, not the trading rules. Strategy knobs (DTE policy, ITM
 * guard, strike selection method, HMA/RSI thresholds, cooldowns, sizing
 * pct, etc.) belong in Config and are selected per-(profile, account)
 * binding in the account-allocations table.
 */
export interface InstrumentProfile {
  /** Stable identifier, e.g. 'spx-0dte'. Used as key in the registry and DB. */
  id: string;

  /** Human-readable name for UI/logs. */
  displayName: string;

  /** Execution routing (account, underlying symbol). */
  execution: ExecutionTarget;

  /** Option symbol formatting. */
  options: OptionSymbolSpec;

  /**
   * Data-provider routing is NOT on the profile. Vendor selection (ThetaData
   * primary, Tradier WS cold-standby for options; Tradier REST for
   * underlying + chain + orders; Polygon/ThetaData for historical backfill)
   * lives in the per-ticker pipeline orchestration under src/pipeline/{id}/,
   * not here. Profile stays structural — WHERE, not HOW.
   */

  /** When to poll / stream for this instrument, in ET. */
  session: SessionHoursET;

  /** Expiry cadences offered by the market for this symbol. */
  offeredExpiryCadences: ExpiryCadence[];

  /** Optional two-phase stream setup (SPX-style). */
  streamPhases?: StreamPhases;

  /**
   * Native bar timeframe the pipeline builds for this instrument.
   * All higher timeframes are aggregated from this. Default '1m'.
   */
  baseTimeframe: Timeframe;

  /**
   * Sticky-band width in $ around underlying for contract tracking.
   * SPX uses ±$100; equities typically need tighter or wider depending
   * on strike interval × expected intraday range.
   */
  bandWidthDollars: number;
}
