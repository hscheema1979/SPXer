/**
 * SPXer XSP Agent — Cash Account
 *
 * Same HMA3x17 strategy, but:
 *   - Executes XSP options (Mini-SPX, 1/10th size, cash-settled)
 *   - 1DTE options (next-day expiry)
 *   - 1 contract, 1 trade per day (cash account settlement constraint)
 *   - Waits for a strong HMA cross signal, enters once, rides to TP/SL/EOD
 *   - No flipping (can't re-enter after selling in cash account)
 *
 * Uses SPX data pipeline for signals — converts strikes for XSP execution.
 *
 * Usage:
 *   npx tsx agent-xsp.ts            # paper mode
 *   AGENT_PAPER=false npx tsx agent-xsp.ts   # live
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
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeTradeSize } from './src/agent/account-balance';

// ── Initialize ──────────────────────────────────────────────────────────────

const CFG = AGENT_XSP_CONFIG;
const EXEC = CFG.execution!;
const guard = new RiskGuard(CFG);
const positions = new PositionManager(CFG, guard.isPaper);

let cycleCount = 0;
let tradedToday = false;
let dailyDate = '';
let dailyPnl = 0;

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

function banner(): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer XSP Agent — Cash Account                   ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log(`║  Signal:  HMA(${CFG.signals.hmaCrossFast})×HMA(${CFG.signals.hmaCrossSlow}) cross on SPX underlying      ║`);
  console.log(`║  Execute: XSP 1DTE options (cash-settled)               ║`);
  console.log(`║  Size:    1 contract, 1 trade/day                       ║`);
  console.log(`║  TP/SL:   ${CFG.position.takeProfitMultiplier}x / ${CFG.position.stopLossPercent}%                                     ║`);
  console.log(`║  Account: ${EXEC.accountId} (cash, $1,200)              ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Main Cycle ──────────────────────────────────────────────────────────────

async function runCycle(): Promise<number> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

  // Reset daily state + refresh account-based sizing
  const today = new Date().toISOString().split('T')[0];
  if (dailyDate !== today) {
    dailyPnl = 0;
    tradedToday = false;
    dailyDate = today;

    // Dynamic sizing: update baseDollarsPerTrade from account balance
    if (CFG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(
        CFG.sizing.riskPercentOfAccount,
        EXEC.accountId,
      );
      CFG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[xsp] Daily sizing: $${tradeSize} per trade (${CFG.sizing.riskPercentOfAccount}% of account)`);
    }
  }

  // Already traded today — just monitor the open position if any
  if (tradedToday && positions.count() === 0) {
    console.log(`[xsp] #${cycleCount} @ ${ts} — Done for today (P&L: $${dailyPnl.toFixed(0)})`);
    return 120; // check every 2 min just for status
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
  console.log(`\n[xsp] ═══ #${cycleCount} @ ${ts} | SPX ${spxPrice.toFixed(2)} | ${positions.count()} open | traded: ${tradedToday} ═══`);

  // 2. Update HMA cross state
  positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();
  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[xsp] HMA cross: ${arrow} ${hmaCross.toUpperCase()}`);
  }

  // 3. Monitor open position
  const closeEvents = await positions.monitor(pnl => {
    guard.recordLoss(pnl);
    dailyPnl += pnl;
  });

  for (const evt of closeEvents) {
    const emoji = evt.pnl >= 0 ? '💰' : '💸';
    console.log(`[xsp] ${emoji} CLOSED ${evt.position.symbol} (${evt.reason}): P&L $${evt.pnl.toFixed(0)}`);
    // Cash account: can't re-enter after selling
    tradedToday = true;
    console.log(`[xsp] Cash account — done trading for today`);
  }

  // 4. If already traded or holding, just monitor
  if (tradedToday || positions.count() > 0) {
    return positions.count() > 0 ? 15 : 120;
  }

  // 5. Risk check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[xsp] Risk guard: ${riskCheck.reason}`);
    return 60;
  }

  // 6. Wait for HMA cross signal to enter
  if (!hmaCross) {
    console.log(`[xsp] No HMA cross yet — waiting`);
    return 30;
  }

  // 7. Enter trade
  const direction = hmaCross;
  const side = direction === 'bullish' ? 'call' : 'put';
  console.log(`[xsp] 🎯 Signal: ${side.toUpperCase()} on HMA ${direction} cross`);

  // Select strike from SPX data
  const candidates = buildCandidates(snap);
  const result = selectStrike(candidates, direction, spxPrice, CFG);
  if (!result) {
    console.log(`[xsp] No qualifying SPX contract found — waiting`);
    return 30;
  }

  // Convert SPX symbol → XSP symbol
  const xspSymbol = convertOptionSymbol(result.candidate.symbol, EXEC);
  const xspStrike = result.candidate.strike / EXEC.strikeDivisor;

  // Price estimate: XSP options track SPX closely, use SPX price as reference
  const entryPrice = result.candidate.price;
  const stopLoss = entryPrice * (1 - CFG.position.stopLossPercent / 100);
  const takeProfit = entryPrice * CFG.position.takeProfitMultiplier;

  console.log(`[xsp] SPX strike ${result.candidate.strike} → XSP strike ${xspStrike}`);
  console.log(`[xsp] ${result.candidate.symbol} → ${xspSymbol}`);
  console.log(`[xsp] Entry ~$${entryPrice.toFixed(2)} | SL $${stopLoss.toFixed(2)} | TP $${takeProfit.toFixed(2)}`);

  const contractState = snap.contracts.find(c => c.meta.symbol === result.candidate.symbol);

  const signal: AgentSignal = {
    type: 'HMA_CROSS',
    symbol: result.candidate.symbol,  // SPX symbol — executor converts
    side: result.candidate.side,
    strike: result.candidate.strike,
    expiry: contractState?.meta.expiry ?? '',
    currentPrice: entryPrice,
    bid: contractState?.quote.bid ?? null,
    ask: contractState?.quote.ask ?? null,
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
    positionSize: 1,  // Always 1 contract in cash account
    stopLoss,
    takeProfit,
    reasoning: `HMA cross → ${side} XSP ${xspStrike} x1 @ ~$${entryPrice.toFixed(2)} | ${result.reason}`,
    concerns: [],
    ts: Date.now(),
  };

  try {
    const { position, execution } = await openPosition(signal, decision, guard.isPaper, EXEC);
    if (!execution.error) {
      positions.add(position);
      guard.recordTrade();
      tradedToday = true; // Even if it's still open, we've used our 1 trade
      console.log(`[xsp] ✅ ENTERED ${side.toUpperCase()} ${xspSymbol} x1 @ $${entryPrice.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution });
    } else {
      console.error(`[xsp] ❌ Order failed: ${execution.error}`);
    }
  } catch (e) {
    console.error('[xsp] Execution error:', e);
  }

  // Report
  writeStatus({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    mode: snap.mode,
    spxPrice,
    minutesToClose: snap.minutesToClose,
    contractsTracked: snap.contracts.length,
    contractsWithBars: snap.contracts.filter(c => c.bars1m.length > 0).length,
    openPositions: positions.count(),
    dailyPnL: dailyPnl,
    judgeCallsToday: 0,
    lastAction: tradedToday ? (positions.count() > 0 ? 'holding' : 'done') : 'watching',
    lastReasoning: `XSP | HMA ${hmaCross ?? '-'} | P&L $${dailyPnl.toFixed(0)}`,
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

      if (minsNow >= marketOpen) {
        resolve();
        return;
      }

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

  console.log('[xsp] Market open — starting (first cycle in 5s)...\n');
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
