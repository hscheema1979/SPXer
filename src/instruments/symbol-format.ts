/**
 * Profile-aware option symbol formatting and strike rounding.
 *
 * Pure utilities — no I/O, no broker calls. These generalize the inline
 * SPXW-specific logic that spx_agent.ts and src/agent/trade-executor.ts
 * use today, so future agents (SPY, QQQ, TSLA, …) can share the same
 * correctness-critical code.
 *
 * Canonical OCC/Tradier option symbol format:
 *
 *     {ROOT}{YYMMDD}{C|P}{STRIKE*1000, 8-digit zero-padded}
 *
 * Examples:
 *     SPX 0DTE call @ 7100 on 2026-04-20 → 'SPXW260420C07100000'
 *     SPY 1DTE put  @ 440  on 2026-04-21 → 'SPY260421P00440000'
 *     TSLA 7DTE call @ 250 on 2026-04-25 → 'TSLA260425C00250000'
 *
 * Symbol strings produced by this module must be byte-identical to what
 * SPX already uses for parity — these utilities are tested against known
 * SPX symbols.
 */

import type { InstrumentProfile } from './types';

/** Right (call) or left (put) side of the chain. */
export type CallOrPut = 'C' | 'P';

/**
 * Round a raw target strike to the nearest strike that actually exists on
 * this instrument's chain, respecting the profile's strikeInterval and
 * strikeDivisor.
 *
 * @param profile      The instrument profile (provides strikeDivisor and strikeInterval)
 * @param targetStrike The ideal strike in dollars (may not be on the grid)
 * @returns            A strike aligned to the chain's grid, in dollars
 */
export function roundStrike(profile: InstrumentProfile, targetStrike: number): number {
  const divisor = profile.options.strikeDivisor || 1;
  const interval = profile.options.strikeInterval || 1;
  const adjusted = targetStrike / divisor;
  return Math.round(adjusted / interval) * interval;
}

/**
 * Format an expiry Date into the YYMMDD portion of the option symbol.
 * The date is interpreted in its source timezone (typically already ET).
 *
 * @param expiry The expiry date as a Date, 'YYYY-MM-DD' string, or YYMMDD string
 */
export function formatExpiryCode(expiry: Date | string): string {
  if (typeof expiry === 'string') {
    // 'YYYY-MM-DD' form
    const isoMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
      return `${isoMatch[1].slice(2)}${isoMatch[2]}${isoMatch[3]}`;
    }
    // Already in YYMMDD form
    if (/^\d{6}$/.test(expiry)) return expiry;
    throw new Error(`[symbol-format] Unrecognized expiry string: '${expiry}'`);
  }
  const yy = String(expiry.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(expiry.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(expiry.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Format the strike portion of the option symbol: strike × 1000, zero-padded
 * to 8 digits. Matches the existing SPX formatting at trade-executor.ts:208.
 */
export function formatStrikeCode(strike: number): string {
  return Math.round(strike * 1000).toString().padStart(8, '0');
}

/**
 * Build a canonical OCC/Tradier option symbol for this profile.
 *
 * Caller is responsible for passing a strike already rounded to the chain's
 * grid — typically via `roundStrike(profile, rawTarget)`.
 *
 * @returns e.g. 'SPXW260420C07100000'
 */
export function formatOptionSymbol(
  profile: InstrumentProfile,
  expiry: Date | string,
  strike: number,
  side: CallOrPut
): string {
  const expiryCode = formatExpiryCode(expiry);
  const strikeCode = formatStrikeCode(strike);
  return `${profile.options.prefix}${expiryCode}${side}${strikeCode}`;
}

/**
 * Parse a canonical option symbol back into its parts. Useful for log
 * parsing, reconciliation, and tests.
 *
 * Returns null for malformed input. Does not require the profile to match —
 * instead returns the root so callers can validate.
 */
export interface ParsedOptionSymbol {
  root: string;
  expiryYYMMDD: string;
  side: CallOrPut;
  strike: number;
}

export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  // Root (1-6 letters), YYMMDD (6 digits), C|P, strike (8 digits)
  const m = symbol.match(/^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, expiryYYMMDD, sideRaw, strikeRaw] = m;
  return {
    root,
    expiryYYMMDD,
    side: sideRaw as CallOrPut,
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}
