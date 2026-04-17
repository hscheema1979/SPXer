/**
 * SPXer SPX Trading Agent — Margin Account
 *
 * Signal pipeline (should match replay/machine.ts and agent-xsp.ts):
 *   detectSignals() on option contract bars (signalTf) → HMA(fast)×HMA(slow) cross
 *   → optional SPX direction gate (requireUnderlyingHmaCross)
 *   → strike selection → OTOCO bracket order
 *   → exit: SPX HMA cross on exitTf triggers scannerReverse → flip to opposite side
 *
 * NOTE: agent.ts may not yet be updated to use detectSignals() on contract bars —
 * verify against agent-xsp.ts which is the reference implementation.
 *
 * Config loaded from DB by AGENT_CONFIG_ID — same config validated in replay.
 * HTTP streaming for real-time TP/SL monitoring when holding a position.
 * Per-cycle broker reconciliation to prevent phantom/orphan positions.
 *
 * Usage:
 *   npm run agent              # paper mode (default)
 *   npm run agent:live         # live trading (AGENT_PAPER=false)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot, type MarketSnapshot, type ContractState } from './src/agent/market-feed';
import { openPosition, closePosition, cancelOcoLegs, convertOptionSymbol } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { createStore } from './src/replay/store';
import { DEFAULT_CONFIG } from './src/config/defaults';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { HealthGate } from './src/agent/health-gate';
import { validateTradeQuality, DEFAULT_QUALITY_CONFIG } from './src/agent/quality-gate';
import { writeStatus, logActivity, setAgentId } from './src/agent/reporter';
setAgentId('spx');
import { PriceStream } from './src/agent/price-stream';
import { nowET, todayET, etTimeToUnixTs } from './src/utils/et-time';
import { config as appConfig, TRADIER_BASE } from './src/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AgentSignal, AgentDecision, OpenPosition } from './src/agent/types';
import type { StrikeCandidate } from './src/core/strike-selector';
import { computeQty } from './src/core/position-sizer';
import { frictionEntry, computeRealisticPnl } from './src/core/friction';
import { computeTradeSize, getAccountBalance } from './src/agent/account-balance';
import type { CoreBar } from './src/core/types';
import type { Config } from './src/config/types';
import {
  detectSignal,
  createInitialSignalState,
  stripFormingCandle,
  type CorePosition,
  type SignalState,
  type SignalResult,
} from './src/core/strategy-engine';
import { detectSignals } from './src/core/signal-detector';
import { evaluateExit, evaluateEntry, type ExitDecision } from './src/core/trade-manager';

// ── Load Config from DB ─────────────────────────────────────────────────────

const CONFIG_ID = process.env.AGENT_CONFIG_ID || 'hma3x15-undhma-itm5-tp14x-sl70-10k';
const _store = createStore();
const config: Config = _store.getConfig(CONFIG_ID) ?? DEFAULT_CONFIG;
_store.close();

// Execution target is a property of the AGENT, not the config.
// The config defines trading strategy (signals, exits, risk). The agent defines where orders go.
const EXECUTION: Config['execution'] = {
  symbol: 'SPX',
  optionPrefix: 'SPXW',
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
};

console.log(`[agent] Loaded config: ${config.id} — "${config.name}"`);

// ── Resolve Timeframes ──────────────────────────────────────────────────────

const dirTf = config.signals.directionTimeframe || '1m';
const exitTf = config.signals.exitTimeframe || dirTf;
const signalTf = config.signals.signalTimeframe || '1m';

// ── Initialize ──────────────────────────────────────────────────────────────

const isPaper = process.env.AGENT_PAPER !== 'false';
const guard = new RiskGuard(config);
const positions = new PositionManager(config, isPaper);
const priceStream = new PriceStream();
const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

let cycleCount = 0;
let tradesTotal = 0;
let winsTotal = 0;
let dailyPnl = 0;
let dailyDate = '';
let consecutiveRejections = 0;
const MAX_REJECTIONS_BEFORE_BACKOFF = 3;
const REJECTION_BACKOFF_SECS = 300;
let rejectionBackoffUntil = 0;

// ── Health Gate — circuit breaker ──────────────────────────────────────────

const healthGate = new HealthGate({ spxerUrl: SPXER_BASE });

// ── Pause flag — written by dashboard/watchdog ─────────────────────────────

const PAUSE_FLAG_FILE = path.resolve('./logs/pause-trading.flag');
function isTradingPaused(): boolean {
  try { return fs.existsSync(PAUSE_FLAG_FILE); } catch { return false; }
}

// ── Signal State — HMA cross tracking, no positions ─────────────────────────

let signalState: SignalState = createInitialSignalState();
let lastEntryTs = 0;  // cooldown tracking
let cachedAccountValue = 0;  // for percentage-based sizing

// ── Option Contract Signal Dedup ─────────────────────────────────────────────
// Tracks the bar timestamp for each contract signal we've already processed.
// Key: `${symbol}:${signalType}:${direction}` → last processed bar ts
// Prevents the same cross from triggering multiple entries across polling cycles.
const processedSignalTs = new Map<string, number>();

// ── Session state file — survives restarts ───────────────────────────────────

const SESSION_FILE = path.join(process.cwd(), 'logs', 'agent-session.json');

interface SessionState {
  date: string;
  dailyPnl: number;
  tradesTotal: number;
  winsTotal: number;
  startedAt: number;
  lastEntryTs?: number;
  signalState?: {
    directionCross: string | null;
    prevDirectionHmaFast: number | null;
    prevDirectionHmaSlow: number | null;
    lastDirectionBarTs: number | null;
    exitCross: string | null;
    prevExitHmaFast: number | null;
    prevExitHmaSlow: number | null;
    lastExitBarTs: number | null;
  };
}

function loadSession(): SessionState | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch { return null; }
}

function saveSession(): void {
  try {
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      date: dailyDate,
      dailyPnl,
      tradesTotal,
      winsTotal,
      startedAt: Date.now(),
      lastEntryTs,
      signalState: {
        directionCross: signalState.directionCross,
        prevDirectionHmaFast: signalState.prevDirectionHmaFast,
        prevDirectionHmaSlow: signalState.prevDirectionHmaSlow,
        lastDirectionBarTs: signalState.lastDirectionBarTs,
        exitCross: signalState.exitCross,
        prevExitHmaFast: signalState.prevExitHmaFast,
        prevExitHmaSlow: signalState.prevExitHmaSlow,
        lastExitBarTs: signalState.lastExitBarTs,
      },
    }));
  } catch {}
}

function restoreSessionState(session: SessionState): void {
  lastEntryTs = session.lastEntryTs ?? 0;
  if (!session.signalState) return;
  const ss = session.signalState;
  signalState.directionCross = ss.directionCross as any;
  signalState.prevDirectionHmaFast = ss.prevDirectionHmaFast;
  signalState.prevDirectionHmaSlow = ss.prevDirectionHmaSlow;
  signalState.lastDirectionBarTs = ss.lastDirectionBarTs;
  signalState.exitCross = ss.exitCross as any;
  signalState.prevExitHmaFast = ss.prevExitHmaFast;
  signalState.prevExitHmaSlow = ss.prevExitHmaSlow;
  signalState.lastExitBarTs = ss.lastExitBarTs;
}

function clearSession(): void {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}

// ── Price Stream TP/SL Callback ─────────────────────────────────────────────

let streamExitPending = false;

priceStream.onPrice((symbol, last, bid, ask) => {
  for (const pos of positions.getAll()) {
    if (pos.symbol !== symbol) continue;
    const sellPrice = bid > 0 ? bid : last;
    if (pos.takeProfit && sellPrice >= pos.takeProfit) {
      console.log(`[stream] 🎯 TP HIT on ${symbol}: $${sellPrice.toFixed(2)} >= TP $${pos.takeProfit.toFixed(2)}`);
      streamExitPending = true;
    }
    if (pos.stopLoss && sellPrice <= pos.stopLoss) {
      console.log(`[stream] 🛑 SL HIT on ${symbol}: $${sellPrice.toFixed(2)} <= SL $${pos.stopLoss.toFixed(2)}`);
      streamExitPending = true;
    }
  }
});

// ── Broker P&L — Single Source of Truth ─────────────────────────────────────

/**
 * Compute today's realized P&L and trade count from Tradier filled orders.
 * This is the broker's actual data — not our in-memory tracking.
 * Called on every startup/resume so the risk guard always reflects reality.
 */
