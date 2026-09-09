/**
 * instruments.ts — which instruments the live-capture daemon polls each RTH.
 *
 * Since Polygon + ThetaData were cancelled, Tradier (live brokerage market
 * data) is the only remaining source. It serves underlying quotes and option
 * chains WITH greeks (delta/gamma/theta/vega/IV, refreshed ~hourly by ORATS)
 * in a single call per expiry. We poll each of these instruments once per
 * minute during market hours and append the ATM±window slice to parquet.
 *
 * `profileId` is the subdirectory under both data/parquet/snapshots/ and
 * data/parquet/bars/ — kept consistent with the existing backtest profiles
 * (spx-0dte, ndx-0dte, spy-1dte, qqq-1dte) plus xsp-0dte and the 2026-09
 * additions spx-1dte / ndx-1dte (prior-day slices of the next expiry, so
 * MA-style indicators can continue across sessions).
 */

export interface CaptureInstrument {
  /** Parquet subdir + logical profile id. */
  profileId: string;
  /** Tradier symbol for the underlying quote (index or ETF). */
  underlyingSymbol: string;
  /** Tradier symbol used to request the option chain (same as underlying). */
  chainSymbol: string;
  /**
   * Which expiry to capture, in *calendar* selection terms:
   *   0 → nearest expiry on/after today (0DTE on daily-expiry names)
   *   1 → first expiry strictly after today (1DTE)
   */
  dte: 0 | 1;
  /** Half-width of the strike window as a fraction of spot (0.10 = ±10%). */
  windowPct: number;
  /** RTH close in ET — options stop updating shortly after. */
  rthEndET: string;
}

/**
 * Cash-settled index options (SPXW/NDXP/XSP) trade until 16:15 ET; ETF
 * options (SPY/QQQ) until 16:00 ET.
 */
export const CAPTURE_INSTRUMENTS: CaptureInstrument[] = [
  { profileId: 'spx-0dte', underlyingSymbol: 'SPX', chainSymbol: 'SPX', dte: 0, windowPct: 0.10, rthEndET: '16:15' },
  { profileId: 'spx-1dte', underlyingSymbol: 'SPX', chainSymbol: 'SPX', dte: 1, windowPct: 0.10, rthEndET: '16:15' },
  { profileId: 'ndx-0dte', underlyingSymbol: 'NDX', chainSymbol: 'NDX', dte: 0, windowPct: 0.10, rthEndET: '16:15' },
  { profileId: 'ndx-1dte', underlyingSymbol: 'NDX', chainSymbol: 'NDX', dte: 1, windowPct: 0.10, rthEndET: '16:15' },
  { profileId: 'xsp-0dte', underlyingSymbol: 'XSP', chainSymbol: 'XSP', dte: 0, windowPct: 0.10, rthEndET: '16:15' },
  { profileId: 'spy-1dte', underlyingSymbol: 'SPY', chainSymbol: 'SPY', dte: 1, windowPct: 0.10, rthEndET: '16:00' },
  { profileId: 'qqq-1dte', underlyingSymbol: 'QQQ', chainSymbol: 'QQQ', dte: 1, windowPct: 0.10, rthEndET: '16:00' },
];

/** RTH open in ET — same for every instrument. */
export const RTH_START_ET = '09:30';
