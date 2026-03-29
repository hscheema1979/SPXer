/**
 * SPXer Autonomous Trading Agent
 *
 * Architecture:
 *   Primary trigger: price-action confluence (session break + range expansion + RSI velocity)
 *   Parallel oversight: LLM scanners (Kimi, GLM, MiniMax) — catch what deterministic misses
 *   Judge: escalation only when scanners flag high-confidence setups
 *
 * Core trading logic (signal detection, strike selection, position exit, risk guard)
 * is shared with the replay system via src/core/. Same Config → same decisions.
 *
 * Usage:
 *   npm run agent              # paper mode (default)
 *   npm run agent:live         # live trading (AGENT_PAPER=false)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchMarketSnapshot } from './src/agent/market-feed';
import { assess, getHttpScannerConfigs } from './src/agent/judgment-engine';
import type { ScannerResult, Assessment, JudgeResult } from './src/agent/judgment-engine';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { AGENT_CONFIG } from './agent-config';
import { RiskGuard } from './src/agent/risk-guard';
import { logEntry, logClose, logRejected } from './src/agent/audit-log';
import { writeStatus, logActivity } from './src/agent/reporter';
import { askModel } from './src/agent/model-clients';
import type { AgentSignal, AgentDecision } from './src/agent/types';
import { runPreSessionAgent } from './src/agent/pre-session-agent';
import { config } from './src/config';
import { selectStrike, type StrikeCandidate } from './src/core/strike-selector';
import { computeQty } from './src/core/position-sizer';
import { initPriceAction, processBar, getRecentSignals, type ConfluenceResult } from './src/agent/price-action';
import { MarketNarrative } from './src/agent/market-narrative';
import { initSession, getState as getRegimeState } from './src/agent/regime-classifier';

// ── Initialize with unified Config ──────────────────────────────────────────

const guard = new RiskGuard(AGENT_CONFIG);
const positions = new PositionManager(AGENT_CONFIG, guard.isPaper);

let cycleCount = 0;
let nextCheckSecs = 30;
let judgeCallCount = 0;

let lastPriceActionTradeTs = 0;
const PRICE_ACTION_COOLDOWN_MS = 5 * 60 * 1000;

const narratives = new Map<string, MarketNarrative>([
  ['kimi',    new MarketNarrative('kimi',    'Kimi K2.5')],
  ['glm',     new MarketNarrative('glm',     'ZAI GLM-5')],
  ['minimax', new MarketNarrative('minimax', 'MiniMax M2.7')],
  ['haiku',   new MarketNarrative('haiku',   'Claude Haiku')],
]);

// ── Helpers: convert snapshot contracts → core StrikeCandidate[] ─────────────

function buildCandidates(snap: Awaited<ReturnType<typeof fetchMarketSnapshot>>): StrikeCandidate[] {
  return snap.contracts.map(c => ({
    symbol: c.meta.symbol,
    side: c.meta.side,
    strike: c.meta.strike,
    price: c.quote.last ?? c.quote.mid ?? 0,
    volume: c.greeks.volume ?? 0,
  }));
}

/** Compute stop loss and take profit from config + entry price */
function computeSlTp(entryPrice: number): { stopLoss: number; takeProfit: number } {
  const slPct = AGENT_CONFIG.position.stopLossPercent / 100;
  return {
    stopLoss: entryPrice * (1 - slPct),
    takeProfit: entryPrice * AGENT_CONFIG.position.takeProfitMultiplier,
  };
}

interface TradeSelection {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  price: number;
  positionSize: number;
  stopLoss: number;
  takeProfit: number;
  reason: string;
}

