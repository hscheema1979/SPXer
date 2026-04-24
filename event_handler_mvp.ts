#!/usr/bin/env tsx
/**
 * Event-Driven Trading Handler — COMPLETELY INDEPENDENT
 *
 * NO spxer dependency - all data fetched directly from Tradier REST API.
 *
 * Responsibilities:
 * - Signal detection (independent - fetches from Tradier)
 * - Entry execution (OTOCO brackets)
 * - Reversal handling (SPX HMA cross detection, flips positions)
 * - Account fill tracking (AccountStream to Tradier WS)
 *
 * Position exits (TP/SL) are handled by broker OCO brackets.
 * Reversal flips are handled here via closePosition().
 */

import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { createStore } from './src/replay/store';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { fetchDailyPnl } from './src/agent/broker-pnl';
import { computeQty } from './src/core/position-sizer';
import { nowET, todayET, etTimeToUnixTs } from './src/utils/et-time';
import type { Config } from './src/config/types';
import type { OpenPosition } from './src/agent/types';
import { PositionOrderManager, type EnrichedSignal } from './src/agent/position-order-manager';
import { AccountStream } from './src/agent/account-stream';
import { initAccountDb, closeAccountDb, getAccountDb } from './src/storage/db';
import { initExecution, getExecutionMode } from './src/agent/execution-router';
import { detectHmaCrossPair, type SignalParams } from './src/pipeline/spx/signal-detector-function';
import { makeHMAState, hmaStep } from './src/pipeline/indicators/tier1';
import {
  initHandlerState,
  setConnected,
  updateSpxPrice,
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
const AGENT_TAG = process.env.AGENT_TAG || 'event-handler-mvp';

const TRADIER_BASE = 'https://api.tradier.com';

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
  dailyPnl: number;
}

function getTradierToken(): string {
  const token = process.env.TRADIER_TOKEN;
  if (!token) {
    throw new Error('TRADIER_TOKEN not set in environment');
  }
  return token;
}

// ── Global State ─────────────────────────────────────────────────────────────

const configs = new Map<string, ConfigState>();
let manager: PositionOrderManager;
let spxPrice = 0;
let running = true;
let killSwitch = false;
const perConfigPaper = new Map<string, boolean>();

let orderMutex = false;

// SPX HMA state for reversal detection
const spxHma3State = makeHMAState(3);
const spxHma12State = makeHMAState(12);
let spxHmaDirection: 'bullish' | 'bearish' | null = null;

// ── SPX HMA Reversal Detection (Independent) ────────────────────────────────────

async function checkSpxReversal(): Promise<void> {
  try {
    const resp = await axios.get(`${TRADIER_BASE}/v1/markets/timesales`, {
      params: {
        symbol: 'SPX',
        interval: '1min',
        session_filter: 'all',
      },
      headers: {
        'Authorization': `Bearer ${getTradierToken()}`,
        'Accept': 'application/json'
      },
    });

    const bars = resp.data?.series?.data || [];
    if (bars.length < 12) {
      return; // Not enough data for HMA
    }

    // Compute HMA(3) and HMA(12) from SPX bars
    const hma3Vals: number[] = [];
    const hma12Vals: number[] = [];

    for (const bar of bars) {
      const h3 = hmaStep(spxHma3State, bar.close);
      const h12 = hmaStep(spxHma12State, bar.close);
      if (h3 !== null) hma3Vals.push(h3);
      if (h12 !== null) hma12Vals.push(h12);
    }

    if (hma3Vals.length < 2 || hma12Vals.length < 2) {
      return;
    }

    const currHma3 = hma3Vals[hma3Vals.length - 1];
    const currHma12 = hma12Vals[hma12Vals.length - 1];
    const currDirection = currHma3 > currHma12 ? 'bullish' : 'bearish';

    // Update SPX price
    spxPrice = bars[bars.length - 1].close;
    updateSpxPrice(spxPrice);

    // Check for reversal
    if (currDirection !== spxHmaDirection) {
      const prevDirection = spxHmaDirection;
      spxHmaDirection = currDirection;
      console.log(`[handler] 🔄 SPX HMA reversal: ${currDirection.toUpperCase()} (HMA3=${currHma3.toFixed(2)}, HMA12=${currHma12.toFixed(2)})`);

      // Trigger reversal handling (closes all positions)
      await handleReversal({ direction: currDirection, previousDirection: prevDirection });
    }
  } catch (e) {
    console.error('[handler] Failed to check SPX reversal:', e);
  }
}

