/**
 * MarketFeed: fetches current market state across sub-minute quotes, 1m, 3m, and 5m bars.
 * Called every 15-30s by the continuous agent loop.
 */
import axios from 'axios';
import type { BarSummary } from './types';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';
const TRADIER_BASE = 'https://api.tradier.com/v1';

function tradierHeaders() {
  return { Authorization: `Bearer ${process.env.TRADIER_TOKEN}`, Accept: 'application/json' };
}

async function get<T>(url: string, params?: Record<string, string | number>): Promise<T> {
  const { data } = await axios.get(url, { params, timeout: 6000 });
  return data as T;
}

export interface LiveQuote {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  change: number | null;
  changePct: number | null;
}

export interface ContractMeta {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  expiry: string;
}

/** Aggregate 1m bars into N-minute bars, aligned from the newest bar backward */
function aggregate(bars1m: BarSummary[], periodMins: number): BarSummary[] {
  const result: BarSummary[] = [];
  // Align from the end so the most recent complete+partial window is always included
  for (let i = bars1m.length - 1; i >= periodMins - 1; i -= periodMins) {
    const slice = bars1m.slice(i - periodMins + 1, i + 1);
    const last = slice[slice.length - 1];
    result.unshift({
      ts: last.ts,
      close: last.close,
      // Use the last bar's indicators as the aggregated representation
      rsi14: last.rsi14,
      ema9: last.ema9,
      ema21: last.ema21,
      hma5: last.hma5,
      hma19: last.hma19,
    });
  }
  return result;
}

function trendLabel(bars: BarSummary[]): 'bullish' | 'bearish' | 'neutral' {
  if (bars.length < 3) return 'neutral';
  const first = bars[bars.length - 3].close;
  const last = bars[bars.length - 1].close;
  const pct = (last - first) / first;
  if (pct > 0.002) return 'bullish';
  if (pct < -0.002) return 'bearish';
  return 'neutral';
}

export interface Greeks {
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  iv: number | null;        // implied volatility
  volume: number | null;
  openInterest: number | null;
}

export interface ContractState {
  meta: ContractMeta;
  quote: LiveQuote;
  greeks: Greeks;
  bars1m: BarSummary[];   // last 20
  bars3m: BarSummary[];   // last 10 (aggregated)
  bars5m: BarSummary[];   // last 10 (aggregated)
  trend1m: string;
  trend3m: string;
  trend5m: string;
}

/** SPY options flow summary — used as a sentiment indicator */
export interface SpyFlow {
  putVolume: number;
  callVolume: number;
  putCallRatio: number;
  totalVolume: number;
  topPutStrikes: { strike: number; volume: number; last: number }[];
  topCallStrikes: { strike: number; volume: number; last: number }[];
  atmIV: number | null;      // IV of ATM strike
  putSkewIV: number | null;  // average IV of OTM puts (5 strikes below ATM)
  callSkewIV: number | null; // average IV of OTM calls (5 strikes above ATM)
  spyPrice: number | null;
}

export interface MarketSnapshot {
  ts: number;
  timeET: string;
  minutesToClose: number;
  mode: string;
  spx: {
    price: number;
    changePct: number;
    bars1m: BarSummary[];
    bars3m: BarSummary[];
    bars5m: BarSummary[];
    trend1m: string;
    trend3m: string;
    trend5m: string;
  };
  contracts: ContractState[];
  spyFlow: SpyFlow | null;
}

