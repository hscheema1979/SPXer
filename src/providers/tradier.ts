import axios from 'axios';
import { config, TRADIER_BASE } from '../config';
import type { ChainContract, OHLCVRaw } from '../types';

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

export async function fetchSpxQuote(): Promise<SpxQuote> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
    headers: headers(),
    params: { symbols: 'SPX' },
    timeout: 8000,
  });
  const q = data?.quotes?.quote;
  return {
    last: q.last ?? q.bid ?? 0,
    bid: q.bid ?? 0,
    ask: q.ask ?? 0,
    change: q.change ?? 0,
    volume: q.volume ?? 0,
  };
}

export async function fetchExpirations(symbol: string): Promise<string[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/options/expirations`, {
    headers: headers(),
    params: { symbol, includeAllRoots: true },
    timeout: 8000,
  });
  const dates = data?.expirations?.date;
  if (!dates) return [];
  return Array.isArray(dates) ? dates : [dates];
}

export async function fetchOptionsChain(
  symbol: string,
  expiry: string,
  greeks = true
): Promise<ChainContract[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/options/chains`, {
    headers: headers(),
    params: { symbol, expiration: expiry, greeks },
    timeout: 10000,
  });
  const opts = data?.options?.option;
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

export async function fetchBatchQuotes(symbols: string[]): Promise<Map<string, { bid: number | null; ask: number | null; last: number | null }>> {
  const result = new Map<string, { bid: number | null; ask: number | null; last: number | null }>();
  for (let i = 0; i < symbols.length; i += 50) {
    const batch = symbols.slice(i, i + 50);
    const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
      headers: headers(),
      params: { symbols: batch.join(',') },
      timeout: 10000,
    });
    const quotes = data?.quotes?.quote;
    if (!quotes) continue;
    const list = Array.isArray(quotes) ? quotes : [quotes];
    for (const q of list) {
      result.set(normalizeSymbol(q.symbol), {
        bid: q.bid ?? null, ask: q.ask ?? null, last: q.last ?? null,
      });
    }
  }
  return result;
}

export async function fetchSpxTimesales(date: string): Promise<OHLCVRaw[]> {
  const { data } = await axios.get(`${TRADIER_BASE}/markets/timesales`, {
    headers: headers(),
    params: { symbol: 'SPX', interval: '1min', start: date, end: date, session_filter: 'all' },
    timeout: 10000,
  });
  const series = data?.series?.data;
  if (!series) return [];
  const list = Array.isArray(series) ? series : [series];
  return list.map((d: any) => ({
    ts: Math.floor(new Date(d.time).getTime() / 1000),
    open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0,
  }));
}