// ── Reversal Handler (closes all positions on SPX HMA cross) ────────────────

async function handleReversal(event: any): Promise<void> {
  console.log(`[handler] 🔄 REVERSAL: ${event.direction.toUpperCase()} - closing all positions`);

  for (const [configId, state] of Array.from(configs.entries())) {
    const positions = manager.getOpenPositions(configId).filter(p => p.status === 'OPEN');
    if (positions.length === 0) continue;

    console.log(`[handler] [${configId}] Reversal: closing ${positions.length} position(s)`);

    for (const pos of positions) {
      try {
        const openPos: OpenPosition = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          strike: pos.strike,
          expiry: todayET(),
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          highWaterPrice: pos.highWater,
          openedAt: pos.openedAt * 1000,
          bracketOrderId: null,
        };

        // closePosition will cancel OCO legs in pre-flight check
        await closePosition(openPos, 'signal_reversal', pos.entryPrice, perConfigPaper.get(configId) ?? AGENT_PAPER, EXECUTION);
        console.log(`[handler] [${configId}] [${pos.basketMember}] Closed ${pos.symbol} x${pos.quantity}`);
      } catch (e: any) {
        console.error(`[handler] [${configId}] Failed to close ${pos.id}:`, e.message);
      }
    }
    syncConfigPositions(configId, state);

    console.log(`[handler] [${configId}] Reversal complete. Waiting for ${event.direction} signals...`);
  }
}

// ── Signal Handler (contract HMA cross → entry) ───────────────────────────────

