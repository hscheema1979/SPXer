/**
 * Core shared types — used by both replay and live agent.
 * Single source of truth for trading logic types.
 */

export type Direction = 'bullish' | 'bearish';
export type SignalType = 'RSI_CROSS' | 'EMA_CROSS' | 'HMA_CROSS' | 'PRICE_CROSS_HMA' | 'PRICE_CROSS_EMA';
export type ExitReason = 'stop_loss' | 'take_profit' | 'signal_reversal' | 'time_exit';

/** A detected trading signal on an option contract */
export interface Signal {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  signalType: SignalType;
  direction: Direction;
  /** Indicator values at time of signal (for logging/debugging) */
  indicators: Record<string, number | null>;
}

/** An open simulated or live position */
export interface Position {
  id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTs: number;
  entryET: string;
}

/** Result of checking exit conditions on a position */
export interface ExitCheck {
  shouldExit: boolean;
  reason: ExitReason | null;
}

/** Result of a completed trade */
export interface TradeResult {
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
  reason: ExitReason;
  pnlPct: number;
  'pnl$': number;
  signalType: string;
}

/** Minimal bar shape for core logic — no DB-specific fields */
export interface CoreBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, number | null>;
}

/** Price getter function — abstracts bar cache (replay) vs API (live) */
export type PriceGetter = (symbol: string, ts: number) => number | null;