async function computeBrokerDailyPnl(): Promise<{ pnl: number; trades: number; wins: number }> {
  const accountId = EXECUTION.accountId!;
  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };

  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      { headers: hdrs, timeout: 10000 },
    );
    const raw = data?.orders?.order;
    const orders = Array.isArray(raw) ? raw : raw ? [raw] : [];

    const today = todayET();

    // Collect all filled legs from today's orders
    interface Fill { symbol: string; side: string; qty: number; avgPrice: number }
    const fills: Fill[] = [];

    for (const order of orders) {
      const legs = order.leg ? (Array.isArray(order.leg) ? order.leg : [order.leg]) : [order];
      for (const leg of legs) {
        if (leg.status !== 'filled') continue;
        const created = leg.create_date || order.create_date || '';
        // Match today's date in the create_date (UTC timestamp)
        // We check both the UTC date and the previous day to handle ET offset
        // A trade at 9:30 ET on Apr 16 = 13:30 UTC on Apr 16, so this works
        if (!created.startsWith(today)) continue;
        const sym = leg.option_symbol || leg.symbol || '';
        if (!sym) continue;
        fills.push({
          symbol: sym,
          side: leg.side || '',
          qty: leg.exec_quantity || 0,
          avgPrice: leg.avg_fill_price || 0,
        });
      }
    }

    // Match buys to sells per symbol to compute realized P&L
    // Group by symbol: sum buy cost, sum sell proceeds
    const bySymbol = new Map<string, { buyCost: number; buyQty: number; sellProceeds: number; sellQty: number }>();
    for (const f of fills) {
      if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, { buyCost: 0, buyQty: 0, sellProceeds: 0, sellQty: 0 });
      const entry = bySymbol.get(f.symbol)!;
      if (f.side === 'buy_to_open') {
        entry.buyCost += f.avgPrice * f.qty * 100;
        entry.buyQty += f.qty;
      } else if (f.side === 'sell_to_close') {
        entry.sellProceeds += f.avgPrice * f.qty * 100;
        entry.sellQty += f.qty;
      }
    }

    let totalPnl = 0;
    let completedTrades = 0;
    let wins = 0;

    for (const [symbol, entry] of bySymbol) {
      // Only count fully closed round-trips (sell qty matches buy qty)
      const closedQty = Math.min(entry.buyQty, entry.sellQty);
      if (closedQty <= 0) continue;

      // Proportional cost/proceeds for the closed portion
      const avgBuy = entry.buyCost / entry.buyQty;
      const avgSell = entry.sellProceeds / entry.sellQty;
      const pnl = (avgSell - avgBuy) * closedQty;
      totalPnl += pnl;
      completedTrades++;
      if (pnl > 0) wins++;
    }

    return { pnl: totalPnl, trades: completedTrades, wins };
  } catch (e: any) {
    console.warn(`[agent] Failed to compute broker P&L: ${e.message}`);
    return { pnl: 0, trades: 0, wins: 0 };
  }
}

// ── Broker Reconciliation ───────────────────────────────────────────────────