async function handleContractSignal(signal: any): Promise<void> {
  if (killSwitch) return;

  const expectedTf = Array.from(configs.values())[0]?.config?.signals?.signalTimeframe || '1m';
  if (signal.timeframe && signal.timeframe !== expectedTf) return;

  if (signal.timestamp) {
    const signalAgeMs = Date.now() - signal.timestamp;
    if (signalAgeMs > 30_000) return;
  }

  const cfg0 = Array.from(configs.values())[0]?.config;
  const targetDist = cfg0?.signals?.targetOtmDistance ?? cfg0?.strikeSelector?.atmOffset ?? 0;
  const strikeInterval = EXECUTION.strikeInterval || 5;
  if (spxPrice > 0 && signal.strike) {
    const spxRounded = Math.round(spxPrice / strikeInterval) * strikeInterval;
    const targetCallStrike = spxRounded + targetDist;
    const targetPutStrike = spxRounded - targetDist;
    const target = signal.side === 'call' ? targetCallStrike : targetPutStrike;
    if (Math.abs(signal.strike - target) > strikeInterval) return;
  }

  const now = Date.now() / 1000;
  const routingDecisions: RoutingDecision['decisions'] = [];

  const enriched: EnrichedSignal = {
    symbol: signal.symbol,
    strike: signal.strike,
    expiry: signal.expiry,
    side: signal.side,
    direction: signal.direction,
    price: signal.price,
    hmaFastPeriod: signal.hmaFastPeriod || signal.hmaFast,
    hmaSlowPeriod: signal.hmaSlowPeriod || signal.hmaSlow,
    channel: signal.channel || `${signal.hmaFastPeriod || signal.hmaFast}_${signal.hmaSlowPeriod || signal.hmaSlow}`,
    receivedTs: now,
  };

  for (const [configId, state] of Array.from(configs.entries())) {
    const cfg = state.config;
    const handlerState = readHandlerState();
    const configEnabled = handlerState?.configs[configId]?.enabled ?? true;

    if (!configEnabled) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'disabled' });
      continue;
    }

    const hmaFast = signal.hmaFastPeriod || signal.hmaFast;
    const hmaSlow = signal.hmaSlowPeriod || signal.hmaSlow;
    if (cfg.signals.hmaCrossFast !== hmaFast || cfg.signals.hmaCrossSlow !== hmaSlow) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'hma_mismatch' });
      continue;
    }

    const decision = manager.evaluate(enriched, configId, cfg);

    if (decision.action === 'skip') {
      routingDecisions.push({ configId, action: 'skipped', reason: decision.reason });
      continue;
    }

    if (orderMutex) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'order_in_progress' });
      continue;
    }

    if (decision.action === 'flip') {
      const existingPos = decision.position;
      orderMutex = true;
      try {
        const openPos: OpenPosition = {
          id: existingPos.id,
          symbol: existingPos.symbol,
          side: existingPos.side,
          strike: existingPos.strike,
          expiry: existingPos.expiry || todayET(),
          entryPrice: existingPos.entryPrice,
          quantity: existingPos.quantity,
          stopLoss: existingPos.stopLoss,
          takeProfit: existingPos.takeProfit,
          highWaterPrice: existingPos.highWater,
          openedAt: existingPos.openedAt * 1000,
          bracketOrderId: null,
        };
        await closePosition(openPos, 'signal_reversal', existingPos.entryPrice, perConfigPaper.get(configId) ?? AGENT_PAPER, EXECUTION);
        console.log(`[handler] [${configId}] Flipped ${existingPos.symbol} (${existingPos.side} → ${signal.side})`);
      } catch (e: any) {
        console.error(`[handler] [${configId}] Flip close failed: ${e.message}`);
        routingDecisions.push({ configId, action: 'skipped', reason: 'flip_error', details: e.message });
        continue;
      } finally {
        orderMutex = false;
      }
    }

    console.log(`[handler] [${configId}] Signal accepted, executing entry...`);

    orderMutex = true;
    try {
      const positionSize = computeQty(signal.price, cfg, null);

      const agentSignal = {
        type: 'HMA_CROSS' as const,
        symbol: signal.symbol,
        side: signal.side as 'call' | 'put',
        strike: signal.strike,
        expiry: signal.expiry,
        currentPrice: signal.price,
        bid: signal.bid ?? signal.price * 0.98,   // Use real bid from quote, fallback to synthetic
        ask: signal.ask ?? signal.price,           // Use real ask from quote, fallback to price
        indicators: {} as any,
        recentBars: [],
        signalBarLow: signal.price,
        spxContext: {
          price: spxPrice,
          changePercent: 0,
          trend: (spxHmaDirection || 'neutral') as 'bullish' | 'bearish' | 'neutral',
          rsi14: null,
          minutesToClose: 360,
          mode: 'rth' as const,
        },
        ts: Date.now(),
      };

      const tradeDecision = {
        action: 'buy' as const,
        confidence: 1.0,
        positionSize,
        stopLoss: signal.price * (1 - cfg.position.stopLossPercent / 100),
        takeProfit: signal.price * (1 + cfg.position.stopLossPercent / 100 * cfg.position.takeProfitMultiplier),
        reasoning: `Event-driven HMA(${signal.hmaFastPeriod || signal.hmaFast})xHMA(${signal.hmaSlowPeriod || signal.hmaSlow}) signal`,
        concerns: [],
        ts: Date.now(),
      };

      const configPaper = perConfigPaper.get(configId) ?? AGENT_PAPER;
      const result = await openPosition(agentSignal, tradeDecision, configPaper, EXECUTION, 0, configId);

      if (result.position.quantity > 0) {
        const basketMember = cfg.id.includes('basket') ? `strike-${signal.strike}` : 'default';
        const positionId = manager.openPosition(enriched, configId, cfg, result.position.quantity, basketMember);

        const orderId = result.execution.orderId;
        const bracketId = result.position.bracketOrderId;
        console.log(`[handler] [${configId}] Position opened: ${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)} | order=${orderId} bracket=${bracketId}`);

        if (bracketId || orderId) {
          try {
            const db = getAccountDb();
            const updated = db.prepare(`
              UPDATE orders SET tradier_id = ?, bracket_id = ?, tp_leg_id = ?, sl_leg_id = ?, status = 'SUBMITTED'
              WHERE position_id = ?
            `).run(orderId || null, bracketId || null, result.position.tpLegId || null, result.position.slLegId || null, positionId);
            console.log(`[handler] Bracket IDs persisted: tradier=${orderId} bracket=${bracketId} tp=${result.position.tpLegId} sl=${result.position.slLegId} rows=${updated.changes}`);
          } catch (e: any) {
            console.error(`[handler] Failed to persist bracket IDs: ${e.message}`);
          }
        }

        routingDecisions.push({ configId, action: 'entered', details: `${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)}` });
        syncConfigPositions(configId, state);
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Entry failed: ${e.message}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'entry_error', details: e.message });
    } finally {
      orderMutex = false;
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
        hmaFastPeriod: signal.hmaFastPeriod || signal.hmaFast,
        hmaSlowPeriod: signal.hmaSlowPeriod || signal.hmaSlow,
        channel: signal.channel || `${signal.hmaFastPeriod || signal.hmaFast}_${signal.hmaSlowPeriod || signal.hmaSlow}`,
        price: signal.price,
      },
      decisions: routingDecisions,
    });
  }
}

