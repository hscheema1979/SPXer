/**
 * SPXer Deterministic Trading Agent — tick()-based
 *
 * Uses the same tick() function from src/core/strategy-engine.ts that
 * replay uses. Config loaded from DB — same config validated in replay.
 *
 * Strategy: HMA(fast) × HMA(slow) cross on SPX underlying → enter OTM contract
 *           → exit on reversal cross (scannerReverse) → immediately flip
 *
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
import { writeStatus, logActivity } from './src/agent/reporter';
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
import { computeTradeSize } from './src/agent/account-balance';
import type { CoreBar } from './src/core/types';
import type { Config } from './src/config/types';
import {
  tick,
  createInitialState,
  stripFormingCandle,
  type CorePosition,
  type StrategyState,
  type TickInput,
  type TickResult,
} from './src/core/strategy-engine';

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

// ── Strategy State — persisted across cycles, survives restarts ─────────────

let strategyState: StrategyState = createInitialState();

// ── Session state file — survives restarts ───────────────────────────────────

const SESSION_FILE = path.join(process.cwd(), 'logs', 'agent-session.json');

interface SessionState {
  date: string;
  dailyPnl: number;
  tradesTotal: number;
  winsTotal: number;
  startedAt: number;
  strategyState?: {
    directionCross: string | null;
    prevDirectionHmaFast: number | null;
    prevDirectionHmaSlow: number | null;
    lastDirectionBarTs: number | null;
    exitCross: string | null;
    prevExitHmaFast: number | null;
    prevExitHmaSlow: number | null;
    lastExitBarTs: number | null;
    lastEntryTs: number;
    dailyPnl: number;
    tradesCompleted: number;
    positions: Array<CorePosition>;
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
    // Serialize strategy state (Map → Array for JSON)
    const posArr = Array.from(strategyState.positions.values());
    fs.writeFileSync(SESSION_FILE, JSON.stringify({
      date: dailyDate,
      dailyPnl,
      tradesTotal,
      winsTotal,
      startedAt: Date.now(),
      strategyState: {
        directionCross: strategyState.directionCross,
        prevDirectionHmaFast: strategyState.prevDirectionHmaFast,
        prevDirectionHmaSlow: strategyState.prevDirectionHmaSlow,
        lastDirectionBarTs: strategyState.lastDirectionBarTs,
        exitCross: strategyState.exitCross,
        prevExitHmaFast: strategyState.prevExitHmaFast,
        prevExitHmaSlow: strategyState.prevExitHmaSlow,
        lastExitBarTs: strategyState.lastExitBarTs,
        lastEntryTs: strategyState.lastEntryTs,
        dailyPnl: strategyState.dailyPnl,
        tradesCompleted: strategyState.tradesCompleted,
        positions: posArr,
      },
    }));
  } catch {}
}

function restoreStrategyState(session: SessionState): void {
  if (!session.strategyState) return;
  const ss = session.strategyState;
  strategyState.directionCross = ss.directionCross as any;
  strategyState.prevDirectionHmaFast = ss.prevDirectionHmaFast;
  strategyState.prevDirectionHmaSlow = ss.prevDirectionHmaSlow;
  strategyState.lastDirectionBarTs = ss.lastDirectionBarTs;
  strategyState.exitCross = ss.exitCross as any;
  strategyState.prevExitHmaFast = ss.prevExitHmaFast;
  strategyState.prevExitHmaSlow = ss.prevExitHmaSlow;
  strategyState.lastExitBarTs = ss.lastExitBarTs;
  strategyState.lastEntryTs = ss.lastEntryTs;
  strategyState.dailyPnl = ss.dailyPnl;
  strategyState.tradesCompleted = ss.tradesCompleted;
  strategyState.positions = new Map();
  for (const p of ss.positions ?? []) {
    strategyState.positions.set(p.id, p);
  }
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

        // Add to strategy state
        const corePos: CorePosition = {
          id: bp.symbol,
          symbol: bp.symbol,
          side: side as any,
          strike,
          qty: quantity,
          entryPrice,
          stopLoss,
          takeProfit,
          entryTs: Math.floor((openPos.openedAt) / 1000),
          highWaterPrice: entryPrice,
        };
        strategyState.positions.set(corePos.id, corePos);

        // Start streaming prices for the adopted position (fire-and-forget)
        priceStream.updateSymbols([bp.symbol]).catch(() => {});
      }
    }

    // Phantom in agent — drop it
    for (const pos of positions.getAll()) {
      if (!brokerSymbols.has(pos.symbol)) {
        console.log(`[agent] ⚠️ PHANTOM: ${pos.symbol} — dropping from agent state`);
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
 * Build contract bars map for tick() from snapshot data.
 */
function buildContractBars(snap: MarketSnapshot): Map<string, CoreBar[]> {
  const map = new Map<string, CoreBar[]>();
  for (const c of snap.contracts) {
    if (c.bars1m.length < 2) continue;
    const coreBars: CoreBar[] = c.bars1m.map(b => toCoreBar(b));
    map.set(c.meta.symbol, coreBars);
  }
  return map;
}