async function reconcileBrokerPositions(): Promise<void> {
  const accountId = EXECUTION.accountId!;
  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };

  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: hdrs, timeout: 10000 },
    );
    const raw = data?.positions?.position;
    const brokerPositions = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const brokerSymbols = new Set(brokerPositions.map((p: any) => p.symbol));
    const agentSymbols = new Set(positions.getAll().map(p => p.symbol));

    // Orphaned at broker — ADOPT into agent state (don't close!)
    // The agent may have restarted and lost its in-memory state.
    // The startup reconcileFromBroker should catch most cases, but this
    // handles positions that appear mid-session (e.g., delayed OTOCO fill).
    for (const bp of brokerPositions) {
      if (!agentSymbols.has(bp.symbol)) {
        const quantity = Math.abs(bp.quantity);
        const costBasis = Math.abs(bp.cost_basis);
        const entryPrice = costBasis / (quantity * 100);

        // Parse option symbol for side/strike/expiry
        const match = (bp.symbol as string).match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!match) {
          console.warn(`[agent] ⚠️ ORPHAN at broker: ${bp.symbol} x${quantity} — unrecognized symbol, skipping`);
          continue;
        }
        const [, , dateStr, callPut, strikeStr] = match;
        const side = callPut === 'C' ? 'call' : 'put';
        const strike = parseInt(strikeStr) / 1000;
        const expiry = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;
        const stopLoss = entryPrice * (1 - config.position.stopLossPercent / 100);
        const takeProfit = entryPrice * config.position.takeProfitMultiplier;

        console.log(`[agent] 📥 ADOPTING orphan from broker: ${bp.symbol} x${quantity} @ $${entryPrice.toFixed(2)} (${side} ${strike})`);

        // Add to PositionManager
        const openPos: import('./src/agent/types').OpenPosition = {
          id: randomUUID(),
          symbol: bp.symbol,
          side: side as any,
          strike,
          expiry,
          entryPrice,
          quantity,
          stopLoss,
          takeProfit,
          openedAt: bp.date_acquired ? new Date(bp.date_acquired).getTime() : Date.now(),
        };
        positions.add(openPos);

        // Start streaming prices for the adopted position (fire-and-forget)
        priceStream.updateSymbols([bp.symbol]).catch(() => {});
      }
    }

    // Phantom in agent — drop it
    for (const pos of positions.getAll()) {
      if (!brokerSymbols.has(pos.symbol)) {
        console.log(`[agent] ⚠️ PHANTOM: ${pos.symbol} — dropping from agent`);
        positions.remove(pos.id);
      }
    }
  } catch (e: any) {
    console.warn(`[agent] Reconciliation check failed: ${e.message}`);
  }
}

// ── Data Conversion Helpers ─────────────────────────────────────────────────

/**
 * Convert a BarSummary (from market-feed) to a CoreBar (for tick()).
 */
function toCoreBar(b: any): CoreBar {
  return {
    ts: b.ts,
    open: b.open ?? b.close,
    high: b.high ?? b.close,
    low: b.low ?? b.close,
    close: b.close,
    volume: b.volume ?? 0,
    indicators: {
      rsi14: b.rsi14 ?? null,
      ema9: b.ema9 ?? null,
      ema21: b.ema21 ?? null,
      hma3: b.hma3 ?? null,
      hma5: b.hma5 ?? null,
      hma15: b.hma15 ?? null,
      hma17: b.hma17 ?? null,
      hma19: b.hma19 ?? null,
      hma25: b.hma25 ?? null,
      ...extractIndicators(b),
    },
  };
}

/** Extract any additional indicator fields from bar data */
function extractIndicators(b: any): Record<string, number | null> {
  if (b.indicators && typeof b.indicators === 'object') {
    return b.indicators;
  }
  return {};
}

/**
 * Fetch bars at a specific timeframe from the data service REST API.
 * The data service stores aggregated bars at all TFs via aggregateAndStore().
 */
async function fetchBarsAtTf(tf: string, n: number = 50): Promise<CoreBar[]> {
  try {
    const { data } = await axios.get(`${SPXER_BASE}/spx/bars`, {
      params: { tf, n },
      timeout: 6000,
    });
    const bars: any[] = Array.isArray(data) ? data : [];
    return bars.map(b => ({
      ts: b.ts,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
      volume: b.volume ?? 0,
      indicators: b.indicators ?? {},
    }));
  } catch (e) {
    console.warn(`[agent] Failed to fetch bars at ${tf}: ${(e as Error).message}`);
    return [];
  }
}

/** Fetch contract bars for a single symbol at a specific timeframe from the data API.
 *  Returns CoreBar[] with full indicators (hma3, hma15, etc.) computed by the pipeline.
 *  Uses the API directly — NOT the pre-fetched BarSummary which only has 1m data.
 */
async function fetchContractBarsAtTf(symbol: string, tf: string, n: number = 30): Promise<CoreBar[]> {
  try {
    const { data } = await axios.get(`${SPXER_BASE}/contracts/${encodeURIComponent(symbol)}/bars`, {
      params: { tf, n },
      timeout: 6000,
    });
    const bars: any[] = Array.isArray(data) ? data : [];
    return bars.map(b => ({
      ts: b.ts,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
      volume: b.volume ?? 0,
      indicators: b.indicators ?? {},
    }));
  } catch {
    return [];
  }
}

/** Build contract bars map at signalTf.
 *  - 1m: uses pre-fetched snap data (no extra API calls)
 *  - Other TF: fetches from API in parallel (correct indicators, not re-aggregated 1m)
 */
async function buildContractBars(snap: MarketSnapshot, tf: string): Promise<Map<string, CoreBar[]>> {
  const map = new Map<string, CoreBar[]>();
  const periodSec = tfToSeconds(tf);

  if (tf === '1m') {
    // Fast path: bars already in snapshot, indicators correct
    for (const c of snap.contracts) {
      const bars = stripFormingCandle(c.bars1m.map(toCoreBar), 60);
      if (bars.length < 2) continue;
      map.set(c.meta.symbol, bars);
    }
    return map;
  }

  // Non-1m: fetch from API in parallel — data pipeline computes correct indicators
  await Promise.allSettled(snap.contracts.map(async c => {
    const bars = stripFormingCandle(
      await fetchContractBarsAtTf(c.meta.symbol, tf, 30),
      periodSec,
    );
    if (bars.length < 2) return;
    map.set(c.meta.symbol, bars);
  }));
  return map;
}

/**
 * Build StrikeCandidates from the market snapshot contracts.
 */
function buildCandidates(snap: MarketSnapshot): StrikeCandidate[] {
  return snap.contracts.map(c => ({
    symbol: c.meta.symbol,
    side: c.meta.side,
    strike: c.meta.strike,
    price: c.quote.last ?? c.quote.mid ?? 0,
    volume: c.greeks.volume ?? 0,
  }));
}

/**
 * Build position prices from PriceStream tick cache.
 */
function buildPositionPrices(): Map<string, number> {
  const prices = new Map<string, number>();
  for (const pos of positions.getAll()) {
    const cached = priceStream.getPrice(pos.symbol);
    if (cached) prices.set(pos.symbol, cached.last);
  }
  return prices;
}

