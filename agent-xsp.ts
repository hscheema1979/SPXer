/**
 * SPXer XSP Agent — Cash Account — tick()-based
 *
 * Uses the same tick() function from src/core/strategy-engine.ts that
 * replay uses. Config loaded from DB — same config validated in replay.
 *
 * Same HMA strategy as the SPX agent, but:
 *   - Executes XSP options (Mini-SPX, 1/10th size, cash-settled)
 *   - 1DTE options (next-day expiry)
 *   - 1 contract at a time (small account)
 *   - Trades all day — flip on HMA reversal, same as SPX
 *
 * Uses SPX data pipeline for signals — converts strikes for XSP execution.
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
import { writeStatus, logActivity } from './src/agent/reporter';
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
  tick,
  createInitialState,
  stripFormingCandle,
  type CorePosition,
  type StrategyState,
  type TickInput,
  type TickResult,
} from './src/core/strategy-engine';

// ── Load Config from DB ─────────────────────────────────────────────────────

const CONFIG_ID = process.env.AGENT_CONFIG_ID || 'hma3x17-xsp-cash';
const _xspStore = createStore();
const CFG: Config = _xspStore.getConfig(CONFIG_ID) ?? DEFAULT_CONFIG;
_xspStore.close();
const EXEC = CFG.execution!;

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

// ── Strategy State ──────────────────────────────────────────────────────────

let strategyState: StrategyState = createInitialState();

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

    for (const bp of brokerPositions) {
      if (!agentSymbols.has(bp.symbol)) {
        console.log(`[xsp] ⚠️ ORPHAN at broker: ${bp.symbol} x${bp.quantity} — closing immediately`);
        try {
          const body = new URLSearchParams({
            class: 'option',
            symbol: EXEC.symbol || 'XSP',
            option_symbol: bp.symbol,
            side: 'sell_to_close',
            quantity: String(Math.abs(bp.quantity)),
            type: 'market',
            duration: 'day',
          }).toString();
          const { data: orderData } = await axios.post(
            `${TRADIER_BASE}/accounts/${accountId}/orders`,
            body,
            { headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
          );
          console.log(`[xsp] 🗑️ Closed orphan ${bp.symbol} — order #${orderData?.order?.id}`);
        } catch (e: any) {
          console.error(`[xsp] Failed to close orphan ${bp.symbol}: ${e?.response?.data?.errors?.error || e.message}`);
        }
      }
    }

    for (const pos of positions.getAll()) {
      if (!brokerSymbols.has(pos.symbol)) {
        console.log(`[xsp] ⚠️ PHANTOM position: ${pos.symbol} — dropping.`);
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

function buildContractBars(snap: MarketSnapshot): Map<string, CoreBar[]> {
  const map = new Map<string, CoreBar[]>();
  for (const c of snap.contracts) {
    if (c.bars1m.length < 2) continue;
    map.set(c.meta.symbol, c.bars1m.map(b => toCoreBar(b)));
  }
  return map;
}

function buildPositionPrices(): Map<string, number> {
  const prices = new Map<string, number>();
  for (const [, pos] of strategyState.positions) {
    const cached = priceStream.getPrice(pos.symbol);
    if (cached) prices.set(pos.symbol, cached.last);
  }
  return prices;
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

async function executeExit(
  pos: CorePosition,
  reason: string,
  decisionPrice: number,
): Promise<{ success: boolean; fillPrice: number; pnl: number }> {
  const openPos = positions.getAll().find(p => p.symbol === pos.symbol);

  if (openPos?.bracketOrderId && !isPaper) {
    try {
      await cancelOcoLegs(openPos.bracketOrderId, CFG.execution);
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

  const result = await closePosition(dummyPos, reason, decisionPrice, isPaper, CFG.execution);

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
  entry: NonNullable<TickResult['entry']>,
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
    const { position: pos, execution: exec } = await openPosition(signal, decision, isPaper, EXEC);
    if (!exec.error) {
      positions.add(pos);
      guard.recordTrade();
      tradesTotal++;
      consecutiveRejections = 0;

      const fillPrice = exec.fillPrice ?? entryPrice;
      console.log(`[xsp] ✅ ENTERED ${entry.side.toUpperCase()} ${xspSymbol} x1 @ $${fillPrice.toFixed(2)} | SL=$${stopLoss.toFixed(2)} TP=$${takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution: exec });

      await priceStream.updateSymbols([xspSymbol]);

      // Add to strategy state (use XSP symbol for position tracking)
      const corePos: CorePosition = {
        id: xspSymbol,
        symbol: xspSymbol,
        side: entry.side,
        strike: xspStrike,
        qty: 1,
        entryPrice: fillPrice,
        stopLoss,
        takeProfit,
        entryTs: Math.floor(Date.now() / 1000),
        highWaterPrice: fillPrice,
      };
      strategyState.positions.set(corePos.id, corePos);
      strategyState.lastEntryTs = corePos.entryTs;

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
  console.log(`║  Signal:  HMA(${CFG.signals.hmaCrossFast})×HMA(${CFG.signals.hmaCrossSlow}) cross on SPX underlying      ║`);
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

      const result = await closePosition(pos, 'stream_exit', sellPrice, isPaper, CFG.execution);
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
      console.log(`[xsp] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)}: P&L $${pnl.toFixed(0)}`);
    }
    streamExitPending = false;
  }
  streamExitPending = false;

  // 5. Build tick input

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

  // 5c. Contract bars
  const contractBars = buildContractBars(snap);

  // 5d. Position prices — for XSP positions, look up via XSP symbol
  const positionPrices = buildPositionPrices();
  for (const [, pos] of strategyState.positions) {
    if (!positionPrices.has(pos.symbol)) {
      // Try fetching from the position manager's positions
      const openPos = positions.getAll().find(p => p.symbol === pos.symbol);
      if (openPos) {
        const cached = priceStream.getPrice(openPos.symbol);
        if (cached) positionPrices.set(pos.symbol, cached.last);
      }
    }
  }

  // 5e. SPX price
  const spxLive = priceStream.getPrice('SPX');
  const spxCurrentPrice = spxLive?.last ?? spxPrice;

  // 5f. Candidates (SPX contracts — tick() does strike selection on SPX, we convert to XSP at execution)
  const candidates = buildCandidates(snap);

  // 6. Call tick()
  const tickInput: TickInput = {
    ts: Math.floor(Date.now() / 1000),
    spxDirectionBars: spxDirBars,
    spxExitBars,
    contractBars,
    spxPrice: spxCurrentPrice,
    closeCutoffTs: computeCloseCutoff(),
    candidates,
    positionPrices,
  };

  const result = tick(strategyState, tickInput, CFG);

  // 7. Apply HMA state
  strategyState.directionCross = result.directionState.directionCross;
  strategyState.prevDirectionHmaFast = result.directionState.prevHmaFast;
  strategyState.prevDirectionHmaSlow = result.directionState.prevHmaSlow;
  strategyState.lastDirectionBarTs = result.directionState.lastBarTs;
  strategyState.exitCross = result.exitState.exitCross;
  strategyState.prevExitHmaFast = result.exitState.prevHmaFast;
  strategyState.prevExitHmaSlow = result.exitState.prevHmaSlow;
  strategyState.lastExitBarTs = result.exitState.lastBarTs;

  if (result.directionState.directionCross) {
    const arrow = result.directionState.directionCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[xsp] HMA cross: ${arrow} ${result.directionState.directionCross.toUpperCase()}${result.directionState.freshCross ? ' (FRESH SIGNAL)' : ''}`);
  }

  // 8. Execute exits
  let allExitsSucceeded = true;
  for (const exit of result.exits) {
    console.log(`[xsp] 📤 Exiting ${exit.symbol} — reason: ${exit.reason} @ $${exit.decisionPrice.toFixed(2)}`);

    const pos = strategyState.positions.get(exit.positionId);
    if (!pos) {
      console.warn(`[xsp] Position ${exit.positionId} not found in strategy state`);
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
      console.log(`[xsp] ${emoji} CLOSED ${pos.symbol} (${exit.reason}): P&L $${exitResult.pnl.toFixed(0)}`);
    } else {
      allExitsSucceeded = false;
    }
  }

  // 9. Execute entry
  if (result.entry && allExitsSucceeded) {
    console.log(`[xsp] 📥 Entry signal: ${result.entry.side.toUpperCase()} ${result.entry.symbol} x${result.entry.qty} @ $${result.entry.price.toFixed(2)} | ${result.entry.reason}`);
    await executeEntry(result.entry, snap);
  } else if (result.skipReason) {
    console.log(`[xsp] Skip: ${result.skipReason}`);
  }

  // Stop streaming if no positions
  if (positions.count() === 0 && priceStream.isConnected()) {
    priceStream.stop();
  }

  // 10. Report
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
    lastReasoning: `XSP | HMA ${result.directionState.directionCross ?? '-'} | trades: ${tradesTotal} (WR ${wr}%) | P&L $${dailyPnl.toFixed(0)}`,
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
    console.log('[xsp] Market open — starting trading session');

    const cancelledPreOpen = await cancelAllOpenOrders();
    if (cancelledPreOpen > 0) console.log(`[xsp] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    consecutiveRejections = 0;
    rejectionBackoffUntil = 0;
    sessionHalted = false;
    dailyDate = todayET();
    strategyState = createInitialState();
    guard.resetIfNewDay();

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
      if (symbols.length > 0) await priceStream.updateSymbols(symbols);

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
            takeProfit: pos.takeProfit ?? pos.entryPrice * CFG.position.takeProfitMultiplier,
            entryTs: Math.floor(pos.openedAt / 1000),
            highWaterPrice: pos.entryPrice,
          });
        }
      }
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
