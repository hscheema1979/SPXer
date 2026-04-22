/**
 * SPY 1DTE profile — placeholder, backtest-only until an account is assigned.
 *
 * Purpose of this file in Phase 1:
 *   - Prove the InstrumentProfile type accommodates a second, structurally
 *     different instrument (ETF options with tighter strikes, physical
 *     settlement, no two-phase band lock).
 *   - Exercise the optional-accountId path in the registry.
 *   - Serve as the template future tickers (QQQ, IWM, TSLA, NVDA) will clone.
 *
 * This profile is NOT routed to any account. The live agent cannot pick
 * it up (canGoLive returns false). Data collection and replay can use it
 * once the pipeline is profile-aware in Phase 2.
 *
 * Strategy knobs (1DTE vs 0DTE, ITM guard, strike selection method, exit
 * rules) live in Config — not here.
 */

import type { InstrumentProfile } from '../types';

export const SPY_1DTE_PROFILE: InstrumentProfile = {
  id: 'spy-1dte',
  displayName: 'SPY 1DTE',

  execution: {
    // No accountId yet — backtest-only until user assigns one in the UI.
    underlyingSymbol: 'SPY',
  },

  options: {
    prefix: 'SPY',
    strikeDivisor: 1,
    strikeInterval: 1, // SPY has $1 strikes (sometimes $0.50 near ATM, we round conservatively)
  },

  session: {
    // Equity ETF: pre-market 04:00–09:30, RTH 09:30–16:00, post-market 16:00–20:00.
    preMarket: '04:00',
    rthStart: '09:30',
    rthEnd: '16:00',
    postMarket: '20:00',
  },

  offeredExpiryCadences: ['daily'],

  // No two-phase band setup — SPY has liquid pre-market, no handoff gap.

  baseTimeframe: '1m',

  // SPY trades near 1/10 of SPX. ±$10 band covers ~2% move, generous for 1DTE.
  bandWidthDollars: 10,
};
