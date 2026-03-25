/**
 * Replay types — re-exports Config as ReplayConfig for backwards compat,
 * plus replay-specific types (Trade, ReplayResult, CycleSnapshot, etc.).
 *
 * The canonical config type is Config in src/config/types.ts.
 */

import type { BarSummary } from '../agent/types';
import type { ContractState, SpyFlow } from '../agent/market-feed';
import type { Config, SignalGate } from '../config/types';

// Re-export Config as ReplayConfig for backwards compat
export type ReplayConfig = Config;
export type RegimeConfig = Config['regime'];
export type { Config, SignalGate };

// ── Run tracking ───────────────────────────────────────────────────────────

export interface ReplayRun {
  id: string;
  configId: string;
  date: string;
  startedAt: number;
  completedAt?: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
}

// ── Trade results ──────────────────────────────────────────────────────────

export interface Trade {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryTs: number;
  entryET: string;
  entryPrice: number;
  exitTs: number;
  exitET: string;
  exitPrice: number;
  reason: 'stop_loss' | 'take_profit' | 'time_exit' | 'signal_reversal';
  pnlPct: number;
  pnl$: number;
  signalType: string;
}

export interface ReplayResult {
  runId: string;
  configId: string;
  date: string;
  promptId?: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  maxWin: number;
  maxLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  sharpeRatio?: number;
  trades_json: string;
}

// ── Replay framework (cycle snapshot for agent injection) ──────────────────

export interface ReplayBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: string;
}

export interface ReplayContract {
  symbol: string;
  type: 'call' | 'put';
  strike: number;
  expiry: string;
}

export interface CycleSnapshot {
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
    trend1m: 'bullish' | 'bearish' | 'neutral';
    trend3m: 'bullish' | 'bearish' | 'neutral';
    trend5m: 'bullish' | 'bearish' | 'neutral';
  };
  contracts: ContractState[];
  spyFlow: SpyFlow | null;
}

export interface ReplayContext {
  date: string;
  db: import('better-sqlite3').Database;
  spxBars: ReplayBar[];
  contracts: ReplayContract[];
  expiry: string;
  sessionStartTs: number;
  sessionEndTs: number;
}

export interface CycleHandlers {
  onCycle: (snapshot: CycleSnapshot, barTs: number) => void | Promise<void>;
  onTrade?: (entry: { ts: number; symbol: string; side: string; entryPrice: number; positionSize: number; stopLoss: number; takeProfit: number }) => void;
  onExit?: (exit: { ts: number; symbol: string; reason: string; pnl: number }) => void;
}
