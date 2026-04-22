#!/usr/bin/env tsx
/**
 * Event-Driven Trading Handler MVP
 *
 * Reacts to WebSocket contract signals and executes trades per config.
 * No polling loop — pure event-driven architecture.
 *
 * Usage:
 *   AGENT_CONFIG_IDS=runner,scalp AGENT_PAPER=true npx tsx event_handler_mvp.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

// @ts-ignore - WebSocket default import works with tsx
import WebSocket from 'ws';
import { createStore } from './src/replay/store';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { fetchDailyPnl } from './src/agent/broker-pnl';
import { isRiskBlocked, type RiskState } from './src/core/risk-guard';
import { computeQty } from './src/core/position-sizer';
import { evaluateExit, type ExitDecision } from './src/core/trade-manager';
import { selectStrike } from './src/core/strike-selector';
import { HealthGate } from './src/agent/health-gate';
import { nowET, todayET, etTimeToUnixTs } from './src/utils/et-time';
import type { Config } from './src/config/types';
import type { OpenPosition } from './src/agent/types';
import {
  initHandlerState,
  setConnected,
  updateSpxPrice,
  setSubscriptions,
  registerConfig,
  updateConfigState,
  recordRoutingDecision,
  markStopped,
  readHandlerState,
  readPendingCommands,
  type RoutingDecision,
} from './src/agent/handler-state';

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG_IDS = process.env.AGENT_CONFIG_IDS
  ? process.env.AGENT_CONFIG_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : [process.env.AGENT_CONFIG_ID || 'default'];
const TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
const AGENT_PAPER = process.env.AGENT_PAPER === 'true';
const WS_URL = process.env.SPXER_WS_URL || 'ws://localhost:3600/ws';
const AGENT_TAG = process.env.AGENT_TAG || 'event-handler-mvp';

// Execution target (same for all configs)
const EXECUTION: Config['execution'] = {
  symbol: process.env.AGENT_SYMBOL || 'SPX',
  optionPrefix: process.env.AGENT_OPTION_PREFIX || 'SPXW',
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: TRADIER_ACCOUNT_ID,
  disableBracketOrders: false,
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConfigState {
  config: Config;
  positions: Map<string, OpenPosition>;
  lastEntryTs: number;
  dailyPnl: number;
  tradesCompleted: number;
  sessionSignalCount: number;
  // Basket member tracking (for configs that trade multiple strikes)
  basketMembers: Map<string, string>;  // positionId → basketMemberId (e.g., "itm5-1", "itm5-2", "itm5-3")
}

// ── Global State ─────────────────────────────────────────────────────────────

const configs = new Map<string, ConfigState>();
const pendingEntries = new Set<string>();  // Track in-flight position opens
let ws: WebSocket | null = null;
let healthGate = new HealthGate();
let spxPrice = 0;
let running = true;
const perConfigPaper = new Map<string, boolean>();

function syncConfigPositions(configId: string, state: ConfigState): void {
  const positions = Array.from(state.positions.values()).map(p => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    strike: p.strike,
    entryPrice: p.entryPrice,
    quantity: p.quantity,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    openedAt: p.openedAt,
    basketMember: state.basketMembers.get(p.id) || undefined,
  }));
  updateConfigState(configId, {
    positionsOpen: state.positions.size,
    tradesCompleted: state.tradesCompleted,
    sessionSignalCount: state.sessionSignalCount,
    lastEntryTs: state.lastEntryTs > 0 ? state.lastEntryTs : null,
    cooldownRemainingSec: Math.max(0, (state.config.judges.entryCooldownSec || 0) - (Date.now() / 1000 - state.lastEntryTs)),
    positions,
  });
}

/**
 * Compute the close cutoff timestamp for today (entries blocked after this time).
 */
function computeCloseCutoff(config: Config): number {
  const cutoffTime = config.risk.cutoffTimeET || '16:00';
  return etTimeToUnixTs(cutoffTime);
}

