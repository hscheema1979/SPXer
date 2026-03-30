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
 *
 * Usage:
 *   npx tsx agent-xsp.ts                        # paper mode
 *   AGENT_PAPER=false npx tsx agent-xsp.ts      # live
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot, type MarketSnapshot } from './src/agent/market-feed';
import { openPosition, convertOptionSymbol } from './src/agent/trade-executor';
import { PositionManager, type PositionCloseEvent } from './src/agent/position-manager';
import { AGENT_XSP_CONFIG } from './agent-xsp-config';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import { config as appConfig, TRADIER_BASE } from './src/config';
import axios from 'axios';
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeTradeSize } from './src/agent/account-balance';

// ── Initialize ──────────────────────────────────────────────────────────────

const CFG = AGENT_XSP_CONFIG;
const EXEC = CFG.execution!;
const guard = new RiskGuard(CFG);
const positions = new PositionManager(CFG, guard.isPaper);

let cycleCount = 0;
let dailyDate = '';
let dailyPnl = 0;
let tradesTotal = 0;
let winsTotal = 0;

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Cancel any open/pending OTOCO bracket orders for a given option symbol.
 * Called on flip so the old bracket's TP/SL legs don't linger.
 */
async function cancelBracketOrdersForSymbol(optionSymbol: string): Promise<void> {
  const accountId = EXEC.accountId!;
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

    for (const order of orders) {
      if (order.status !== 'open' && order.status !== 'pending') continue;
      if (order.class !== 'otoco' && order.class !== 'oco') continue;

      const legs = Array.isArray(order.leg) ? order.leg : order.leg ? [order.leg] : [];
      const matchesSymbol = legs.some((l: any) => l.option_symbol === optionSymbol);
      if (!matchesSymbol) continue;

      try {
        await axios.delete(
          `${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`,
          { headers: hdrs, timeout: 10000 },
        );
        console.log(`[xsp] 🗑️ Cancelled bracket #${order.id} for ${optionSymbol}`);
      } catch (e: any) {
        console.warn(`[xsp] ⚠️ Failed to cancel bracket #${order.id}: ${e?.response?.data?.errors?.error || e.message}`);
      }
    }
  } catch (e: any) {
    console.warn(`[xsp] ⚠️ Failed to fetch orders for bracket cleanup: ${e.message}`);
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

  const entryPrice = xspQuote.ask; // worst-case fill for market buy
  const stopLoss = entryPrice * (1 - CFG.position.stopLossPercent / 100);
  const takeProfit = entryPrice * CFG.position.takeProfitMultiplier;

  console.log(`[xsp] Quote ${xspSymbol}: bid=$${xspQuote.bid.toFixed(2)} ask=$${xspQuote.ask.toFixed(2)} last=$${xspQuote.last.toFixed(2)}`);

  const contractState = snap.contracts.find(c => c.meta.symbol === result.candidate.symbol);

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: xspSymbol,           // use XSP symbol, not SPX
    side: result.candidate.side,
    strike: result.candidate.strike,  // SPX strike — openPosition divides by strikeDivisor
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
    // Leg 1: OTOCO bracket (test — server-side TP/SL)
    const bracketExec = { ...EXEC, disableBracketOrders: false };
    const { position: bracketPos, execution: bracketResult } = await openPosition(signal, decision, guard.isPaper, bracketExec);
    if (!bracketResult.error) {
      console.log(`[xsp] 🧪 BRACKET ${side.toUpperCase()} ${xspSymbol} x1 @ $${entryPrice.toFixed(2)} | TP=$${takeProfit.toFixed(2)} SL=$${stopLoss.toFixed(2)} (test)`);
      logEntry({ ts: Date.now(), signal, decision, execution: bracketResult });
    } else {
      console.warn(`[xsp] ⚠️ BRACKET order rejected: ${bracketResult.error}`);
    }

    // Leg 2: Plain market order (agent monitors exits via TP/SL/reversal)
    const plainExec = { ...EXEC, disableBracketOrders: true };
    const { position: plainPos, execution: plainResult } = await openPosition(signal, decision, guard.isPaper, plainExec);
    if (!plainResult.error) {
      positions.add(plainPos);
      guard.recordTrade();
      tradesTotal++;
      console.log(`[xsp] ✅ ENTERED ${side.toUpperCase()} ${xspSymbol} x1 @ $${entryPrice.toFixed(2)} | agent-managed exits`);
      logEntry({ ts: Date.now(), signal, decision, execution: plainResult });
      return true;
    } else {
      console.error(`[xsp] ❌ Market order failed: ${plainResult.error}`);
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
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Main Cycle ──────────────────────────────────────────────────────────────

async function runCycle(): Promise<number> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

  // Reset daily state + refresh sizing
  const today = new Date().toISOString().split('T')[0];
  if (dailyDate !== today) {
    dailyPnl = 0;
    dailyDate = today;

    if (CFG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(
        CFG.sizing.riskPercentOfAccount,
        EXEC.accountId,
      );
      CFG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[xsp] Daily sizing: $${tradeSize} per trade (${CFG.sizing.riskPercentOfAccount}% of account)`);
    }
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

  // 2. Update HMA cross state
  positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();
  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[xsp] HMA cross: ${arrow} ${hmaCross.toUpperCase()}`);
  }

  // 3. Pre-close: cancel bracket orders for any position that's about to exit
  //    Must happen BEFORE monitor() sends sell orders, otherwise Tradier rejects
  //    the sell because pending bracket sell legs count against position quantity.
  if (positions.count() > 0) {
    for (const pos of positions.getAll()) {
      await cancelBracketOrdersForSymbol(pos.symbol);
    }
  }

  // 4. Monitor open position (may close + sell)
  const closeEvents = await positions.monitor(pnl => {
    guard.recordLoss(pnl);
    dailyPnl += pnl;
  });

  for (const evt of closeEvents) {
    const emoji = evt.pnl >= 0 ? '💰' : '💸';
    if (evt.pnl > 0) winsTotal++;
    console.log(`[xsp] ${emoji} CLOSED ${evt.position.symbol} (${evt.reason}): P&L $${evt.pnl.toFixed(0)}`);
  }

  // 4. Risk check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[xsp] Risk guard: ${riskCheck.reason}`);
    return 60;
  }

  // 5. Handle flip-on-reversal
  const reversals = closeEvents.filter(e => e.reason === 'signal_reversal');
  for (const rev of reversals) {
    const flipDirection = rev.position.side === 'call' ? 'bearish' : 'bullish';
    const flipSide = flipDirection === 'bullish' ? 'call' : 'put';
    console.log(`[xsp] 🔄 FLIP → ${flipSide.toUpperCase()} (reversal from ${rev.position.side})`);
    await executeEntry(flipDirection, snap, 'FLIP');
  }

  // 6. If no position and no flip, enter on HMA cross
  if (positions.count() === 0 && reversals.length === 0 && hmaCross) {
    const side = hmaCross === 'bullish' ? 'call' : 'put';
    console.log(`[xsp] No position — entering ${side.toUpperCase()} on HMA ${hmaCross} cross`);
    await executeEntry(hmaCross, snap, 'HMA cross');
  }

  // 7. Report
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
    nextCheckSecs: 15,
    upSince: '',
  });

  return positions.count() > 0 ? 15 : 30;
}

