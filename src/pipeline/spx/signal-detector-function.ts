/**
 * Pure Signal Detection Function
 *
 * Called by event handler at :00 seconds to check for HMA crosses.
 * Fetches all data from Tradier, computes HMA locally, returns result.
 */

import axios from 'axios';

const TRADIER_BASE = 'https://api.tradier.com';

import { makeHMAState, hmaStep } from '../../pipeline/indicators/tier1';
import { todayET } from '../../utils/et-time';

function getTradierToken(): string {
  const token = process.env.TRADIER_TOKEN;
  if (!token) {
    throw new Error('TRADIER_TOKEN not set in environment');
  }
  return token;
}

export interface SignalParams {
  fast: number;           // HMA fast period (e.g., 3)
  slow: number;           // HMA slow period (e.g., 12)
  strikeOffset: number;   // Strike offset from SPX (e.g., -5 for ITM5 call, +5 for ITM5 put)
  timeframe: number;      // Bar timeframe in minutes (e.g., 3)
  side: 'call' | 'put';   // Call or put
}

export interface SignalResult {
  cross: boolean;
  direction: 'bullish' | 'bearish' | null;
  hmaFast: number;
  hmaSlow: number;
  price: number;
  strike: number;
  symbol: string;
  barTime: string | null;
  barsAnalyzed: number;
  bid: number | null;  // Real bid from option quote
  ask: number | null;  // Real ask from option quote
}

/**
 * Detect HMA cross for a single option contract
 * Fetches all 1m bars from Tradier, aggregates to target timeframe, computes HMA
 */
export async function detectHmaCross(params: SignalParams): Promise<SignalResult> {
  const { fast, slow, strikeOffset, timeframe, side } = params;

  // Step 1: Fetch SPX price
  const spxResp = await axios.get(`${TRADIER_BASE}/v1/markets/quotes`, {
    params: { symbols: 'SPX' },
    headers: {
      'Authorization': `Bearer ${getTradierToken()}`,
      'Accept': 'application/json'
    },
  });

  const spxPrice = spxResp.data?.quotes?.quote?.last;
  if (!spxPrice) {
    throw new Error('Failed to fetch SPX price');
  }

  // Step 2: Calculate strike
  const strike = Math.round((spxPrice + strikeOffset) / 5) * 5;

  // Step 3: Build option symbol
  const todayStr = todayET();
  const symbol = `SPXW${todayStr.replace(/-/g, '').slice(2)}${side === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`;

  // Step 3.5: Fetch option quote for real bid/ask
  let bid: number | null = null;
  let ask: number | null = null;
  try {
    const quoteResp = await axios.get(`${TRADIER_BASE}/v1/markets/quotes`, {
      params: { symbols: symbol },
      headers: {
        'Authorization': `Bearer ${getTradierToken()}`,
        'Accept': 'application/json'
      },
    });
    const quote = quoteResp.data?.quotes?.quote;
    if (quote) {
      bid = quote.bid ?? null;
      ask = quote.ask ?? null;
    }
  } catch (e) {
    // If quote fetch fails, bid/ask remain null (will use fallback)
  }

  // Step 4: Fetch timesales
  const resp = await axios.get(`${TRADIER_BASE}/v1/markets/timesales`, {
    params: { symbol, interval: '1min', session_filter: 'all' },
    headers: {
      'Authorization': `Bearer ${getTradierToken()}`,
      'Accept': 'application/json'
    },
  });

  const bars = resp.data?.series?.data || [];
  if (bars.length === 0) {
    return {
      cross: false,
      direction: null,
      hmaFast: 0,
      hmaSlow: 0,
      price: spxPrice,
      strike,
      symbol,
      barTime: null,
      barsAnalyzed: 0,
      bid,
      ask,
    };
  }

  // Step 5: Aggregate to target timeframe
  const aggregatedBars: number[] = [];
  for (let i = 0; i < bars.length; i += timeframe) {
    const endIndex = Math.min(i + timeframe - 1, bars.length - 1);
    aggregatedBars.push(bars[endIndex].close);
  }

  // Step 6: Compute HMA for all bars
  const hmaFastState = makeHMAState(fast);
  const hmaSlowState = makeHMAState(slow);

  const hmaFastVals: (number | null)[] = [];
  const hmaSlowVals: (number | null)[] = [];

  for (const bar of aggregatedBars) {
    hmaFastVals.push(hmaStep(hmaFastState, bar));
    hmaSlowVals.push(hmaStep(hmaSlowState, bar));
  }

  // Step 7: Filter nulls
  const validHmaFast = hmaFastVals.filter((v): v is number => v !== null);
  const validHmaSlow = hmaSlowVals.filter((v): v is number => v !== null);

  if (validHmaFast.length < 2 || validHmaSlow.length < 2) {
    return {
      cross: false,
      direction: null,
      hmaFast: validHmaFast[validHmaFast.length - 1] || 0,
      hmaSlow: validHmaSlow[validHmaSlow.length - 1] || 0,
      price: spxPrice,
      strike,
      symbol,
      barTime: null,
      barsAnalyzed: aggregatedBars.length,
      bid,
      ask,
    };
  }

  // Step 8: Check last 2 bars for cross
  const prevHmaFast = validHmaFast[validHmaFast.length - 2];
  const currHmaFast = validHmaFast[validHmaFast.length - 1];
  const prevHmaSlow = validHmaSlow[validHmaSlow.length - 2];
  const currHmaSlow = validHmaSlow[validHmaSlow.length - 1];

  const prevWasBullish = prevHmaFast > prevHmaSlow;
  const currIsBullish = currHmaFast > currHmaSlow;
  const cross = prevWasBullish !== currIsBullish;

  // Get bar time
  const lastBarIndex = (validHmaFast.length - 1) * timeframe + (timeframe - 1);
  const barTime = bars[lastBarIndex]?.time || null;

  return {
    cross,
    direction: cross ? (currIsBullish ? 'bullish' : 'bearish') : null,
    hmaFast: currHmaFast,
    hmaSlow: currHmaSlow,
    price: spxPrice,
    strike,
    symbol,
    barTime,
    barsAnalyzed: aggregatedBars.length,
    bid,
    ask,
  };
}

/**
 * Detect HMA cross for both call and put
 */
export async function detectHmaCrossPair(params: Omit<SignalParams, 'side'>): Promise<{
  call: SignalResult;
  put: SignalResult;
}> {
  const [call, put] = await Promise.all([
    detectHmaCross({ ...params, side: 'call' }),
    detectHmaCross({ ...params, side: 'put' }),
  ]);

  return { call, put };
}