/**
 * Build position prices from PriceStream tick cache.
 */
function buildPositionPrices(): Map<string, number> {
  const prices = new Map<string, number>();
  for (const [, pos] of strategyState.positions) {
    const cached = priceStream.getPrice(pos.symbol);
    if (cached) prices.set(pos.symbol, cached.last);
  }
  return prices;
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

async function executeExit(
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
  entry: NonNullable<TickResult['entry']>,
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
      await priceStream.updateSymbols([position.symbol]);

      // Add to strategy state
      const corePos: CorePosition = {
        id: entry.symbol,
        symbol: entry.symbol,
        side: entry.side,
        strike: entry.strike,
        qty: entry.qty,
        entryPrice: fillPrice,
        stopLoss: entry.stopLoss,
        takeProfit: entry.takeProfit,
        entryTs: Math.floor(Date.now() / 1000),
        highWaterPrice: fillPrice,
      };
      strategyState.positions.set(corePos.id, corePos);
      strategyState.lastEntryTs = corePos.entryTs;

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
  console.log(`║  Signal:  HMA(${config.signals.hmaCrossFast})×HMA(${config.signals.hmaCrossSlow}) cross on SPX underlying      ║`);
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
      strategyState.dailyPnl += pnl;
      strategyState.tradesCompleted++;
      guard.recordLoss(pnl);
      positions.remove(pos.id);
      strategyState.positions.delete(pos.symbol);

      const emoji = pnl >= 0 ? '💰' : '💸';
      if (pnl > 0) winsTotal++;
      tradesTotal++;
      console.log(`[agent] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)}: P&L $${pnl.toFixed(0)}`);
    }
    streamExitPending = false;
    saveSession();
  }
  streamExitPending = false;

  // 5. Build tick input

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

  // 5c. Contract bars at signal timeframe
  const contractBars = buildContractBars(snap);

  // 5d. Position prices from PriceStream tick cache
  const positionPrices = buildPositionPrices();

  // Also use Tradier quotes for positions not in the stream
  for (const [, pos] of strategyState.positions) {
    if (!positionPrices.has(pos.symbol)) {
      // Fall back to snapshot quote
      const contractState = snap.contracts.find(c => c.meta.symbol === pos.symbol);
      const price = contractState?.quote?.last ?? contractState?.quote?.mid;
      if (price && price > 0) positionPrices.set(pos.symbol, price);
    }
  }

  // 5e. SPX price from stream or snapshot
  const spxLive = priceStream.getPrice('SPX');
  const spxCurrentPrice = spxLive?.last ?? spxPrice;

  // 5f. Candidates from contract pool
  const candidates = buildCandidates(snap);

  // 5g. Position bar high/low for intrabar TP/SL detection
  const positionBars = new Map<string, { high: number; low: number }>();
  for (const [, pos] of strategyState.positions) {
    const contractState = snap.contracts.find(c => c.meta.symbol === pos.symbol);
    if (contractState && contractState.bars1m.length > 0) {
      const lastBar = contractState.bars1m[contractState.bars1m.length - 1];
      positionBars.set(pos.symbol, { high: lastBar.high ?? lastBar.close, low: lastBar.low ?? lastBar.close });
    }
  }

  // 6. Call tick() — same function replay uses
  const lastDirBar = spxDirBars.length > 0 ? spxDirBars[spxDirBars.length - 1] : null;
  const tickInput: TickInput = {
    ts: lastDirBar?.ts ?? Math.floor(Date.now() / 1000),
    spxDirectionBars: spxDirBars,
    spxExitBars,
    contractBars,
    spxPrice: spxCurrentPrice,
    closeCutoffTs: computeCloseCutoff(),
    candidates,
    positionPrices,
    positionBars,
  };

  const result = tick(strategyState, tickInput, config);

  // 7. Apply HMA state (always, even if no trades)
  strategyState.directionCross = result.directionState.directionCross;
  strategyState.prevDirectionHmaFast = result.directionState.prevHmaFast;
  strategyState.prevDirectionHmaSlow = result.directionState.prevHmaSlow;
  strategyState.lastDirectionBarTs = result.directionState.lastBarTs;
  strategyState.exitCross = result.exitState.exitCross;
  strategyState.prevExitHmaFast = result.exitState.prevHmaFast;
  strategyState.prevExitHmaSlow = result.exitState.prevHmaSlow;
  strategyState.lastExitBarTs = result.exitState.lastBarTs;

  // Log direction state
  if (result.directionState.directionCross) {
    const arrow = result.directionState.directionCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[agent] HMA cross: ${arrow} ${result.directionState.directionCross.toUpperCase()}${result.directionState.freshCross ? ' (FRESH SIGNAL)' : ''}`);
  }

  // 8. Execute exits FIRST
  let allExitsSucceeded = true;
  for (const exit of result.exits) {
    console.log(`[agent] 📤 Exiting ${exit.symbol} — reason: ${exit.reason} @ $${exit.decisionPrice.toFixed(2)} (est P&L: $${exit.pnl['pnl$'].toFixed(0)})`);

    const pos = strategyState.positions.get(exit.positionId);
    if (!pos) {
      console.warn(`[agent] Position ${exit.positionId} not found in strategy state`);
      continue;
    }

    const exitResult = await executeExit(pos, exit.reason, exit.decisionPrice);

    if (exitResult.success) {
      strategyState.positions.delete(exit.positionId);
      strategyState.dailyPnl += exitResult.pnl;
      strategyState.tradesCompleted++;
      dailyPnl += exitResult.pnl;
      guard.recordLoss(exitResult.pnl);
      if (exitResult.pnl > 0) winsTotal++;
      tradesTotal++;

      const emoji = exitResult.pnl >= 0 ? '💰' : '💸';
      console.log(`[agent] ${emoji} CLOSED ${pos.symbol} (${exit.reason}): P&L $${exitResult.pnl.toFixed(0)}`);
    } else {
      allExitsSucceeded = false;
      console.error(`[agent] Failed to exit ${pos.symbol} — will retry next cycle`);
    }
  }

  // 9. Execute entry ONLY if all exits succeeded
  if (result.entry && allExitsSucceeded) {
    console.log(`[agent] 📥 Entry signal: ${result.entry.side.toUpperCase()} ${result.entry.symbol} x${result.entry.qty} @ $${result.entry.price.toFixed(2)} | ${result.entry.reason}`);
    await executeEntry(result.entry, snap);
  } else if (result.skipReason) {
    console.log(`[agent] Skip: ${result.skipReason}`);
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
    lastReasoning: `HMA ${result.directionState.directionCross ?? 'none'} | trades: ${tradesTotal} (WR ${wr}%) | daily P&L: $${dailyPnl.toFixed(0)}`,
    scannerReads: [],
    nextCheckSecs: positions.count() > 0 ? 5 : 30,
    upSince: '',
  });

  logActivity({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    event: 'cycle' as any,
    summary: `SPX ${spxPrice.toFixed(2)} | HMA ${result.directionState.directionCross ?? '-'} | ${positions.count()} open | P&L $${dailyPnl.toFixed(0)}`,
    details: {
      hmaCross: result.directionState.directionCross,
      freshCross: result.directionState.freshCross,
      openPositions: positions.count(),
      dailyPnl,
      tradesTotal,
      exits: result.exits.map(e => ({ symbol: e.symbol, reason: e.reason, pnl: e.pnl['pnl$'] })),
      entry: result.entry ? { symbol: result.entry.symbol, side: result.entry.side } : null,
      skipReason: result.skipReason,
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
      dailyPnl         = existingSession!.dailyPnl;
      tradesTotal      = existingSession!.tradesTotal;
      winsTotal        = existingSession!.winsTotal;
      dailyDate        = today;
      restoreStrategyState(existingSession!);
      console.log(`[agent] ⚡ RESUMING session for ${today} (P&L $${dailyPnl.toFixed(0)}, ${tradesTotal} trades, ${strategyState.positions.size} positions in state)`);
    } else {
      // ── Fresh session start ──
      console.log('[agent] Market open — starting trading session');

      // Pre-open: cancel stale orders from previous sessions
      const cancelledPreOpen = await cancelAllOpenOrders();
      if (cancelledPreOpen > 0) console.log(`[agent] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

      dailyPnl             = 0;
      tradesTotal          = 0;
      winsTotal            = 0;
      consecutiveRejections = 0;
      rejectionBackoffUntil = 0;
      dailyDate            = today;
      strategyState        = createInitialState();
      guard.resetIfNewDay();
      saveSession();

      // Dynamic sizing (once per day)
      if (config.sizing.riskPercentOfAccount) {
        const tradeSize = await computeTradeSize(
          config.sizing.riskPercentOfAccount,
          EXECUTION.accountId,
        );
        config.sizing.baseDollarsPerTrade = tradeSize;
        console.log(`[agent] Daily sizing: $${tradeSize} per trade (${config.sizing.riskPercentOfAccount}% of account)`);
      }
    }

    // Reconcile broker positions every start/resume
    const reconciled = await positions.reconcileFromBroker(EXECUTION);
    if (reconciled > 0) {
      console.log(`[agent] Reconciled ${reconciled} position(s) from broker`);
      const symbols = positions.getAll().map(p => p.symbol);
      // Fire-and-forget: don't await — connect() blocks forever reading the stream.
      // The stream will connect in the background and start delivering prices.
      if (symbols.length > 0) priceStream.updateSymbols(symbols).catch(() => {});

      // Sync reconciled positions into strategy state
      for (const pos of positions.getAll()) {
        if (!strategyState.positions.has(pos.symbol)) {
          strategyState.positions.set(pos.symbol, {
            id: pos.symbol,
            symbol: pos.symbol,
            side: pos.side,
            strike: pos.strike,
            qty: pos.quantity,
            entryPrice: pos.entryPrice,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit ?? pos.entryPrice * config.position.takeProfitMultiplier,
            entryTs: Math.floor(pos.openedAt / 1000),
            highWaterPrice: pos.entryPrice,
          });
        }
      }
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