/**
 * Determine which basket member a position belongs to.
 * For non-basket configs, returns "default".
 * For basket configs, determines membership based on strike position relative to SPX.
 */
function getBasketMemberId(signal: any, state: ConfigState): string {
  const cfg = state.config;
  const targetOtm = cfg.signals.targetOtmDistance ?? 0;

  // Check if this is a basket config (name contains "basket")
  if (!cfg.id.includes('basket')) {
    return 'default';
  }

  // For basket configs, member is determined by the strike's moneyness
  // Calculate actual OTM distance from SPX price
  const spxRounded = Math.round(spxPrice / 5) * 5;  // Round to nearest 5
  const actualOtm = signal.side === 'call'
    ? (signal.strike - spxRounded) / 5  // Calls: positive = OTM
    : (spxRounded - signal.strike) / 5; // Puts: positive = OTM

  // Basket members: itm5-1, itm5-2, itm5-3 (sorted by strike)
  // Or: strike-7090, strike-7095, strike-7100 (actual strikes)

  // Use strike as member ID for clarity
  return `strike-${signal.strike}`;
}

// ── Config Loading ───────────────────────────────────────────────────────────

async function loadConfigs(): Promise<void> {
  const store = createStore();

  for (const configId of CONFIG_IDS) {
    const cfg = store.getConfig(configId);
    if (!cfg) {
      console.error(`[handler] Failed to load config: ${configId}`);
      continue;
    }

    configs.set(configId, {
      config: cfg,
      positions: new Map(),
      lastEntryTs: 0,
      dailyPnl: 0,
      tradesCompleted: 0,
      sessionSignalCount: 0,
      basketMembers: new Map(),
    });

    console.log(`[handler] Loaded config '${configId}':`);
    console.log(`  HMA: ${cfg.signals.hmaCrossFast}x${cfg.signals.hmaCrossSlow}`);
    console.log(`  TP/SL: ${cfg.position.takeProfitMultiplier}x / ${cfg.position.stopLossPercent}%`);
    console.log(`  Strike: ${cfg.strikeSelector?.strikeMode || 'otm'}`);
    console.log(`  Max pos: ${cfg.position.maxPositionsOpen}`);

    registerConfig(configId, cfg.name || configId, `${cfg.signals.hmaCrossFast}x${cfg.signals.hmaCrossSlow}`);
  }

  store.close();
}

// ── WebSocket Channel Subscription ───────────────────────────────────────────

function subscribeToChannels(): void {
  if (!ws) return;

  const subscribedPairs = new Set<string>();

  // Subscribe to HMA pairs used by configs
  for (const state of configs.values()) {
    const cfg = state.config;
    const pair = `hma_${cfg.signals.hmaCrossFast}_${cfg.signals.hmaCrossSlow}`;
    subscribedPairs.add(pair);

    ws.send(JSON.stringify({
      action: 'subscribe',
      channel: `contract_signal:${pair}`
    }));
  }

  console.log(`[handler] Subscribed to ${subscribedPairs.size} HMA pair channels:`, Array.from(subscribedPairs));
  setSubscriptions(Array.from(subscribedPairs));

  ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx_bar' }));
  ws.send(JSON.stringify({ action: 'subscribe', channel: 'hma_cross_signal' }));
}

// ── Signal Filtering ─────────────────────────────────────────────────────────

function signalMatchesConfig(signal: any, state: ConfigState): boolean {
  const cfg = state.config;

  // HMA pair filter
  if (cfg.signals.hmaCrossFast !== signal.hmaFastPeriod) {
    return false;
  }
  if (cfg.signals.hmaCrossSlow !== signal.hmaSlowPeriod) {
    return false;
  }

  // Direction filter: call/put must match signal direction
  if (signal.direction === 'bullish' && signal.side !== 'call') {
    return false;
  }
  if (signal.direction === 'bearish' && signal.side !== 'put') {
    return false;
  }

  return true;
}

// ── Contract Signal Handler (Entry) ───────────────────────────────────────────

