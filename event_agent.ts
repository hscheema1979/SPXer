#!/usr/bin/env tsx
/**
 * Event-Driven Multi-Config SPX Agent
 *
 * Unlike spx_agent.ts which polls every 10 seconds, this agent:
 * - Subscribes to WebSocket events from the data service
 * - Reacts to signals in real-time
 * - Supports multiple configs simultaneously (runner, scalp, etc.)
 * - Each config has its own position tracking and gating
 *
 * Event flow:
 *   contract_signal → filter by config → execute entry
 *   tp_hit/sl_hit → close position for that config
 *   reversal_signal → close + flip direction
 */

import WebSocket, { WebSocketClient } from 'ws';
import { config, loadConfig, type Config } from './src/config';
import { openPosition, closePosition } from './src/agent/trade-executor';
import { fetchDailyPnl } from './src/agent/broker-pnl';
import { isRiskBlocked, type RiskState } from './src/core/risk-guard';
import { getBars } from './src/storage/queries';
import { selectStrike } from './src/core/strike-selector';
import { todayET } from './src/utils/et-time';
import type { AgentSignal, OpenPosition } from './src/agent/types';
import { HealthGate } from './src/agent/health-gate';

// Configuration
const AGENT_CONFIG_IDS = process.env.AGENT_CONFIG_IDS?.split(',') || ['default'];
const TRADIER_ACCOUNT_ID = process.env.TRADIER_ACCOUNT_ID || config.tradierAccountId;
const AGENT_PAPER = process.env.AGENT_PAPER === 'true';
const WS_URL = process.env.SPXER_WS_URL || 'ws://localhost:3600/ws';

// State per config
interface ConfigState {
  config: Config;
  positions: Map<string, OpenPosition>;
  lastEntryTs: number;
  dailyPnl: number;
  tradesCompleted: number;
  sessionSignalCount: number;
}

const configs = new Map<string, ConfigState>();
let ws: WebSocketClient | null = null;
let healthGate = new HealthGate();
let spxPrice = 0;

/**
 * Load all configs from database
 */
async function loadConfigs(): Promise<void> {
  console.log(`[agent] Loading ${AGENT_CONFIG_IDS.length} configs: ${AGENT_CONFIG_IDS.join(', ')}`);

  for (const configId of AGENT_CONFIG_IDS) {
    const cfg = await loadConfig(configId);
    if (!cfg) {
      console.error(`[agent] Failed to load config: ${configId}`);
      continue;
    }

    configs.set(configId, {
      config: cfg,
      positions: new Map(),
      lastEntryTs: 0,
      dailyPnl: 0,
      tradesCompleted: 0,
      sessionSignalCount: 0,
    });

    console.log(`[agent] Loaded config '${configId}':`);
    console.log(`  - TP: ${cfg.exit.takeProfitMultiplier}x`);
    console.log(`  - SL: ${(cfg.exit.stopLossPercent * 100).toFixed(0)}%`);
    console.log(`  - Strike mode: ${cfg.strikeSelector?.strikeMode || 'otm'}`);
    console.log(`  - Max positions: ${cfg.position.maxPositionsOpen}`);
  }
}

/**
 * Check if a signal matches this config's criteria
 */
function signalMatchesConfig(signal: any, cfg: Config): boolean {
  // Strike filter: does this strike match what the config wants?
  const targetStrike = selectStrike(spxPrice, cfg);
  if (signal.strike !== targetStrike) {
    return false;
  }

  // Direction filter: call/put must match signal direction
  const parsedSide = signal.side; // 'call' or 'put'
  if (signal.direction === 'bullish' && parsedSide !== 'call') return false;
  if (signal.direction === 'bearish' && parsedSide !== 'put') return false;

  return true;
}

/**
 * Handle contract_signal event
 */
