export type SignalType = 'RSI_BREAK_40' | 'RSI_BREAK_50' | 'EMA_CROSS' | 'HMA_CROSS' | 'MULTI_MODEL_CONSENSUS' | 'PRICE_ACTION';
export type OptionSide = 'call' | 'put';
export type TradeAction = 'buy' | 'skip';

export interface BarSummary {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi14: number | null;
  ema9: number | null;
  ema21: number | null;
  hma3: number | null;
  hma5: number | null;
  hma15?: number | null;
  hma17: number | null;
  hma19: number | null;
  [key: string]: number | null | undefined; // allow indicator access by key
}

export interface SpxContext {
  price: number;
  changePercent: number;
  trend: 'bullish' | 'bearish' | 'neutral';
  rsi14: number | null;
  minutesToClose: number;
  mode: string;
}

export interface AgentSignal {
  type: SignalType;
  symbol: string;
  side: OptionSide;
  strike: number;
  expiry: string;
  currentPrice: number;
  bid: number | null;
  ask: number | null;
  indicators: BarSummary | Record<string, number | null | string>;
  recentBars: BarSummary[];   // last 10 bars, newest last
  signalBarLow: number;       // low of bar where signal fired (stop reference)
  spxContext: SpxContext;
  ts: number;
}

export interface AgentDecision {
  action: TradeAction;
  confidence: number;          // 0.0 – 1.0
  positionSize: number;        // contracts (0 if skip)
  stopLoss: number;
  takeProfit: number | null;
  reasoning: string;
  concerns: string[];
  ts: number;
}

export interface OpenPosition {
  id: string;                  // uuid
  symbol: string;
  side: OptionSide;
  strike: number;
  expiry: string;
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number | null;
  openedAt: number;
  tradierOrderId?: number;
  bracketOrderId?: number;     // OTOCO parent order ID
  tpLegId?: number;            // TP limit leg order ID
  slLegId?: number;            // SL stop leg order ID
  closeFailCount?: number;     // How many times close order was rejected by broker
  // Intra-trade price tracking — for post-trade "what-if TP" analysis
  highPrice?: number;          // Highest price seen during trade
  lowPrice?: number;           // Lowest price seen during trade
  highTs?: number;             // Timestamp of high
  lowTs?: number;              // Timestamp of low
  maxPnlPct?: number;          // Peak unrealized P&L as % of entry (e.g. 0.35 = +35%)
  maxDrawdownPct?: number;     // Worst unrealized P&L as % of entry (e.g. -0.50 = -50%)
}

export interface PositionClose {
  position: OpenPosition;
  closePrice: number;
  reason: 'stop_loss' | 'take_profit' | 'time_exit' | 'signal_reversal' | 'manual';
  pnl: number;
  closedAt: number;
}

export interface AuditEntry {
  ts: number;
  signal: AgentSignal;
  decision: AgentDecision;
  execution?: { orderId?: number; fillPrice?: number; error?: string };
  outcome?: PositionClose;
}