function etTime(): { label: string; minutesToClose: number } {
  // Use Intl to get correct ET time (handles EST/EDT automatically)
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const [datePart, timePart] = etStr.split(', ');
  const [h, m] = timePart.split(':').map(Number);
  const label = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} ET`;
  // Minutes until 16:00 ET
  const minsNow = h * 60 + m;
  const minsClose = 16 * 60;
  const mins = Math.max(0, minsClose - minsNow);
  return { label, minutesToClose: mins };
}

/** Fetch SPX 0DTE options chain with Greeks from Tradier */
async function fetchGreeksChain(expiry: string): Promise<Map<string, Greeks>> {
  const map = new Map<string, Greeks>();
  try {
    const resp = await axios.get(`${TRADIER_BASE}/markets/options/chains`, {
      headers: tradierHeaders(),
      params: { symbol: 'SPX', expiration: expiry, greeks: 'true' },
      timeout: 10000,
    });
    const opts = resp.data?.options?.option;
    const list: any[] = opts ? (Array.isArray(opts) ? opts : [opts]) : [];
    for (const o of list) {
      map.set(o.symbol, {
        delta: o.greeks?.delta ?? null,
        gamma: o.greeks?.gamma ?? null,
        theta: o.greeks?.theta ?? null,
        vega: o.greeks?.vega ?? null,
        iv: o.greeks?.mid_iv ?? o.greeks?.ask_iv ?? null,
        volume: o.volume ?? null,
        openInterest: o.open_interest ?? null,
      });
    }
  } catch { /* chain unavailable */ }
  return map;
}

/** Fetch SPY 0DTE chain for flow/sentiment analysis */
async function fetchSpyFlow(spyExpiry: string): Promise<SpyFlow | null> {
  try {
    // Get SPY price first
    const qResp = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
      headers: tradierHeaders(),
      params: { symbols: 'SPY' },
      timeout: 6000,
    });
    const spyPrice = qResp.data?.quotes?.quote?.last ?? null;

    const resp = await axios.get(`${TRADIER_BASE}/markets/options/chains`, {
      headers: tradierHeaders(),
      params: { symbol: 'SPY', expiration: spyExpiry, greeks: 'true' },
      timeout: 10000,
    });
    const opts = resp.data?.options?.option;
    const list: any[] = opts ? (Array.isArray(opts) ? opts : [opts]) : [];
    if (list.length === 0) return null;

    const puts = list.filter(o => o.option_type === 'put');
    const calls = list.filter(o => o.option_type === 'call');

    const putVol = puts.reduce((s, o) => s + (o.volume || 0), 0);
    const callVol = calls.reduce((s, o) => s + (o.volume || 0), 0);

    // Top 5 put/call strikes by volume
    const topPuts = [...puts].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5)
      .map(o => ({ strike: o.strike, volume: o.volume || 0, last: o.last || 0 }));
    const topCalls = [...calls].sort((a, b) => (b.volume || 0) - (a.volume || 0)).slice(0, 5)
      .map(o => ({ strike: o.strike, volume: o.volume || 0, last: o.last || 0 }));

    // ATM IV — find strike closest to SPY price
    let atmIV: number | null = null;
    let putSkewIV: number | null = null;
    let callSkewIV: number | null = null;

    if (spyPrice) {
      const sortedByDist = [...list].sort((a, b) => Math.abs(a.strike - spyPrice) - Math.abs(b.strike - spyPrice));
      const atmStrike = sortedByDist[0]?.strike;
      const atmOpts = list.filter(o => o.strike === atmStrike);
      const ivVals = atmOpts.map(o => o.greeks?.mid_iv).filter((v: any) => v != null);
      if (ivVals.length > 0) atmIV = ivVals.reduce((a: number, b: number) => a + b, 0) / ivVals.length;

      // OTM put skew: 5 strikes below ATM
      const otmPuts = puts
        .filter(o => o.strike < atmStrike && o.strike >= atmStrike - 5)
        .map(o => o.greeks?.mid_iv).filter((v: any) => v != null);
      if (otmPuts.length > 0) putSkewIV = otmPuts.reduce((a: number, b: number) => a + b, 0) / otmPuts.length;

      // OTM call skew: 5 strikes above ATM
      const otmCalls = calls
        .filter(o => o.strike > atmStrike && o.strike <= atmStrike + 5)
        .map(o => o.greeks?.mid_iv).filter((v: any) => v != null);
      if (otmCalls.length > 0) callSkewIV = otmCalls.reduce((a: number, b: number) => a + b, 0) / otmCalls.length;
    }

    return {
      putVolume: putVol,
      callVolume: callVol,
      putCallRatio: callVol > 0 ? putVol / callVol : 0,
      totalVolume: putVol + callVol,
      topPutStrikes: topPuts,
      topCallStrikes: topCalls,
      atmIV,
      putSkewIV,
      callSkewIV,
      spyPrice,
    };
  } catch {
    return null;
  }
}

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const { label: timeET, minutesToClose } = etTime();

  // 1. Health (mode) — fetch first so we can filter contracts correctly
  const health: any = await get(`${SPXER_BASE}/health`).catch(() => ({}));
  const isRth = (health.mode ?? 'rth') === 'rth';

  // 2. Active contracts from SPXer — during RTH only show today's 0DTE
  const activeRaw: any[] = await get<any[]>(`${SPXER_BASE}/contracts/active`).catch(() => []);
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // 3. SPX 1m bars from SPXer — fetch early so we have the price for ATM sorting
  const spxBars1mRaw: any[] = await get<any[]>(`${SPXER_BASE}/spx/bars?tf=1m&n=25`).catch(() => []);
  const spxBars1m: BarSummary[] = spxBars1mRaw.map(b => ({
    ts: b.ts, close: b.close,
    rsi14: b.indicators?.rsi14 ?? null,
    ema9: b.indicators?.ema9 ?? null,
    ema21: b.indicators?.ema21 ?? null,
    hma5: b.indicators?.hma5 ?? null,
    hma19: b.indicators?.hma19 ?? null,
  }));
  const latestSpxPrice = spxBars1m.length > 0 ? spxBars1m[spxBars1m.length - 1].close : 0;

  const contracts: ContractMeta[] = activeRaw
    .filter(c => c.state === 'ACTIVE' || c.state === 'STICKY')
    // During RTH, show ONLY today's 0DTE contracts — tomorrow's have no gamma and pollute the view
    .filter(c => !isRth || c.expiry === todayET)
    .map(c => ({ symbol: c.symbol, side: c.type, strike: c.strike, expiry: c.expiry }))
    // Sort by distance from ATM so the most relevant contracts are always selected first
    .sort((a, b) => Math.abs(a.strike - latestSpxPrice) - Math.abs(b.strike - latestSpxPrice));

  // 3. SPX bars — already fetched above for ATM sorting; reuse here
  const spxBars3m = aggregate(spxBars1m, 3);
  const spxBars5m = aggregate(spxBars1m, 5);

  const latestSpx = spxBars1m[spxBars1m.length - 1];
  // Use first bar of the session (index 0) for session change; fallback to 1m diff
  const sessionOpenSpx = spxBars1m.length > 1 ? spxBars1m[0] : null;
  const spxChangePct = latestSpx && sessionOpenSpx
    ? ((latestSpx.close - sessionOpenSpx.close) / sessionOpenSpx.close) * 100 : 0;

  // 4a. Fetch SPX Greeks chain + SPY flow in parallel (don't block main flow)
  const [greeksMap, spyFlow] = await Promise.all([
    fetchGreeksChain(todayET),
    fetchSpyFlow(todayET),
  ]);

  // 4. Live quotes from Tradier for all tracked contracts (sub-minute)
  const quoteMap = new Map<string, LiveQuote>();
  if (contracts.length > 0) {
    const symbols = contracts.slice(0, 50).map(c => c.symbol).join(',');
    try {
      const qResp = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
        headers: tradierHeaders(),
        params: { symbols },
        timeout: 8000,
      });
      const quotes = qResp.data?.quotes?.quote;
      const qList = quotes ? (Array.isArray(quotes) ? quotes : [quotes]) : [];
      for (const q of qList) {
        const sym = q.symbol;
        const last = q.last ?? q.bid ?? null;
        const bid = q.bid ?? null;
        const ask = q.ask ?? null;
        quoteMap.set(sym, {
          symbol: sym,
          last,
          bid,
          ask,
          mid: bid !== null && ask !== null ? (bid + ask) / 2 : last,
          change: q.change ?? null,
          changePct: q.change_percentage ?? null,
        });
      }
    } catch { /* quotes unavailable — use last bar close */ }
  }

  // 5. Per-contract bars from SPXer + live quote merge
  // Include contracts even without bars (quote-only at market open)
  const contractStates: ContractState[] = [];
  const subset = contracts.slice(0, 30); // top 30 contracts near the money

  await Promise.allSettled(subset.map(async meta => {
    const barsRaw: any[] = await get<any[]>(
      `${SPXER_BASE}/contracts/${meta.symbol}/bars?tf=1m&n=25`
    ).catch(() => []);

    const bars1m: BarSummary[] = barsRaw.map(b => ({
      ts: b.ts, close: b.close,
      rsi14: b.indicators?.rsi14 ?? null,
      ema9: b.indicators?.ema9 ?? null,
      ema21: b.indicators?.ema21 ?? null,
      hma5: b.indicators?.hma5 ?? null,
      hma19: b.indicators?.hma19 ?? null,
    }));

    const bars3m = aggregate(bars1m, 3);
    const bars5m = aggregate(bars1m, 5);

    const liveQ = quoteMap.get(meta.symbol);
    const lastClose = bars1m.length > 0 ? bars1m[bars1m.length - 1].close : null;
    const quote: LiveQuote = liveQ ?? {
      symbol: meta.symbol, last: lastClose, bid: null, ask: null,
      mid: lastClose, change: null, changePct: null,
    };
    // Skip if we have neither bars nor a live quote
    if (bars1m.length === 0 && !liveQ) return;

    const greeks: Greeks = greeksMap.get(meta.symbol) ?? {
      delta: null, gamma: null, theta: null, vega: null,
      iv: null, volume: null, openInterest: null,
    };

    contractStates.push({
      meta,
      quote,
      greeks,
      bars1m: bars1m.slice(-10),
      bars3m: bars3m.slice(-8),
      bars5m: bars5m.slice(-6),
      trend1m: trendLabel(bars1m),
      trend3m: trendLabel(bars3m),
      trend5m: trendLabel(bars5m),
    });
  }));

  // Sort by distance from ATM so nearest-to-money contracts appear first in the prompt
  const spxPrice = latestSpx?.close ?? latestSpxPrice;
  contractStates.sort((a, b) =>
    Math.abs(a.meta.strike - spxPrice) - Math.abs(b.meta.strike - spxPrice)
  );

  return {
    ts: Date.now(),
    timeET,
    minutesToClose,
    mode: health.mode ?? 'unknown',
    spx: {
      price: latestSpx?.close ?? 0,
      changePct: spxChangePct,
      bars1m: spxBars1m.slice(-10),
      bars3m: spxBars3m.slice(-8),
      bars5m: spxBars5m.slice(-6),
      trend1m: trendLabel(spxBars1m),
      trend3m: trendLabel(spxBars3m),
      trend5m: trendLabel(spxBars5m),
    },
    contracts: contractStates,
    spyFlow,
  };
}
