/**
 * SPXer Autonomous Trading Agent
 *
 * Polls SPXer every 60s for fresh bar data, detects candidate signals,
 * calls Claude for judgment, and executes trades via Tradier (or logs in paper mode).
 *
 * Usage:
 *   tsx agent.ts                  # paper mode (default)
 *   AGENT_PAPER=false tsx agent.ts  # live trading
 *
 * Required env:
 *   ANTHROPIC_API_KEY  — Claude API key (judgment engine)
 *   TRADIER_TOKEN      — Tradier API token (data + execution)
 *   TRADIER_ACCOUNT_ID — Tradier account ID (live orders only)
 *
 * Optional env:
 *   AGENT_PAPER=true             default: true
 *   AGENT_MAX_DAILY_LOSS=2000    default: 2000
 *   AGENT_MAX_POSITIONS=2        default: 2
 *   AGENT_MAX_RISK_PER_TRADE=500 default: 500
 *   AGENT_CUTOFF_ET=15:30        default: 15:30 (no new entries after)
 *   AGENT_MIN_MINS_TO_CLOSE=60   default: 60 (skip signals < 60m to close)
 *   SPXER_URL=http://localhost:3600
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { fetchSnapshot } from './src/agent/market-feed';
import { detectSignals } from './src/agent/signal-detector';
import { getJudgment } from './src/agent/judgment-engine';
import { openPosition } from './src/agent/trade-executor';
import { PositionManager } from './src/agent/position-manager';
import { RiskGuard, defaultRiskConfig } from './src/agent/risk-guard';
import { logEntry, logRejected } from './src/agent/audit-log';
import type { AuditEntry } from './src/agent/types';

const POLL_INTERVAL_MS = 60_000;
const MONITOR_INTERVAL_MS = 30_000;

const guard = new RiskGuard(defaultRiskConfig());
const positions = new PositionManager(guard.isPaper);

function banner(): void {
  console.log('');
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║       SPXer Autonomous Trading Agent         ║');
  console.log(`║  Mode: ${guard.isPaper ? 'PAPER (no real orders)     ' : 'LIVE  ⚠️  REAL MONEY         '}   ║`);
  console.log(`║  Max risk/trade: $${guard.config.maxRiskPerTrade.toFixed(0).padEnd(6)} Daily limit: $${guard.config.maxDailyLoss.toFixed(0).padEnd(6)}║`);
  console.log(`║  Max positions: ${guard.config.maxPositions}  Cutoff: ${guard.config.cutoffTimeET} ET           ║`);
  console.log('╚══════════════════════════════════════════════╝');
  console.log('');
}

async function pollCycle(): Promise<void> {
  const cycleTs = new Date().toISOString();
  console.log(`\n[agent] ── poll cycle ${cycleTs} ──`);

  let snapshot: Awaited<ReturnType<typeof fetchSnapshot>>;
  try {
    snapshot = await fetchSnapshot();
  } catch (e) {
    console.error('[agent] Failed to fetch snapshot from SPXer:', e);
    return;
  }

  const { contracts, barsBySymbol, spxContext } = snapshot;
  console.log(`[agent] ${contracts.length} contracts tracked | SPX: ${spxContext.price.toFixed(2)} (${spxContext.trend}) | ${spxContext.minutesToClose}m to close`);

  // Check risk guard before signal detection (avoid wasted Claude calls)
  const riskCheck = guard.check(positions.getAll(), spxContext.minutesToClose);
  if (!riskCheck.allowed) {
    console.log(`[agent] Risk guard: ${riskCheck.reason} — no new entries this cycle`);
    return;
  }

  // Build quote map from latest bar close prices (SPXer batches quotes separately;
  // for now use last bar close as proxy — good enough for signal detection)
  const quotes = new Map(
    [...barsBySymbol.entries()].map(([sym, bars]) => {
      const last = bars[bars.length - 1];
      return [sym, { last: last.close, bid: null, ask: null }];
    })
  );

  const signals = detectSignals(contracts, barsBySymbol, quotes, spxContext);

  if (signals.length === 0) {
    console.log('[agent] No signals detected this cycle');
    return;
  }

  console.log(`[agent] ${signals.length} signal(s) detected — sending to judgment engine`);

  // Process signals sequentially (avoid placing duplicate positions on same contract)
  for (const signal of signals) {
    // Re-check risk guard for each signal (positions may have changed)
    const check = guard.check(positions.getAll(), spxContext.minutesToClose);
    if (!check.allowed) {
      logRejected(check.reason!, signal.symbol, signal.type);
      break;
    }

    console.log(`\n[agent] Signal: ${signal.type} on ${signal.symbol} (${signal.side} ${signal.strike})`);

    let decision;
    try {
      decision = await getJudgment(signal, guard);
    } catch (e) {
      console.error('[agent] Judgment engine error:', e);
      continue;
    }

    const entry: AuditEntry = { ts: Date.now(), signal, decision };

    if (decision.action === 'buy' && decision.positionSize > 0) {
      try {
        const { position, execution } = await openPosition(signal, decision, guard.isPaper);
        entry.execution = execution;

        if (!execution.error) {
          positions.add(position);
        }
      } catch (e) {
        console.error('[agent] Execution error:', e);
        entry.execution = { error: String(e), paper: guard.isPaper };
      }
    } else {
      console.log(`[agent] Skipped ${signal.symbol}: ${decision.reasoning}`);
    }

    logEntry(entry);
  }
}

async function monitorCycle(): Promise<void> {
  await positions.monitor(pnl => guard.recordLoss(pnl));
}

async function main(): Promise<void> {
  banner();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[agent] ANTHROPIC_API_KEY not set — judgment engine requires it');
    process.exit(1);
  }

  if (!guard.isPaper && !process.env.TRADIER_ACCOUNT_ID) {
    console.error('[agent] TRADIER_ACCOUNT_ID required for live trading');
    process.exit(1);
  }

  console.log('[agent] Starting — initial poll in 5s...');
  await new Promise(r => setTimeout(r, 5000));

  // Run an immediate cycle on startup
  await pollCycle();

  // Poll for new signals every 60s
  setInterval(() => { pollCycle().catch(console.error); }, POLL_INTERVAL_MS);

  // Monitor open positions every 30s
  setInterval(() => { monitorCycle().catch(console.error); }, MONITOR_INTERVAL_MS);

  process.on('SIGTERM', () => { console.log('[agent] Shutting down'); process.exit(0); });
  process.on('SIGINT',  () => { console.log('[agent] Shutting down'); process.exit(0); });
}

main().catch(e => { console.error('[agent] Fatal:', e); process.exit(1); });
