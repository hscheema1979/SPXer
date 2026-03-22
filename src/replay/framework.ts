/**
 * Replay framework — injects historical data into agent logic without modifying agent code.
 * buildCycleSnapshot() returns the same shape as MarketSnapshot, so the
 * agent's assess() and processBar() work unchanged against historical bars.
 */

import Database from 'better-sqlite3';
import type { BarSummary } from '../agent/types';
import type { ContractState } from '../agent/market-feed';
import type { ReplayBar, ReplayContract, ReplayContext, CycleSnapshot, CycleHandlers } from './types';
import { etLabel, minutesToClose, parseIndicators } from './metrics';

// ── Helpers ────────────────────────────────────────────────────────────────

function barsUpTo(bars: ReplayBar[], atTs: number): ReplayBar[] {
  return bars.filter(b => b.ts <= atTs);
}

function aggregateBars(bars: ReplayBar[], periodMins: number): BarSummary[] {
  const result: BarSummary[] = [];
  const arr = barsUpTo(bars, bars[bars.length - 1]?.ts ?? 0);
  for (let i = arr.length - periodMins; i >= 0; i -= periodMins) {
    const slice = arr.slice(Math.max(0, i), i + periodMins);
    const last = slice[slice.length - 1];
    const ind = parseIndicators(last.indicators);
    result.unshift({
      ts: last.ts,
      close: last.close,
      rsi14: ind.rsi14 ?? null,
      ema9: ind.ema9 ?? null,
      ema21: ind.ema21 ?? null,
      hma5: ind.hma5 ?? null,
      hma19: ind.hma19 ?? null,
    });
  }
  return result;
}

function trend(bars: BarSummary[]): 'bullish' | 'bearish' | 'neutral' {
  if (bars.length < 3) return 'neutral';
  const first = bars[bars.length - 3].close;
  const last = bars[bars.length - 1].close;
  const pct = (last - first) / first;
  if (pct > 0.002) return 'bullish';
  if (pct < -0.002) return 'bearish';
  return 'neutral';
}

function buildContractState(
  contract: ReplayContract,
  barsAtTs: ReplayBar[],
  spxPrice: number,
): ContractState {
  const lastBar = barsAtTs[barsAtTs.length - 1];
  const close = lastBar?.close ?? spxPrice;
  return {
    meta: { symbol: contract.symbol, side: contract.type, strike: contract.strike, expiry: contract.expiry },
    quote: { symbol: contract.symbol, last: close, bid: close * 0.999, ask: close * 1.001, mid: close, change: null, changePct: null },
    greeks: { delta: null, gamma: null, theta: null, vega: null, iv: null, volume: lastBar?.volume ?? 0, openInterest: null },
    bars1m: aggregateBars(barsAtTs, 1).slice(-20),
    bars3m: aggregateBars(barsAtTs, 3).slice(-10),
    bars5m: aggregateBars(barsAtTs, 5).slice(-10),
    trend1m: 'neutral',
    trend3m: 'neutral',
    trend5m: 'neutral',
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function buildCycleSnapshot(ctx: ReplayContext, atTs: number): CycleSnapshot {
  const barsAtTs = barsUpTo(ctx.spxBars, atTs);
  const lastBar = barsAtTs[barsAtTs.length - 1];
  const spxPrice = lastBar?.close ?? 0;
  const sessionOpen = barsAtTs[0]?.close ?? spxPrice;
  const changePct = sessionOpen > 0 ? ((spxPrice - sessionOpen) / sessionOpen) * 100 : 0;
  const bars1m = aggregateBars(ctx.spxBars, 1).slice(-25);
  const bars3m = aggregateBars(ctx.spxBars, 3);
  const bars5m = aggregateBars(ctx.spxBars, 5);

  const contracts = ctx.contracts.map(c => buildContractState(c, barsAtTs, spxPrice));

  return {
    ts: atTs,
    timeET: etLabel(atTs),
    minutesToClose: minutesToClose(atTs, ctx.sessionEndTs),
    mode: 'rth',
    spx: {
      price: spxPrice,
      changePct,
      bars1m,
      bars3m,
      bars5m,
      trend1m: trend(bars1m),
      trend3m: trend(bars3m),
      trend5m: trend(bars5m),
    },
    contracts,
    spyFlow: null,
  };
}

export function createReplayContext(db: Database.Database, date: string): ReplayContext {
  const sessionStart = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
  const sessionEnd = sessionStart + 390 * 60;

  const spxRows = db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM bars WHERE symbol='SPX' AND timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(sessionStart, sessionEnd) as ReplayBar[];

  const contractRows = db.prepare(`
    SELECT DISTINCT c.symbol, c.type, c.strike, c.expiry
    FROM contracts c
    JOIN bars b ON b.symbol = c.symbol
    WHERE b.timeframe='1m' AND b.ts >= ? AND b.ts <= ?
  `).all(sessionStart, sessionEnd) as ReplayContract[];

  return {
    date,
    db,
    spxBars: spxRows,
    contracts: contractRows,
    expiry: contractRows[0]?.expiry ?? '',
    sessionStartTs: sessionStart,
    sessionEndTs: sessionEnd,
  };
}

export function getAvailableDays(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT date(ts, 'unixepoch', '-5 hours') as d
    FROM bars WHERE symbol='SPX' AND timeframe='1m'
    ORDER BY d
  `).all() as { d: string }[];
  return rows.map(r => r.d);
}

export async function runReplayDay(ctx: ReplayContext, handlers: CycleHandlers): Promise<void> {
  for (const bar of ctx.spxBars) {
    const snapshot = buildCycleSnapshot(ctx, bar.ts);
    const p = handlers.onCycle(snapshot, bar.ts);
    if (p instanceof Promise) await p;
  }
}
