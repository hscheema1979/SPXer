/**
 * SPXer XSP Agent — Cash Account
 *
 * Signal pipeline (identical to replay/machine.ts):
 *   detectSignals() on option contract bars (signalTf) → HMA(fast)×HMA(slow) cross
 *   → optional SPX direction gate (requireUnderlyingHmaCross)
 *   → strike selection → OTOCO bracket order
 *   → exit: SPX HMA cross on exitTf triggers scannerReverse → flip to opposite side
 *
 * Executes on XSP (Mini-SPX, 1/10th size of SPX):
 *   - 1DTE options (next-day expiry), cash-settled
 *   - 1 contract at a time, cash account 6YA58635
 *   - Strike conversion: SPX strikes ÷ 10 (strikeDivisor: 10)
 *   - Contract bars fetched directly from the data API at signalTf
 *     (NOT the pre-aggregated snapshot bars — those copy 1m indicators)
 *
 * Config loaded from DB by AGENT_CONFIG_ID — same config validated in replay.
 * HTTP streaming for real-time TP/SL monitoring when holding a position.
 *
 * Usage:
 *   npx tsx agent-xsp.ts                        # paper mode
 *   AGENT_PAPER=false npx tsx agent-xsp.ts      # live
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot, type MarketSnapshot } from './src/agent/market-feed';
import { openPosition, closePosition, cancelOcoLegs, convertOptionSymbol } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { createStore } from './src/replay/store';
import { DEFAULT_CONFIG } from './src/config/defaults';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { HealthGate } from './src/agent/health-gate';
import { validateTradeQuality, DEFAULT_QUALITY_CONFIG } from './src/agent/quality-gate';
import { writeStatus, logActivity, setAgentId } from './src/agent/reporter';
setAgentId('xsp');
import { PriceStream } from './src/agent/price-stream';
import { nowET, todayET, etTimeToUnixTs } from './src/utils/et-time';
import { config as appConfig, TRADIER_BASE } from './src/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSignal, AgentDecision, OpenPosition } from './src/agent/types';
import type { StrikeCandidate } from './src/core/strike-selector';
import { computeTradeSize } from './src/agent/account-balance';
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
const _xspStore = createStore();
const CFG: Config = _xspStore.getConfig(CONFIG_ID) ?? DEFAULT_CONFIG;
_xspStore.close();

// Execution target is a property of the AGENT, not the config.
// The config defines trading strategy (signals, exits, risk). The agent defines where orders go.
const EXEC: NonNullable<Config['execution']> = {
  symbol: 'XSP',
  optionPrefix: 'XSP',
  strikeDivisor: 10,
  strikeInterval: 1,
  accountId: process.env.XSP_ACCOUNT_ID || '6YA58635',
};

console.log(`[xsp] Loaded config: ${CFG.id} — "${CFG.name}"`);

// ── Resolve Timeframes ──────────────────────────────────────────────────────

const dirTf = CFG.signals.directionTimeframe || '1m';
const exitTf = CFG.signals.exitTimeframe || dirTf;
const signalTf = CFG.signals.signalTimeframe || '1m';

// ── Initialize ──────────────────────────────────────────────────────────────

const isPaper = process.env.AGENT_PAPER !== 'false';
const guard = new RiskGuard(CFG);
const positions = new PositionManager(CFG, isPaper);
const priceStream = new PriceStream();
const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

let cycleCount = 0;
let dailyDate = '';
let dailyPnl = 0;
let tradesTotal = 0;
let winsTotal = 0;
let consecutiveRejections = 0;
const MAX_REJECTIONS_BEFORE_BACKOFF = 3;
const MAX_REJECTIONS_BEFORE_HALT = 5;
const REJECTION_BACKOFF_SECS = 300;
let rejectionBackoffUntil = 0;
let sessionHalted = false;

// ── Health Gate — circuit breaker ──────────────────────────────────────────

const healthGate = new HealthGate({ spxerUrl: SPXER_BASE });

// ── Pause flag — written by dashboard/watchdog ─────────────────────────────

const PAUSE_FLAG_FILE = path.resolve('./logs/pause-trading-xsp.flag');
function isTradingPaused(): boolean {
  try { return fs.existsSync(PAUSE_FLAG_FILE); } catch { return false; }
}

// ── Signal State — HMA cross tracking, no positions ─────────────────────────

let signalState: SignalState = createInitialSignalState();
let lastEntryTs = 0;  // cooldown tracking

// ── Option Contract Signal Dedup ─────────────────────────────────────────────
// Tracks the bar timestamp for each contract signal we've already processed.
// Key: `${symbol}:${signalType}:${direction}` → last processed bar ts
// Prevents the same cross from triggering multiple entries across polling cycles.
const processedSignalTs = new Map<string, number>();

// ── Session state file — survives restarts ───────────────────────────────────

const XSP_SESSION_FILE = path.join(process.cwd(), 'logs', 'xsp-session.json');

interface XspSessionState {
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

function loadXspSession(): XspSessionState | null {
  try {
    const raw = fs.readFileSync(XSP_SESSION_FILE, 'utf8');
    return JSON.parse(raw) as XspSessionState;
  } catch { return null; }
}

function saveXspSession(): void {
  try {
    fs.mkdirSync(path.join(process.cwd(), 'logs'), { recursive: true });
    fs.writeFileSync(XSP_SESSION_FILE, JSON.stringify({
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

function restoreXspSessionState(session: XspSessionState): void {
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

// ── Price Stream TP/SL Callback ─────────────────────────────────────────────

let streamExitPending = false;

priceStream.onPrice((symbol, last, bid, ask) => {
  for (const pos of positions.getAll()) {
    if (pos.symbol !== symbol) continue;
    const sellPrice = bid > 0 ? bid : last;

    // Track intra-trade highs/lows
    const now = Date.now();
    if (last > (pos.highPrice ?? pos.entryPrice)) {
      pos.highPrice = last;
      pos.highTs = now;
    }
    if (last < (pos.lowPrice ?? pos.entryPrice)) {
      pos.lowPrice = last;
      pos.lowTs = now;
    }
    const pnlPct = (last - pos.entryPrice) / pos.entryPrice;
    if (pnlPct > (pos.maxPnlPct ?? 0)) pos.maxPnlPct = pnlPct;
    if (pnlPct < (pos.maxDrawdownPct ?? 0)) pos.maxDrawdownPct = pnlPct;

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
  const accountId = EXEC.accountId!;
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
    for (const bp of brokerPositions) {
      if (!agentSymbols.has(bp.symbol)) {
        const quantity = Math.abs(bp.quantity);
        const costBasis = Math.abs(bp.cost_basis);
        const entryPrice = costBasis / (quantity * 100);

        const match = (bp.symbol as string).match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        if (!match) {
          console.warn(`[xsp] ⚠️ ORPHAN at broker: ${bp.symbol} x${quantity} — unrecognized symbol, skipping`);
          continue;
        }
        const [, , dateStr, callPut, strikeStr] = match;
        const side = callPut === 'C' ? 'call' : 'put';
        const strike = parseInt(strikeStr) / 1000;
        const expiry = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;
        const stopLoss = entryPrice * (1 - CFG.position.stopLossPercent / 100);
        const takeProfit = entryPrice * CFG.position.takeProfitMultiplier;

        console.log(`[xsp] 📥 ADOPTING orphan from broker: ${bp.symbol} x${quantity} @ $${entryPrice.toFixed(2)} (${side} ${strike})`);

        const { randomUUID } = await import('crypto');
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
        priceStream.updateSymbols([bp.symbol]).catch(() => {});
      }
    }

    for (const pos of positions.getAll()) {
      if (!brokerSymbols.has(pos.symbol)) {
        console.log(`[xsp] ⚠️ PHANTOM position: ${pos.symbol} — dropping from agent`);
        positions.remove(pos.id);
      }
    }
  } catch (e: any) {
    console.warn(`[xsp] Reconciliation check failed: ${e.message}`);
  }
}

// ── Data Conversion Helpers ─────────────────────────────────────────────────

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

function extractIndicators(b: any): Record<string, number | null> {
  if (b.indicators && typeof b.indicators === 'object') {
    return b.indicators;
  }
  return {};
}

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
    console.warn(`[xsp] Failed to fetch bars at ${tf}: ${(e as Error).message}`);
    return [];
  }
}

function buildCandidates(snap: MarketSnapshot): StrikeCandidate[] {
  return snap.contracts.map(c => ({
    symbol: c.meta.symbol,
    side: c.meta.side,
    strike: c.meta.strike,
    price: c.quote.last ?? c.quote.mid ?? 0,
    volume: c.greeks.volume ?? 0,
  }));
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
    takeProfit: pos.takeProfit ?? pos.entryPrice * CFG.position.takeProfitMultiplier,
    entryTs: Math.floor(pos.openedAt / 1000),
    highWaterPrice: pos.highPrice ?? pos.entryPrice,
  };
}

function computeCloseCutoff(): number {
  return etTimeToUnixTs(CFG.risk.cutoffTimeET || '16:00');
}

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

// ── XSP-Specific Helpers ────────────────────────────────────────────────────

/** Fetch real-time quote from Tradier API (source of truth for execution) */
async function fetchXspQuote(symbol: string): Promise<{ last: number; bid: number; ask: number } | null> {
  try {
    const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
      headers: { Authorization: `Bearer ${appConfig.tradierToken}`, Accept: 'application/json' },
      params: { symbols: symbol, greeks: 'false' },
      timeout: 5000,
    });
    const q = data?.quotes?.quote;
    if (!q) return null;
    const bid = q.bid ?? 0;
    const ask = q.ask ?? 0;
    const last = q.last ?? (bid + ask) / 2;
    return { last, bid, ask };
  } catch (e) {
    console.error(`[xsp] Quote fetch failed for ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

// ── Order Execution Helpers ─────────────────────────────────────────────────

async function executeBrokerExit(
  pos: CorePosition,
  reason: string,
  decisionPrice: number,
): Promise<{ success: boolean; fillPrice: number; pnl: number }> {
  const openPos = positions.getAll().find(p => p.symbol === pos.symbol);

  if (openPos?.bracketOrderId && !isPaper) {
    try {
      await cancelOcoLegs(openPos.bracketOrderId, EXEC);
    } catch (e: any) {
      console.warn(`[xsp] Failed to cancel bracket: ${e.message}`);
    }
  }

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

  const result = await closePosition(dummyPos, reason, decisionPrice, isPaper, EXEC);

  if (result.error) {
    console.error(`[xsp] ❌ Exit failed for ${pos.symbol}: ${result.error}`);
    return { success: false, fillPrice: decisionPrice, pnl: 0 };
  }

  const fillPrice = result.fillPrice ?? decisionPrice;
  const pnl = (fillPrice - pos.entryPrice) * pos.qty * 100;

  if (openPos) positions.remove(openPos.id);

  return { success: true, fillPrice, pnl };
}

async function executeEntry(
  entry: { symbol: string; side: 'call' | 'put'; strike: number; price: number; qty: number; stopLoss: number; takeProfit: number; direction: string; reason: string },
  snap: MarketSnapshot,
): Promise<boolean> {
  if (sessionHalted) {
    console.log('[xsp] ⛔ Session halted due to repeated buying-power rejections');
    return false;
  }

  if (Date.now() < rejectionBackoffUntil) {
    const remaining = Math.round((rejectionBackoffUntil - Date.now()) / 1000);
    console.log(`[xsp] Rejection backoff — ${remaining}s remaining`);
    return false;
  }

  if (positions.count() >= (CFG.position.maxPositionsOpen ?? 1)) {
    console.log(`[xsp] Already have ${positions.count()} open position(s) — skipping entry`);
    return false;
  }

  // Expired contract validation
  const contractMeta = snap.contracts.find(c => c.meta.symbol === entry.symbol);
  const contractExpiry = contractMeta?.meta.expiry;
  if (contractExpiry && contractExpiry < todayET()) {
    console.log(`[xsp] ⚠️ Contract ${entry.symbol} expired (${contractExpiry} < ${todayET()}) — skipping`);
    return false;
  }

  // Convert SPX symbol → XSP symbol
  const xspSymbol = convertOptionSymbol(entry.symbol, EXEC);
  const xspStrike = entry.strike / EXEC.strikeDivisor;

  // Fetch real XSP quote from Tradier — source of truth for execution prices
  const xspQuote = await fetchXspQuote(xspSymbol);
  if (!xspQuote || xspQuote.ask <= 0) {
    console.log(`[xsp] No valid quote for ${xspSymbol} — skipping entry`);
    return false;
  }

  const entryPrice = xspQuote.ask;
  const stopLoss = entryPrice * (1 - CFG.position.stopLossPercent / 100);
  const takeProfit = entryPrice * CFG.position.takeProfitMultiplier;

  // Price vs budget pre-check
  const contractCost = entryPrice * 100;
  if (contractCost > CFG.sizing.baseDollarsPerTrade) {
    console.log(`[xsp] 💰 Contract too expensive: $${contractCost.toFixed(0)} > budget $${CFG.sizing.baseDollarsPerTrade} — skipping`);
    return false;
  }

  console.log(`[xsp] Quote ${xspSymbol}: bid=$${xspQuote.bid.toFixed(2)} ask=$${xspQuote.ask.toFixed(2)} last=$${xspQuote.last.toFixed(2)}`);

  const contractState = snap.contracts.find(c => c.meta.symbol === entry.symbol);

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: xspSymbol,
    side: entry.side,
    strike: entry.strike,
    expiry: contractState?.meta.expiry ?? '',
    currentPrice: entryPrice,
    bid: xspQuote.bid,
    ask: xspQuote.ask,
    indicators: contractState?.bars1m[contractState.bars1m.length - 1] ?? {} as any,
    recentBars: contractState?.bars1m ?? [],
    signalBarLow: stopLoss,
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
    positionSize: 1,
    stopLoss,
    takeProfit,
    reasoning: `tick() → ${entry.reason} → ${entry.side} XSP ${xspStrike} x1 @ ~$${entryPrice.toFixed(2)}`,
    concerns: [],
    ts: Date.now(),
  };

  try {
    // Pre-trade quality gate
    const lastBar = contractState?.bars1m[contractState.bars1m.length - 1];
    const recentVolume = contractState?.bars1m.slice(-5).reduce((s, b) => s + (b.volume ?? 0), 0) ?? 0;
    const quality = validateTradeQuality({
      bid: xspQuote.bid ?? null,
      ask: xspQuote.ask ?? null,
      quoteTs: snap.ts,
      now: Date.now(),
      recentVolume,
      indicatorsComplete: !!(lastBar?.hma3 != null && lastBar?.hma17 != null),
      signalTs: Date.now(),
      config: DEFAULT_QUALITY_CONFIG,
    });
    if (!quality.passed) {
      console.warn(`[xsp] ⚠️ Quality gate BLOCKED ${xspSymbol}: ${quality.failures.join('; ')}`);
      logRejected(`Quality gate: ${quality.failures.join('; ')}`, xspSymbol, 'HMA_CROSS');
      return false;
    }

    const { position: pos, execution: exec } = await openPosition(signal, decision, isPaper, EXEC);
    if (!exec.error) {
      positions.add(pos);
      guard.recordTrade();
      tradesTotal++;
      consecutiveRejections = 0;

      const fillPrice = exec.fillPrice ?? entryPrice;
      console.log(`[xsp] ✅ ENTERED ${entry.side.toUpperCase()} ${xspSymbol} x1 @ $${fillPrice.toFixed(2)} | SL=$${stopLoss.toFixed(2)} TP=$${takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution: exec });

      // Fire-and-forget: don't await — connect() blocks forever reading the stream
      priceStream.updateSymbols([xspSymbol]).catch(() => {});

      // Update entry timestamp for cooldown tracking
      lastEntryTs = Math.floor(Date.now() / 1000);

      return true;
    } else {
      console.error(`[xsp] ❌ Order failed: ${exec.error}`);
      const isBuyingPowerError = exec.error.toLowerCase().includes('buying power');
      consecutiveRejections++;

      if (isBuyingPowerError) {
        console.log(`[xsp] 🔍 Buying power rejection — checking broker for ghost positions...`);
        await reconcileBrokerPositions();
      }

      if (consecutiveRejections >= MAX_REJECTIONS_BEFORE_HALT && isBuyingPowerError) {
        sessionHalted = true;
        console.error(`[xsp] 🚨 CRITICAL: ${consecutiveRejections} buying-power rejections — HALTING session.`);
      } else if (consecutiveRejections >= MAX_REJECTIONS_BEFORE_BACKOFF) {
        rejectionBackoffUntil = Date.now() + REJECTION_BACKOFF_SECS * 1000;
        console.log(`[xsp] 🚫 ${consecutiveRejections} consecutive rejections — backing off ${REJECTION_BACKOFF_SECS}s`);
      }
      return false;
    }
  } catch (e) {
    console.error('[xsp] Execution error:', e);
    return false;
  }
}

