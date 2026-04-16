import axios from 'axios';
import type { OHLCVRaw } from '../types';
import { CircuitBreaker, withRetry, circuitBreakers } from '../utils/resilience';
import { filterValidRaws } from '../core/bar-validator';

const cb = new CircuitBreaker('yahoo', { failureThreshold: 3, resetTimeoutMs: 30_000 });
circuitBreakers.set('yahoo', cb);

const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = { 'User-Agent': 'Mozilla/5.0' };

export async function fetchYahooBars(
  symbol: string,
  interval: '1m' | '5m' | '15m' | '1h' | '1d',
  range: '1d' | '2d' | '5d' | '30d' | '60d' | '1y'
): Promise<OHLCVRaw[]> {
  const encoded = encodeURIComponent(symbol);
  const url = `${YAHOO_BASE}/${encoded}?interval=${interval}&range=${range}`;
  const resp = await cb.call(() =>
    withRetry(
      () => axios.get(url, { headers: HEADERS, timeout: 10000 }),
      { label: 'yahoo:fetchYahooBars' }
    )
  );
  if (!resp) return [];
  const result = resp.data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const opens: (number | null)[] = quote.open || [];
  const highs: (number | null)[] = quote.high || [];
  const lows: (number | null)[] = quote.low || [];
  const closes: (number | null)[] = quote.close || [];
  const volumes: (number | null)[] = quote.volume || [];

  const bars: OHLCVRaw[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue;
    bars.push({
      ts: timestamps[i],
      open: opens[i] ?? close,
      high: highs[i] ?? close,
      low: lows[i] ?? close,
      close,
      volume: volumes[i] ?? 0,
    });
  }
  return filterValidRaws(bars, `yahoo:${symbol}`);
}
