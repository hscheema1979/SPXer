/**
 * NDX 0DTE profile — backtest-only until an account is assigned.
 *
 * Values locked in by live Tradier probe on 2026-04-20:
 *   - GET /markets/quotes?symbols=NDX → {last: 26360.43, type: 'index', ...}
 *   - GET /markets/options/expirations?symbol=NDX&includeAllRoots=true
 *       → daily weekday expiries (0DTE confirmed)
 *   - GET /markets/options/chains?symbol=NDX&expiration=2026-04-20
 *       → 844 contracts, all roots = 'NDXP'
 *       → ATM strikes at $10 interval (26200, 26210, 26220, ...)
 *       → Wings get coarser: $100/$200/$500/$1000
 *       → Symbol format: NDXP260420C26200000 (OCC canonical, same as SPX)
 *
 * Tunable knobs marked with TODO belong in Config once the NDX strategy is
 * tested in replay. Profile stays structural per the "profile = WHERE,
 * config = HOW" rule.
 */

import type { InstrumentProfile } from '../types';

export const NDX_0DTE_PROFILE: InstrumentProfile = {
  id: 'ndx-0dte',
  displayName: 'NDX 0DTE',

  execution: {
    // Backtest-only — no NDX account assigned yet. canGoLive() will be false.
    accountId: undefined,
    underlyingSymbol: 'NDX',
  },

  options: {
    prefix: 'NDXP',
    strikeDivisor: 1,
    // ATM interval on the live chain. NDX chain uses $10 strikes at the money;
    // wings coarsen to $100/$200/$500/$1000. The pipeline's strike-band logic
    // will only generate ATM strikes, so $10 is the right base interval.
    strikeInterval: 10,
  },

  session: {
    // NDX is a CBOE-listed index; same Tradier timesales window as SPX.
    preMarket: '08:00',
    rthStart: '09:30',
    rthEnd: '16:00',
    postMarket: '16:15',
  },

  offeredExpiryCadences: ['daily'],

  // Stream phases intentionally omitted — NDX pipeline is not wired yet.
  // When the ndx/ pipeline folder is built, will match SPX's shipped
  // single-phase 09:22 ET wake (see docs/MULTI-TICKER-PLAN.md).

  baseTimeframe: '1m',

  // Starting value. NDX at ~$26k with $10 strikes → ±$500 band yields
  // ~100 strikes per side per expiry, comparable to SPX's ~40 strikes × 2 sides.
  // TODO: tune against replay win rate / contract liquidity once data lands.
  bandWidthDollars: 500,
};
