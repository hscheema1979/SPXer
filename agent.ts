/**
 * SPXer Autonomous Trading Agent — Multi-Model Consensus
 *
 * Architecture:
 *   Tier 1 (every 15-60s): 3 scanners run in parallel via LiteLLM → Chutes
 *     - Kimi K2.5   — momentum pattern recognition
 *     - GLM-5       — technical analysis
 *     - MiniMax M2.5 — trend assessment
 *
 *   Tier 2 (on demand): Claude Opus judge via direct Anthropic API
 *     - Only fires when a scanner flags confidence >= 0.5
 *     - Gets full market context + all 3 scanner reads
 *     - Makes the actual buy/sell decision
 *
 * Cost: scanners ~free (Chutes), Opus ~$0.03/call × 5-15/day = ~$0.15-0.45/day
 *
 * Usage:
 *   npm run agent              # paper mode (default)
 *   npm run agent:live         # live trading (AGENT_PAPER=false)
 *
 * Run in tmux for persistence:
 *   tmux new-session -d -s agent 'cd /home/ubuntu/SPXer && npm run agent'
 *   tmux attach -t agent
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot } from './src/agent/market-feed';
import { assess } from './src/agent/judgment-engine';
import type { ScannerResult, Assessment } from './src/agent/judgment-engine';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { RiskGuard, defaultRiskConfig } from './src/agent/risk-guard';
import { logEntry, logClose, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import { getScannerConfigs } from './src/agent/model-clients';
import type { AgentSignal, AgentDecision } from './src/agent/types';

const guard = new RiskGuard(defaultRiskConfig());
const positions = new PositionManager(guard.isPaper);

let cycleCount = 0;
let nextCheckSecs = 30;
let judgeCallCount = 0;

function banner(): void {
  const scanners = getScannerConfigs();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer Multi-Model Trading Agent                    ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log('║  Scanners (Tier 1, via LiteLLM → Chutes):               ║');
  for (const s of scanners) {
    console.log(`║    • ${(s.label + ' (' + s.model + ')').padEnd(50)}║`);
  }
  console.log('║  Judge (Tier 2, on escalation only):                     ║');
  console.log(`║    • Claude Opus (direct Anthropic API)                   ║`);
  console.log('║                                                          ║');
  console.log(`║  Poll: dynamic 15-60s (scanners set tempo)               ║`);
  console.log(`║  Risk/trade: $${guard.config.maxRiskPerTrade} | Daily limit: $${guard.config.maxDailyLoss}            ║`);
  console.log(`║  Max positions: ${guard.config.maxPositions} | Cutoff: ${guard.config.cutoffTimeET} ET                  ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

function logScannerResults(results: ScannerResult[]): void {
  for (const sr of results) {
    const setupCount = sr.setups.length;
    const hot = sr.setups.filter(s => s.confidence >= 0.5).length;
    const icon = sr.error ? '✗' : hot > 0 ? '🔥' : setupCount > 0 ? '•' : '·';
    console.log(`[scan] ${icon} ${sr.scannerId.padEnd(8)} | ${sr.marketRead.slice(0, 80)}${sr.error ? ` ERR: ${sr.error.slice(0, 40)}` : ''}`);
    for (const s of sr.setups) {
      console.log(`[scan]    → ${s.symbol} ${s.setupType} conf=${s.confidence.toFixed(2)} ${s.urgency}`);
    }
  }
}

async function runCycle(): Promise<void> {
  cycleCount++;
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`\n[agent] ═══ cycle #${cycleCount} @ ${ts} | judge calls today: ${judgeCallCount} ═══`);

  // 1. Fetch full market state
  let snap: Awaited<ReturnType<typeof fetchMarketSnapshot>>;
  try {
    snap = await fetchMarketSnapshot();
  } catch (e) {
    console.error('[agent] Market fetch failed:', (e as Error).message);
    nextCheckSecs = 30;
    return;
  }

  console.log(`[agent] ${snap.contracts.length} contracts | SPX ${snap.spx.price.toFixed(2)} | ${snap.minutesToClose}m to close`);

  // 2. Monitor existing positions
  await positions.monitor(pnl => guard.recordLoss(pnl));

  // 3. Risk guard check
  const riskCheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[agent] Risk guard: ${riskCheck.reason}`);
    nextCheckSecs = 60;
    return;
  }

  // 4. Two-tier assessment: scanners → optional judge escalation
  let result: { scannerResults: ScannerResult[]; assessment: Assessment };
  try {
    result = await assess(snap, positions.getAll(), guard);
  } catch (e) {
    console.error('[agent] Assessment failed:', (e as Error).message);
    nextCheckSecs = 30;
    return;
  }

  const { scannerResults, assessment } = result;

  // Log scanner results
  logScannerResults(scannerResults);

  // Log assessment
  const tierLabel = assessment.tier === 'judge' ? 'OPUS JUDGE' : 'SCANNER ONLY';
  if (assessment.tier === 'judge') judgeCallCount++;
  console.log(`[agent] ── ${tierLabel} ──`);
  console.log(`[agent] Market: ${assessment.marketRead}`);
  if (assessment.scannerAgreement && assessment.tier === 'judge') {
    console.log(`[agent] Scanner agreement: ${assessment.scannerAgreement}`);
  }
  console.log(`[agent] Action: ${assessment.action.toUpperCase()} | Confidence: ${(assessment.confidence * 100).toFixed(0)}%`);
  console.log(`[agent] Reasoning: ${assessment.reasoning}`);
  if (assessment.concerns.length > 0) {
    console.log(`[agent] Concerns: ${assessment.concerns.join('; ')}`);
  }
  console.log(`[agent] Next check: ${assessment.nextCheckSecs}s`);

  nextCheckSecs = assessment.nextCheckSecs;

  // 4b. Report status + activity
  writeStatus({
    ts: Date.now(),
    timeET: snap.timeET,
    cycle: cycleCount,
    mode: snap.mode,
    spxPrice: snap.spx.price,
    minutesToClose: snap.minutesToClose,
    contractsTracked: snap.contracts.length,
    contractsWithBars: snap.contracts.filter(c => c.bars1m.length > 0).length,
    openPositions: positions.getAll().length,
    dailyPnL: guard.currentDailyLoss,
    judgeCallsToday: judgeCallCount,
    lastAction: assessment.action,
    lastReasoning: assessment.reasoning,
    scannerReads: scannerResults.map(sr => ({ id: sr.scannerId, read: sr.marketRead, setups: sr.setups.length })),
    nextCheckSecs: assessment.nextCheckSecs,
    upSince: '',
  });

  const hotSetups = scannerResults.flatMap(sr => sr.setups).filter(s => s.confidence >= 0.5);
  if (assessment.tier === 'judge') {
    logActivity({ ts: Date.now(), timeET: snap.timeET, cycle: cycleCount, event: 'escalate', summary: `Opus judge: ${assessment.action} ${assessment.targetSymbol ?? ''} conf=${assessment.confidence.toFixed(2)}`, details: { reasoning: assessment.reasoning } });
  } else if (hotSetups.length > 0) {
    logActivity({ ts: Date.now(), timeET: snap.timeET, cycle: cycleCount, event: 'scan', summary: `${hotSetups.length} hot setups detected`, details: { setups: hotSetups } });
  }

  // 5. Execute if judge recommends a trade
  if (assessment.action === 'buy' && assessment.targetSymbol && assessment.positionSize > 0) {
    const contractState = snap.contracts.find(c => c.meta.symbol === assessment.targetSymbol);
    if (!contractState) {
      console.warn(`[agent] Target ${assessment.targetSymbol} not in snapshot — skipping`);
      return;
    }

    const recheck = guard.check(positions.getAll(), snap.minutesToClose);
    if (!recheck.allowed) {
      logRejected(recheck.reason!, assessment.targetSymbol, 'buy');
      return;
    }

    const signal: AgentSignal = {
      type: 'MULTI_MODEL_CONSENSUS',
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
    console.error('[agent] ANTHROPIC_API_KEY not set (needed for Opus judge)');
    process.exit(1);
  }
  if (!guard.isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  console.log('[agent] Starting — first cycle in 5s...');
  await new Promise(r => setTimeout(r, 5000));

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
