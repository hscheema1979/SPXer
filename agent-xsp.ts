/**
 * SPXer XSP Agent — Cash Account
 *
 * Same HMA3x17 scannerReverse strategy as the SPX agent, but:
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
import { openPosition, convertOptionSymbol, closePosition } from './src/agent/trade-executor';
import { PositionManager, type PositionCloseEvent } from './src/agent/position-manager';
import { AGENT_XSP_CONFIG } from './agent-xsp-config';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import { config as appConfig, TRADIER_BASE } from './src/config';
import { PriceStream } from './src/agent/price-stream';
import { nowET, todayET } from './src/utils/et-time';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeTradeSize } from './src/agent/account-balance';

// ── Initialize ──────────────────────────────────────────────────────────────

const CFG = AGENT_XSP_CONFIG;
const EXEC = CFG.execution!;
const guard = new RiskGuard(CFG);
const positions = new PositionManager(CFG, guard.isPaper);
const priceStream = new PriceStream();

let cycleCount = 0;
let dailyDate = '';
let dailyPnl = 0;
let tradesTotal = 0;
let winsTotal = 0;
let consecutiveRejections = 0;
const MAX_REJECTIONS_BEFORE_BACKOFF = 3;
const REJECTION_BACKOFF_SECS = 300; // 5 minutes
let rejectionBackoffUntil = 0;

// ── Price Stream TP/SL Callback ─────────────────────────────────────────────

/**
 * Called on every price tick from the HTTP stream.
 * Checks TP/SL in real-time — no polling gap.
 */
let streamExitPending = false; // flag so runCycle picks up the exit

priceStream.onPrice((symbol, last, bid, ask) => {
  // Check all open positions against this price
  for (const pos of positions.getAll()) {
    if (pos.symbol !== symbol) continue;

    // Use bid for sell (what we'd actually get)
    const sellPrice = bid > 0 ? bid : last;

    // TP check
    if (pos.takeProfit && sellPrice >= pos.takeProfit) {
      console.log(`[stream] 🎯 TP HIT on ${symbol}: $${sellPrice.toFixed(2)} >= TP $${pos.takeProfit.toFixed(2)} — flagging for exit`);
      streamExitPending = true;
    }

    // SL check
    if (pos.stopLoss && sellPrice <= pos.stopLoss) {
      console.log(`[stream] 🛑 SL HIT on ${symbol}: $${sellPrice.toFixed(2)} <= SL $${pos.stopLoss.toFixed(2)} — flagging for exit`);
      streamExitPending = true;
    }
  }
});

// ── Broker Reconciliation ───────────────────────────────────────────────────

/**
 * Per-cycle broker sync: ensure agent state matches broker reality.
 * 1. Close any broker positions the agent doesn't know about (orphans)
 * 2. Drop any agent positions the broker doesn't have (phantoms)
 */
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

    // 1. Orphaned at broker — agent doesn't know about it
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

    // 2. Phantom in agent — broker doesn't have it
    for (const pos of positions.getAll()) {
      if (!brokerSymbols.has(pos.symbol)) {
        console.log(`[xsp] ⚠️ PHANTOM position: ${pos.symbol} — agent thinks it's open but broker says no. Dropping.`);
        positions.remove(pos.id);
      }
    }
  } catch (e: any) {
    // Don't crash the cycle over a reconciliation failure
    console.warn(`[xsp] Reconciliation check failed: ${e.message}`);
  }
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

