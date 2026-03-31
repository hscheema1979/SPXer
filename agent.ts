/**
 * SPXer Deterministic Trading Agent — HMA3x17 ScannerReverse
 *
 * Pure deterministic execution — no LLM scanners or judges.
 * Strategy: HMA(3) × HMA(17) cross on SPX underlying → enter OTM contract
 *           → exit on reversal cross (scannerReverse) → immediately flip to opposite side
 *
 * Matches the backtested config: hma3x17-undhma-otm15-tp14x-sl70
 * Full year results: $2M P&L, 59.2% WR, 88% green days, 2.17:1 win/loss
 *
 * Usage:
 *   npm run agent              # paper mode (default)
 *   npm run agent:live         # live trading (AGENT_PAPER=false)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot, type MarketSnapshot } from './src/agent/market-feed';
import { openPosition } from './src/agent/trade-executor';
import { PositionManager, type PositionCloseEvent } from './src/agent/position-manager';
import { AGENT_CONFIG } from './agent-config';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeQty } from './src/core/position-sizer';
import { frictionEntry } from './src/core/friction';
import { computeTradeSize } from './src/agent/account-balance';

// ── Initialize ──────────────────────────────────────────────────────────────

const guard = new RiskGuard(AGENT_CONFIG);
const positions = new PositionManager(AGENT_CONFIG, guard.isPaper);

let cycleCount = 0;
let tradesTotal = 0;
let winsTotal = 0;
let dailyPnl = 0;
let dailyDate = '';

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
    const { position, execution } = await openPosition(signal, decision, guard.isPaper);
    if (!execution.error) {
      positions.add(position);
      guard.recordTrade();
      tradesTotal++;
      console.log(`[agent] ✅ ENTERED ${selection.side.toUpperCase()} ${selection.symbol} x${selection.qty} @ $${selection.price.toFixed(2)} | stop=$${selection.stopLoss.toFixed(2)} tp=$${selection.takeProfit.toFixed(2)}`);
      logEntry({ ts: Date.now(), signal, decision, execution });
      return true;
    } else {
      console.error(`[agent] ❌ Order failed: ${execution.error}`);
      logEntry({ ts: Date.now(), signal, decision, execution });
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
  console.log(`║  Scanners: DISABLED  |  Judges: DISABLED               ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Main Cycle ──────────────────────────────────────────────────────────────

async function runCycle(): Promise<number> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });

  // Daily state is reset in the outer loop (main) at market open

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

  // 2. Update HMA cross state from SPX bars
  positions.updateHmaCross(snap.spx.bars1m);
  const hmaCross = positions.getHmaCrossDirection();

  if (hmaCross) {
    const arrow = hmaCross === 'bullish' ? '🔼' : '🔽';
    console.log(`[agent] HMA cross: ${arrow} ${hmaCross.toUpperCase()}`);
  }

  // 3. Monitor existing positions — may close and return events
  const closeEvents = await positions.monitor(pnl => {
    guard.recordLoss(pnl);
    dailyPnl += pnl;
  });

  for (const evt of closeEvents) {
    const emoji = evt.pnl >= 0 ? '💰' : '💸';
    if (evt.pnl > 0) winsTotal++;
    console.log(`[agent] ${emoji} CLOSED ${evt.position.symbol} (${evt.reason}): P&L $${evt.pnl.toFixed(0)}`);
  }

  // 4. Risk guard check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[agent] Risk guard: ${riskCheck.reason}`);
    return 60;
  }

  // 5. Handle flip-on-reversal: if position closed via signal_reversal, enter opposite
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

  // 6. If no position open and no flip happened, check for new entry on HMA cross
  if (positions.count() === 0 && reversals.length === 0 && hmaCross) {
    const direction = hmaCross;
    const side = direction === 'bullish' ? 'call' : 'put';
    console.log(`[agent] No position — entering ${side.toUpperCase()} on HMA ${direction} cross`);

    const candidates = buildCandidates(snap);
    const selection = selectTradeStrike(candidates, direction, spxPrice);
    if (selection) {
      await executeBuy(selection, snap);
    } else {
      console.log(`[agent] No qualifying ${side} contract found`);
    }
  }

  // 7. Report status
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
    nextCheckSecs: 15,
    upSince: '',
  });

  logActivity({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    event: 'cycle',
    summary: `SPX ${spxPrice.toFixed(2)} | HMA ${hmaCross ?? '-'} | ${positions.count()} open | P&L $${dailyPnl.toFixed(0)}`,
    details: {
      hmaCross,
      openPositions: positions.count(),
      dailyPnl,
      tradesTotal,
      closeEvents: closeEvents.map(e => ({
        symbol: e.position.symbol,
        reason: e.reason,
        pnl: e.pnl,
      })),
    },
  });

  // Fast polling when in a trade (15s), slower when watching (30s)
  return positions.count() > 0 ? 15 : 30;
}

// ── Startup ─────────────────────────────────────────────────────────────────

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

/** Sleep until next 9:30 AM ET. Returns ms slept. */
async function sleepUntilMarketOpen(): Promise<void> {
  while (true) {
    const mins = etMinuteOfDay();
    if (mins >= MARKET_OPEN && mins < MARKET_CLOSE) return;

    // Calculate wait time
    let waitMins: number;
    if (mins >= MARKET_CLOSE) {
      // After close — wait until tomorrow 9:30
      waitMins = (24 * 60 - mins) + MARKET_OPEN;
    } else {
      // Before open
      waitMins = MARKET_OPEN - mins;
    }

    const waitMs = Math.min(waitMins * 60 * 1000, 5 * 60 * 1000); // check every 5 min max
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
    `  DAILY REVIEW — ${date} — SPX Agent (6YA51425)`,
    `${'═'.repeat(70)}`,
    ``,
    `  Trades:     ${tradesTotal} total (${winsTotal} wins, ${losses} losses)`,
    `  Win Rate:   ${wr}%`,
    `  Daily P&L:  $${dailyPnl.toFixed(2)}`,
    `  Avg P&L:    $${avgPnl}/trade`,
    `  Paper:      ${guard.isPaper ? 'YES' : 'NO — LIVE'}`,
    ``,
  ];

  // Lessons learned
  const lessons: string[] = [];

  if (tradesTotal === 0) {
    lessons.push('No trades executed. Check if risk guard or contract selection blocked all signals.');
  }
  if (tradesTotal > 30) {
    lessons.push(`High trade count (${tradesTotal}). HMA whipsawing — consider wider HMA periods or cooldown.`);
  }
  if (dailyPnl < -1000) {
    lessons.push(`Significant loss ($${dailyPnl.toFixed(0)}). Review largest losing trades for pattern.`);
  }
  if (tradesTotal > 0 && parseFloat(wr) < 40) {
    lessons.push(`Low win rate (${wr}%). Signal quality may be poor today — choppy market?`);
  }
  if (tradesTotal > 0 && parseFloat(wr) > 70) {
    lessons.push(`Strong win rate (${wr}%). Trending market favored the strategy.`);
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

  // Write to daily review log
  try {
    const reviewDir = path.join(process.cwd(), 'logs');
    fs.mkdirSync(reviewDir, { recursive: true });
    const reviewFile = path.join(reviewDir, 'daily-reviews.log');
    fs.appendFileSync(reviewFile, text + '\n');
  } catch (e) {
    console.error('[agent] Failed to write daily review:', (e as Error).message);
  }

  // Also log as activity
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

  // Outer loop: one iteration per trading day
  while (true) {
    console.log('[agent] Waiting for market open...');
    await sleepUntilMarketOpen();

    console.log('[agent] Market open — starting trading session');

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    dailyDate = todayET();
    guard.resetIfNewDay();

    // Dynamic sizing: update baseDollarsPerTrade from account balance
    if (AGENT_CONFIG.sizing.riskPercentOfAccount) {
      const tradeSize = await computeTradeSize(
        AGENT_CONFIG.sizing.riskPercentOfAccount,
        AGENT_CONFIG.execution?.accountId,
      );
      AGENT_CONFIG.sizing.baseDollarsPerTrade = tradeSize;
      console.log(`[agent] Daily sizing: $${tradeSize} per trade (${AGENT_CONFIG.sizing.riskPercentOfAccount}% of account)`);
    }

    // Reconcile any open positions from broker (survives restarts)
    const reconciled = await positions.reconcileFromBroker(AGENT_CONFIG.execution);
    if (reconciled > 0) console.log(`[agent] Reconciled ${reconciled} position(s) from broker`);

    console.log('[agent] First cycle in 5s (letting bars build)...\n');
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

    // Market closed — run daily review
    console.log('\n[agent] 🔔 Market closed — ending trading session');
    dailyReview();
    console.log('[agent] Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', () => { console.log('\n[agent] Shutting down (SIGTERM)'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[agent] Shutting down (SIGINT)');  process.exit(0); });

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