// ── Banner ──────────────────────────────────────────────────────────────────

function banner(): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer XSP Agent — Cash Account — tick()-based    ║');
  console.log(`║  Mode: ${isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log(`║  Config: ${CFG.id.slice(0, 46).padEnd(46)}║`);
  console.log(`║  Signal:  HMA(${CFG.signals.hmaCrossFast})×HMA(${CFG.signals.hmaCrossSlow}) on option contracts (entry) + SPX (exit)║`);
  console.log(`║  Dir TF:  ${dirTf.padEnd(5)} | Exit TF: ${exitTf.padEnd(5)} | Sig TF: ${signalTf.padEnd(5)}  ║`);
  console.log(`║  Execute: XSP 1DTE options (cash-settled)               ║`);
  console.log(`║  Exit:    ${CFG.exit.strategy.padEnd(47)}║`);
  console.log(`║  Size:    1 contract, trade all day                     ║`);
  console.log(`║  TP/SL:   ${CFG.position.takeProfitMultiplier}x / ${CFG.position.stopLossPercent}%                                     ║`);
  console.log(`║  Account: ${(EXEC.accountId ?? '').padEnd(46)}║`);
  console.log(`║  Stream:  HTTP streaming for real-time TP/SL            ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Main Cycle ──────────────────────────────────────────────────────────────

async function runCycle(): Promise<number> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

  // 0. Check pause flag (from dashboard/watchdog)
  if (isTradingPaused()) {
    console.log(`[xsp] ⏸️ Trading paused by external flag — skipping cycle`);
    return 10;
  }

  // 0a. Health gate circuit breaker
  const health = await healthGate.check();
  if (!health.healthy) {
    console.log(`[xsp] 🚫 HEALTH GATE: ${health.reason}`);
    return 30;
  }

  // 1. Fetch market state (SPX data)
  let snap: MarketSnapshot;
  try {
    snap = await fetchMarketSnapshot();
  } catch (e) {
    console.error(`[xsp] #${cycleCount} @ ${ts} — Market fetch failed: ${(e as Error).message}`);
    return 30;
  }

  const spxPrice = snap.spx.price;
  const wr = tradesTotal > 0 ? (winsTotal / tradesTotal * 100).toFixed(0) : '-';
  console.log(`\n[xsp] ═══ #${cycleCount} @ ${ts} | SPX ${spxPrice.toFixed(2)} | ${positions.count()} open | trades: ${tradesTotal} (WR ${wr}%) | P&L: $${dailyPnl.toFixed(0)} ═══`);

  // SPX price = 0 guard
  if (!spxPrice || spxPrice <= 0) {
    console.warn(`[xsp] ⚠️ Bad SPX price (${spxPrice}) from data service — skipping cycle`);
    return 30;
  }

  // 2. Warmup check
  const { h: etH, m: etM } = nowET();
  const [asH, asM] = CFG.timeWindows.activeStart.split(':').map(Number);
  if (etH * 60 + etM < asH * 60 + asM) {
    console.log(`[xsp] Warming up — waiting until ${CFG.timeWindows.activeStart} ET for indicator stabilization`);
    return 30;
  }

  // 3. Reconcile broker positions every cycle
  await reconcileBrokerPositions();

  // 4. Handle stream-flagged exits
  if (streamExitPending && positions.count() > 0) {
    console.log(`[xsp] ⚡ Stream flagged exit — force-closing`);
    for (const pos of positions.getAll()) {
      const streamPrice = priceStream.getPrice(pos.symbol);
      const sellPrice = streamPrice?.bid ?? streamPrice?.last ?? pos.entryPrice;

      const result = await closePosition(pos, 'stream_exit', sellPrice, isPaper, EXEC);
      const pnl = ((result.fillPrice ?? sellPrice) - pos.entryPrice) * pos.quantity * 100;
      dailyPnl += pnl;
      guard.recordLoss(pnl);
      positions.remove(pos.id);

      const emoji = pnl >= 0 ? '💰' : '💸';
      if (pnl > 0) winsTotal++;
      tradesTotal++;
      console.log(`[xsp] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)}: P&L $${pnl.toFixed(0)}`);
    }
    streamExitPending = false;
  }
  streamExitPending = false;

  // 5. Build signal input (bars only — no positions needed)

  // 5a. SPX direction bars
  let spxDirBars: CoreBar[];
  if (dirTf === '1m') {
    spxDirBars = stripFormingCandle(snap.spx.bars1m.map(toCoreBar), 60);
  } else {
    const rawBars = await fetchBarsAtTf(dirTf, 50);
    spxDirBars = stripFormingCandle(rawBars, tfToSeconds(dirTf));
  }

  // 5b. SPX exit bars
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
  }, CFG);

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
    console.log(`[xsp] SPX HMA(${CFG.signals.hmaCrossFast}×${CFG.signals.hmaCrossSlow}) ${dirTf}: ${arrow} ${spxSignal.directionState.cross.toUpperCase()}${spxSignal.directionState.freshCross ? ' (fresh)' : ''}`);
  }

  // 6b. Detect option contract HMA crosses — the PRIMARY entry trigger
  // Entry is based on the option contract's own HMA cross, not SPX underlying.
  // SPX direction is used as a gate (requireUnderlyingHmaCross) but NOT the trigger.
  // signalTf bars are fetched from the API (correct pipeline indicators, not re-aggregated 1m).
  const contractBarsMap = await buildContractBars(snap, signalTf);
  const allContractSignals = detectSignals(contractBarsMap, spxPrice, CFG);

  // Dedup: only treat signals as fresh if we haven't seen this bar's cross yet.
  // Key: symbol:signalType:direction → last bar ts processed
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

  // Apply requireUnderlyingHmaCross gate (mirror replay machine logic):
  //   SPX bullish → only call signals with bullish option direction
  //   SPX bearish → only put signals with bullish option direction
  //   SPX null    → block all contract signals
  let gatedContractSignals = freshContractSignals;
  if (CFG.signals.requireUnderlyingHmaCross) {
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

  // Pick best contract signal (first = closest to ATM, contracts sorted by ATM distance)
  const bestContractSignal = gatedContractSignals[0] ?? null;

  if (freshContractSignals.length > 0) {
    console.log(`[xsp] 📡 Contract signals (${freshContractSignals.length}): ${freshContractSignals.slice(0, 3).map(s => `${s.symbol.slice(-12)} ${s.direction}`).join(', ')}`);
  }
  if (bestContractSignal) {
    console.log(`[xsp] ✅ Best contract signal: ${bestContractSignal.symbol} (${bestContractSignal.side} ${bestContractSignal.direction}) → entry trigger`);
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
    const currentPrice = cached?.last ?? null;

    // Get bar high/low for intrabar TP/SL detection
    const contractState = snap.contracts.find(c => c.meta.symbol === openPos.symbol);
    const barHighLow = contractState?.bars1m.length
      ? { high: contractState.bars1m[contractState.bars1m.length - 1].high ?? 0,
          low: contractState.bars1m[contractState.bars1m.length - 1].low ?? 0 }
      : undefined;

    const exitDecision = evaluateExit(
      corePos, currentPrice, signal.exitState.cross, signal.exitState.freshCross,
      CFG, Math.floor(Date.now() / 1000), closeCutoffTs, barHighLow,
    );
    if (exitDecision) exits.push(exitDecision);
  }

  // 8. Execute exits
  let allExitsSucceeded = true;
  for (const exit of exits) {
    console.log(`[xsp] 📤 Exiting ${exit.symbol} — reason: ${exit.reason} @ $${exit.decisionPrice.toFixed(2)}`);

    const corePos = toCorePosition(positions.getAll().find(p => p.symbol === exit.symbol)!);
    const exitResult = await executeBrokerExit(corePos, exit.reason, exit.decisionPrice);

    if (exitResult.success) {
      dailyPnl += exitResult.pnl;
      guard.recordLoss(exitResult.pnl);
      if (exitResult.pnl > 0) winsTotal++;
      tradesTotal++;

      const emoji = exitResult.pnl >= 0 ? '💰' : '💸';
      console.log(`[xsp] ${emoji} CLOSED ${corePos.symbol} (${exit.reason}): P&L $${exitResult.pnl.toFixed(0)}`);
    } else {
      allExitsSucceeded = false;
    }
  }

  // 9. Evaluate & execute entry
  const spxLive = priceStream.getPrice('SPX');
  const spxCurrentPrice = spxLive?.last ?? spxPrice;
  const candidates = buildCandidates(snap);

  const { entry, skipReason } = evaluateEntry(signal, exits, positions.count() + exits.length, CFG, {
    ts: Math.floor(Date.now() / 1000),
    spxPrice: spxCurrentPrice,
    candidates,
    dailyPnl,
    tradesCompleted: tradesTotal,
    lastEntryTs,
    closeCutoffTs,
  });

  if (entry && allExitsSucceeded) {
    console.log(`[xsp] 📥 Entry signal: ${entry.side.toUpperCase()} ${entry.symbol} x${entry.qty} @ $${entry.price.toFixed(2)} | ${entry.reason}`);
    await executeEntry(entry, snap);
  } else if (skipReason) {
    console.log(`[xsp] Skip: ${skipReason}`);
  }

  // Stop streaming if no positions
  if (positions.count() === 0 && priceStream.isConnected()) {
    priceStream.stop();
  }

  // 10. Save session & report
  saveXspSession();
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
    lastReasoning: `XSP | SPX ${spxSignal.directionState.cross ?? '-'} | opts: ${allContractSignals.length} sigs | trades: ${tradesTotal} (WR ${wr}%) | P&L $${dailyPnl.toFixed(0)}`,
    scannerReads: [],
    nextCheckSecs: positions.count() > 0 ? 5 : 30,
    upSince: '',
  });

  return positions.count() > 0 ? 5 : 30;
}