/** Convert broker OpenPosition to CorePosition for evaluateExit() */
function toCorePosition(pos: OpenPosition): CorePosition {
  return {
    id: pos.symbol,
    symbol: pos.symbol,
    side: pos.side,
    strike: pos.strike,
    qty: pos.quantity,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit ?? pos.entryPrice * config.position.takeProfitMultiplier,
    entryTs: Math.floor(pos.openedAt / 1000),
    highWaterPrice: pos.highPrice ?? pos.entryPrice,
  };
}

/**
 * Compute the EOD close cutoff timestamp.
 */
function computeCloseCutoff(): number {
  return etTimeToUnixTs(config.risk.cutoffTimeET || '16:00');
}

/**
 * Get the period in seconds for a timeframe string.
 */
function tfToSeconds(tf: string): number {
  const match = tf.match(/^(\d+)(m|h|d)$/);
  if (!match) return 60;
  const [, num, unit] = match;
  const n = parseInt(num);
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  if (unit === 'd') return n * 86400;
  return 60;
}

// ── Order Execution Helpers ─────────────────────────────────────────────────

async function executeBrokerExit(
  pos: CorePosition,
  reason: string,
  decisionPrice: number,
): Promise<{ success: boolean; fillPrice: number; pnl: number }> {
  // Find the OpenPosition in the PositionManager (for broker operations)
  const openPos = positions.getAll().find(p => p.symbol === pos.symbol);

  // Cancel bracket legs if present
  if (openPos?.bracketOrderId && !isPaper) {
    try {
      await cancelOcoLegs(openPos.bracketOrderId, EXECUTION);
    } catch (e: any) {
      console.warn(`[agent] Failed to cancel bracket: ${e.message}`);
    }
  }

  // Submit sell
  const dummyPos: OpenPosition = openPos ?? {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    strike: pos.strike,
    expiry: '',
    entryPrice: pos.entryPrice,
    quantity: pos.qty,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    openedAt: pos.entryTs * 1000,
  };

  const result = await closePosition(dummyPos, reason, decisionPrice, isPaper, EXECUTION);

  if (result.error) {
    // If position doesn't exist at broker, treat as already closed — don't retry
    if (result.error === 'Position not at broker') {
      console.warn(`[agent] ⚠️ Position ${pos.symbol} already gone from broker — removing from state`);
      if (openPos) positions.remove(openPos.id);
      return { success: true, fillPrice: decisionPrice, pnl: 0 };
    }
    console.error(`[agent] ❌ Exit failed for ${pos.symbol}: ${result.error}`);
    return { success: false, fillPrice: decisionPrice, pnl: 0 };
  }

  const fillPrice = result.fillPrice ?? decisionPrice;
  const pnl = (fillPrice - pos.entryPrice) * pos.qty * 100;

  // Clean up
  if (openPos) positions.remove(openPos.id);

  return { success: true, fillPrice, pnl };
}

