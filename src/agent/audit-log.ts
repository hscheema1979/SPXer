import { appendFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { AuditEntry, PositionClose } from './types';

const LOG_DIR = path.resolve('./logs');
const LOG_PATH = path.join(LOG_DIR, 'agent-audit.jsonl');

function ensureDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

export function logEntry(entry: AuditEntry): void {
  ensureDir();
  appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
}

export function logClose(close: PositionClose): void {
  ensureDir();
  const line = {
    type: 'position_close',
    ts: close.closedAt,
    symbol: close.position.symbol,
    reason: close.reason,
    entryPrice: close.position.entryPrice,
    closePrice: close.closePrice,
    quantity: close.position.quantity,
    pnl: close.pnl,
    pnlFormatted: (close.pnl >= 0 ? '+' : '') + close.pnl.toFixed(2),
  };
  appendFileSync(LOG_PATH, JSON.stringify(line) + '\n');
  console.log(`[audit] ${close.position.symbol} closed ${close.reason}: PnL ${line.pnlFormatted}`);
}

export function logRejected(reason: string, symbol: string, signalType: string): void {
  ensureDir();
  appendFileSync(LOG_PATH, JSON.stringify({
    type: 'risk_rejected',
    ts: Date.now(),
    symbol,
    signalType,
    reason,
  }) + '\n');
  console.log(`[audit] SKIP ${symbol} (${signalType}): ${reason}`);
}
