/**
 * SPXer Deterministic Trading Agent — HMA3x17 ScannerReverse
 *
 * Pure deterministic execution — no LLM scanners or judges.
 * Strategy: HMA(3) × HMA(17) cross on SPX underlying → enter OTM contract
 *           → exit on reversal cross (scannerReverse) → immediately flip to opposite side
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

import { fetchMarketSnapshot, type MarketSnapshot } from './src/agent/market-feed';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { PositionManager, type PositionCloseEvent } from './src/agent/position-manager';
import { AGENT_CONFIG } from './agent-config';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import { PriceStream } from './src/agent/price-stream';
import { nowET, todayET } from './src/utils/et-time';
import { config as appConfig, TRADIER_BASE } from './src/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeQty } from './src/core/position-sizer';
import { frictionEntry } from './src/core/friction';
import { computeTradeSize } from './src/agent/account-balance';
import { detectSignals } from './src/core/signal-detector';
import type { CoreBar, Signal } from './src/core/types';

// ── Initialize ──────────────────────────────────────────────────────────────

const guard = new RiskGuard(AGENT_CONFIG);
const positions = new PositionManager(AGENT_CONFIG, guard.isPaper);
const priceStream = new PriceStream();

let cycleCount = 0;
let tradesTotal = 0;
let winsTotal = 0;
let dailyPnl = 0;
let dailyDate = '';
let consecutiveRejections = 0;
const MAX_REJECTIONS_BEFORE_BACKOFF = 3;
const REJECTION_BACKOFF_SECS = 300;
let rejectionBackoffUntil = 0;

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
  const accountId = AGENT_CONFIG.execution?.accountId || process.env.TRADIER_ACCOUNT_ID || '';
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

    // Orphaned at broker — close immediately
    for (const bp of brokerPositions) {
      if (!agentSymbols.has(bp.symbol)) {
        console.log(`[agent] ⚠️ ORPHAN at broker: ${bp.symbol} x${bp.quantity} — closing immediately`);
        try {
          const rootSymbol = AGENT_CONFIG.execution?.symbol || 'SPX';
          const body = new URLSearchParams({
            class: 'option',
            symbol: rootSymbol,
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
          console.log(`[agent] 🗑️ Closed orphan ${bp.symbol} — order #${orderData?.order?.id}`);
        } catch (e: any) {
          console.error(`[agent] Failed to close orphan ${bp.symbol}: ${e?.response?.data?.errors?.error || e.message}`);
        }
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

// ── Core Signal Detection ───────────────────────────────────────────────────
// Uses the SAME detectSignals() from src/core/ that replay uses.
// Scans option contract HMA crosses, filters by OTM distance and
// underlying SPX HMA confirmation — identical to the backtested strategy.

let prevContractBarTs = new Map<string, number>(); // dedupe: only process new candle closes

function runCoreSignalDetection(snap: MarketSnapshot): Signal | null {
  const spxPrice = snap.spx.price;
  if (spxPrice <= 0) return null;

  // Build CoreBar map from snapshot contract bars
  const contractBars = new Map<string, CoreBar[]>();
  for (const c of snap.contracts) {
    if (c.bars1m.length < 2) continue;
    const coreBars: CoreBar[] = c.bars1m.map(b => ({
      ts: b.ts,
      open: b.open ?? b.close,
      high: b.high ?? b.close,
      low: b.low ?? b.close,
      close: b.close,
      volume: b.volume ?? 0,
      indicators: {
        rsi14: b.rsi14, ema9: b.ema9, ema21: b.ema21,
        hma3: b.hma3, hma5: b.hma5, hma17: b.hma17, hma19: b.hma19,
      },
    }));
    contractBars.set(c.meta.symbol, coreBars);
  }

  if (contractBars.size === 0) return null;

  // Check if we have a new candle close (dedupe — don't fire same signal twice)
  const sampleBars = contractBars.values().next().value;
  if (sampleBars && sampleBars.length >= 2) {
    const closedTs = sampleBars[sampleBars.length - 2].ts;
    const lastProcessed = prevContractBarTs.get('__global__');
    if (lastProcessed === closedTs) return null; // same candle, already processed
    prevContractBarTs.set('__global__', closedTs);
  }

  // Run core signal detection — same as replay
  let signals = detectSignals(contractBars, spxPrice, AGENT_CONFIG);

  // Filter by target OTM distance (same as replay)
  if (AGENT_CONFIG.signals.targetOtmDistance != null && signals.length > 0) {
    const targetDist = AGENT_CONFIG.signals.targetOtmDistance;
    const spxRounded = Math.round(spxPrice / 5) * 5;
    const targetCallStrike = spxRounded + targetDist;
    const targetPutStrike = spxRounded - targetDist;
    signals = signals.filter(sig => {
      if (sig.side === 'call') return Math.abs(sig.strike - targetCallStrike) <= 5;
      if (sig.side === 'put') return Math.abs(sig.strike - targetPutStrike) <= 5;
      return false;
    });
  }

  // Filter by underlying HMA cross confirmation (same as replay)
  if (AGENT_CONFIG.signals.requireUnderlyingHmaCross && signals.length > 0) {
    const hmaCross = positions.getHmaCrossDirection();
    if (!hmaCross) {
      signals = [];
    } else {
      const wantSide = hmaCross === 'bullish' ? 'call' : 'put';
      signals = signals.filter(sig => sig.side === wantSide && sig.direction === 'bullish');
    }
  }

  if (signals.length === 0) return null;

  // Pick the best signal (closest to target OTM)
  const best = signals[0];
  console.log(`[signal] 📡 Core signal: ${best.direction} ${best.side} ${best.symbol} (strike ${best.strike}) — ${best.signalType}`);
  return best;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildCandidates(snap: MarketSnapshot): StrikeCandidate[] {
  return snap.contracts.map(c => ({
    symbol: c.meta.symbol,
    side: c.meta.side,
    strike: c.meta.strike,
    price: c.quote.last ?? c.quote.mid ?? 0,
    volume: c.greeks.volume ?? 0,
  }));
}

function computeSlTp(entryPrice: number): { stopLoss: number; takeProfit: number } {
  const effEntry = frictionEntry(entryPrice);
  const slPct = AGENT_CONFIG.position.stopLossPercent / 100;
  return {
    stopLoss: effEntry * (1 - slPct),
    takeProfit: effEntry * AGENT_CONFIG.position.takeProfitMultiplier,
  };
}

interface TradeSelection {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  price: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
}

function selectTradeStrike(
  candidates: StrikeCandidate[],
  direction: 'bullish' | 'bearish',
  spxPrice: number,
): TradeSelection | null {
  const result = selectStrike(candidates, direction, spxPrice, AGENT_CONFIG);
  if (!result) return null;

  const { candidate, reason } = result;
  const effEntry = frictionEntry(candidate.price);
  const qty = computeQty(effEntry, AGENT_CONFIG);
  const { stopLoss, takeProfit } = computeSlTp(candidate.price);

  return {
    symbol: candidate.symbol,
    side: candidate.side,
    strike: candidate.strike,
    price: candidate.price,
    qty,
    stopLoss,
    takeProfit,
    reason,
  };
}

async function executeBuy(
  selection: TradeSelection,
  snap: MarketSnapshot,
): Promise<boolean> {
  // Rejection backoff
  if (Date.now() < rejectionBackoffUntil) {
    const remaining = Math.round((rejectionBackoffUntil - Date.now()) / 1000);
    console.log(`[agent] Rejection backoff — ${remaining}s remaining`);
    return false;
  }

  const contractState = snap.contracts.find(c => c.meta.symbol === selection.symbol);
  if (!contractState) {
    console.warn(`[agent] Contract ${selection.symbol} not in snapshot — skipping`);
    return false;
  }

  const recheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!recheck.allowed) {
    logRejected(recheck.reason!, selection.symbol, 'hma_cross');
    return false;
  }

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: contractState.meta.symbol,
    side: contractState.meta.side,
    strike: contractState.meta.strike,
    expiry: contractState.meta.expiry,
    currentPrice: contractState.quote.last ?? contractState.quote.mid ?? 0,
    bid: contractState.quote.bid,
    ask: contractState.quote.ask,
    indicators: contractState.bars1m[contractState.bars1m.length - 1] ?? {} as any,
    recentBars: contractState.bars1m,
    signalBarLow: selection.stopLoss,
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
    positionSize: selection.qty,
    stopLoss: selection.stopLoss,
    takeProfit: selection.takeProfit,
    reasoning: `HMA cross → ${selection.side} ${selection.symbol} x${selection.qty} @ $${selection.price.toFixed(2)} | ${selection.reason}`,
    concerns: [],
    ts: Date.now(),
  };

  try {
    const { position, execution } = await openPosition(signal, decision, guard.isPaper, AGENT_CONFIG.execution);
    if (!execution.error) {
      positions.add(position);
      guard.recordTrade();
      tradesTotal++;
      consecutiveRejections = 0;
      console.log(`[agent] ✅ ENTERED ${selection.side.toUpperCase()} ${selection.symbol} x${selection.qty} @ $${(execution.fillPrice ?? selection.price).toFixed(2)} | SL=$${selection.stopLoss.toFixed(2)} TP=$${selection.takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution });

      // Start streaming prices for real-time TP/SL
      await priceStream.updateSymbols([position.symbol]);

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
  const cfg = AGENT_CONFIG;
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer Deterministic Agent — HMA3x17              ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log(`║  Signal:  HMA(${cfg.signals.hmaCrossFast})×HMA(${cfg.signals.hmaCrossSlow}) cross on SPX underlying      ║`);
  console.log(`║  Exit:    scannerReverse (flip on HMA reversal)          ║`);
  console.log(`║  TP/SL:   ${cfg.position.takeProfitMultiplier}x / ${cfg.position.stopLossPercent}%                                     ║`);
  console.log(`║  Target:  $${cfg.signals.targetOtmDistance} OTM | $${cfg.sizing.baseDollarsPerTrade} base | max ${cfg.sizing.maxContracts} contracts  ║`);
  console.log(`║  Risk:    $${cfg.risk.maxRiskPerTrade}/trade | cutoff ${cfg.risk.cutoffTimeET} ET            ║`);
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
  const [asH, asM] = AGENT_CONFIG.timeWindows.activeStart.split(':').map(Number);
  if (etH * 60 + etM < asH * 60 + asM) {
    console.log(`[agent] Warming up — waiting until ${AGENT_CONFIG.timeWindows.activeStart} ET for indicator stabilization`);
    return 30;
  }

  // 3. CLOSE FIRST — reconcile broker positions every cycle
  await reconcileBrokerPositions();

  // 4. Update HMA cross state from SPX bars
  const freshCross = positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();
  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[agent] HMA cross: ${arrow} ${hmaCross.toUpperCase()}${freshCross ? ' (FRESH SIGNAL)' : ''}`);
  }

  // 5. Monitor existing positions — may close and return events
  const closeEvents = await positions.monitor(pnl => {
    guard.recordLoss(pnl);
    dailyPnl += pnl;
  });

  // Handle stream-flagged exits that monitor didn't catch
  if (streamExitPending && closeEvents.length === 0 && positions.count() > 0) {
    console.log(`[agent] ⚡ Stream flagged exit — force-closing`);
    for (const pos of positions.getAll()) {
      const streamPrice = priceStream.getPrice(pos.symbol);
      const sellPrice = streamPrice?.bid ?? streamPrice?.last ?? pos.entryPrice;

      const result = await closePosition(pos, 'stream_exit', sellPrice, guard.isPaper, AGENT_CONFIG.execution);
      const pnl = ((result.fillPrice ?? sellPrice) - pos.entryPrice) * pos.quantity * 100;
      dailyPnl += pnl;
      guard.recordLoss(pnl);
      positions.remove(pos.id);

      const emoji = pnl >= 0 ? '💰' : '💸';
      if (pnl > 0) winsTotal++;
      console.log(`[agent] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)}: P&L $${pnl.toFixed(0)}`);
      closeEvents.push({ position: pos, closePrice: result.fillPrice ?? sellPrice, reason: 'stream_exit', pnl });
    }
  }
  streamExitPending = false;

  for (const evt of closeEvents) {
    const emoji = evt.pnl >= 0 ? '💰' : '💸';
    if (evt.pnl > 0) winsTotal++;
    console.log(`[agent] ${emoji} CLOSED ${evt.position.symbol} (${evt.reason}): P&L $${evt.pnl.toFixed(0)}`);
  }

  // Stop streaming if no positions
  if (positions.count() === 0 && priceStream.isConnected()) {
    priceStream.stop();
  }

  // 6. Risk guard check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[agent] Risk guard: ${riskCheck.reason}`);
    return 60;
  }

  // 7. Handle flip-on-reversal — CLOSE already happened, now ENTER opposite
  const reversals = closeEvents.filter(e => e.reason === 'signal_reversal');
  for (const rev of reversals) {
    const flipDirection = rev.position.side === 'call' ? 'bearish' : 'bullish';
    const flipSide = flipDirection === 'bullish' ? 'call' : 'put';
    console.log(`[agent] 🔄 FLIP → ${flipSide.toUpperCase()} (reversal from ${rev.position.side})`);

    const candidates = buildCandidates(snap);
    const selection = selectTradeStrike(candidates, flipDirection, spxPrice);
    if (selection) {
      await executeBuy(selection, snap);
    } else {
      console.log(`[agent] No qualifying ${flipSide} contract found for flip`);
    }
  }

  // 8. If no position open and no flip happened, run core signal detection
  //    Uses the SAME detectSignals() from src/core/ that replay uses:
  //    option contract HMA crosses → OTM filter → underlying HMA confirmation
  if (positions.count() === 0 && reversals.length === 0) {
    const coreSignal = runCoreSignalDetection(snap);
    if (coreSignal) {
      const direction: 'bullish' | 'bearish' = coreSignal.side === 'call' ? 'bullish' : 'bearish';
      console.log(`[agent] 📡 Core signal → entering ${coreSignal.side.toUpperCase()} ${coreSignal.symbol} (strike ${coreSignal.strike})`);

      const candidates = buildCandidates(snap);
      const selection = selectTradeStrike(candidates, direction, spxPrice);
      if (selection) {
        await executeBuy(selection, snap);
      } else {
        console.log(`[agent] No qualifying ${coreSignal.side} contract found for strike ~${coreSignal.strike}`);
      }
    }
  }

  // 9. Report status
  const wr = tradesTotal > 0 ? (winsTotal / tradesTotal * 100).toFixed(0) : '-';
  writeStatus({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    mode: snap.mode,
    paper: guard.isPaper,
    spxPrice,
    minutesToClose: snap.minutesToClose,
    contractsTracked: snap.contracts.length,
    contractsWithBars: snap.contracts.filter(c => c.bars1m.length > 0).length,
    openPositions: positions.count(),
    dailyPnL: dailyPnl,
    judgeCallsToday: 0,
    lastAction: positions.count() > 0 ? 'holding' : 'watching',
    lastReasoning: `HMA ${hmaCross ?? 'none'} | trades: ${tradesTotal} (WR ${wr}%) | daily P&L: $${dailyPnl.toFixed(0)}`,
    scannerReads: [],
    nextCheckSecs: positions.count() > 0 ? 5 : 30,
    upSince: '',
  });

  logActivity({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    event: 'cycle' as any,
    summary: `SPX ${spxPrice.toFixed(2)} | HMA ${hmaCross ?? '-'} | ${positions.count()} open | P&L $${dailyPnl.toFixed(0)}`,
    details: {
      hmaCross,
      openPositions: positions.count(),
      dailyPnl,
      tradesTotal,
      closeEvents: closeEvents.map(e => ({ symbol: e.position.symbol, reason: e.reason, pnl: e.pnl })),
    },
  });

  // Poll faster when holding (5s) since stream handles TP/SL in between
  return positions.count() > 0 ? 5 : 30;
}

// ── Order Cleanup ────────────────────────────────────────────────────────────

async function cancelAllOpenOrders(): Promise<number> {
  const accountId = AGENT_CONFIG.execution?.accountId || process.env.TRADIER_ACCOUNT_ID || '';
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
    `  DAILY REVIEW — ${date} — SPX Agent (${AGENT_CONFIG.execution?.accountId ?? 'default'})`,
    `${'═'.repeat(70)}`,
    ``,
    `  Trades:     ${tradesTotal} total (${winsTotal} wins, ${losses} losses)`,
    `  Win Rate:   ${wr}%`,
    `  Daily P&L:  $${dailyPnl.toFixed(2)}`,
    `  Avg P&L:    $${avgPnl}/trade`,
    `  Paper:      ${guard.isPaper ? 'YES' : 'NO — LIVE'}`,
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
  if (!guard.isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  // Start price stream (connects on demand)
  await priceStream.start([]);

  // Outer loop: one iteration per trading day
  while (true) {
    console.log('[agent] Waiting for market open...');
    await sleepUntilMarketOpen();
    console.log('[agent] Market open — starting trading session');

    // Pre-open: cancel stale orders
    const cancelledPreOpen = await cancelAllOpenOrders();
    if (cancelledPreOpen > 0) console.log(`[agent] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    consecutiveRejections = 0;
    rejectionBackoffUntil = 0;
    dailyDate = todayET();
    guard.resetIfNewDay();

    // Dynamic sizing
    if (AGENT_CONFIG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(
        AGENT_CONFIG.sizing.riskPercentOfAccount,
        AGENT_CONFIG.execution?.accountId,
      );
      AGENT_CONFIG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[agent] Daily sizing: $${tradeSize} per trade (${AGENT_CONFIG.sizing.riskPercentOfAccount}% of account)`);
    }

    // Reconcile broker positions
    const reconciled = await positions.reconcileFromBroker(AGENT_CONFIG.execution);
    if (reconciled > 0) {
      console.log(`[agent] Reconciled ${reconciled} position(s) from broker`);
      const symbols = positions.getAll().map(p => p.symbol);
      if (symbols.length > 0) await priceStream.updateSymbols(symbols);
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
    console.log('[agent] Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', () => { priceStream.stop(); console.log('\n[agent] Shutting down (SIGTERM)'); process.exit(0); });
process.on('SIGINT',  () => { priceStream.stop(); console.log('\n[agent] Shutting down (SIGINT)');  process.exit(0); });

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