// ── Startup ─────────────────────────────────────────────────────────────────

function waitForMarketOpen(): Promise<void> {
  return new Promise(resolve => {
    const check = () => {
      const now = new Date();
      const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
      const timePart = etStr.split(', ')[1];
      const [h, m] = timePart.split(':').map(Number);
      const minsNow = h * 60 + m;
      const marketOpen = 9 * 60 + 30;

      if (minsNow >= marketOpen) { resolve(); return; }

      const waitMins = marketOpen - minsNow;
      console.log(`[xsp] Market opens in ${waitMins} minutes — waiting...`);
      setTimeout(check, Math.min(waitMins * 60 * 1000, 60000));
    };
    check();
  });
}

async function main(): Promise<void> {
  banner();

  if (!process.env.TRADIER_TOKEN) {
    console.error('[xsp] TRADIER_TOKEN not set');
    process.exit(1);
  }

  console.log('[xsp] Waiting for market open...');
  await waitForMarketOpen();

  console.log('[xsp] Market open — starting trading loop');

  // Reconcile any open positions from broker (survives restarts)
  const reconciled = await positions.reconcileFromBroker(EXEC);
  if (reconciled > 0) console.log(`[xsp] Reconciled ${reconciled} position(s) from broker`);

  console.log('[xsp] First cycle in 5s (letting bars build)...\n');
  await new Promise(r => setTimeout(r, 5000));

  while (true) {
    let nextSecs = 30;
    try {
      nextSecs = await runCycle();
    } catch (e) {
      console.error('[xsp] Cycle error:', e);
    }
    await new Promise(r => setTimeout(r, nextSecs * 1000));
  }
}

process.on('SIGTERM', () => { console.log('\n[xsp] Shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[xsp] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[xsp] Fatal:', e); process.exit(1); });