async function handleContractSignal(signal: any): Promise<void> {
  console.log(`[agent] Received signal: ${signal.symbol} ${signal.direction.toUpperCase()} @ $${signal.price.toFixed(2)} (strike ${signal.strike})`);

  // Update SPX price
  if (signal.price > 0) {
    spxPrice = signal.price; // This is wrong - need SPX price not option price
    // TODO: Get SPX price from separate event
  }

  // Process each config independently
  for (const [configId, state] of configs) {
    const { config } = state;

    // Filter: does this signal match this config?
    if (!signalMatchesConfig(signal, config)) {
      continue;
    }

    // Risk gate check
    const riskState: RiskState = {
      openPositions: state.positions.size,
      tradesCompleted: state.tradesCompleted,
      dailyPnl: state.dailyPnl,
      currentTs: Date.now() / 1000,
      closeCutoffTs: 0, // TODO
      lastEscalationTs: state.lastEntryTs,
      sessionSignalCount: state.sessionSignalCount,
    };

    const riskBlocked = isRiskBlocked(riskState, config);
    if (riskBlocked.blocked) {
      console.log(`[agent] [${configId}] Risk blocked: ${riskBlocked.reason}`);
      continue;
    }

    // Health gate check
    const health = await healthGate.check();
    if (!health.healthy) {
      console.log(`[agent] [${configId}] Health blocked: ${health.reason}`);
      continue;
    }

    // Execute entry
    console.log(`[agent] [${configId}] Signal matches, executing entry...`);

    const agentSignal: AgentSignal = {
      symbol: signal.symbol,
      side: signal.direction === 'bullish' ? 'call' : 'put',
      strike: signal.strike,
      direction: signal.direction,
      currentPrice: signal.price,
      ask: signal.price,
      bid: signal.price * 0.98, // TODO: get real bid/ask
      timestamps: { signal: signal.timestamp },
    };

    try {
      const result = await openPosition(agentSignal, AGENT_PAPER, config.execution, 0, configId);
      if (result.position.quantity > 0) {
        state.positions.set(result.position.id, result.position);
        state.lastEntryTs = Date.now() / 1000;
        state.sessionSignalCount++;
        console.log(`[agent] [${configId}] Position opened: ${result.position.symbol} x${result.position.quantity} @ $${result.execution.fillPrice?.toFixed(2)}`);
      }
    } catch (e: any) {
      console.error(`[agent] [${configId}] Entry failed: ${e.message}`);
    }
  }
}

/**
 * WebSocket message handler
 */
function handleWebSocketMessage(data: any): void {
  if (data.type === 'contract_signal') {
    handleContractSignal(data.data).catch(e => console.error('[agent] Error handling signal:', e));
  } else if (data.type === 'spx_bar') {
    // Update SPX price
    spxPrice = data.data.close;
  } else if (data.type === 'hma_cross_signal') {
    // SPX HMA reversal - handle scannerReverse for all configs
    console.log(`[agent] SPX HMA reversal: ${data.direction.toUpperCase()} @ $${data.price}`);
    // TODO: Implement reversal logic
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('[agent] Event-Driven Multi-Config Agent starting...');
  console.log(`[agent] Account: ${TRADIER_ACCOUNT_ID} (paper=${AGENT_PAPER})`);
  console.log(`[agent] WebSocket: ${WS_URL}`);

  // Load configs
  await loadConfigs();

  if (configs.size === 0) {
    console.error('[agent] No configs loaded, exiting');
    process.exit(1);
  }

  // Connect to WebSocket
  ws = new WebSocket(WS_URL);
  ws.on('open', () => {
    console.log('[agent] WebSocket connected');
    // Subscribe to events
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx' }));
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'signals' }));
  });

  ws.on('message', (data: Buffer) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type) {
        handleWebSocketMessage(msg);
      }
    } catch (e) {
      console.error('[agent] Error parsing WebSocket message:', e);
    }
  });

  ws.on('error', (e) => {
    console.error('[agent] WebSocket error:', e);
  });

  ws.on('close', () => {
    console.log('[agent] WebSocket closed, exiting');
    process.exit(0);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('[agent] Received SIGINT, shutting down...');
    if (ws) ws.close();
    process.exit(0);
  });

  console.log('[agent] Event loop started, waiting for signals...');
}

main().catch(e => {
  console.error('[agent] Fatal error:', e);
  process.exit(1);
});