// ── Order Cleanup ────────────────────────────────────────────────────────────

async function cancelAllOpenOrders(): Promise<number> {
  const accountId = EXEC.accountId!;
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
        console.log(`[xsp] 🗑️ Cancelled order #${order.id} (${order.class} ${order.status})`);
        cancelled++;
      } catch (e: any) {
        console.warn(`[xsp] ⚠️ Failed to cancel #${order.id}: ${e?.response?.data?.errors?.error || e.message}`);
      }
    }
  } catch (e: any) {
    console.warn(`[xsp] ⚠️ Failed to fetch orders for cleanup: ${e.message}`);
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
    console.log(`[xsp] Market closed — ${waitMins} min until open. Sleeping...`);
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
    `  DAILY REVIEW — ${date} — XSP Agent (${EXEC.accountId})`,
    `${'═'.repeat(70)}`,
    ``,
    `  Config:     ${CFG.id}`,
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
  if (dailyPnl < -200) lessons.push(`Significant loss ($${dailyPnl.toFixed(0)}).`);
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
    console.error('[xsp] Failed to write daily review:', (e as Error).message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  if (!process.env.TRADIER_TOKEN) {
    console.error('[xsp] TRADIER_TOKEN not set');
    process.exit(1);
  }

  await priceStream.start([]);

  while (true) {
    console.log('[xsp] Waiting for market open...');
    await sleepUntilMarketOpen();

    const today = todayET();
    const existingSession = loadXspSession();
    const isResume = existingSession?.date === today;

    if (isResume) {
      dailyPnl         = existingSession!.dailyPnl;
      tradesTotal      = existingSession!.tradesTotal;
      winsTotal        = existingSession!.winsTotal;
      dailyDate        = today;
      consecutiveRejections = 0;
      rejectionBackoffUntil = 0;
      sessionHalted    = false;
      restoreXspSessionState(existingSession!);
      console.log(`[xsp] ⚡ RESUMING session for ${today} (P&L $${dailyPnl.toFixed(0)}, ${tradesTotal} trades)`);
    } else {
      console.log('[xsp] Market open — starting trading session');

      const cancelledPreOpen = await cancelAllOpenOrders();
      if (cancelledPreOpen > 0) console.log(`[xsp] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

      dailyPnl = 0;
      tradesTotal = 0;
      winsTotal = 0;
      consecutiveRejections = 0;
      rejectionBackoffUntil = 0;
      sessionHalted = false;
      dailyDate = today;
      signalState = createInitialSignalState();
      lastEntryTs = 0;
      processedSignalTs.clear();
      guard.resetIfNewDay();
      saveXspSession();
    }

    // Dynamic sizing
    if (CFG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(CFG.sizing.riskPercentOfAccount, EXEC.accountId);
      CFG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[xsp] Daily sizing: $${tradeSize} per trade (${CFG.sizing.riskPercentOfAccount}% of account)`);
    }

    // Reconcile broker positions
    const reconciled = await positions.reconcileFromBroker(EXEC);
    if (reconciled > 0) {
      console.log(`[xsp] Reconciled ${reconciled} position(s) from broker`);
      const symbols = positions.getAll().map(p => p.symbol);
      // Fire-and-forget: don't await — connect() blocks forever reading the stream.
      if (symbols.length > 0) priceStream.updateSymbols(symbols).catch(() => {});

      // Positions are now managed by PositionManager (broker is truth)
      // No need to sync into strategy state
    }

    console.log('[xsp] First cycle in 5s...\n');
    await new Promise(r => setTimeout(r, 5000));

    while (isMarketOpen()) {
      let nextSecs = 30;
      try {
        nextSecs = await runCycle();
      } catch (e) {
        console.error('[xsp] Cycle error:', e);
      }
      await new Promise(r => setTimeout(r, nextSecs * 1000));
    }

    console.log('\n[xsp] 🔔 Market closed — ending trading session');
    priceStream.stop();
    const cancelledAtClose = await cancelAllOpenOrders();
    if (cancelledAtClose > 0) console.log(`[xsp] Cancelled ${cancelledAtClose} open order(s) at market close`);
    dailyReview();
    console.log('[xsp] Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', () => { priceStream.stop(); console.log('\n[xsp] Shutting down'); process.exit(0); });
process.on('SIGINT', () => { priceStream.stop(); console.log('\n[xsp] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[xsp] Fatal:', e); process.exit(1); });
