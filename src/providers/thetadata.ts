/**
 * ThetaData provider — connects to the locally-running ThetaTerminal v3.
 *
 * Terminal ports (set in .env):
 *   - REST + MCP: THETADATA_REST_URL (default http://127.0.0.1:25503)
 *   - WS:         THETADATA_WS_URL   (default ws://127.0.0.1:25520)
 *
 * Migrated from v2 → v3 on 2026-04-20:
 *   - Port 25510 → 25503 (HTTP server + MCP both on 25503; WS stays on 25520)
 *   - /v2/hist/option/<req>   → /v3/option/history/<req>
 *   - Params renamed: root→symbol, exp→expiration(ISO), ivl→interval("1m"),
 *     right C/P → "call"/"put", strike (×1000 int) → float dollars,
 *     use_csv → format, rth removed (use start_time/end_time)
 *   - Response shape: {header:{format:[]}, response:[rows]} →
 *     {response:[{contract, data:[{timestamp,open,high,low,close,volume,...}]}]}
 *
 * Index endpoints (SPX/NDX underlying) require Standard Index subscription;
 * current bundle is Index.FREE. SPXer uses Polygon (I:SPX / I:NDX aggregates)
 * for underlying historical backfill — see scripts/backfill/backfill-worker.ts.
 *
 * Symbol format
 *   ThetaData v3 uses (symbol=root, expiration="YYYY-MM-DD", right="call"|"put", strike=float).
 *   SPXer canonical is "<ROOT>YYMMDD<R><strike×1000 zero-padded 8>":
 *     SPXW260319C06610000   (root=SPXW, strike=$6610)
 *     NDXP260420P26000000   (root=NDXP, strike=$26000)
 *   parseOptionSymbol() converts between the two.
 */
import axios from 'axios';
import type { OHLCVRaw } from '../types';
import { CircuitBreaker, withRetry, circuitBreakers } from '../utils/resilience';
import { filterValidRaws } from '../core/bar-validator';

const REST = process.env.THETADATA_REST_URL || 'http://127.0.0.1:25503';

const cb = new CircuitBreaker('thetadata', { failureThreshold: 3, resetTimeoutMs: 30_000 });
circuitBreakers.set('thetadata', cb);

// ── Symbol helpers ──────────────────────────────────────────────────────────

export interface ParsedOptionSymbol {
  root: string;           // "SPXW", "NDXP", "SPY", "QQQ", etc.
  expYYYYMMDD: number;    // 20260319 (used by WS subscribe payload)
  expISO: string;         // "2026-03-19" (used by v3 REST)
  right: 'C' | 'P';
  rightWord: 'call' | 'put'; // v3 REST wants the word
  strike1000: number;     // strike × 1000 (used by WS + OCC reconstruction)
  strikeDollars: number;  // strike in plain dollars (used by v3 REST)
}

/** e.g. "SPXW260319C06610000" or "NDXP260420C26000000" → parsed fields. */
export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const m = symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, root, yy, mm, dd, right, strikeStr] = m;
  const strike1000 = parseInt(strikeStr, 10);
  return {
    root,
    expYYYYMMDD: parseInt(`20${yy}${mm}${dd}`, 10),
    expISO: `20${yy}-${mm}-${dd}`,
    right: right as 'C' | 'P',
    rightWord: right === 'C' ? 'call' : 'put',
    strike1000,
    strikeDollars: strike1000 / 1000,
  };
}

// ── HTTP helper ─────────────────────────────────────────────────────────────

async function thetaGet<T = any>(pathAndQuery: string, label: string): Promise<T | null> {
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(`${REST}${pathAndQuery}`, { timeout: 15_000 }),
      { label: `thetadata:${label}` }
    )
  );
  return (resp?.data as T) ?? null;
}

/** v3 grouped-by-contract response shape. */
interface V3ContractResponse {
  response: Array<{
    contract: { symbol: string; expiration: string; right: string; strike: number };
    data: Array<{
      timestamp: string;    // "2026-04-17T09:30:00.000" — ET wall clock, no TZ suffix
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      vwap?: number;
      count?: number;
    }>;
  }>;
}

// ── Timestamp helpers ───────────────────────────────────────────────────────