async function handleContractSignal(signal: any): Promise<void> {
  const now = Date.now() / 1000;
  const routingDecisions: RoutingDecision['decisions'] = [];

  // Process each config independently
  const configStatesArray = Array.from(configs.entries());
  for (const [configId, state] of configStatesArray) {
    const cfg = state.config;
    const handlerState = readHandlerState();
    const configPaper = handlerState?.configs[configId]?.paper ?? AGENT_PAPER;
    const configEnabled = handlerState?.configs[configId]?.enabled ?? true;

    if (!configEnabled) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'disabled' });
      continue;
    }

    if (!signalMatchesConfig(signal, state)) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'hma_mismatch' });
      continue;
    }

    const riskState: RiskState = {
      openPositions: state.positions.size,
      tradesCompleted: state.tradesCompleted,
      dailyPnl: state.dailyPnl,
      currentTs: now,
      closeCutoffTs: computeCloseCutoff(cfg),
      lastEscalationTs: state.lastEntryTs,
      sessionSignalCount: state.sessionSignalCount,
    };

    const riskBlocked = isRiskBlocked(riskState, cfg);
    if (riskBlocked.blocked) {
      console.log(`[handler] [${configId}] Risk blocked: ${riskBlocked.reason}`);
      routingDecisions.push({ configId, action: 'skipped', reason: riskBlocked.reason || 'risk_block' });
      continue;
    }

    const health = await healthGate.check();
    if (!health.healthy) {
      console.log(`[handler] [${configId}] Health blocked: ${health.reason}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'health_block', details: health.reason });
      continue;
    }

    const nowEt = nowET();
    const [startH, startM] = cfg.timeWindows.activeStart.split(':').map(Number);
    const [endH, endM] = cfg.timeWindows.activeEnd.split(':').map(Number);
    const currentEtMin = nowEt.h * 60 + nowEt.m;
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    if (currentEtMin < startMin || currentEtMin >= endMin) {
      console.log(`[handler] [${configId}] Time blocked: outside ${cfg.timeWindows.activeStart}-${cfg.timeWindows.activeEnd}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'time_window', details: `${cfg.timeWindows.activeStart}-${cfg.timeWindows.activeEnd}` });
      continue;
    }

    const maxPositions = cfg.position.maxPositionsOpen ?? 1;
    const totalPositions = state.positions.size + pendingEntries.size;
    if (totalPositions >= maxPositions) {
      console.log(`[handler] [${configId}] Max positions gate: ${totalPositions}/${maxPositions} (open=${state.positions.size}, pending=${pendingEntries.size})`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'max_positions', details: `${totalPositions}/${maxPositions}` });
      continue;
    }

    // ── Strike Selection: validate signal strike matches config requirements ─────
    try {
      const contractsUrl = `${WS_URL.replace('ws://', 'http://')}/contracts/active`;
      const contractsResp = await fetch(contractsUrl);
      if (!contractsResp.ok) {
        console.error(`[handler] [${configId}] Failed to fetch contracts: ${contractsResp.status}`);
        continue;
      }
      const activeContracts = await contractsResp.json();

      // Build candidates from active contracts
      const candidates = activeContracts
        .filter((c: any) => {
          const expiryMatch = c.symbol.includes(signal.expiry);
          const sideMatch = signal.side === 'call'
            ? c.symbol.includes('C')
            : c.symbol.includes('P');
          return expiryMatch && sideMatch && c.last > 0;
        })
        .map((c: any) => ({
          symbol: c.symbol,
          side: signal.side as 'call' | 'put',
          strike: c.strike,
          price: c.last,
          volume: 1, // Not available in active endpoint, use default
        }));

      if (candidates.length === 0) {
        console.log(`[handler] [${configId}] No candidates for ${signal.side} ${signal.expiry}`);
        continue;
      }

      const strikeResult = selectStrike(candidates, signal.direction, spxPrice, cfg);
      if (!strikeResult) {
        console.log(`[handler] [${configId}] No suitable strike found`);
        continue;
      }

      // Only enter if signal strike matches selected strike
      if (strikeResult.candidate.strike !== signal.strike) {
        console.log(`[handler] [${configId}] Strike mismatch: signal=${signal.strike} (${signal.strike - spxPrice > 0 ? '+' : ''}${signal.strike - spxPrice}) vs selected=${strikeResult.candidate.strike} (${strikeResult.candidate.strike - spxPrice > 0 ? '+' : ''}${strikeResult.candidate.strike - spxPrice})`);
        console.log(`[handler] [${configId}] Reason: ${strikeResult.reason}`);
        continue;
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Strike selection error: ${e.message}`);
      continue;
    }

    console.log(`[handler] [${configId}] Signal matches, executing entry...`);

    // Track this entry as pending to prevent race conditions
    const pendingKey = `${configId}:${signal.symbol}`;
    pendingEntries.add(pendingKey);

    try {
      const positionSize = computeQty(signal.price, cfg, null);

      const agentSignal = {
        type: 'HMA_CROSS' as const,
        symbol: signal.symbol,
        side: (signal.direction === 'bullish' ? 'call' : 'put') as 'call' | 'put',
        strike: signal.strike,
        expiry: signal.expiry,
        currentPrice: signal.price,
        bid: signal.price * 0.98,
        ask: signal.price,
        indicators: {} as any,
        recentBars: [],
        signalBarLow: signal.price,
        spxContext: {
          price: spxPrice,
          changePercent: 0,
          trend: 'neutral' as const,
          rsi14: null,
          minutesToClose: 360,
          mode: 'rth' as const,
        },
        ts: Date.now(),
      };

      const decision = {
        action: 'buy' as const,
        confidence: 1.0,
        positionSize,
        stopLoss: signal.price * (1 - cfg.position.stopLossPercent / 100),
        takeProfit: signal.price * cfg.position.takeProfitMultiplier,
        reasoning: `Event-driven HMA(${signal.hmaFastPeriod})xHMA(${signal.hmaSlowPeriod}) signal`,
        concerns: [],
        ts: Date.now(),
      };

      const result = await openPosition(
        agentSignal,
        decision,
        configPaper,
        EXECUTION,
        0,
        configId
      );

      if (result.position.quantity > 0) {
        const posId = result.position.id;
        result.position.highWaterPrice = result.position.entryPrice;
        state.positions.set(posId, result.position);
        const basketMemberId = getBasketMemberId(signal, state);
        state.basketMembers.set(posId, basketMemberId);
        state.lastEntryTs = now;
        state.sessionSignalCount++;

        const orderId = result.execution.orderId;
        const bracketId = result.position.bracketOrderId;
        const basketInfo = basketMemberId !== 'default' ? ` [${basketMemberId}]` : '';
        console.log(`[handler] [${configId}]${basketInfo} Position opened: ${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)} | order=${orderId} bracket=${bracketId}`);

        routingDecisions.push({ configId, action: 'entered', details: `${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)}` });

        syncConfigPositions(configId, state);
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Entry failed: ${e.message}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'entry_error', details: e.message });
    } finally {
      // Always remove from pending entries
      pendingEntries.delete(pendingKey);
    }
  }

  if (routingDecisions.length > 0) {
    const etNow = nowET();
    recordRoutingDecision({
      ts: Date.now(),
      timeET: `${String(etNow.h).padStart(2, '0')}:${String(etNow.m).padStart(2, '0')}:${String(etNow.s).padStart(2, '0')}`,
      signal: {
        symbol: signal.symbol,
        strike: signal.strike,
        side: signal.side,
        direction: signal.direction,
        hmaFastPeriod: signal.hmaFastPeriod,
        hmaSlowPeriod: signal.hmaSlowPeriod,
        channel: signal.channel || `hma_${signal.hmaFastPeriod}_${signal.hmaSlowPeriod}`,
        price: signal.price,
      },
      decisions: routingDecisions,
    });
  }
}

// ── Reversal Handler (SPX HMA Cross) ───────────────────────────────────────────

async function handleReversal(event: any): Promise<void> {
  console.log(`[handler] SPX reversal: ${event.direction}`);

  // For EACH config with positions
  const configStatesArray = Array.from(configs.entries());
  for (const [configId, state] of configStatesArray) {
    if (state.positions.size === 0) continue;

    console.log(`[handler] [${configId}] Reversal: closing ${state.positions.size} position(s)`);

    // Close all positions for this config
    const positionsArray = Array.from(state.positions.entries());
    for (const [posId, position] of positionsArray) {
      try {
        const basketMemberId = state.basketMembers.get(posId) || 'default';
        // closePosition signature: (position, reason, currentPrice, paper, execCfg?)
        await closePosition(position, 'signal_reversal', position.entryPrice, perConfigPaper.get(configId) ?? AGENT_PAPER, EXECUTION);
        state.positions.delete(posId);
        state.basketMembers.delete(posId);
        console.log(`[handler] [${configId}] [${basketMemberId}] Closed ${position.symbol} x${position.quantity}`);
      } catch (e: any) {
        console.error(`[handler] [${configId}] Failed to close ${posId}:`, e.message);
      }
    }
    syncConfigPositions(configId, state);

    // Note: scannerReverse only closes positions on reversal.
    // New entries will come from fresh contract signals in the new direction.
    console.log(`[handler] [${configId}] Reversal complete. Waiting for ${event.direction} signals...`);
  }
}

// ── Exit Check Loop (scannerReverse + broker reconciliation) ─────────────────────

/**
 * Map OpenPosition to CorePosition for evaluateExit().
 * Tracks high-water price for trailing stops.
 */
interface CorePositionWithHwm {
  id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number | null;
  entryTs: number;
  highWaterPrice: number;
}

let spxHmaExitState: { direction: 'bullish' | 'bearish' | null; fresh: boolean } = { direction: null, fresh: false };

async function checkExits(): Promise<void> {
  const now = Date.now() / 1000;

  // Fetch SPX HMA exit state from data service (for scannerReverse)
  try {
    const response = await fetch(`${WS_URL.replace('ws://', 'http://')}/signal/latest`);
    if (response.ok) {
      const signalData = await response.json();
      if (signalData.signal) {
        const newDir = signalData.signal.direction;
        if (newDir !== spxHmaExitState.direction) {
          spxHmaExitState = { direction: newDir, fresh: true };
        } else {
          spxHmaExitState.fresh = false;
        }
      }
    }
  } catch (e) {
    // Ignore fetch errors — SPX signal may not be available
  }

  const configStatesArray = Array.from(configs.entries());
  for (const [configId, state] of configStatesArray) {
    const closeCutoffTs = computeCloseCutoff(state.config);
    const positionsArray = Array.from(state.positions.entries());
    const positionsToClose: Array<{ posId: string; position: OpenPosition; reason: string }> = [];

    for (const [posId, position] of positionsArray) {
      try {
        // Fetch current price from data service
        let currentPrice: number | null = null;
        try {
          const quoteUrl = `${WS_URL.replace('ws://', 'http://')}/contracts/${position.symbol}/latest`;
          const quoteResp = await fetch(quoteUrl);
          if (quoteResp.ok) {
            const bar = await quoteResp.json();
            currentPrice = bar.close || null;
          }
        } catch (e) {
          // No price data — continue with null (only time-based exits)
        }

        // Map to CorePosition for evaluateExit
        const corePos: CorePositionWithHwm = {
          id: position.id,
          symbol: position.symbol,
          side: position.side,
          strike: position.strike,
          qty: position.quantity,
          entryPrice: position.entryPrice,
          stopLoss: position.stopLoss,
          takeProfit: position.takeProfit || null,
          entryTs: position.openedAt / 1000,
          highWaterPrice: position.highWaterPrice || position.entryPrice,
        };

        // Call evaluateExit (handles TP/SL/time_exit/scannerReverse)
        const exitDecision = evaluateExit(
          corePos,
          currentPrice,
          spxHmaExitState.direction,
          spxHmaExitState.fresh,
          state.config,
          now,
          closeCutoffTs,
        );

        if (exitDecision) {
          positionsToClose.push({ posId, position, reason: exitDecision.reason });
        }
      } catch (e: any) {
        console.error(`[handler] [${configId}] Error checking exit for ${posId}:`, e.message);
      }
    }

    // Execute exits
    for (const { posId, position, reason } of positionsToClose) {
      try {
        const basketMemberId = state.basketMembers.get(posId) || 'default';
        // closePosition signature: (position, reason, currentPrice, paper, execCfg?)
        // Use entryPrice as fallback if we don't have current price
        await closePosition(position, reason, position.entryPrice, perConfigPaper.get(configId) ?? AGENT_PAPER, EXECUTION);
        state.positions.delete(posId);
        state.basketMembers.delete(posId);
        console.log(`[handler] [${configId}] [${basketMemberId}] Closed ${position.symbol} x${position.quantity} (${reason})`);
      } catch (e: any) {
        console.error(`[handler] [${configId}] Failed to close ${posId}:`, e.message);
      }
    }
    if (positionsToClose.length > 0) {
      syncConfigPositions(configId, state);
    }
  }
}

// ── P&L Sync Loop (poll broker for realized P&L) ───────────────────────────────

async function updateBrokerPnl(): Promise<void> {
  if (configs.size === 0) return;

  try {
    const brokerPnl = await fetchDailyPnl(TRADIER_ACCOUNT_ID);
    for (const [configId, state] of configs) {
      state.dailyPnl = brokerPnl.pnl;
      updateConfigState(configId, { dailyPnl: brokerPnl.pnl });
    }
  } catch (e: any) {
    console.error('[handler] Failed to fetch broker P&L:', e.message);
  }
}

// ── WebSocket Message Handler ─────────────────────────────────────────────────

function handleWebSocketMessage(data: any): void {
  if (!running) return;

  if (data.type === 'contract_signal') {
    handleContractSignal(data.data).catch(e => console.error('[handler] Error handling signal:', e));
  } else if (data.type === 'spx_bar') {
    spxPrice = data.data.close;
    updateSpxPrice(spxPrice);
  } else if (data.type === 'hma_cross_signal') {
    // SPX HMA reversal - handle scannerReverse
    handleReversal(data).catch(e => console.error('[handler] Error handling reversal:', e));
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[handler] Event-Driven Trading Handler MVP starting...');
  console.log(`[handler] Account: ${TRADIER_ACCOUNT_ID} (paper=${AGENT_PAPER})`);
  console.log(`[handler] Configs: ${CONFIG_IDS.join(', ')}`);
  console.log(`[handler] WebSocket: ${WS_URL}`);

  await loadConfigs();

  if (configs.size === 0) {
    console.error('[handler] No configs loaded, exiting');
    process.exit(1);
  }

  initHandlerState({
    paper: AGENT_PAPER,
    accountId: TRADIER_ACCOUNT_ID,
    agentTag: AGENT_TAG,
    configIds: CONFIG_IDS,
  });

  // Connect to WebSocket
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[handler] WebSocket connected');
    setConnected(true);
    subscribeToChannels();
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type) {
        handleWebSocketMessage(msg);
      }
    } catch (e) {
      console.error('[handler] Error parsing WebSocket message:', e);
    }
  });

  ws.on('error', (e) => {
    console.error('[handler] WebSocket error:', e);
  });

  ws.on('close', () => {
    console.log('[handler] WebSocket closed, reconnecting in 5s...');
    setConnected(false);
    setTimeout(() => {
      if (running) main();
    }, 5000);
  });

  setInterval(() => {
    processCommands();
  }, 5_000);

  setInterval(() => {
    updateBrokerPnl().catch(e => console.error('[handler] P&L update failed:', e));
  }, 60_000);

  setInterval(() => {
    checkExits().catch(e => console.error('[handler] Exit check failed:', e));
  }, 10_000);

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('[handler] Event loop started, waiting for signals...');
}

function gracefulShutdown(): void {
  console.log('[handler] Shutting down...');
  running = false;
  markStopped();

  if (ws) {
    ws.close();
  }

  const lockPath = `data/account-${TRADIER_ACCOUNT_ID}.lock`;
  try {
    if (require('fs').existsSync(lockPath)) {
      require('fs').unlinkSync(lockPath);
    }
  } catch (e) {}
  process.exit(0);
}

async function processCommands(): Promise<void> {
  const commands = readPendingCommands();
  if (commands.length === 0) return;

  for (const cmd of commands) {
    console.log(`[handler] Processing command: ${cmd.action}`, 'configId' in cmd ? `(${(cmd as any).configId})` : '');

    switch (cmd.action) {
      case 'toggle_paper':
        if ('configId' in cmd && configs.has((cmd as any).configId as string)) {
          perConfigPaper.set((cmd as any).configId as string, (cmd as any).paper);
          console.log(`[handler][${(cmd as any).configId}] Paper mode set to ${(cmd as any).paper}`);
        }
        break;

      case 'toggle_enabled':
        if ('configId' in cmd && configs.has((cmd as any).configId as string)) {
          const state = readHandlerState();
          if (state) {
            const cfg = state.configs[cmd.configId as string];
            if (cfg) {
              cfg.enabled = cmd.enabled;
              updateConfigState(cmd.configId, {});
            }
          }
          console.log(`[handler] [${cmd.configId}] Config ${cmd.enabled ? 'enabled' : 'disabled'}`);
        }
        break;

      case 'force_close':
        if ('configId' in cmd) {
          const cs = configs.get(cmd.configId as string);
          if (!cs) break;
          const positionsArray = Array.from(cs.positions.entries());
          for (const [posId, position] of positionsArray) {
            try {
              await closePosition(
                position,
                'manual',
                position.entryPrice,
                perConfigPaper.get(cmd.configId as string) ?? AGENT_PAPER,
                EXECUTION,
              );
              cs.positions.delete(posId);
              cs.basketMembers.delete(posId);
              console.log(`[handler] [${cmd.configId}] Force closed ${position.symbol} x${position.quantity}`);
            } catch (e: any) {
              console.error(`[handler] [${cmd.configId}] Force close failed: ${e.message}`);
            }
          }
          syncConfigPositions(cmd.configId as string, cs);
        }
        break;

      case 'shutdown':
        gracefulShutdown();
        break;

      case 'reload_config':
        if (cmd.configId) {
          await reloadConfig(cmd.configId);
        }
        break;
    }
  }
}

async function reloadConfig(configId: string): Promise<void> {
  const store = createStore();
  try {
    const cfg = store.getConfig(configId);
    if (!cfg) {
      console.error(`[handler] Reload failed: config '${configId}' not found in DB`);
      return;
    }
    configs.set(configId, {
      config: cfg,
      positions: configs.get(configId)?.positions || new Map(),
      lastEntryTs: configs.get(configId)?.lastEntryTs || 0,
      dailyPnl: configs.get(configId)?.dailyPnl || 0,
      tradesCompleted: configs.get(configId)?.tradesCompleted || 0,
      sessionSignalCount: configs.get(configId)?.sessionSignalCount || 0,
      basketMembers: configs.get(configId)?.basketMembers || new Map(),
    });
    registerConfig(configId, cfg.name || configId, `${cfg.signals.hmaCrossFast}x${cfg.signals.hmaCrossSlow}`);
    console.log(`[handler] [${configId}] Config reloaded: HMA ${cfg.signals.hmaCrossFast}x${cfg.signals.hmaCrossSlow}`);
  } finally {
    store.close();
  }
}

main().catch(e => {
  console.error('[handler] Fatal error:', e);
  process.exit(1);
});
