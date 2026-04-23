#!/usr/bin/env tsx

import * as dotenv from 'dotenv';
dotenv.config();

import WebSocket from 'ws';
import { createStore } from './src/replay/store';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { fetchDailyPnl } from './src/agent/broker-pnl';
import { computeQty } from './src/core/position-sizer';
import { evaluateExit } from './src/core/trade-manager';
import { HealthGate } from './src/agent/health-gate';
import { nowET, todayET, etTimeToUnixTs } from './src/utils/et-time';
import type { Config } from './src/config/types';
import type { OpenPosition } from './src/agent/types';
import { PositionOrderManager, type EnrichedSignal } from './src/agent/position-order-manager';
import { AccountStream } from './src/agent/account-stream';
import { initAccountDb, closeAccountDb } from './src/storage/db';
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

// ── Global State ─────────────────────────────────────────────────────────────

const configs = new Map<string, ConfigState>();
let manager: PositionOrderManager;
let ws: WebSocket | null = null;
let healthGate = new HealthGate();
let spxPrice = 0;
let running = true;
const perConfigPaper = new Map<string, boolean>();

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

function computeCloseCutoff(config: Config): number {
  const cutoffTime = config.risk.cutoffTimeET || '16:00';
  return etTimeToUnixTs(cutoffTime);
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

// ── WebSocket Channel Subscription ───────────────────────────────────────────

function subscribeToChannels(): void {
  if (!ws) return;

  const subscribedChannels = new Set<string>();

  for (const state of configs.values()) {
    const cfg = state.config;
    const fast = cfg.signals.hmaCrossFast;
    const slow = cfg.signals.hmaCrossSlow;
    const pair = `${fast}_${slow}`;

    const channel = `contract_signal:${pair}`;
    subscribedChannels.add(channel);

    ws.send(JSON.stringify({
      action: 'subscribe',
      channel,
    }));
  }

  console.log(`[handler] Subscribed to ${subscribedChannels.size} HMA pair channels`);
  setSubscriptions(Array.from(subscribedChannels));

  ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx_bar' }));
  ws.send(JSON.stringify({ action: 'subscribe', channel: 'hma_cross_signal' }));
}

// ── Contract Signal Handler (Entry) ───────────────────────────────────────────

async function handleContractSignal(signal: any): Promise<void> {
  const now = Date.now() / 1000;
  const routingDecisions: RoutingDecision['decisions'] = [];

  const enriched: EnrichedSignal = {
    symbol: signal.symbol,
    strike: signal.strike,
    expiry: signal.expiry,
    side: signal.side,
    direction: signal.direction,
    price: signal.price,
    hmaFastPeriod: signal.hmaFastPeriod,
    hmaSlowPeriod: signal.hmaSlowPeriod,
    channel: signal.channel || `${signal.hmaFastPeriod}_${signal.hmaSlowPeriod}`,
    receivedTs: now,
  };

  for (const [configId, state] of configs) {
    const cfg = state.config;
    const handlerState = readHandlerState();
    const configEnabled = handlerState?.configs[configId]?.enabled ?? true;

    if (!configEnabled) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'disabled' });
      continue;
    }

    if (cfg.signals.hmaCrossFast !== signal.hmaFastPeriod || cfg.signals.hmaCrossSlow !== signal.hmaSlowPeriod) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'hma_mismatch' });
      continue;
    }

    const health = await healthGate.check();
    if (!health.healthy) {
      routingDecisions.push({ configId, action: 'skipped', reason: 'health_block', details: health.reason });
      continue;
    }

    const decision = manager.evaluate(enriched, configId, cfg);

    if (decision.action === 'skip') {
      routingDecisions.push({ configId, action: 'skipped', reason: decision.reason });
      continue;
    }

    if (decision.action === 'flip') {
      const existingPos = decision.position;
      try {
        const openPos: OpenPosition = {
          id: existingPos.id,
          symbol: existingPos.symbol,
          side: existingPos.side,
          strike: existingPos.strike,
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
      }
    }

    console.log(`[handler] [${configId}] Signal accepted, executing entry...`);

    try {
      const positionSize = computeQty(signal.price, cfg, null);

      const agentSignal = {
        type: 'HMA_CROSS' as const,
        symbol: signal.symbol,
        side: signal.side as 'call' | 'put',
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

      const tradeDecision = {
        action: 'buy' as const,
        confidence: 1.0,
        positionSize,
        stopLoss: signal.price * (1 - cfg.position.stopLossPercent / 100),
        takeProfit: signal.price * (1 + cfg.position.stopLossPercent / 100 * cfg.position.takeProfitMultiplier),
        reasoning: `Event-driven HMA(${signal.hmaFastPeriod})xHMA(${signal.hmaSlowPeriod}) signal`,
        concerns: [],
        ts: Date.now(),
      };

      const configPaper = perConfigPaper.get(configId) ?? AGENT_PAPER;
      const result = await openPosition(agentSignal, tradeDecision, configPaper, EXECUTION, 0, configId);

      if (result.position.quantity > 0) {
        const basketMember = cfg.id.includes('basket') ? `strike-${signal.strike}` : 'default';
        manager.openPosition(enriched, configId, cfg, result.position.quantity, basketMember);

        const orderId = result.execution.orderId;
        const bracketId = result.position.bracketOrderId;
        console.log(`[handler] [${configId}] Position opened: ${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)} | order=${orderId} bracket=${bracketId}`);

        routingDecisions.push({ configId, action: 'entered', details: `${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)}` });
        syncConfigPositions(configId, state);
      }
    } catch (e: any) {
      console.error(`[handler] [${configId}] Entry failed: ${e.message}`);
      routingDecisions.push({ configId, action: 'skipped', reason: 'entry_error', details: e.message });
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
        channel: signal.channel || `${signal.hmaFastPeriod}_${signal.hmaSlowPeriod}`,
        price: signal.price,
      },
      decisions: routingDecisions,
    });
  }
}

