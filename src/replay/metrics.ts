/**
 * Pure metric computations for replay results.
 * Extracted to be testable independently.
 */

import type { Trade, ReplayResult } from './types';

export function etLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function minutesToClose(ts: number, sessionEndTs: number): number {
  return Math.max(0, Math.floor((sessionEndTs - ts) / 60));
}

export function parseIndicators(raw: string): Record<string, number | null> {
  try { return JSON.parse(raw || '{}'); }
  catch { return {}; }
}

export function computeMetrics(trades: Trade[]): Pick<
  ReplayResult,
  'trades' | 'wins' | 'winRate' | 'totalPnl' | 'avgPnlPerTrade' | 'maxWin' | 'maxLoss' | 'maxConsecutiveWins' | 'maxConsecutiveLosses'
> {
  let totalPnl = 0;
  let wins = 0;
  let maxWin = 0;
  let maxLoss = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentConsecutiveWins = 0;
  let currentConsecutiveLosses = 0;

  for (const trade of trades) {
    totalPnl += trade.pnl$;
    if (trade.pnlPct > 0) {
      wins++;
      currentConsecutiveWins++;
      currentConsecutiveLosses = 0;
      maxWin = Math.max(maxWin, trade.pnl$);
    } else {
      currentConsecutiveLosses++;
      currentConsecutiveWins = 0;
      maxLoss = Math.min(maxLoss, trade.pnl$);
    }
    maxConsecutiveWins = Math.max(maxConsecutiveWins, currentConsecutiveWins);
    maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentConsecutiveLosses);
  }

  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnl,
    avgPnlPerTrade: trades.length ? totalPnl / trades.length : 0,
    maxWin: maxWin || 0,
    maxLoss: maxLoss || 0,
    maxConsecutiveWins,
    maxConsecutiveLosses,
  };
}

/**
 * Build date filter for contract symbols from a date string.
 * e.g. '2026-03-20' → '%260320%'
 */
export function buildSymbolFilter(date: string): string {
  return '%' + date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10) + '%';
}

/**
 * Build session timestamps from a date string.
 * Returns Unix timestamps for session start (09:30 ET) and end (16:00 ET).
 */
export function buildSessionTimestamps(date: string): { start: number; end: number; closeCutoff: number } {
  const dateObj = new Date(`${date}T09:30:00-04:00`);
  const start = Math.floor(dateObj.getTime() / 1000);
  const end = start + 390 * 60;
  const closeCutoff = end - 15 * 60;
  return { start, end, closeCutoff };
}