/**
 * v3 timestamps are ET wall clock without TZ suffix (e.g. "2026-04-17T09:30:00.000").
 * Convert to Unix seconds (UTC) by parsing the wall-clock components and
 * adding the ET offset (4h for EDT, 5h for EST) using Intl.DateTimeFormat
 * — same pattern used in src/utils/et-time.ts.
 */
export function v3TimestampToUnixSec(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const Y = parseInt(m[1], 10);
  const Mo = parseInt(m[2], 10);
  const D = parseInt(m[3], 10);
  const H = parseInt(m[4], 10);
  const Mi = parseInt(m[5], 10);
  const S = parseInt(m[6], 10);
  // Treat the wall-clock components as if they were UTC, then add the ET offset
  // to recover the real UTC instant.
  const asIfUTC = Date.UTC(Y, Mo - 1, D, H, Mi, S);
  const noon = new Date(Date.UTC(Y, Mo - 1, D, 12, 0, 0));
  const etFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', hour12: false,
  });
  const etHourAtNoonUTC = parseInt(etFormatter.format(noon), 10); // 7 EDT or 8 EST
  const etOffsetMs = (12 - etHourAtNoonUTC) * 3600_000; // +4h EDT, +5h EST
  return Math.floor((asIfUTC + etOffsetMs) / 1000);
}

// ── Historical 1m bars ──────────────────────────────────────────────────────

/**
 * Index endpoints (/v3/index/history/*) require a Standard Index subscription;
 * our current bundle is Index.FREE. Returns [] and logs a warning.
 * Backfill uses Polygon I:SPX / I:NDX aggregates for underlying history instead.
 */
export async function fetchSpxTimesales(_date: string): Promise<OHLCVRaw[]> {
  console.warn('[thetadata] fetchSpxTimesales: Index endpoints require Standard Index subscription — use Polygon I:SPX instead');
  return [];
}

/**
 * Fetch 1-minute OHLC bars for an option contract on a given date via v3 REST.
 * Works for any root the SPXer symbol format supports (SPXW, NDXP, SPY, QQQ, …).
 *
 *   GET /v3/option/history/ohlc
 *     ?symbol=SPXW &expiration=2026-04-17 &right=call &strike=7125
 *     &start_date=2026-04-17 &end_date=2026-04-17 &interval=1m &format=json
 */
export async function fetchOptionTimesales(symbol: string, date: string): Promise<OHLCVRaw[]> {
  const parsed = parseOptionSymbol(symbol);
  if (!parsed) {
    console.warn(`[thetadata] unparseable symbol: ${symbol}`);
    return [];
  }
  const url =
    `/v3/option/history/ohlc` +
    `?symbol=${encodeURIComponent(parsed.root)}` +
    `&expiration=${parsed.expISO}` +
    `&right=${parsed.rightWord}` +
    `&strike=${parsed.strikeDollars}` +
    `&start_date=${date}` +
    `&end_date=${date}` +
    `&interval=1m` +
    `&format=json`;

  const data = await thetaGet<V3ContractResponse>(url, 'fetchOptionTimesales');
  if (!data?.response || data.response.length === 0) return [];

  // v3 groups by contract; single-contract request → response[0] has all bars.
  const rows = data.response[0]?.data ?? [];
  const raws: OHLCVRaw[] = rows
    .map((r) => ({
      ts: v3TimestampToUnixSec(r.timestamp),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume ?? 0,
    }))
    .filter((b) => Number.isFinite(b.ts));
  return filterValidRaws(raws, `thetadata:${symbol}`);
}

/** Generic timesales shim — routes to (unsupported) index or option by symbol shape. */
export async function fetchTimesales(symbol: string, date: string): Promise<OHLCVRaw[]> {
  if (symbol === 'SPX' || symbol === 'NDX') return fetchSpxTimesales(date);
  return fetchOptionTimesales(symbol, date);
}

// ── Health ──────────────────────────────────────────────────────────────────

/**
 * Liveness probe. Uses an options-tier endpoint that works on the
 * Options.STANDARD subscription we carry.
 */
export async function ping(): Promise<boolean> {
  const data = await thetaGet<any>('/v3/option/list/dates?symbol=SPXW&format=json', 'ping');
  return Array.isArray(data?.response) && data.response.length > 0;
}
