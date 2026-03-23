import axios from 'axios';
import { config, TRADIER_BASE } from '../config';
import type { ChainContract, OHLCVRaw } from '../types';
import { CircuitBreaker, withRetry, circuitBreakers } from '../utils/resilience';

const cb = new CircuitBreaker('tradier', { failureThreshold: 3, resetTimeoutMs: 30_000 });
circuitBreakers.set('tradier', cb);

function headers() {
  return {
    Authorization: `Bearer ${config.tradierToken}`,
    Accept: 'application/json',
  };
}

export interface SpxQuote {
  last: number;
  bid: number;
  ask: number;
  change: number;
  volume: number;
}

export function normalizeSymbol(symbol: string): string {
  if (/^SPXW\d{6}[CP]\d{8}$/.test(symbol)) return symbol;
  const match = symbol.match(/^(SPXW\d{6}[CP])([\d.]+)$/);
  if (!match) return symbol;
  const strike = Math.round(parseFloat(match[2]) * 1000);
  return `${match[1]}${String(strike).padStart(8, '0')}`;
}

export async function fetchSpxQuote(): Promise<SpxQuote | null> {
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(`${TRADIER_BASE}/markets/quotes`, {
        headers: headers(),
        params: { symbols: 'SPX' },
        timeout: 8000,
      }),
      { label: 'tradier:fetchSpxQuote' }
    )
  );
  if (!resp) return null;
  const q = resp.data?.quotes?.quote;
  if (!q) return null;
  return {
    last: q.last ?? q.bid ?? 0,
    bid: q.bid ?? 0,
    ask: q.ask ?? 0,
    change: q.change ?? 0,
    volume: q.volume ?? 0,
  };
}

export async function fetchExpirations(symbol: string): Promise<string[]> {
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(`${TRADIER_BASE}/markets/options/expirations`, {
        headers: headers(),
        params: { symbol, includeAllRoots: true },
        timeout: 8000,
      }),
      { label: 'tradier:fetchExpirations' }
    )
  );
  if (!resp) return [];
  const dates = resp.data?.expirations?.date;
  if (!dates) return [];
  return Array.isArray(dates) ? dates : [dates];
}

export async function fetchOptionsChain(
  symbol: string,
  expiry: string,
  greeks = true
): Promise<ChainContract[]> {
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(`${TRADIER_BASE}/markets/options/chains`, {
        headers: headers(),
        params: { symbol, expiration: expiry, greeks },
        timeout: 10000,
      }),
      { label: 'tradier:fetchOptionsChain' }
    )
  );
  if (!resp) return [];
  const opts = resp.data?.options?.option;
  if (!opts) return [];
  const list = Array.isArray(opts) ? opts : [opts];
  return list.map((o: any) => ({
    symbol: normalizeSymbol(o.symbol),
    type: o.option_type as 'call' | 'put',
    strike: o.strike,
    expiry,
    bid: o.bid ?? null,
    ask: o.ask ?? null,
    last: o.last ?? null,
    volume: o.volume ?? null,
    openInterest: o.open_interest ?? null,
    impliedVolatility: o.implied_volatility ?? null,
    delta: o.greeks?.delta ?? null,
    gamma: o.greeks?.gamma ?? null,
    theta: o.greeks?.theta ?? null,
    vega: o.greeks?.vega ?? null,
  }));
}

export interface BatchQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number;
  lastVolume: number;
  openInterest: number;
  change: number | null;
  changePct: number | null;
}

export async function fetchBatchQuotes(symbols: string[]): Promise<Map<string, BatchQuote>> {
  const result = new Map<string, BatchQuote>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const resp = await cb.call(() =>
      withRetry(
        () => axios.get(`${TRADIER_BASE}/markets/quotes`, {
          headers: headers(),
          params: { symbols: batch.join(',') },
          timeout: 10000,
        }),
        { label: 'tradier:fetchBatchQuotes' }
      )
    );
    if (!resp) continue;
    const quotes = resp.data?.quotes?.quote;
    if (!quotes) continue;
    const list = Array.isArray(quotes) ? quotes : [quotes];
    for (const q of list) {
      result.set(normalizeSymbol(q.symbol), {
        bid: q.bid ?? null,
        ask: q.ask ?? null,
        last: q.last ?? null,
        open: q.open ?? null,
        high: q.high ?? null,
        low: q.low ?? null,
        volume: q.volume ?? 0,
        lastVolume: q.last_volume ?? 0,
        openInterest: q.open_interest ?? 0,
        change: q.change ?? null,
        changePct: q.change_percentage ?? null,
      });
    }
  }
  return result;
}

export async function fetchSpxTimesales(date: string): Promise<OHLCVRaw[]> {
  return fetchTimesales('SPX', date);
}

/** Generic 1-min timesales for any symbol (SPX, SPXW options, etc.)
 *  date is optional — omit for option contracts (Tradier returns null with explicit dates for options) */
export async function fetchTimesales(symbol: string, date?: string): Promise<OHLCVRaw[]> {
  const params: Record<string, string> = { symbol, interval: '1min' };
  if (date) { params.start = date; params.end = date; }
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(`${TRADIER_BASE}/markets/timesales`, {
        headers: headers(),
        params,
        timeout: 10000,
      }),
      { label: 'tradier:fetchTimesales' }
    )
  );
  if (!resp) return [];
  const series = resp.data?.series?.data;
  if (!series) return [];
  const list = Array.isArray(series) ? series : [series];
  return list.map((d: any) => ({
    ts: Math.floor(new Date(d.time).getTime() / 1000),
    open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0,
  }));
}
