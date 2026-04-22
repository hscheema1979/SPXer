/**
 * Pure metric computations for replay results.
 * Extracted to be testable independently.
 */

import type { Trade, ReplayResult } from './types';

/**
 * Convert a UTC Unix timestamp to an ET time label (HH:MM format).
 * Handles EST/EDT automatically via Intl timezone resolution.
 */
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
  'trades' | 'wins' | 'winRate' | 'totalPnl' | 'avgPnlPerTrade' | 'maxWin' | 'maxLoss' | 'maxConsecutiveWins' | 'maxConsecutiveLosses' | 'sumWinPct' | 'cntWins' | 'sumLossPct' | 'cntLosses'
> {
  let totalPnl = 0;
  let wins = 0;
  let maxWin = 0;
  let maxLoss = 0;
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentConsecutiveWins = 0;
  let currentConsecutiveLosses = 0;
  let sumWinPct = 0;
  let cntWins = 0;
  let sumLossPct = 0;
  let cntLosses = 0;

  for (const trade of trades) {
    totalPnl += trade.pnl$;
    if (trade.pnlPct > 0) {
      wins++;
      currentConsecutiveWins++;
      currentConsecutiveLosses = 0;
      maxWin = Math.max(maxWin, trade.pnl$);
      sumWinPct += trade.pnlPct;
      cntWins++;
    } else if (trade.pnlPct < 0) {
      currentConsecutiveLosses++;
      currentConsecutiveWins = 0;
      maxLoss = Math.min(maxLoss, trade.pnl$);
      sumLossPct += trade.pnlPct;
      cntLosses++;
    } else {
      currentConsecutiveWins = 0;
      currentConsecutiveLosses = 0;
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
    sumWinPct,
    cntWins,
    sumLossPct,
    cntLosses,
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
 * Build a symbol range for efficient index-based contract queries.
 * e.g. '2026-03-20' → { prefix: 'SPXW260320', lo: 'SPXW260320', hi: 'SPXW260321' }
 * Use: WHERE symbol >= lo AND symbol < hi (uses index, ~100x faster than LIKE)
 *
 * `contractPrefix` defaults to 'SPXW' (SPX 0DTE). Pass 'NDXP' for NDX 0DTE,
 * 'SPY'/'QQQ' for 1DTE ETFs.
 */
export function buildSymbolRange(date: string, contractPrefix: string = 'SPXW'): { prefix: string; lo: string; hi: string } {
  const dateCode = date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10);
  const prefix = `${contractPrefix}${dateCode}`;
  // Increment the last digit of dateCode for upper bound
  const dayNum = parseInt(date.slice(8, 10), 10);
  const hiDateCode = date.slice(2, 4) + date.slice(5, 7) + String(dayNum + 1).padStart(2, '0');
  return { prefix, lo: prefix, hi: `${contractPrefix}${hiDateCode}` };
}

/**
 * Convert an ET time string to a real UTC Unix timestamp.
 * Uses Intl to determine whether a given date falls in EDT or EST.
 */
export function etToUnix(date: string, timeET: string): number {
  const [h, m] = timeET.split(':').map(Number);
  // Determine UTC offset for this date by comparing UTC noon to ET noon
  const testDate = new Date(`${date}T12:00:00Z`);
  const etHour = parseInt(
    testDate.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })
  );
  const offset = 12 - etHour; // 5 for EST, 4 for EDT
  return Math.floor(new Date(`${date}T${String(h + offset).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`).getTime() / 1000);
}

/**
 * Build session timestamps from a date string.
 * Returns real UTC Unix timestamps for session start (08:00 ET) and end (17:00 ET).
 * Handles EDT/EST correctly via etToUnix.
 *
 * Note: the EOD close cutoff is NOT part of session timestamps — it is a
 * config-driven value derived via computeCloseCutoffTs(config) from
 * src/core/entry-gate.ts. Previously this function returned a hardcoded
 * closeCutoff (end - 15min = 16:45 ET) that silently overrode
 * config.risk.cutoffTimeET in the replay engine. That coupling has been
 * removed so replay and live agent honor the same config knob.
 */
export function buildSessionTimestamps(date: string): { start: number; end: number } {
  const start = etToUnix(date, '08:00');
  const end = start + 540 * 60;      // 9 hours (8:00 AM - 5:00 PM)
  return { start, end };
}
