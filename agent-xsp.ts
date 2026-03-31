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
    const { position: plainPos, execution: plainResult } = await openPosition(signal, decision, guard.isPaper, EXEC);
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

  // Daily state is reset in the outer loop (main) at market open

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

  // 1b. Warmup check — don't trade until activeStart (indicators need bars to compute)
  const { h: etH, m: etM } = nowET();
  const [asH, asM] = CFG.timeWindows.activeStart.split(':').map(Number);
  if (etH * 60 + etM < asH * 60 + asM) {
    console.log(`[xsp] Warming up — waiting until ${CFG.timeWindows.activeStart} ET for indicator stabilization`);
    return 30;
  }

  // 2. Update HMA cross state
  positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();
  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[xsp] HMA cross: ${arrow} ${hmaCross.toUpperCase()}`);
  }

  // 3. Monitor open position (may close + sell)
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

// ── Market Hours ─────────────────────────────────────────────────────────────

import { nowET, todayET } from './src/utils/et-time';
import * as fs from 'fs';
import * as path from 'path';

/** Get current ET minutes-of-day */
function etMinuteOfDay(): number {
  const { h, m } = nowET();
  return h * 60 + m;
}

const MARKET_OPEN = 9 * 60 + 30;   // 9:30 AM ET
const MARKET_CLOSE = 16 * 60;       // 4:00 PM ET

/** Returns true if current ET time is within trading hours */
function isMarketOpen(): boolean {
  const mins = etMinuteOfDay();
  return mins >= MARKET_OPEN && mins < MARKET_CLOSE;
}

/** Sleep until next 9:30 AM ET */
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
    ``,
  ];

  const lessons: string[] = [];

  if (tradesTotal === 0) {
    lessons.push('No trades executed. Check risk guard or contract selection.');
  }
  if (tradesTotal > 30) {
    lessons.push(`High trade count (${tradesTotal}). HMA whipsawing — consider wider periods or cooldown.`);
  }
  if (dailyPnl < -200) {
    lessons.push(`Significant loss for XSP ($${dailyPnl.toFixed(0)}). Review biggest losers.`);
  }
  if (tradesTotal > 0 && parseFloat(wr) < 40) {
    lessons.push(`Low win rate (${wr}%). Choppy market may not suit HMA cross.`);
  }
  if (tradesTotal > 0 && parseFloat(wr) > 70) {
    lessons.push(`Strong win rate (${wr}%). Trending market favored strategy.`);
  }
  if (dailyPnl > 0 && tradesTotal > 0) {
    lessons.push(`Profitable day. Strategy worked as designed.`);
  }

  if (lessons.length > 0) {
    review.push(`  Lessons:`);
    for (const l of lessons) {
      review.push(`    • ${l}`);
    }
    review.push(``);
  }

  review.push(`${'═'.repeat(70)}\n`);
  const text = review.join('\n');
  console.log(text);

  try {
    const reviewDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.appendFileSync(path.join(reviewDir, 'daily-reviews.log'), text + '\n');
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

  // Outer loop: one iteration per trading day
  while (true) {
    console.log('[xsp] Waiting for market open...');
    await sleepUntilMarketOpen();

    console.log('[xsp] Market open — starting trading session');

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    dailyDate = todayET();
    guard.resetIfNewDay();

    // Dynamic sizing
    if (CFG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(
        CFG.sizing.riskPercentOfAccount,
        EXEC.accountId,
      );
      CFG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[xsp] Daily sizing: $${tradeSize} per trade (${CFG.sizing.riskPercentOfAccount}% of account)`);
    }

    // Reconcile any open positions from broker
    const reconciled = await positions.reconcileFromBroker(EXEC);
    if (reconciled > 0) console.log(`[xsp] Reconciled ${reconciled} position(s) from broker`);

    console.log('[xsp] First cycle in 5s (letting bars build)...\n');
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

    // Market closed — daily review
    console.log('\n[xsp] 🔔 Market closed — ending trading session');
    dailyReview();
    console.log('[xsp] Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', () => { console.log('\n[xsp] Shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[xsp] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[xsp] Fatal:', e); process.exit(1); });