/** Select strike using core module, compute SL/TP/qty from config */
function selectTradeStrike(
  candidates: StrikeCandidate[],
  direction: 'bullish' | 'bearish',
  spxPrice: number,
): TradeSelection | null {
  const result = selectStrike(candidates, direction, spxPrice, AGENT_CONFIG);
  if (!result) return null;

  const { candidate, reason } = result;
  const positionSize = computeQty(candidate.price, AGENT_CONFIG);
  const { stopLoss, takeProfit } = computeSlTp(candidate.price);

  return {
    symbol: candidate.symbol,
    side: candidate.side,
    strike: candidate.strike,
    price: candidate.price,
    positionSize,
    stopLoss,
    takeProfit,
    reason: `${reason} | ${positionSize} contracts, stop=$${stopLoss.toFixed(2)}, tp=$${takeProfit.toFixed(2)}`,
  };
}

// ── Execute Buy ─────────────────────────────────────────────────────────────

async function executeBuy(
  selection: TradeSelection,
  snap: Awaited<ReturnType<typeof fetchMarketSnapshot>>,
  spxRsi: number | null,
): Promise<void> {
  const contractState = snap.contracts.find(c => c.meta.symbol === selection.symbol);
  if (!contractState) {
    console.warn(`[agent] Selected contract ${selection.symbol} not in snapshot — skipping`);
    return;
  }
  const recheck = guard.check(positions.getAll(), snap.minutesToClose);
  if (!recheck.allowed) {
    logRejected(recheck.reason!, selection.symbol, 'buy');
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
    indicators: contractState.bars1m[contractState.bars1m.length - 1] ?? {} as any,
    recentBars: contractState.bars1m,
    signalBarLow: selection.stopLoss,
    spxContext: {
      price: snap.spx.price,
      changePercent: snap.spx.changePct,
      trend: snap.spx.trend1m as any,
      rsi14: spxRsi,
      minutesToClose: snap.minutesToClose,
      mode: snap.mode,
    },
    ts: Date.now(),
  };
  const decision: AgentDecision = {
    action: 'buy',
    confidence: 0.7,
    positionSize: selection.positionSize,
    stopLoss: selection.stopLoss,
    takeProfit: selection.takeProfit,
    reasoning: selection.reason,
    concerns: [],
    ts: Date.now(),
  };
  try {
    const { position, execution } = await openPosition(signal, decision, guard.isPaper);
    if (!execution.error) {
      positions.add(position);
      guard.recordTrade();
    }
    logEntry({ ts: Date.now(), signal, decision, execution });
  } catch (e) {
    console.error('[agent] Execution error:', e);
    logEntry({ ts: Date.now(), signal, decision, execution: { error: String(e) } });
  }
}