async function executeEntry(
  entry: { symbol: string; side: 'call' | 'put'; strike: number; price: number; qty: number; stopLoss: number; takeProfit: number; direction: string; reason: string },
  snap: MarketSnapshot,
): Promise<boolean> {
  // Rejection backoff
  if (Date.now() < rejectionBackoffUntil) {
    const remaining = Math.round((rejectionBackoffUntil - Date.now()) / 1000);
    console.log(`[agent] Rejection backoff — ${remaining}s remaining`);
    return false;
  }

  // Hard guard: never exceed max positions
  if (positions.count() >= (config.position.maxPositionsOpen ?? 1)) {
    console.log(`[agent] Already have ${positions.count()} open position(s) — skipping entry`);
    return false;
  }

  // Find the contract in the snapshot
  const contractState = snap.contracts.find(c => c.meta.symbol === entry.symbol);
  const quote = contractState?.quote;

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: entry.symbol,
    side: entry.side,
    strike: entry.strike,
    expiry: contractState?.meta.expiry ?? '',
    currentPrice: entry.price,
    bid: quote?.bid ?? null,
    ask: quote?.ask ?? null,
    indicators: contractState?.bars1m[contractState.bars1m.length - 1] ?? {} as any,
    recentBars: contractState?.bars1m ?? [],
    signalBarLow: entry.stopLoss,
    spxContext: {
      price: snap.spx.price,
      changePercent: snap.spx.changePct,
      trend: snap.spx.trend1m as any,
      rsi14: snap.spx.bars1m[snap.spx.bars1m.length - 1]?.rsi14 ?? null,
      minutesToClose: snap.minutesToClose,
      mode: snap.mode,
    },
    ts: Date.now(),
  };

  const decision: AgentDecision = {
    action: 'buy',
    confidence: 1.0,
    positionSize: entry.qty,
    stopLoss: entry.stopLoss,
    takeProfit: entry.takeProfit,
    reasoning: `tick() → ${entry.reason}`,
    concerns: [],
    ts: Date.now(),
  };

  try {
    // Pre-trade quality gate
    const lastBar = contractState?.bars1m[contractState.bars1m.length - 1];
    const recentVolume = contractState?.bars1m.slice(-5).reduce((s, b) => s + (b.volume ?? 0), 0) ?? 0;
    const quality = validateTradeQuality({
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      quoteTs: snap.ts,
      now: Date.now(),
      recentVolume,
      indicatorsComplete: !!(lastBar?.hma3 != null && lastBar?.hma17 != null),
      signalTs: Date.now(),
      config: DEFAULT_QUALITY_CONFIG,
    });
    if (!quality.passed) {
      console.warn(`[agent] ⚠️ Quality gate BLOCKED ${entry.symbol}: ${quality.failures.join('; ')}`);
      logRejected(`Quality gate: ${quality.failures.join('; ')}`, entry.symbol, 'HMA_CROSS');
      return false;
    }

    const { position, execution } = await openPosition(signal, decision, isPaper, EXECUTION);
    if (!execution.error) {
      positions.add(position);
      guard.recordTrade();
      tradesTotal++;
      consecutiveRejections = 0;

      const fillPrice = execution.fillPrice ?? entry.price;
      console.log(`[agent] ✅ ENTERED ${entry.side.toUpperCase()} ${entry.symbol} x${entry.qty} @ $${fillPrice.toFixed(2)} | SL=$${entry.stopLoss.toFixed(2)} TP=$${entry.takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution });

      // Start streaming prices for real-time TP/SL
      // Fire-and-forget: don't await — connect() blocks forever reading the stream
      priceStream.updateSymbols([position.symbol]).catch(() => {});

      // Update entry timestamp for cooldown tracking
      lastEntryTs = Math.floor(Date.now() / 1000);

      return true;
    } else {
      console.error(`[agent] ❌ Order failed: ${execution.error}`);
      logEntry({ ts: Date.now(), signal, decision, execution });
      consecutiveRejections++;
      if (consecutiveRejections >= MAX_REJECTIONS_BEFORE_BACKOFF) {
        rejectionBackoffUntil = Date.now() + REJECTION_BACKOFF_SECS * 1000;
        console.log(`[agent] 🚫 ${consecutiveRejections} consecutive rejections — backing off ${REJECTION_BACKOFF_SECS}s`);
      }
      return false;
    }
  } catch (e) {
    console.error('[agent] Execution error:', e);
    return false;
  }
}

// ── Banner ──────────────────────────────────────────────────────────────────

function banner(): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer Deterministic Agent — tick()-based          ║');
  console.log(`║  Mode: ${isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log(`║  Config: ${config.id.slice(0, 46).padEnd(46)}║`);
  console.log(`║  Signal:  HMA(${config.signals.hmaCrossFast})×HMA(${config.signals.hmaCrossSlow}) cross on option contracts   ║`);
  console.log(`║  Dir TF:  ${dirTf.padEnd(5)} | Exit TF: ${exitTf.padEnd(5)} | Sig TF: ${signalTf.padEnd(5)}  ║`);
  console.log(`║  Exit:    ${config.exit.strategy.padEnd(47)}║`);
  console.log(`║  TP/SL:   ${config.position.takeProfitMultiplier}x / ${config.position.stopLossPercent}%                                     ║`);
  console.log(`║  Stream:  HTTP streaming for real-time TP/SL            ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Main Cycle ──────────────────────────────────────────────────────────────

async function runCycle(): Promise<number> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

  // 0. Check pause flag (from dashboard/watchdog)
  if (isTradingPaused()) {
    console.log(`[agent] ⏸️ Trading paused by external flag — skipping cycle`);
    return 10;
  }

  // 0a. Health gate circuit breaker
  const health = await healthGate.check();
  if (!health.healthy) {
    console.log(`[agent] 🚫 HEALTH GATE: ${health.reason}`);
    return 30;
  }

  // 1. Fetch market state
  let snap: MarketSnapshot;
  try {
    snap = await fetchMarketSnapshot();
  } catch (e) {
    console.error(`[agent] cycle #${cycleCount} @ ${ts} — Market fetch failed: ${(e as Error).message}`);
    return 30;
  }

  const spxPrice = snap.spx.price;
  const openCount = positions.count();
  console.log(`\n[agent] ═══ #${cycleCount} @ ${ts} | SPX ${spxPrice.toFixed(2)} | ${snap.contracts.length} contracts | ${openCount} open | daily P&L: $${dailyPnl.toFixed(0)} ═══`);

  // 2. Warmup check
  const { h: etH, m: etM } = nowET();
  const [asH, asM] = config.timeWindows.activeStart.split(':').map(Number);
  if (etH * 60 + etM < asH * 60 + asM) {
    console.log(`[agent] Warming up — waiting until ${config.timeWindows.activeStart} ET for indicator stabilization`);
    return 30;
  }

  // 3. Reconcile broker positions every cycle
  await reconcileBrokerPositions();

  // 4. Handle stream-flagged exits
  if (streamExitPending && positions.count() > 0) {
    console.log(`[agent] ⚡ Stream flagged exit — force-closing`);
    for (const pos of positions.getAll()) {
      const streamPrice = priceStream.getPrice(pos.symbol);
      const sellPrice = streamPrice?.bid ?? streamPrice?.last ?? pos.entryPrice;

      const result = await closePosition(pos, 'stream_exit', sellPrice, isPaper, EXECUTION);
      const pnl = ((result.fillPrice ?? sellPrice) - pos.entryPrice) * pos.quantity * 100;
      dailyPnl += pnl;
      guard.recordLoss(pnl);
      positions.remove(pos.id);

      const emoji = pnl >= 0 ? '💰' : '💸';
      if (pnl > 0) winsTotal++;
      tradesTotal++;
      console.log(`[agent] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)}: P&L $${pnl.toFixed(0)}`);
    }
    streamExitPending = false;
    saveSession();
  }
  streamExitPending = false;

  // 5. Build signal input (bars only — no positions needed)

  // 5a. SPX direction bars — fetch at direction timeframe, strip forming candle
  let spxDirBars: CoreBar[];
  if (dirTf === '1m') {
    spxDirBars = stripFormingCandle(snap.spx.bars1m.map(toCoreBar), 60);
  } else {
    const rawBars = await fetchBarsAtTf(dirTf, 50);
    spxDirBars = stripFormingCandle(rawBars, tfToSeconds(dirTf));
  }

  // 5b. SPX exit bars — same as direction if same TF
  let spxExitBars: CoreBar[];
  if (exitTf === dirTf) {
    spxExitBars = spxDirBars;
  } else if (exitTf === '1m') {
    spxExitBars = stripFormingCandle(snap.spx.bars1m.map(toCoreBar), 60);
  } else {
    const rawBars = await fetchBarsAtTf(exitTf, 50);
    spxExitBars = stripFormingCandle(rawBars, tfToSeconds(exitTf));
  }

  // 6a. Detect SPX HMA cross (for direction gate + exit monitoring)
  const spxSignal = detectSignal(signalState, {
    spxDirectionBars: spxDirBars,
    spxExitBars,
  }, config);

  // Update SPX signal state
  signalState.directionCross = spxSignal.directionState.cross;
  signalState.prevDirectionHmaFast = spxSignal.directionState.prevFast;
  signalState.prevDirectionHmaSlow = spxSignal.directionState.prevSlow;
  signalState.lastDirectionBarTs = spxSignal.directionState.lastBarTs;
  signalState.exitCross = spxSignal.exitState.cross;
  signalState.prevExitHmaFast = spxSignal.exitState.prevFast;
  signalState.prevExitHmaSlow = spxSignal.exitState.prevSlow;
  signalState.lastExitBarTs = spxSignal.exitState.lastBarTs;

  if (spxSignal.directionState.cross) {
    const arrow = spxSignal.directionState.cross === 'bullish' ? '🔼' : '🔽';
    console.log(`[agent] SPX HMA(${config.signals.hmaCrossFast}×${config.signals.hmaCrossSlow}) ${dirTf}: ${arrow} ${spxSignal.directionState.cross.toUpperCase()}${spxSignal.directionState.freshCross ? ' (fresh)' : ''}`);
  }

  // 6b. Detect option contract HMA crosses — the PRIMARY entry trigger
  // Entry is based on the option contract's own HMA cross, not SPX underlying.
  // SPX direction is used as a gate (requireUnderlyingHmaCross) but NOT the trigger.
  // signalTf bars are fetched from the API (correct pipeline indicators, not re-aggregated 1m).
  const contractBarsMap = await buildContractBars(snap, signalTf);
  const allContractSignals = detectSignals(contractBarsMap, spxPrice, config);

  // Dedup: only treat signals as fresh if we haven't seen this bar's cross yet.
  const freshContractSignals = allContractSignals.filter(sig => {
    const bars = contractBarsMap.get(sig.symbol);
    if (!bars || bars.length === 0) return false;
    const barTs = bars[bars.length - 1].ts;
    const key = `${sig.symbol}:${sig.signalType}:${sig.direction}`;
    return processedSignalTs.get(key) !== barTs;
  });

  // Mark fresh signals as processed
  for (const sig of freshContractSignals) {
    const bars = contractBarsMap.get(sig.symbol);
    if (bars && bars.length > 0) {
      processedSignalTs.set(`${sig.symbol}:${sig.signalType}:${sig.direction}`, bars[bars.length - 1].ts);
    }
  }

  // Apply requireUnderlyingHmaCross gate:
  //   SPX bullish → only call signals with bullish option direction
  //   SPX bearish → only put signals with bullish option direction
  //   SPX null    → block all contract signals
  let gatedContractSignals = freshContractSignals;
  if (config.signals.requireUnderlyingHmaCross) {
    const spxDir = spxSignal.directionState.cross;
    if (spxDir == null) {
      gatedContractSignals = [];
    } else {
      const wantSide: 'call' | 'put' = spxDir === 'bullish' ? 'call' : 'put';
      gatedContractSignals = freshContractSignals.filter(
        s => s.side === wantSide && s.direction === 'bullish'
      );
    }
  }

  // Pick best contract signal (first = closest to ATM)
  const bestContractSignal = gatedContractSignals[0] ?? null;

  if (freshContractSignals.length > 0) {
    console.log(`[agent] 📡 Contract signals (${freshContractSignals.length}): ${freshContractSignals.slice(0, 3).map(s => `${s.symbol.slice(-12)} ${s.direction}`).join(', ')}`);
  }
  if (bestContractSignal) {
    console.log(`[agent] ✅ Best contract signal: ${bestContractSignal.symbol} (${bestContractSignal.side} ${bestContractSignal.direction}) → entry trigger`);
  }

  // Build combined signal: contract HMA cross drives ENTRY, SPX HMA cross drives EXIT
  const contractFreshCross = bestContractSignal !== null;
  const contractDirection = bestContractSignal
    ? (bestContractSignal.side === 'call' ? 'bullish' as const : 'bearish' as const)
    : spxSignal.directionState.cross;  // fall back to SPX direction (for flip-on-reversal context)

  const signal: SignalResult = {
    directionState: {
      cross: contractDirection,
      prevFast: spxSignal.directionState.prevFast,
      prevSlow: spxSignal.directionState.prevSlow,
      lastBarTs: spxSignal.directionState.lastBarTs,
      freshCross: contractFreshCross,
    },
    exitState: spxSignal.exitState,  // exit still driven by SPX HMA reversal
  };

  // 7. Evaluate exits — broker positions are truth
  const closeCutoffTs = computeCloseCutoff();
  const exits: ExitDecision[] = [];
  for (const openPos of positions.getAll()) {
    const corePos = toCorePosition(openPos);
    const cached = priceStream.getPrice(openPos.symbol);
    let currentPrice = cached?.last ?? null;

    // Fall back to snapshot quote if not in stream
    if (currentPrice === null) {
      const contractState = snap.contracts.find(c => c.meta.symbol === openPos.symbol);
      const price = contractState?.quote?.last ?? contractState?.quote?.mid;
      if (price && price > 0) currentPrice = price;
    }

    // Get bar high/low for intrabar TP/SL detection
    const contractState = snap.contracts.find(c => c.meta.symbol === openPos.symbol);
    const barHighLow = contractState?.bars1m.length
      ? { high: contractState.bars1m[contractState.bars1m.length - 1].high ?? 0,
          low: contractState.bars1m[contractState.bars1m.length - 1].low ?? 0 }
      : undefined;

    const exitDecision = evaluateExit(
      corePos, currentPrice, signal.exitState.cross, signal.exitState.freshCross,
      config, Math.floor(Date.now() / 1000), closeCutoffTs, barHighLow,
    );
    if (exitDecision) exits.push(exitDecision);
  }

  // 8. Execute exits FIRST
  let allExitsSucceeded = true;
  for (const exit of exits) {
    console.log(`[agent] 📤 Exiting ${exit.symbol} — reason: ${exit.reason} @ $${exit.decisionPrice.toFixed(2)} (est P&L: $${exit.pnl['pnl$'].toFixed(0)})`);

    const corePos = toCorePosition(positions.getAll().find(p => p.symbol === exit.symbol)!);
    const exitResult = await executeBrokerExit(corePos, exit.reason, exit.decisionPrice);

    if (exitResult.success) {
      dailyPnl += exitResult.pnl;
      guard.recordLoss(exitResult.pnl);
      if (exitResult.pnl > 0) winsTotal++;
      tradesTotal++;

      const emoji = exitResult.pnl >= 0 ? '💰' : '💸';
      console.log(`[agent] ${emoji} CLOSED ${corePos.symbol} (${exit.reason}): P&L $${exitResult.pnl.toFixed(0)}`);
    } else {
      allExitsSucceeded = false;
      console.error(`[agent] Failed to exit ${corePos.symbol} — will retry next cycle`);
    }
  }

  // 9. Evaluate & execute entry
  const spxLive = priceStream.getPrice('SPX');
  const spxCurrentPrice = spxLive?.last ?? spxPrice;
  const candidates = buildCandidates(snap);

  // ── MTF confirmation: fetch higher-TF HMA direction if enabled ──
  let mtfDirection: 'bullish' | 'bearish' | null = null;
  const mtfCfg = config.signals.mtfConfirmation;
  if (mtfCfg?.enabled && mtfCfg.timeframe) {
    const mtfBars = await fetchBarsAtTf(mtfCfg.timeframe, 30);
    const stripped = stripFormingCandle(mtfBars, tfToSeconds(mtfCfg.timeframe));
    if (stripped.length >= 2) {
      const hmaFastKey = `hma${config.signals.hmaCrossFast ?? 5}`;
      const hmaSlowKey = `hma${config.signals.hmaCrossSlow ?? 19}`;
      const last = stripped[stripped.length - 1].indicators;
      if (last[hmaFastKey] != null && last[hmaSlowKey] != null) {
        mtfDirection = last[hmaFastKey]! > last[hmaSlowKey]! ? 'bullish' : 'bearish';
        console.log(`[agent] MTF ${mtfCfg.timeframe} HMA: ${mtfDirection} (fast=${last[hmaFastKey]!.toFixed(2)} slow=${last[hmaSlowKey]!.toFixed(2)})`);
      }
    }
  }

  const { entry, skipReason } = evaluateEntry(signal, exits, positions.count() + exits.length, config, {
    ts: Math.floor(Date.now() / 1000),
    spxPrice: spxCurrentPrice,
    candidates,
    dailyPnl,
    tradesCompleted: tradesTotal,
    lastEntryTs,
    closeCutoffTs,
    mtfDirection,
    accountValue: cachedAccountValue || null,
  });

  if (entry && allExitsSucceeded) {
    console.log(`[agent] 📥 Entry signal: ${entry.side.toUpperCase()} ${entry.symbol} x${entry.qty} @ $${entry.price.toFixed(2)} | ${entry.reason}`);
    await executeEntry(entry, snap);
  } else if (skipReason) {
    console.log(`[agent] Skip: ${skipReason}`);
  }

  // Stop streaming if no positions
  if (positions.count() === 0 && priceStream.isConnected()) {
    priceStream.stop();
  }

  // 10. Save session & report status
  saveSession();

  const wr = tradesTotal > 0 ? (winsTotal / tradesTotal * 100).toFixed(0) : '-';
  writeStatus({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    mode: snap.mode,
    paper: isPaper,
    spxPrice,
    minutesToClose: snap.minutesToClose,
    contractsTracked: snap.contracts.length,
    contractsWithBars: snap.contracts.filter(c => c.bars1m.length > 0).length,
    openPositions: positions.count(),
    dailyPnL: dailyPnl,
    judgeCallsToday: 0,
    lastAction: positions.count() > 0 ? 'holding' : 'watching',
    lastReasoning: `HMA ${signal.directionState.cross ?? 'none'} | trades: ${tradesTotal} (WR ${wr}%) | daily P&L: $${dailyPnl.toFixed(0)}`,
    scannerReads: [],
    nextCheckSecs: positions.count() > 0 ? 5 : 30,
    upSince: '',
  });

  logActivity({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    event: 'cycle' as any,
    summary: `SPX ${spxPrice.toFixed(2)} | HMA ${signal.directionState.cross ?? '-'} | ${positions.count()} open | P&L $${dailyPnl.toFixed(0)}`,
    details: {
      hmaCross: signal.directionState.cross,
      freshCross: signal.directionState.freshCross,
      openPositions: positions.count(),
      dailyPnl,
      tradesTotal,
      exits: exits.map(e => ({ symbol: e.symbol, reason: e.reason, pnl: e.pnl['pnl$'] })),
      entry: entry ? { symbol: entry.symbol, side: entry.side } : null,
      skipReason,
    },
  });

  // Poll faster when holding (5s) since stream handles TP/SL in between
  return positions.count() > 0 ? 5 : 30;
}

// ── Order Cleanup ────────────────────────────────────────────────────────────

async function cancelAllOpenOrders(): Promise<number> {
  const accountId = EXECUTION.accountId!;
  const hdrs = {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };

  let cancelled = 0;
  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      { headers: hdrs, timeout: 10000 },
    );
    const raw = data?.orders?.order;
    const orders = Array.isArray(raw) ? raw : raw ? [raw] : [];

    for (const order of orders) {
      if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'partially_filled') continue;
      try {
        await axios.delete(
          `${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`,
          { headers: hdrs, timeout: 10000 },
        );
        console.log(`[agent] 🗑️ Cancelled order #${order.id} (${order.class} ${order.status})`);
        cancelled++;
      } catch (e: any) {
        console.warn(`[agent] ⚠️ Failed to cancel #${order.id}: ${e?.response?.data?.errors?.error || e.message}`);
      }
    }
  } catch (e: any) {
    console.warn(`[agent] ⚠️ Failed to fetch orders for cleanup: ${e.message}`);
  }

  return cancelled;
}

