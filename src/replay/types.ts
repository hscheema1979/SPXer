/**
 * Unified replay types — single source of truth for replay/backtest system.
 * Consolidates types from replay-store, replay-machine, and replay-framework.
 */

import type { BarSummary } from '../agent/types';
import type { ContractState, SpyFlow } from '../agent/market-feed';

// ── Config ─────────────────────────────────────────────────────────────────

export interface ReplayConfig {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  baselineConfigId?: string;

  rsi: {
    oversoldThreshold: number;
    overboughtThreshold: number;
    /** When true, only enter trades when SPX RSI is at extremes (< oversold or > overbought) */
    enableSpxGate?: boolean;
  };

  indicators: {
    hma: boolean;
    ema: boolean;
    rsi: boolean;
    bollingerBands: boolean;
    macd?: boolean;
  };

  signals: {
    enableRsiCrosses: boolean;
    enableHmaCrosses: boolean;
    enableEmaCrosses: boolean;
    /** RSI threshold for option contract oversold cross (default: 30) */
    optionRsiOversold: number;
    /** RSI threshold for option contract overbought cross (default: 70) */
    optionRsiOverbought: number;
  };

  position: {
    stopLossPercent: number;
    takeProfitMultiplier: number;
    maxPositionsOpen: number;
    positionSizeMultiplier: number;
  };

  /** Optional time window gate — only enter new trades within this ET range */
  timeWindows?: {
    activeStart?: string; // 'HH:MM' ET, e.g. '09:30'
    activeEnd?: string;   // 'HH:MM' ET, e.g. '15:45'
  };

  regime: {
    allowMorningMomentum: boolean;
    allowMeanReversion: boolean;
    allowTrendingUp: boolean;
    allowTrendingDown: boolean;
    allowGammaExpiry: boolean;
  };

  judge: {
    /** Enable judge tier (advisor tier, doesn't execute) */
    enabled: boolean;
    /** Which judge models to consult in parallel */
    models: ('haiku' | 'sonnet' | 'opus')[];
    /** Decision rule: how to combine judge votes */
    consensusRule: 'majority' | 'unanimous' | 'first-agree' | 'primary-decides';
    /** Primary judge (if consensusRule='primary-decides') — executes the trade */
    primaryModel?: 'haiku' | 'sonnet' | 'opus';
    /** Min confidence threshold to accept judge decision (0.0-1.0) */
    confidenceThreshold: number;
    /** Cooldown between judge escalations in seconds */
    escalationCooldownSec: number;
  };

  prompts: {
    /** Override the judge system prompt entirely */
    judgeSystemPrompt?: string;
    /** Override individual scanner prompts by scanner ID */
    scannerPrompts?: Record<string, string>;
    /** Context brief level: how much history to include */
    contextBrief: 'minimal' | 'standard' | 'verbose';
    /** Additional context to inject into every escalation */
    extraContext?: string;
  };

  strikeSelector: {
    minOtmDollar: number;
    maxOtmDollar: number;
    minOtmPoints: number;
    maxOtmPoints: number;
    /** Strike search range in points from SPX (separate from OTM range) */
    strikeSearchRange: number;
    preferredDelta?: number;
  };

  /** Position sizing formula */
  sizing: {
    /** Base dollar amount per trade (default: $250) */
    baseDollarsPerTrade: number;
    /** Multiplier applied to base (default: 1.0) */
    sizeMultiplier: number;
    /** Min contracts per trade */
    minContracts: number;
    /** Max contracts per trade */
    maxContracts: number;
  };

  /** Scanner configuration (Tier 1 models) */
  scanners: {
    /** Enable scanner tier (if false, only deterministic signals + judges) */
    enabled: boolean;
    /** Which scanners to use */
    enableKimi: boolean;
    enableGlm: boolean;
    enableMinimax: boolean;
    enableHaiku: boolean;
    /** Scanner cycle interval in seconds */
    cycleIntervalSec: number;
    /** Min scanner confidence to escalate to judge */
    minConfidenceToEscalate: number;
    /** Scanner prompt ID from prompt library (e.g., 'rsi-extremes-2026-03-19-v2.0') */
    promptId: string;
  };

  /** Escalation logic: what triggers judge evaluation */
  escalation: {
    /** Deterministic signals alone can trigger judge */
    signalTriggersJudge: boolean;
    /** Scanner setups alone can trigger judge */
    scannerTriggersJudge: boolean;
    /** Deterministic signal only escalates if scanner also flags it */
    requireScannerAgreement: boolean;
    /** Scanner only escalates if there's also a deterministic signal */
    requireSignalAgreement: boolean;
    /** Min number of scanners (out of 4) that must agree to escalate */
    minScannersToEscalate?: number;
  };

  timing: {
    tradingStartEt: string;
    tradingEndEt: string;
    noTradeAfterEt?: string;
  };

  risk: {
    maxDailyLoss: number;
    maxTradesPerDay: number;
    maxRiskPerTrade: number;
  };

  /** Exit strategy: how to exit open positions */
  exit: {
    /** takeProfit: exit when TP hit or stop hit (standard) */
    /** scannerReverse: if opposite signal fires, reverse instead of just exiting */
    strategy: 'takeProfit' | 'scannerReverse';
    /** For scannerReverse: reload position with same size on opposite side */
    reversalSizeMultiplier: number;
  };
}

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
  reason: 'stop_loss' | 'take_profit' | 'time_exit';
  pnlPct: number;
  pnl$: number;
  signalType: string;
}

export interface ReplayResult {
  runId: string;
  configId: string;
  date: string;
  /** Scanner prompt ID used in this run (e.g., 'rsi-extremes-2026-03-19-v2.0') */
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
