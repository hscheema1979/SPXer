import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3600'),
  tradierToken: process.env.TRADIER_TOKEN || '',
  tradierAccountId: process.env.TRADIER_ACCOUNT_ID || '',
  gdriveRemote: process.env.GDRIVE_REMOTE || 'gdrive:SPXer/archives',
  dbPath: process.env.DB_PATH || './data/spxer.db',
  logLevel: process.env.LOG_LEVEL || 'info',
};

export const TRADIER_BASE = 'https://api.tradier.com/v1';

export const MARKET_HOLIDAYS = new Set([
  '2025-01-01','2025-01-20','2025-02-17','2025-04-18',
  '2025-05-26','2025-06-19','2025-07-04','2025-09-01',
  '2025-11-27','2025-12-25',
  '2026-01-01','2026-01-19','2026-02-16','2026-04-03',
  '2026-05-25','2026-06-19','2026-07-03','2026-08-31',
  '2026-11-26','2026-12-25',
  '2027-01-01','2027-01-18','2027-02-15','2027-03-26',
  '2027-05-31','2027-06-18','2027-07-05','2027-09-06',
  '2027-11-25','2027-12-24',
]);

export const EARLY_CLOSE_DAYS = new Set([
  '2025-07-03','2025-11-28',
  '2026-07-02','2026-11-27',
  '2027-07-02','2027-11-26',
]);

export const STRIKE_BAND = 100;
export const STRIKE_INTERVAL = 5;
export const POLL_UNDERLYING_MS = 60_000;
export const POLL_OPTIONS_RTH_MS = 30_000;
export const POLL_OPTIONS_OVERNIGHT_MS = 300_000;
export const POLL_SCREENER_MS = 60_000;
export const GAP_INTERPOLATE_MAX_MINS = 60;
export const MAX_BARS_MEMORY = 2000;

/** ET time to initialize option stream (connect WebSocket, start building option bars).
 *  Set to 09:22 — 8 minutes before market open. Pre-market SPX from Tradier is firm
 *  enough by now to pick the ideal ±100 strike band; the subscription settles well
 *  before 9:30 so OPRA prints flow immediately at open without a subscribe-storm.
 *  SPX underlying indicators are warmed separately from 8:00 ET via the Tradier
 *  timesales poll and don't depend on the option stream. */
export const OPTION_STREAM_WAKE_ET = process.env.OPTION_STREAM_WAKE_ET || '09:22';
/** ET time to stop option stream (close WebSocket, expire 0DTE contracts) */
export const OPTION_STREAM_CLOSE_ET = '17:00';

/** Max age (ms) of the last TRADE/QUOTE frame from ThetaData WS before we stop
 *  treating it as primary. STATUS keepalives don't count — they arrive every ~1s
 *  even when no market data is flowing, so a pure `isConnected()` check can miss
 *  a silent feed. On ATM 0DTE with ~200 contracts subscribed, quote traffic is
 *  effectively continuous during RTH, so 15s is a comfortable margin. If this
 *  window is exceeded, `thetaIsPrimary()` returns false and Tradier WS ticks
 *  start flowing through `OptionCandleBuilder` until ThetaData resumes. */
export const OPTION_STREAM_THETA_STALE_MS = Number(process.env.OPTION_STREAM_THETA_STALE_MS ?? 15_000);