// ── Market Hours ─────────────────────────────────────────────────────────────

function etMinuteOfDay(): number {
  const { h, m } = nowET();
  return h * 60 + m;
}

const MARKET_OPEN = 9 * 60 + 30;
const MARKET_CLOSE = 16 * 60;

function isMarketOpen(): boolean {
  const mins = etMinuteOfDay();
  return mins >= MARKET_OPEN && mins < MARKET_CLOSE;
}

async function sleepUntilMarketOpen(): Promise<void> {
  while (true) {
    const mins = etMinuteOfDay();
    if (mins >= MARKET_OPEN && mins < MARKET_CLOSE) return;
    let waitMins: number;
    if (mins >= MARKET_CLOSE) {
      waitMins = (24 * 60 - mins) + MARKET_OPEN;
    } else {
      waitMins = MARKET_OPEN - mins;
    }
    const waitMs = Math.min(waitMins * 60 * 1000, 5 * 60 * 1000);
    console.log(`[agent] Market closed — ${waitMins} min until open. Sleeping...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── Daily Review ────────────────────────────────────────────────────────────

function dailyReview(): void {
  const date = todayET();
  const wr = tradesTotal > 0 ? (winsTotal / tradesTotal * 100).toFixed(1) : '0';
  const losses = tradesTotal - winsTotal;
  const avgPnl = tradesTotal > 0 ? (dailyPnl / tradesTotal).toFixed(2) : '0';

  const review = [
    `\n${'═'.repeat(70)}`,
    `  DAILY REVIEW — ${date} — SPX Agent (${EXECUTION.accountId!})`,
    `${'═'.repeat(70)}`,
    ``,
    `  Config:     ${config.id}`,
    `  Trades:     ${tradesTotal} total (${winsTotal} wins, ${losses} losses)`,
    `  Win Rate:   ${wr}%`,
    `  Daily P&L:  $${dailyPnl.toFixed(2)}`,
    `  Avg P&L:    $${avgPnl}/trade`,
    `  Paper:      ${isPaper ? 'YES' : 'NO — LIVE'}`,
    `  Rejections: ${consecutiveRejections} consecutive`,
    ``,
  ];

  const lessons: string[] = [];
  if (tradesTotal === 0) lessons.push('No trades executed.');
  if (tradesTotal > 30) lessons.push(`High trade count (${tradesTotal}). HMA whipsawing.`);
  if (dailyPnl < -1000) lessons.push(`Significant loss ($${dailyPnl.toFixed(0)}).`);
  if (tradesTotal > 0 && parseFloat(wr) < 40) lessons.push(`Low win rate (${wr}%).`);
  if (tradesTotal > 0 && parseFloat(wr) > 70) lessons.push(`Strong win rate (${wr}%).`);
  if (dailyPnl > 0 && tradesTotal > 0) lessons.push(`Profitable day.`);
  if (consecutiveRejections > 0) lessons.push(`${consecutiveRejections} rejections — check buying power.`);

  if (lessons.length > 0) {
    review.push(`  Lessons:`);
    for (const l of lessons) review.push(`    • ${l}`);
    review.push(``);
  }

  review.push(`${'═'.repeat(70)}\n`);
  const text = review.join('\n');
  console.log(text);

  try {
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
    fs.appendFileSync(path.join(process.cwd(), 'logs', 'daily-reviews.log'), text + '\n');
  } catch (e) {
    console.error('[agent] Failed to write daily review:', (e as Error).message);
  }

  logActivity({
    ts: Date.now(),
    timeET: `${nowET().h.toString().padStart(2, '0')}:${nowET().m.toString().padStart(2, '0')} ET`,
    cycle: cycleCount,
    event: 'close',
    summary: `DAILY REVIEW: ${tradesTotal} trades, WR ${wr}%, P&L $${dailyPnl.toFixed(0)}`,
    details: { tradesTotal, winsTotal, losses, dailyPnl, winRate: parseFloat(wr), lessons },
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  if (!process.env.TRADIER_TOKEN) {
    console.error('[agent] TRADIER_TOKEN not set');
    process.exit(1);
  }
  if (!isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  // Start price stream (connects on demand)
  await priceStream.start([]);

  // Outer loop: one iteration per trading day
  while (true) {
    console.log('[agent] Waiting for market open...');
    await sleepUntilMarketOpen();

    const today = todayET();
    const existingSession = loadSession();
    const isResume = existingSession?.date === today;

    if (isResume) {
      // ── Crash-restart mid-session: restore state ──
      // Restore signal state from session (HMA cross direction, etc.)
      dailyDate        = today;
      restoreSessionState(existingSession!);
      console.log(`[agent] ⚡ RESUMING session for ${today}`);
    } else {
      // ── Fresh session start ──
      console.log('[agent] Market open — starting trading session');

      // Pre-open: cancel stale orders from previous sessions
      const cancelledPreOpen = await cancelAllOpenOrders();
      if (cancelledPreOpen > 0) console.log(`[agent] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

      consecutiveRejections = 0;
      rejectionBackoffUntil = 0;
      dailyDate            = today;
      signalState          = createInitialSignalState();
      lastEntryTs          = 0;

      // Dynamic sizing (once per day) — fetch account buying power
      const sizingPct = config.sizing.accountPercentPerTrade ?? config.sizing.riskPercentOfAccount;
      if (sizingPct) {
        const balance = await getAccountBalance(EXECUTION.accountId);
        if (balance) {
          cachedAccountValue = balance.optionBuyingPower;
          console.log(`[agent] Account buying power: $${cachedAccountValue.toFixed(0)} (${sizingPct}% per trade)`);
        }
      }
    }

    // ── Broker is truth: sync P&L and trade count from actual filled orders ──
    const brokerPnl = await computeBrokerDailyPnl();
    dailyPnl    = brokerPnl.pnl;
    tradesTotal = brokerPnl.trades;
    winsTotal   = brokerPnl.wins;
    guard.syncFromBroker(brokerPnl.pnl, brokerPnl.trades);
    console.log(`[agent] Broker P&L: $${dailyPnl.toFixed(0)} | ${tradesTotal} trades (${winsTotal}W ${tradesTotal - winsTotal}L)`);
    saveSession();

    // Reconcile broker positions every start/resume
    const reconciled = await positions.reconcileFromBroker(EXECUTION);
    if (reconciled > 0) {
      console.log(`[agent] Reconciled ${reconciled} position(s) from broker`);
      const symbols = positions.getAll().map(p => p.symbol);
      // Fire-and-forget: don't await — connect() blocks forever reading the stream.
      // The stream will connect in the background and start delivering prices.
      if (symbols.length > 0) priceStream.updateSymbols(symbols).catch(() => {});

      // Positions are now managed by PositionManager (broker is truth)
      // No need to sync into strategy state
    }

    console.log('[agent] First cycle in 5s...\n');
    await new Promise(r => setTimeout(r, 5000));

    // Inner loop: trade until market close
    while (isMarketOpen()) {
      let nextCheckSecs = 30;
      try {
        nextCheckSecs = await runCycle();
      } catch (e) {
        console.error('[agent] Cycle error:', e);
      }
      await new Promise(r => setTimeout(r, nextCheckSecs * 1000));
    }

    // Market closed
    console.log('\n[agent] 🔔 Market closed — ending trading session');
    priceStream.stop();
    const cancelledAtClose = await cancelAllOpenOrders();
    if (cancelledAtClose > 0) console.log(`[agent] Cancelled ${cancelledAtClose} open order(s) at market close`);
    dailyReview();
    clearSession();
    console.log('[agent] Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', () => { priceStream.stop(); console.log('\n[agent] Shutting down (SIGTERM)'); process.exit(0); });
process.on('SIGINT',  () => { priceStream.stop(); console.log('\n[agent] Shutting down (SIGINT)');  process.exit(0); });

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
