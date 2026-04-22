/**
 * SPX 0DTE profile — extracted from the values spx_agent.ts hardcodes today.
 *
 * This profile is the *structural* description of the SPX 0DTE instrument.
 * It matches EXACTLY what spx_agent.ts sets in its local `EXECUTION` object
 * plus the session/phase timings the data pipeline applies to SPX today.
 *
 * Until Phase 2, spx_agent.ts does not import this profile — it is here as
 * the first concrete profile for the registry and for new agents built on
 * the agnostic framework. Parity with live SPX is preserved because we
 * are not changing the agent, only documenting its facts in a typed form.
 */

import type { InstrumentProfile } from '../types';

export const SPX_0DTE_PROFILE: InstrumentProfile = {
  id: 'spx-0dte',
  displayName: 'SPX 0DTE',

  execution: {
    // Tradier margin account — source of truth is spx_agent.ts:74
    accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
    underlyingSymbol: 'SPX',
  },

  options: {
    // From spx_agent.ts:71-73
    prefix: 'SPXW',
    strikeDivisor: 1,
    strikeInterval: 5,
  },

  session: {
    // SPX index hours: 08:00 ET pre-open timesales, 09:30–16:00 RTH.
    // Matches the data-service's RTH-mode polling window.
    preMarket: '08:00',
    rthStart: '09:30',
    rthEnd: '16:00',
    postMarket: '16:15',
  },

  offeredExpiryCadences: ['daily'],

  streamPhases: {
    // Two-phase band setup documented in CLAUDE.md:
    //   Phase 1 at 08:00 ET connects WS with preliminary strike band
    //   Phase 2 at 09:30 ET locks band on firm SPX opening price
    phase1StartET: '08:00',
    phase2LockET: '09:30',
  },

  baseTimeframe: '1m',

  bandWidthDollars: 100,
};
