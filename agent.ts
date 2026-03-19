/**
 * SPXer Autonomous Trading Agent
 *
 * Runs continuously in a tmux session, fetching full market state
 * (sub-minute quotes + 1m/3m/5m bars) and asking Claude to review
 * everything every 15-60s. Claude determines what matters today —
 * no hardcoded signal rules.
 *
 * Usage:
 *   npm run agent              # paper mode (default, safe)
 *   npm run agent:live         # live trading (AGENT_PAPER=false)
 *
 * Recommended: run inside tmux so it survives SSH disconnects:
 *   tmux new-session -d -s agent 'cd /home/ubuntu/SPXer && npm run agent'
 *   tmux attach -t agent       # to watch it
 *
 * Models (AGENT_MODEL env):
 *   claude-haiku-4-5-20251001    ~$0.002/call  (default — good for 15-30s polling)
 *   claude-sonnet-4-6            ~$0.006/call  (sharper judgment, use if budget allows)
 *
 * API key: reuses ANTHROPIC_API_KEY from .env (same key Claude Code uses)
 *
 * Required env: ANTHROPIC_API_KEY, TRADIER_TOKEN
 * Live only:    TRADIER_ACCOUNT_ID, AGENT_PAPER=false
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot } from './src/agent/market-feed';
import { assess } from './src/agent/judgment-engine';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { RiskGuard, defaultRiskConfig } from './src/agent/risk-guard';
import { logEntry, logClose, logRejected } from './src/agent/audit-log';
import type { AgentSignal, AgentDecision } from './src/agent/types';

const guard = new RiskGuard(defaultRiskConfig());
const positions = new PositionManager(guard.isPaper);

let cycleCount = 0;
let lastAssessmentTs = 0;
let nextCheckSecs = 30; // Claude sets this dynamically each cycle

function banner(): void {
  const model = process.env.AGENT_MODEL || 'claude-haiku-4-5-20251001';
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║         SPXer Continuous Trading Agent               ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)          ' : 'LIVE  ⚠️  REAL MONEY              '}║`);
  console.log(`║  Model: ${model.padEnd(44)}║`);
  console.log(`║  Poll: dynamic 15-60s (Claude decides tempo)         ║`);
  console.log(`║  Risk/trade: $${guard.config.maxRiskPerTrade} | Daily limit: $${guard.config.maxDailyLoss}        ║`);
  console.log(`║  Max positions: ${guard.config.maxPositions} | Cutoff: ${guard.config.cutoffTimeET} ET              ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
}

async function runCycle(): Promise<void> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`\n[agent] ── cycle #${cycleCount} @ ${ts} ──`);

  // 1. Fetch full market state (sub-minute quotes + 1m/3m/5m)
  let snap: Awaited<ReturnType<typeof fetchMarketSnapshot>>;
  try {
    snap = await fetchMarketSnapshot();
  } catch (e) {
    console.error('[agent] Market fetch failed:', (e as Error).message);
    nextCheckSecs = 30;
    return;
  }

  console.log(`[agent] ${snap.contracts.length} contracts | SPX ${snap.spx.price.toFixed(2)} | ${snap.minutesToClose}m to close`);

  // 2. Monitor existing positions (stop-loss / take-profit / time exit)
  await positions.monitor(pnl => guard.recordLoss(pnl));

  // 3. Risk guard check before calling Claude
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[agent] Risk guard: ${riskCheck.reason}`);
    nextCheckSecs = 60;
    return;
  }

  // 4. Ask Claude for full market assessment
  let assessment: Awaited<ReturnType<typeof assess>>;
  try {
    assessment = await assess(snap, positions.getAll(), guard);
    lastAssessmentTs = Date.now();
  } catch (e) {
    console.error('[agent] Claude assessment failed:', (e as Error).message);
    nextCheckSecs = 30;
    return;
  }

  console.log(`[agent] Market read: ${assessment.marketRead}`);
  console.log(`[agent] Action: ${assessment.action.toUpperCase()} | Confidence: ${(assessment.confidence * 100).toFixed(0)}%`);
  console.log(`[agent] Reasoning: ${assessment.reasoning}`);
  if (assessment.concerns.length > 0) {
    console.log(`[agent] Concerns: ${assessment.concerns.join('; ')}`);
  }
  console.log(`[agent] Next check: ${assessment.nextCheckSecs}s`);

  // Update dynamic polling interval
  nextCheckSecs = assessment.nextCheckSecs;

  // 5. Execute if Claude recommends a trade
  if (assessment.action === 'buy' && assessment.targetSymbol && assessment.positionSize > 0) {
    // Find contract meta
    const contractState = snap.contracts.find(c => c.meta.symbol === assessment.targetSymbol);
    if (!contractState) {
      console.warn(`[agent] Target symbol ${assessment.targetSymbol} not in snapshot — skipping`);
      return;
    }

    // Re-check risk (positions may have changed)
    const recheck = guard.check(positions.getAll(), snap.minutesToClose);
    if (!recheck.allowed) {
      logRejected(recheck.reason!, assessment.targetSymbol, 'buy');
      return;
    }

    // Build synthetic signal/decision objects for the audit log
    const signal: AgentSignal = {
      type: 'RSI_BREAK_40', // placeholder type — Claude determined the signal
      symbol: contractState.meta.symbol,
      side: contractState.meta.side,
      strike: contractState.meta.strike,
      expiry: contractState.meta.expiry,
      currentPrice: contractState.quote.last ?? contractState.quote.mid ?? 0,
      bid: contractState.quote.bid,
      ask: contractState.quote.ask,
      indicators: contractState.bars1m[contractState.bars1m.length - 1] ?? {},
      recentBars: contractState.bars1m,
      signalBarLow: assessment.stopLoss ?? (contractState.quote.last ?? 0) * 0.7,
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
      confidence: assessment.confidence,
      positionSize: assessment.positionSize,
      stopLoss: assessment.stopLoss ?? signal.signalBarLow,
      takeProfit: assessment.takeProfit,
      reasoning: assessment.reasoning,
      concerns: assessment.concerns,
      ts: Date.now(),
    };

    try {
      const { position, execution } = await openPosition(signal, decision, guard.isPaper);
      if (!execution.error) positions.add(position);
      logEntry({ ts: Date.now(), signal, decision, execution });
    } catch (e) {
      console.error('[agent] Execution error:', e);
      logEntry({ ts: Date.now(), signal, decision, execution: { error: String(e), paper: guard.isPaper } });
    }

  } else if (assessment.action === 'sell_to_close' && assessment.targetSymbol) {
    // Claude wants to close a position early
    const pos = positions.getAll().find(p => p.symbol === assessment.targetSymbol);
    if (pos) {
      const contractState = snap.contracts.find(c => c.meta.symbol === assessment.targetSymbol);
      const currentPrice = contractState?.quote.last ?? pos.entryPrice;
      await closePosition(pos, 'manual', currentPrice, guard.isPaper);
      const pnl = (currentPrice - pos.entryPrice) * pos.quantity * 100;
      guard.recordLoss(pnl);
      logClose({ position: pos, closePrice: currentPrice, reason: 'manual', pnl, closedAt: Date.now() });
    }
  }
}

async function main(): Promise<void> {
  banner();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[agent] ANTHROPIC_API_KEY not set');
    process.exit(1);
  }
  if (!guard.isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  console.log('[agent] Starting — first cycle in 5s...');
  await new Promise(r => setTimeout(r, 5000));

  // Continuous dynamic-interval loop (Claude controls the tempo)
  while (true) {
    try {
      await runCycle();
    } catch (e) {
      console.error('[agent] Cycle error:', e);
    }
    const waitMs = nextCheckSecs * 1000;
    console.log(`[agent] Sleeping ${nextCheckSecs}s...\n`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

process.on('SIGTERM', () => { console.log('\n[agent] Shutting down (SIGTERM)'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[agent] Shutting down (SIGINT)');  process.exit(0); });

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