function syncConfigPositions(configId: string, state: ConfigState): void {
  const positions = manager.getOpenPositions(configId).map(p => ({
    id: p.id,
    symbol: p.symbol,
    side: p.side,
    strike: p.strike,
    entryPrice: p.entryPrice,
    quantity: p.quantity,
    stopLoss: p.stopLoss,
    takeProfit: p.takeProfit,
    openedAt: p.openedAt,
    basketMember: p.basketMember,
  }));
  const dbState = manager.getConfigState(configId);
  updateConfigState(configId, {
    positionsOpen: positions.length,
    tradesCompleted: dbState.tradesCompleted,
    sessionSignalCount: dbState.sessionSignalCount,
    lastEntryTs: dbState.lastEntryTs > 0 ? dbState.lastEntryTs : null,
    cooldownRemainingSec: Math.max(0, (state.config.judges.entryCooldownSec || 0) - (Date.now() / 1000 - dbState.lastEntryTs)),
    positions,
  });
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
      dailyPnl: 0,
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

// ── Signal Detection (independent - fetches from Tradier) ───────────────────────

async function checkForSignals(): Promise<void> {
  if (configs.size === 0) return;

  // Fetch SPX price first
  try {
    const spxResp = await axios.get(`${TRADIER_BASE}/v1/markets/quotes`, {
      params: { symbols: 'SPX' },
      headers: {
        'Authorization': `Bearer ${getTradierToken()}`,
        'Accept': 'application/json'
      },
    });
    spxPrice = spxResp.data?.quotes?.quote?.last || spxPrice;
    updateSpxPrice(spxPrice);
  } catch (e) {
    console.error('[handler] Failed to fetch SPX price:', e);
  }

  for (const [configId, state] of Array.from(configs.entries())) {
    const cfg = state.config;

    // Build signal params from config
    const params: Omit<SignalParams, 'side'> = {
      fast: cfg.signals.hmaCrossFast,
      slow: cfg.signals.hmaCrossSlow,
      strikeOffset: -5,  // ITM5 for calls
      timeframe: parseInt(cfg.signals.signalTimeframe.replace(/\D/g, '')) || 3,
    };

    try {
      const results = await detectHmaCrossPair(params);

      // Check call and put for crosses
      for (const [side, result] of [['call', results.call], ['put', results.put]] as const) {
        if (result.cross && result.direction) {
          console.log(`[handler] [${configId}] ${side.toUpperCase()} SIGNAL: ${result.direction.toUpperCase()} at ${result.barTime}`);

          // Create signal object matching contract_signal format
          const signal = {
            symbol: result.symbol,
            strike: result.strike,
            side: side as 'call' | 'put',
            direction: result.direction,
            hmaFast: params.fast,
            hmaSlow: params.slow,
            price: result.price,
            timeframe: cfg.signals.signalTimeframe,
            timestamp: Date.now(),
            expiry: todayET(),  // CRITICAL: Set expiry to today's date
            bid: result.bid,    // Real bid from option quote
            ask: result.ask,    // Real ask from option quote
          };

          await handleContractSignal(signal);
        }
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Signal detection failed:`, e.message);
    }
  }
}

// ── P&L Sync Loop (poll broker for realized P&L) ───────────────────────────────

async function updateBrokerPnl(): Promise<void> {
  if (configs.size === 0) return;

  try {
    const brokerPnl = await fetchDailyPnl(TRADIER_ACCOUNT_ID);
    for (const [configId, state] of Array.from(configs.entries())) {
      state.dailyPnl = brokerPnl.pnl;
      manager.setConfigState(configId, { dailyPnl: brokerPnl.pnl });
      updateConfigState(configId, { dailyPnl: brokerPnl.pnl });
    }
  } catch (e: any) {
    console.error('[handler] Failed to fetch broker P&L:', e.message);
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[handler] Event-Driven Trading Handler starting...');
  console.log(`[handler] Account: ${TRADIER_ACCOUNT_ID} (paper=${AGENT_PAPER})`);
  console.log(`[handler] Configs: ${CONFIG_IDS.join(', ')}`);
  console.log('[handler] INDEPENDENT MODE: No spxer dependency - all data from Tradier REST API');

  // Initialize execution router
  initExecution();
  const execMode = getExecutionMode();
  console.log(`[handler] Execution mode: ${execMode}`);

  initAccountDb();

  const accountStream = new AccountStream();
  manager = new PositionOrderManager(accountStream);
  manager.start();

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

  setConnected(true); // Independent mode, always "connected"

  // ── Startup Reconciliation ───────────────────────────────────────────────
  // 1. Fetch positions from broker and adopt any orphans
  // 2. Validate existing positions against current market regime
  console.log('[handler] Running startup reconciliation...');
  for (const [configId, state] of Array.from(configs.entries())) {
    try {
      // Fetch positions from Tradier broker
      const resp = await axios.get(`${TRADIER_BASE}/accounts/${TRADIER_ACCOUNT_ID}/positions`, {
        headers: { 'Authorization': `Bearer ${getTradierToken()}`, 'Accept': 'application/json' }
      });

      const brokerPositionsRaw = resp.data?.positions?.position;
      const brokerPositions = Array.isArray(brokerPositionsRaw) ? brokerPositionsRaw : (brokerPositionsRaw ? [brokerPositionsRaw] : []);

      // Transform to our format
      const normalizedPositions = brokerPositions
        .filter((p: any) => p.quantity !== 0)
        .map((p: any) => ({
          symbol: p.symbol,
          side: p.symbol.includes('C') ? 'call' as const : 'put' as const,
          strike: parseFloat(p.strike),
          expiry: p.expiration_date, // Tradier format: YYYY-MM-DD
          quantity: Math.abs(p.quantity),
          entryPrice: parseFloat(p.avg_open_price || 0),
        }));

      const adopted = manager.reconcileFromBroker(configId, state.config, normalizedPositions);
      if (adopted.length > 0) {
        console.log(`[handler] [${configId}] Adopted ${adopted.length} orphaned position(s) from broker: ${adopted.join(', ')}`);
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Startup reconciliation failed:`, e.message);
    }
  }

  // ── Regime Validation (Critical Safety Check) ────────────────────────────────
  // After adopting orphans, validate that all OPEN positions align with current market regime
  console.log('[handler] Validating position alignment with current SPX HMA regime...');
  await checkSpxReversal(); // This will close any positions that oppose current regime
  console.log('[handler] Startup regime validation complete');

  // Command processing
  setInterval(() => {
    processCommands();
  }, 5_000);

  // P&L sync (every 60s)
  setInterval(() => {
    updateBrokerPnl().catch(e => console.error('[handler] P&L update failed:', e));
  }, 60_000);

  // Cleanup stale opening positions
  setInterval(() => {
    manager.cleanupStaleOpening();
  }, 5_000);

  // ── Startup Delay ─────────────────────────────────────────────────────────
  // Wait 5 seconds for AccountStream to connect and process initial fills
  // before starting signal detection. This prevents race conditions during restart.
  console.log('[handler] Waiting 5s for AccountStream to stabilize before signal detection...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  // Signal detection: check at :00 seconds of every minute
  setInterval(() => {
    const now = new Date();
    if (now.getSeconds() === 0) {
      checkForSignals().catch(e => console.error('[handler] Signal check failed:', e));
    }
  }, 1000);

  // SPX reversal detection: check at :00 seconds too (same time as signal detection)
  setInterval(() => {
    const now = new Date();
    if (now.getSeconds() === 0) {
      checkSpxReversal().catch(e => console.error('[handler] Reversal check failed:', e));
    }
  }, 1000);

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  console.log('[handler] Event loop started - completely independent of spxer');
}

function gracefulShutdown(): void {
  console.log('[handler] Shutting down...');
  running = false;
  markStopped();

  manager.stop();
  closeAccountDb();

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
          const positions = manager.getOpenPositions(cmd.configId as string).filter(p => p.status === 'OPEN');
          for (const pos of positions) {
            try {
              const openPos: OpenPosition = {
                id: pos.id,
                symbol: pos.symbol,
                side: pos.side,
                strike: pos.strike,
                expiry: pos.expiry || todayET(),
                entryPrice: pos.entryPrice,
                quantity: pos.quantity,
                stopLoss: pos.stopLoss,
                takeProfit: pos.takeProfit,
                highWaterPrice: pos.highWater,
                openedAt: pos.openedAt * 1000,
                bracketOrderId: null,
              };
              await closePosition(
                openPos,
                'manual',
                pos.entryPrice,
                perConfigPaper.get(cmd.configId as string) ?? AGENT_PAPER,
                EXECUTION,
              );
              console.log(`[handler] [${cmd.configId}] Force closed ${pos.symbol} x${pos.quantity}`);
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
      dailyPnl: configs.get(configId)?.dailyPnl || 0,
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
