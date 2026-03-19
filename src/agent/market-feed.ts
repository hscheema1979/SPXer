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

/** Aggregate 1m bars into N-minute bars */
function aggregate(bars1m: BarSummary[], periodMins: number): BarSummary[] {
  const result: BarSummary[] = [];
  for (let i = 0; i + periodMins <= bars1m.length; i += periodMins) {
    const slice = bars1m.slice(i, i + periodMins);
    const last = slice[slice.length - 1];
    result.push({
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

export interface ContractState {
  meta: ContractMeta;
  quote: LiveQuote;
  bars1m: BarSummary[];   // last 20
  bars3m: BarSummary[];   // last 10 (aggregated)
  bars5m: BarSummary[];   // last 10 (aggregated)
  trend1m: string;
  trend3m: string;
  trend5m: string;
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

export async function fetchMarketSnapshot(): Promise<MarketSnapshot> {
  const { label: timeET, minutesToClose } = etTime();

  // 1. Active contracts from SPXer — prioritize 0DTE (today's expiry)
  const activeRaw: any[] = await get<any[]>(`${SPXER_BASE}/contracts/active`).catch(() => []);
  const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const contracts: ContractMeta[] = activeRaw
    .filter(c => c.state === 'ACTIVE' || c.state === 'STICKY')
    .map(c => ({ symbol: c.symbol, side: c.type, strike: c.strike, expiry: c.expiry }))
    .sort((a, b) => {
      // 0DTE first, then by closest expiry, then by strike distance from SPX
      const a0dte = a.expiry === todayET ? 0 : 1;
      const b0dte = b.expiry === todayET ? 0 : 1;
      if (a0dte !== b0dte) return a0dte - b0dte;
      return a.expiry.localeCompare(b.expiry);
    });

  // 2. Health (mode)
  const health: any = await get(`${SPXER_BASE}/health`).catch(() => ({}));

  // 3. SPX 1m bars from SPXer (last 25 → enough for 3m and 5m aggregation)
  const spxBars1mRaw: any[] = await get<any[]>(`${SPXER_BASE}/spx/bars?tf=1m&n=25`).catch(() => []);
  const spxBars1m: BarSummary[] = spxBars1mRaw.map(b => ({
    ts: b.ts, close: b.close,
    rsi14: b.indicators?.rsi14 ?? null,
    ema9: b.indicators?.ema9 ?? null,
    ema21: b.indicators?.ema21 ?? null,
    hma5: b.indicators?.hma5 ?? null,
    hma19: b.indicators?.hma19 ?? null,
  }));
  const spxBars3m = aggregate(spxBars1m, 3);
  const spxBars5m = aggregate(spxBars1m, 5);

  const latestSpx = spxBars1m[spxBars1m.length - 1];
  const prevSpx = spxBars1m.length > 1 ? spxBars1m[spxBars1m.length - 2] : null;
  const spxChangePct = latestSpx && prevSpx
    ? ((latestSpx.close - prevSpx.close) / prevSpx.close) * 100 : 0;

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

    contractStates.push({
      meta,
      quote,
      bars1m: bars1m.slice(-10),
      bars3m: bars3m.slice(-8),
      bars5m: bars5m.slice(-6),
      trend1m: trendLabel(bars1m),
      trend3m: trendLabel(bars3m),
      trend5m: trendLabel(bars5m),
    });
  }));

  // Sort by momentum: highest RSI first (active movers at top)
  contractStates.sort((a, b) => {
    const ra = a.bars1m[a.bars1m.length - 1]?.rsi14 ?? 0;
    const rb = b.bars1m[b.bars1m.length - 1]?.rsi14 ?? 0;
    return rb - ra;
  });

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
  };
}
