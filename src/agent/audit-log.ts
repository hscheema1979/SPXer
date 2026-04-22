import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { AuditEntry, PositionClose } from './types';

const LOG_DIR = path.resolve('./logs');
let logPath = path.join(LOG_DIR, 'agent-audit.jsonl');

/** Set per-agent audit file suffix. Call once at startup alongside setAgentId(). */
export function setAuditId(id: string): void {
  logPath = path.join(LOG_DIR, id ? `agent-audit-${id}.jsonl` : 'agent-audit.jsonl');
}

function ensureDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function logEntry(entry: AuditEntry): void {
  ensureDir();
  appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

export function logClose(close: PositionClose): void {
  ensureDir();
  const pos = close.position;
  const holdTimeSec = Math.round((close.closedAt - pos.openedAt) / 1000);
  const line = {
    type: 'position_close',
    ts: close.closedAt,
    symbol: pos.symbol,
    side: pos.side,
    strike: pos.strike,
    reason: close.reason,
    entryPrice: pos.entryPrice,
    closePrice: close.closePrice,
    quantity: pos.quantity,
    pnl: close.pnl,
    pnlFormatted: (close.pnl >= 0 ? '+' : '') + close.pnl.toFixed(2),
    holdTimeSec,
    // Intra-trade price extremes — for "what-if TP" analysis
    highPrice: pos.highPrice ?? null,
    lowPrice: pos.lowPrice ?? null,
    highTs: pos.highTs ?? null,
    lowTs: pos.lowTs ?? null,
    maxPnlPct: pos.maxPnlPct != null ? +(pos.maxPnlPct * 100).toFixed(1) : null,      // e.g. 35.0 = +35%
    maxDrawdownPct: pos.maxDrawdownPct != null ? +(pos.maxDrawdownPct * 100).toFixed(1) : null, // e.g. -50.0 = -50%
    // What-if analysis: would smaller TPs have been hit?
    wouldHitTP: pos.highPrice != null ? {
      '1.1x': pos.highPrice >= pos.entryPrice * 1.1,
      '1.2x': pos.highPrice >= pos.entryPrice * 1.2,
      '1.3x': pos.highPrice >= pos.entryPrice * 1.3,
      '1.4x': pos.highPrice >= pos.entryPrice * 1.4,
      '1.5x': pos.highPrice >= pos.entryPrice * 1.5,
      '2.0x': pos.highPrice >= pos.entryPrice * 2.0,
    } : null,
  };
  appendFileSync(logPath, JSON.stringify(line) + '\n');
  const highPct = pos.maxPnlPct != null ? `peak +${(pos.maxPnlPct * 100).toFixed(0)}%` : '';
  const lowPct = pos.maxDrawdownPct != null ? `trough ${(pos.maxDrawdownPct * 100).toFixed(0)}%` : '';
  console.log(`[audit] ${pos.symbol} closed ${close.reason}: PnL ${line.pnlFormatted} | high=$${pos.highPrice?.toFixed(2) ?? '?'} low=$${pos.lowPrice?.toFixed(2) ?? '?'} | ${highPct} ${lowPct} | held ${holdTimeSec}s`);
}

export function logRejected(reason: string, symbol: string, signalType: string): void {
  ensureDir();
  appendFileSync(logPath, JSON.stringify({
    type: 'risk_rejected',
    ts: Date.now(),
    symbol,
    signalType,
    reason,
  }) + '\n');
  console.log(`[audit] SKIP ${symbol} (${signalType}): ${reason}`);
}