async function executeEntry(
  direction: 'bullish' | 'bearish',
  snap: MarketSnapshot,
  reason: string,
): Promise<boolean> {
  // Rejection backoff check
  if (Date.now() < rejectionBackoffUntil) {
    const remaining = Math.round((rejectionBackoffUntil - Date.now()) / 1000);
    console.log(`[xsp] Rejection backoff — ${remaining}s remaining, skipping entry`);
    return false;
  }

  const spxPrice = snap.spx.price;
  const side = direction === 'bullish' ? 'call' : 'put';

  const candidates = buildCandidates(snap);
  const result = selectStrike(candidates, direction, spxPrice, CFG);
  if (!result) {
    console.log(`[xsp] No qualifying ${side} contract found`);
    return false;
  }

  const xspSymbol = convertOptionSymbol(result.candidate.symbol, EXEC);
  const xspStrike = result.candidate.strike / EXEC.strikeDivisor;

  // Fetch real XSP quote from Tradier — source of truth for execution prices
  const xspQuote = await fetchXspQuote(xspSymbol);
  if (!xspQuote || xspQuote.ask <= 0) {
    console.log(`[xsp] No valid quote for ${xspSymbol} — skipping entry`);
    return false;
  }

  const entryPrice = xspQuote.ask;
  const stopLoss = entryPrice * (1 - CFG.position.stopLossPercent / 100);
  const takeProfit = entryPrice * CFG.position.takeProfitMultiplier;

  console.log(`[xsp] Quote ${xspSymbol}: bid=$${xspQuote.bid.toFixed(2)} ask=$${xspQuote.ask.toFixed(2)} last=$${xspQuote.last.toFixed(2)}`);

  const contractState = snap.contracts.find(c => c.meta.symbol === result.candidate.symbol);

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: xspSymbol,
    side: result.candidate.side,
    strike: result.candidate.strike,
    expiry: contractState?.meta.expiry ?? '',
    currentPrice: entryPrice,
    bid: xspQuote.bid,
    ask: xspQuote.ask,
    indicators: contractState?.bars1m[contractState.bars1m.length - 1] ?? {} as any,
    recentBars: contractState?.bars1m ?? [],
    signalBarLow: stopLoss,
    spxContext: {
      price: spxPrice,
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
    reasoning: `${reason} → ${side} XSP ${xspStrike} x1 @ ~$${entryPrice.toFixed(2)} | ${result.reason}`,
    concerns: [],
    ts: Date.now(),
  };

  try {
    const { position: pos, execution: exec } = await openPosition(signal, decision, guard.isPaper, EXEC);
    if (!exec.error) {
      positions.add(pos);
      guard.recordTrade();
      tradesTotal++;
      consecutiveRejections = 0; // reset on success
      console.log(`[xsp] ✅ ENTERED ${side.toUpperCase()} ${xspSymbol} x1 @ $${(exec.fillPrice ?? entryPrice).toFixed(2)} | SL=$${stopLoss.toFixed(2)} TP=$${takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution: exec });

      // Start streaming prices for real-time TP/SL monitoring
      await priceStream.updateSymbols([xspSymbol]);

      return true;
    } else {
      console.error(`[xsp] ❌ Order failed: ${exec.error}`);
      consecutiveRejections++;
      if (consecutiveRejections >= MAX_REJECTIONS_BEFORE_BACKOFF) {
        rejectionBackoffUntil = Date.now() + REJECTION_BACKOFF_SECS * 1000;
        console.log(`[xsp] 🚫 ${consecutiveRejections} consecutive rejections — backing off for ${REJECTION_BACKOFF_SECS}s`);
      }
      return false;
    }
  } catch (e) {
    console.error('[xsp] Execution error:', e);
    return false;
  }
}

function banner(): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer XSP Agent — Cash Account                   ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log(`║  Signal:  HMA(${CFG.signals.hmaCrossFast})×HMA(${CFG.signals.hmaCrossSlow}) cross on SPX underlying      ║`);
  console.log(`║  Execute: XSP 1DTE options (cash-settled)               ║`);
  console.log(`║  Exit:    scannerReverse (flip on HMA reversal)         ║`);
  console.log(`║  Size:    1 contract, trade all day                     ║`);
  console.log(`║  TP/SL:   ${CFG.position.takeProfitMultiplier}x / ${CFG.position.stopLossPercent}%                                     ║`);
  console.log(`║  Account: ${EXEC.accountId} (cash)                      ║`);
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

  // 2. Warmup check
  const { h: etH, m: etM } = nowET();
  const [asH, asM] = CFG.timeWindows.activeStart.split(':').map(Number);
  if (etH * 60 + etM < asH * 60 + asM) {
    console.log(`[xsp] Warming up — waiting until ${CFG.timeWindows.activeStart} ET for indicator stabilization`);
    return 30;
  }

  // 3. CLOSE FIRST — reconcile broker positions every cycle
  //    This catches orphans (broker has it, agent doesn't) and phantoms (agent has it, broker doesn't)
  await reconcileBrokerPositions();

  // 4. Update HMA cross state
  positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();
  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[xsp] HMA cross: ${arrow} ${hmaCross.toUpperCase()}`);
  }

  // 5. Monitor open positions — check TP/SL/reversal and close if needed
  //    Also handles streamExitPending flag from the price stream
  const closeEvents = await positions.monitor(pnl => {
    guard.recordLoss(pnl);
    dailyPnl += pnl;
  });

  // If price stream flagged an exit but monitor didn't catch it (e.g. price moved back),
  // force-close the position using the stream's latest price
  if (streamExitPending && closeEvents.length === 0 && positions.count() > 0) {
    console.log(`[xsp] ⚡ Stream flagged exit but monitor didn't trigger — force-closing`);
    for (const pos of positions.getAll()) {
      const streamPrice = priceStream.getPrice(pos.symbol);
      const sellPrice = streamPrice?.bid ?? streamPrice?.last ?? pos.entryPrice;

      const result = await closePosition(pos, 'stream_exit', sellPrice, guard.isPaper, CFG.execution);
      const pnl = ((result.fillPrice ?? sellPrice) - pos.entryPrice) * pos.quantity * 100;
      dailyPnl += pnl;
      guard.recordLoss(pnl);
      positions.remove(pos.id);

      const emoji = pnl >= 0 ? '💰' : '💸';
      if (pnl > 0) winsTotal++;
      console.log(`[xsp] ${emoji} STREAM-CLOSED ${pos.symbol} @ $${(result.fillPrice ?? sellPrice).toFixed(2)} (${result.error ? 'FAILED: ' + result.error : 'filled'}): P&L $${pnl.toFixed(0)}`);

      closeEvents.push({ position: pos, closePrice: result.fillPrice ?? sellPrice, reason: 'stream_exit', pnl });
    }
  }
  streamExitPending = false;

  for (const evt of closeEvents) {
    const emoji = evt.pnl >= 0 ? '💰' : '💸';
    if (evt.pnl > 0) winsTotal++;
    console.log(`[xsp] ${emoji} CLOSED ${evt.position.symbol} (${evt.reason}): P&L $${evt.pnl.toFixed(0)}`);
  }

  // Stop streaming if no positions
  if (positions.count() === 0 && priceStream.isConnected()) {
    priceStream.stop();
  }

  // 6. Risk check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[xsp] Risk guard: ${riskCheck.reason}`);
    return 60;
  }

  // 7. Handle flip-on-reversal — CLOSE happened above, now ENTER opposite
  const reversals = closeEvents.filter(e => e.reason === 'signal_reversal');
  for (const rev of reversals) {
    const flipDirection = rev.position.side === 'call' ? 'bearish' : 'bullish';
    const flipSide = flipDirection === 'bullish' ? 'call' : 'put';
    console.log(`[xsp] 🔄 FLIP → ${flipSide.toUpperCase()} (reversal from ${rev.position.side})`);
    await executeEntry(flipDirection, snap, 'FLIP');
  }

  // 8. If no position and no flip, enter on HMA cross
  if (positions.count() === 0 && reversals.length === 0 && hmaCross) {
    const side = hmaCross === 'bullish' ? 'call' : 'put';
    console.log(`[xsp] No position — entering ${side.toUpperCase()} on HMA ${hmaCross} cross`);
    await executeEntry(hmaCross, snap, 'HMA cross');
  }

  // 9. Report
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
    lastReasoning: `XSP | HMA ${hmaCross ?? '-'} | trades: ${tradesTotal} (WR ${wr}%) | P&L $${dailyPnl.toFixed(0)}`,
    scannerReads: [],
    nextCheckSecs: positions.count() > 0 ? 5 : 30,
    upSince: '',
  });

  // Poll faster when holding (5s) since stream handles TP/SL in between
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
    `  Trades:     ${tradesTotal} total (${winsTotal} wins, ${losses} losses)`,
    `  Win Rate:   ${wr}%`,
    `  Daily P&L:  $${dailyPnl.toFixed(2)}`,
    `  Avg P&L:    $${avgPnl}/trade`,
    `  Paper:      ${guard.isPaper ? 'YES' : 'NO — LIVE'}`,
    `  Rejections: ${consecutiveRejections} consecutive`,
    ``,
  ];

  const lessons: string[] = [];
  if (tradesTotal === 0) lessons.push('No trades executed. Check risk guard or contract selection.');
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

  // Start price stream (connects on demand when symbols are set)
  await priceStream.start([]);

  // Outer loop: one iteration per trading day
  while (true) {
    console.log('[xsp] Waiting for market open...');
    await sleepUntilMarketOpen();
    console.log('[xsp] Market open — starting trading session');

    // Pre-open: cancel stale orders
    const cancelledPreOpen = await cancelAllOpenOrders();
    if (cancelledPreOpen > 0) console.log(`[xsp] Cancelled ${cancelledPreOpen} stale order(s) pre-open`);

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    consecutiveRejections = 0;
    rejectionBackoffUntil = 0;
    dailyDate = todayET();
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
      // Start streaming for reconciled positions
      const symbols = positions.getAll().map(p => p.symbol);
      if (symbols.length > 0) await priceStream.updateSymbols(symbols);
    }

    console.log('[xsp] First cycle in 5s...\n');
    await new Promise(r => setTimeout(r, 5000));

    // Inner loop: trade until market close
    while (isMarketOpen()) {
      let nextSecs = 30;
      try {
        nextSecs = await runCycle();
      } catch (e) {
        console.error('[xsp] Cycle error:', e);
      }
      await new Promise(r => setTimeout(r, nextSecs * 1000));
    }

    // Market closed
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