function banner(): void {
  const scanners = getHttpScannerConfigs();
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       SPXer Trading Agent                               ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  console.log('║                                                          ║');
  console.log('║  PRIMARY: Price-action confluence                       ║');
  console.log(`║    session break + range expansion + RSI velocity         ║`);
  console.log('║  PARALLEL: LLM scanners (oversight, every ~30s):        ║');
  for (const s of scanners) {
    console.log(`║    • ${(s.label + ' (' + s.model + ')').padEnd(50)}║`);
  }
  console.log('║  ESCALATION: Judge on high-confidence scanner signals    ║');
  console.log(`║  Risk/trade: $${AGENT_CONFIG.risk.maxRiskPerTrade} | Daily limit: $${AGENT_CONFIG.risk.maxDailyLoss}            ║`);
  console.log(`║  Max positions: ${AGENT_CONFIG.position.maxPositionsOpen} | Cutoff: ${AGENT_CONFIG.risk.cutoffTimeET} ET                  ║`);
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

  const latestBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];
  const spxRsi = latestBar?.rsi14 ?? null;
  const optionSnaps = snap.contracts.map(c => ({
    symbol: c.meta.symbol,
    strike: c.meta.strike,
    side: c.meta.side,
    price: c.quote.last ?? c.quote.mid ?? 0,
    prevPrice: snap.spx.bars1m.length > 1 ? snap.spx.bars1m[snap.spx.bars1m.length - 2]?.close ?? null : null,
    volume: c.greeks.volume ?? 0,
    avgVolume: c.greeks.volume ?? 0,
  }));
  const confluence: ConfluenceResult = latestBar
    ? processBar({ ts: latestBar.ts, open: latestBar.close, high: latestBar.close, low: latestBar.close, close: latestBar.close, rsi: spxRsi }, optionSnaps)
    : { triggered: false, direction: null, signals: [], confidence: 0 };

  if (confluence.triggered && confluence.direction) {
    const nowTs = Date.now();
    if (nowTs - lastPriceActionTradeTs > PRICE_ACTION_COOLDOWN_MS) {
      lastPriceActionTradeTs = nowTs;
      console.log(`[agent] 🔥 PRICE ACTION TRIGGER — ${confluence.direction.toUpperCase()} conf=${(confluence.confidence * 100).toFixed(0)}%`);
      for (const s of confluence.signals) {
        console.log(`[agent]   → ${s.type} ${s.direction} ${s.detail}`);
      }
      const candidates = buildCandidates(snap);
      const selection = selectTradeStrike(candidates, confluence.direction, snap.spx.price);
      if (selection) {
        console.log(`[agent]   strike: ${selection.reason}`);
        await executeBuy(selection, snap, spxRsi);
      } else {
        console.log(`[agent]   no qualifying OTM contract — skipping`);
      }
    } else {
      console.log(`[agent] Price-action fired but on cooldown — skipping`);
    }
  }

  let result: { scannerResults: ScannerResult[]; assessment: Assessment; allJudges?: JudgeResult[] };
  try {
    result = await assess(snap, positions.getAll(), guard, narratives, AGENT_CONFIG.regime);
  } catch (e) {
    console.error('[agent] Assessment failed:', (e as Error).message);
    nextCheckSecs = 30;
    return;
  }

  const { scannerResults, assessment, allJudges } = result;

  logScannerResults(scannerResults);

  if (allJudges && allJudges.length > 0) {
    judgeCallCount++;
    console.log(`[agent] ── JUDGE PANEL (${allJudges.length} judges) ──`);
    for (const jr of allJudges) {
      const a = jr.assessment;
      const active = jr.judgeId === (process.env.AGENT_ACTIVE_JUDGE || 'sonnet') ? ' ★ACTIVE' : '';
      console.log(`[judge:${jr.judgeId}]${active} ${a.action.toUpperCase()} conf=${(a.confidence * 100).toFixed(0)}% | ${a.reasoning.slice(0, 120)}`);
    }
  } else {
    console.log(`[agent] ── SCANNER ONLY ──`);
  }
  console.log(`[agent] Active decision: ${assessment.action.toUpperCase()} | Confidence: ${(assessment.confidence * 100).toFixed(0)}%`);
  console.log(`[agent] Reasoning: ${assessment.reasoning.slice(0, 200)}`);
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
    scannerReads: scannerResults.map(sr => ({ id: sr.scannerId, read: sr.marketRead, setups: sr.setups.length, setupDetails: sr.setups })),
    nextCheckSecs: assessment.nextCheckSecs,
    upSince: '',
  });

  const regimeState = getRegimeState();
  const cycleSummary = scannerResults.length > 0
    ? scannerResults.map(sr => `${sr.scannerId}:${sr.marketRead.slice(0, 40)}`).join(' | ')
    : 'no scanners';
  for (const narrative of narratives.values()) {
    narrative.appendEvent(
      Math.floor(Date.now() / 1000),
      snap.timeET,
      snap.spx.price,
      spxRsi,
      regimeState.regime,
      cycleSummary,
    );
  }

  // Always log scanner reads
  const allSetups = scannerResults.flatMap(sr => sr.setups);
  const hotSetups = allSetups.filter(s => s.confidence >= 0.5);
  logActivity({
    ts: Date.now(), timeET: snap.timeET, cycle: cycleCount, event: 'scan',
    summary: `${scannerResults.length} scanners | ${allSetups.length} setups (${hotSetups.length} hot)`,
    details: {
      scanners: scannerResults.map(sr => ({
        id: sr.scannerId,
        read: sr.marketRead,
        setups: sr.setups,
        nextCheckSecs: sr.nextCheckSecs,
        error: sr.error,
      })),
      spxPrice: snap.spx.price,
    },
  });

  if (allJudges && allJudges.length > 0) {
    logActivity({
      ts: Date.now(), timeET: snap.timeET, cycle: cycleCount, event: 'judge-panel',
      summary: `${allJudges.length} judges: ${allJudges.map(j => `${j.judgeId}=${j.assessment.action}`).join(' ')}`,
      details: {
        activeJudge: process.env.AGENT_ACTIVE_JUDGE || 'sonnet',
        judges: allJudges.map(j => ({
          id: j.judgeId,
          action: j.assessment.action,
          confidence: j.assessment.confidence,
          targetSymbol: j.assessment.targetSymbol,
          reasoning: j.assessment.reasoning,
          concerns: j.assessment.concerns,
          error: j.error,
        })),
      },
    });
  }

  // 5. Execute if judge recommends a trade
  if (assessment.action === 'buy' && assessment.direction && assessment.positionSize > 0) {
    const spxRsi = snap.spx.bars1m[snap.spx.bars1m.length - 1]?.rsi14 ?? null;
    const candidates = buildCandidates(snap);
    const selection = selectTradeStrike(candidates, assessment.direction, snap.spx.price);

    if (!selection) {
      console.warn(`[agent] No qualifying OTM contract found for ${assessment.direction} — skipping`);
      return;
    }

    const contractState = snap.contracts.find(c => c.meta.symbol === selection.symbol);
    if (!contractState) {
      console.warn(`[agent] Selected contract ${selection.symbol} not in snapshot — skipping`);
      return;
    }

    const recheck = guard.check(positions.getAll(), snap.minutesToClose);
    if (!recheck.allowed) {
      logRejected(recheck.reason!, selection.symbol, 'buy');
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
      indicators: contractState.bars1m[contractState.bars1m.length - 1] ?? {} as any,
      recentBars: contractState.bars1m,
      signalBarLow: selection.stopLoss,
      spxContext: {
        price: snap.spx.price,
        changePercent: snap.spx.changePct,
        trend: snap.spx.trend1m as any,
        rsi14: spxRsi,
        minutesToClose: snap.minutesToClose,
        mode: snap.mode,
      },
      ts: Date.now(),
    };
    const decision: AgentDecision = {
      action: 'buy',
      confidence: assessment.confidence,
      positionSize: selection.positionSize,
      stopLoss: selection.stopLoss,
      takeProfit: selection.takeProfit,
      reasoning: `${selection.reason} | Judge: ${assessment.reasoning}`,
      concerns: assessment.concerns,
      ts: Date.now(),
    };

    try {
      const { position, execution } = await openPosition(signal, decision, guard.isPaper);
      if (!execution.error) {
        positions.add(position);
        guard.recordTrade();
      }
      logEntry({ ts: Date.now(), signal, decision, execution });
    } catch (e) {
      console.error('[agent] Execution error:', e);
      logEntry({ ts: Date.now(), signal, decision, execution: { error: String(e) } });
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
    console.error('[agent] ANTHROPIC_API_KEY not set (needed for judge)');
    process.exit(1);
  }
  if (!guard.isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  await runMorningSequence();

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

async function runMorningSequence(): Promise<void> {
  const now = new Date();
  const etHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
  const etMin = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit', hour12: false }));
  const etTime = etHour * 60 + etMin;

  const marketOpen = 9 * 60 + 30; // 9:30 AM ET

  if (etTime >= marketOpen) {
    console.log('[morning] Market already open — skipping morning sequence');
    return;
  }

  const mkt925 = 9 * 60 + 25;
  const mkt920 = 9 * 60 + 20;

  if (etTime < mkt920) {
    const waitMs = (mkt920 - etTime) * 60 * 1000;
    console.log(`[morning] Sleeping ${Math.round(waitMs / 60000)}min until 9:20 ET...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  console.log('[morning] Running pre-session analysis...');
  const preSession = await runPreSessionAgent(config.dbPath);
  console.log(`[morning] Overnight: ${preSession.narrative.split('|')[0]}`);

  for (const narrative of narratives.values()) {
    narrative.setOvernight(preSession.overnight);
    narrative.setPreMarket({
      impliedOpen: preSession.preMarket.impliedOpen,
      auctionRange: preSession.preMarket.auctionRange,
      imbalance: 'neutral',
      contractCount: 0,
      callCount: 0,
      putCount: 0,
      volumeEstimate: 0,
      regimeExpectation: '',
    });
  }

  const now2 = new Date();
  const etTime2 = parseInt(now2.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) * 60 +
    parseInt(now2.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit', hour12: false }));

  if (etTime2 < mkt925) {
    const waitMs = (mkt925 - etTime2) * 60 * 1000;
    console.log(`[morning] Sleeping ${Math.round(waitMs / 60000)}min until 9:25 ET...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  console.log('[morning] Judge overnight validation...');
  let judgeValidation = '';
  const judgePrompt = `Overnight session summary:\n${preSession.narrative}\n\nIs this a bullish, bearish, or neutral overnight setup? What should we watch for in the first 15 minutes of trading?`;
  try {
    judgeValidation = await askModel({
      id: 'sonnet',
      label: 'Claude Sonnet',
      model: process.env.SONNET_MODEL || 'claude-sonnet-4-6',
    }, 'You are a senior 0DTE SPX options strategist.', judgePrompt, 30000);
    console.log(`[morning] Judge: ${judgeValidation.slice(0, 200)}`);
  } catch (e) {
    console.warn(`[morning] Judge validation failed: ${(e as Error).message}`);
  }
  for (const narrative of narratives.values()) {
    narrative.setJudgeValidation(judgeValidation);
  }

  const now3 = new Date();
  const etTime3 = parseInt(now3.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })) * 60 +
    parseInt(now3.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit', hour12: false }));

  if (etTime3 < marketOpen) {
    const waitMs = (marketOpen - etTime3) * 60 * 1000;
    console.log(`[morning] Waiting ${Math.round(waitMs / 60000)}min until market open...`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  initPriceAction();
  const snap = await fetchMarketSnapshot();
  const lastClose = snap.spx.price;
  const firstBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];

  initSession(preSession.priorDayClose);

  for (const narrative of narratives.values()) {
    narrative.startSession(lastClose, Math.floor(Date.now() / 1000));
  }

  if (firstBar) {
    const optionSnaps = snap.contracts.map(c => ({
      symbol: c.meta.symbol,
      strike: c.meta.strike,
      side: c.meta.side,
      price: c.quote.last ?? c.quote.mid ?? 0,
      prevPrice: snap.spx.bars1m.length > 1 ? snap.spx.bars1m[snap.spx.bars1m.length - 2]?.close : null,
      volume: c.greeks.volume ?? 0,
      avgVolume: c.greeks.volume ?? 0,
    }));
    processBar({ ts: firstBar.ts, open: lastClose, high: lastClose, low: lastClose, close: lastClose, rsi: firstBar.rsi14 ?? null }, optionSnaps);

    const regimeState = getRegimeState();
    for (const narrative of narratives.values()) {
      narrative.appendEvent(
        firstBar.ts,
        snap.timeET,
        lastClose,
        firstBar.rsi14 ?? null,
        regimeState.regime,
        'session open',
      );
    }
  }
  console.log('[morning] Market open — beginning trading cycle\n');
}

process.on('SIGTERM', () => { console.log('\n[agent] Shutting down (SIGTERM)'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[agent] Shutting down (SIGINT)');  process.exit(0); });

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