// ── Reversal Handler (SPX HMA Cross) ───────────────────────────────────────────

async function handleReversal(event: any): Promise<void> {
  console.log(`[handler] SPX reversal: ${event.direction}`);

  for (const [configId, state] of configs) {
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
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          highWaterPrice: pos.highWater,
          openedAt: pos.openedAt * 1000,
          bracketOrderId: null,
        };
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

// ── Exit Check Loop (scannerReverse + broker reconciliation) ─────────────────────

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
  } catch (e) {}

  for (const [configId, state] of configs) {
    const closeCutoffTs = computeCloseCutoff(state.config);
    const positions = manager.getOpenPositions(configId).filter(p => p.status === 'OPEN');
    const positionsToClose: Array<{ pos: typeof positions[0]; reason: string }> = [];

    for (const pos of positions) {
      try {
        let currentPrice: number | null = null;
        try {
          const quoteUrl = `${WS_URL.replace('ws://', 'http://')}/contracts/${pos.symbol}/latest`;
          const quoteResp = await fetch(quoteUrl);
          if (quoteResp.ok) {
            const bar = await quoteResp.json();
            currentPrice = bar.close || null;
          }
        } catch (e) {}

        const corePos: CorePositionWithHwm = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          strike: pos.strike,
          qty: pos.quantity,
          entryPrice: pos.entryPrice,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          entryTs: pos.openedAt,
          highWaterPrice: pos.highWater,
        };

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
          positionsToClose.push({ pos, reason: exitDecision.reason });
        }
      } catch (e: any) {
        console.error(`[handler] [${configId}] Error checking exit for ${pos.id}:`, e.message);
      }
    }

    for (const { pos, reason } of positionsToClose) {
      try {
        const openPos: OpenPosition = {
          id: pos.id,
          symbol: pos.symbol,
          side: pos.side,
          strike: pos.strike,
          entryPrice: pos.entryPrice,
          quantity: pos.quantity,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          highWaterPrice: pos.highWater,
          openedAt: pos.openedAt * 1000,
          bracketOrderId: null,
        };
        await closePosition(openPos, reason, pos.entryPrice, perConfigPaper.get(configId) ?? AGENT_PAPER, EXECUTION);
        console.log(`[handler] [${configId}] [${pos.basketMember}] Closed ${pos.symbol} x${pos.quantity} (${reason})`);
      } catch (e: any) {
        console.error(`[handler] [${configId}] Failed to close ${pos.id}:`, e.message);
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
      manager.setConfigState(configId, { dailyPnl: brokerPnl.pnl });
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
    handleReversal(data).catch(e => console.error('[handler] Error handling reversal:', e));
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[handler] Event-Driven Trading Handler starting...');
  console.log(`[handler] Account: ${TRADIER_ACCOUNT_ID} (paper=${AGENT_PAPER})`);
  console.log(`[handler] Configs: ${CONFIG_IDS.join(', ')}`);
  console.log(`[handler] WebSocket: ${WS_URL}`);

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

  manager.stop();
  closeAccountDb();

  if (ws) {
    ws.close();
  }

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
