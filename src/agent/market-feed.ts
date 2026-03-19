/**
 * MarketFeed: polls SPXer REST API every 60s, caches bar data per symbol,
 * provides SpxContext and per-contract BarSummary arrays to the signal detector.
 */
import axios from 'axios';
import type { BarSummary, SpxContext } from './types';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

export interface ContractMeta {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  expiry: string;
}

export interface FeedSnapshot {
  contracts: ContractMeta[];
  barsBySymbol: Map<string, BarSummary[]>;
  spxContext: SpxContext;
  ts: number;
}

async function fetchJson<T>(path: string): Promise<T> {
  const { data } = await axios.get(`${SPXER_BASE}${path}`, { timeout: 8000 });
  return data as T;
}

function calcTrend(bars: BarSummary[]): 'bullish' | 'bearish' | 'neutral' {
  if (bars.length < 5) return 'neutral';
  const recent = bars.slice(-5);
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  const pct = (last - first) / first;
  if (pct > 0.001) return 'bullish';
  if (pct < -0.001) return 'bearish';
  return 'neutral';
}

function minutesToClose(): number {
  const etOffset = 5 * 60 * 60 * 1000;
  const nowET = new Date(Date.now() - etOffset);
  const closeET = new Date(nowET);
  closeET.setUTCHours(16, 0, 0, 0);
  return Math.max(0, Math.floor((closeET.getTime() - nowET.getTime()) / 60000));
}

export async function fetchSnapshot(): Promise<FeedSnapshot> {
  // 1. Active contracts
  const activeContracts: any[] = await fetchJson('/contracts/active');

  const contracts: ContractMeta[] = activeContracts
    .filter(c => c.state === 'ACTIVE' || c.state === 'STICKY')
    .map(c => ({
      symbol: c.symbol,
      side: c.type as 'call' | 'put',
      strike: c.strike,
      expiry: c.expiry,
    }));

  // 2. SPX bars for context
  const spxBars: any[] = await fetchJson<any[]>('/spx/bars?tf=1m&n=20').catch(() => []);
  const spxBarSummaries: BarSummary[] = spxBars.map(b => ({
    ts: b.ts,
    close: b.close,
    rsi14: b.indicators?.rsi14 ?? null,
    ema9: b.indicators?.ema9 ?? null,
    ema21: b.indicators?.ema21 ?? null,
    hma5: b.indicators?.hma5 ?? null,
    hma19: b.indicators?.hma19 ?? null,
  }));

  const latestSpx = spxBarSummaries[spxBarSummaries.length - 1];
  const prevSpx = spxBarSummaries.length > 1 ? spxBarSummaries[spxBarSummaries.length - 2] : null;
  const changePercent = latestSpx && prevSpx
    ? ((latestSpx.close - prevSpx.close) / prevSpx.close) * 100
    : 0;

  const health: any = await fetchJson('/health').catch(() => ({}));

  const spxContext: SpxContext = {
    price: latestSpx?.close ?? 0,
    changePercent,
    trend: calcTrend(spxBarSummaries),
    rsi14: latestSpx?.rsi14 ?? null,
    minutesToClose: minutesToClose(),
    mode: health.mode ?? 'unknown',
  };

  // 3. Bars per contract (parallel, max 20 contracts to avoid hammering)
  const barsBySymbol = new Map<string, BarSummary[]>();
  const subset = contracts.slice(0, 20);

  await Promise.allSettled(
    subset.map(async c => {
      const bars: any[] = await fetchJson<any[]>(`/contracts/${c.symbol}/bars?tf=1m&n=20`).catch(() => []);
      const summaries: BarSummary[] = bars.map(b => ({
        ts: b.ts,
        close: b.close,
        rsi14: b.indicators?.rsi14 ?? null,
        ema9: b.indicators?.ema9 ?? null,
        ema21: b.indicators?.ema21 ?? null,
        hma5: b.indicators?.hma5 ?? null,
        hma19: b.indicators?.hma19 ?? null,
      }));
      if (summaries.length > 0) barsBySymbol.set(c.symbol, summaries);
    })
  );

  return { contracts, barsBySymbol, spxContext, ts: Date.now() };
}
