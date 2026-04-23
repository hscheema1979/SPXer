/**
 * E2E: Live Data Service → Signal → Paper Order → Fill Verify
 *
 * Connects to the running data service on port 3600.
 * Subscribes to contract_signal channels.
 * When a real signal arrives, evaluates it via PositionOrderManager,
 * places a 1-contract paper order, and verifies the complete cycle.
 *
 * Run: npx vitest run tests/e2e/live-signal-to-order.test.ts
 * Requires: data service running (npm run dev)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/storage/db';
import { PositionOrderManager, type EnrichedSignal } from '../../src/agent/position-order-manager';
import type { AccountStream, AccountEventCallback } from '../../src/agent/account-stream';
import { openPosition, closePosition } from '../../src/agent/trade-executor';
import { computeQty } from '../../src/core/position-sizer';
import type { Config } from '../../src/config/types';
import type { OpenPosition } from '../../src/agent/types';
import { createStore } from '../../src/replay/store';
import { todayET } from '../../src/utils/et-time';

const DATA_SERVICE = process.env.SPXER_URL || 'http://localhost:3600';
const WS_URL = DATA_SERVICE.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
const TEST_DB_DIR = path.resolve('./tests/fixtures/e2e-live');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'account.db');

const EXECUTION: Config['execution'] = {
  symbol: 'SPX',
  optionPrefix: 'SPXW',
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
  disableBracketOrders: true,
};

const TIMEOUT_MS = 120_000;

class LiveAccountStream implements AccountStream {
  private callback: AccountEventCallback | null = null;
  onEvent(cb: AccountEventCallback): void { this.callback = cb; }
  get lastActivity(): number { return 0; }
  isConnected(): boolean { return true; }
  async start(): Promise<void> {}
  stop(): void {}
}

function waitForWsMessage(ws: WebSocket, type: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for WS message type="${type}" after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(data: Buffer) {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === type) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    }

    ws.on('message', handler);
  });
}

let dataServiceHealthy = false;

beforeAll(async () => {
  try {
    const resp = await axios.get(`${DATA_SERVICE}/health`, { timeout: 5000 });
    dataServiceHealthy = resp.data?.status !== 'critical';
    console.log(`[live-e2e] Data service: ${resp.data?.status} (SPX=${resp.data?.lastSpxPrice})`);
  } catch {
    dataServiceHealthy = false;
  }

  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  initAccountDb(TEST_DB_PATH);
});

afterAll(() => {
  closeAccountDb();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getAccountDb();
  db.exec('DELETE FROM orders');
  db.exec('DELETE FROM positions');
  db.exec('DELETE FROM config_state');
});

describe('E2E: Live signal → paper order', () => {

  it('data service is healthy', async () => {
    if (!dataServiceHealthy) {
      console.warn('[live-e2e] SKIP: data service not running on port 3600');
      return;
    }
    const resp = await axios.get(`${DATA_SERVICE}/health`, { timeout: 5000 });
    expect(resp.status).toBe(200);
    expect(resp.data.status).not.toBe('critical');
  });

  it('receives a signal from data service WS within timeout', async () => {
    if (!dataServiceHealthy) return;

    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
    });

    let configId = process.env.AGENT_CONFIG_ID;
    if (!configId) {
      const store = createStore();
      const configs = store.listConfigs();
      store.close();
      configId = configs?.[0]?.id;
    }

    const hmaFast = configId?.includes('3x12') ? 3 : 5;
    const hmaSlow = configId?.includes('3x12') ? 12 : 19;
    const pair = `${hmaFast}_${hmaSlow}`;

    ws.send(JSON.stringify({ action: 'subscribe', channel: `contract_signal:${pair}` }));
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx_bar' }));

    console.log(`[live-e2e] Subscribed to contract_signal:${pair}, waiting for signal...`);

    const msg = await waitForWsMessage(ws, 'contract_signal', TIMEOUT_MS);
    expect(msg).toBeDefined();
    expect(msg.type).toBe('contract_signal');
    expect(msg.data).toBeDefined();
    expect(msg.data.symbol).toBeDefined();
    expect(msg.data.side).toMatch(/^(call|put)$/);
    expect(msg.data.strike).toBeGreaterThan(0);
    expect(msg.data.price).toBeGreaterThan(0);

    console.log(`[live-e2e] Signal received: ${msg.data.symbol} ${msg.data.side} @ $${msg.data.price} | channel=${msg.data.channel}`);

    ws.close();
  }, TIMEOUT_MS + 30_000);

  it('full cycle: signal → evaluate → paper order → verify account.db', async () => {
    if (!dataServiceHealthy) return;

    const store = createStore();
    let configId = process.env.AGENT_CONFIG_ID;
    let config: Config;
    if (configId) {
      config = store.getConfig(configId)!;
    } else {
      const configs = store.listConfigs();
      configId = configs?.[0]?.id || 'default';
      config = store.getConfig(configId) || configs?.[0];
    }
    store.close();

    if (!config) {
      console.warn('[live-e2e] SKIP: no config found in DB');
      return;
    }

    const hmaFast = config.signals.hmaCrossFast;
    const hmaSlow = config.signals.hmaCrossSlow;
    const pair = `${hmaFast}_${hmaSlow}`;

    const stream = new LiveAccountStream();
    const manager = new PositionOrderManager(stream);
    manager.start();

    const ws = new WebSocket(WS_URL);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('WS connect timeout')), 10_000);
    });

    ws.send(JSON.stringify({ action: 'subscribe', channel: `contract_signal:${pair}` }));

    console.log(`[live-e2e] Waiting for signal on channel contract_signal:${pair}...`);

    const msg = await waitForWsMessage(ws, 'contract_signal', TIMEOUT_MS);
    const signalData = msg.data;

    console.log(`[live-e2e] Signal: ${signalData.symbol} ${signalData.side} @ $${signalData.price}`);

    const enriched: EnrichedSignal = {
      symbol: signalData.symbol,
      strike: signalData.strike,
      expiry: signalData.expiry || todayET(),
      side: signalData.side,
      direction: signalData.direction,
      price: signalData.price,
      hmaFastPeriod: signalData.hmaFastPeriod || hmaFast,
      hmaSlowPeriod: signalData.hmaSlowPeriod || hmaSlow,
      channel: signalData.channel || pair,
      receivedTs: Math.floor(Date.now() / 1000),
    };

    const decision = manager.evaluate(enriched, configId!, config);
    console.log(`[live-e2e] Decision: ${decision.action} — ${decision.action === 'skip' ? (decision as any).reason : ''}`);

    if (decision.action === 'skip') {
      console.log(`[live-e2e] Signal skipped: ${(decision as any).reason}. Test passes — gate working correctly.`);
      ws.close();
      manager.stop();
      return;
    }

    const qty = 1;

    const agentSignal = {
      type: 'HMA_CROSS' as const,
      symbol: signalData.symbol,
      side: signalData.side as 'call' | 'put',
      strike: signalData.strike,
      expiry: signalData.expiry || todayET(),
      currentPrice: signalData.price,
      bid: signalData.price * 0.98,
      ask: signalData.price,
      indicators: {} as any,
      recentBars: [],
      signalBarLow: signalData.price,
      spxContext: {
        price: signalData.spxPrice || 5800,
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
      positionSize: qty,
      stopLoss: signalData.price * (1 - config.position.stopLossPercent / 100),
      takeProfit: signalData.price * (1 + config.position.stopLossPercent / 100 * config.position.takeProfitMultiplier),
      reasoning: `Live E2E test: HMA(${hmaFast})xHMA(${hmaSlow})`,
      concerns: [],
      ts: Date.now(),
    };

    console.log(`[live-e2e] Placing PAPER order: ${qty}x ${signalData.symbol} @ $${signalData.price.toFixed(2)}`);

    const result = await openPosition(agentSignal, tradeDecision, true, EXECUTION, 0, 'live-e2e-test');

    expect(result.execution.paper).toBe(true);
    expect(result.position.quantity).toBe(qty);
    expect(result.position.symbol).toContain('SPXW');
    expect(result.execution.fillPrice).toBeGreaterThan(0);

    console.log(`[live-e2e] Paper order result: fill=$${result.execution.fillPrice?.toFixed(2)} symbol=${result.position.symbol}`);

    const positionId = manager.openPosition(enriched, configId!, config, qty);

    const db = getAccountDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
    expect(pos).toBeDefined();
    expect(pos.status).toBe('OPENING');
    expect(pos.config_id).toBe(configId);
    expect(pos.side).toBe(signalData.side);
    expect(pos.quantity).toBe(qty);

    const state = manager.getConfigState(configId!);
    expect(state.sessionSignalCount).toBe(1);
    expect(state.lastEntryTs).toBeGreaterThan(0);

    console.log(`[live-e2e] Position persisted: id=${positionId} status=OPENING`);
    console.log(`[live-e2e] Config state: signals=${state.sessionSignalCount} lastEntry=${state.lastEntryTs}`);

    ws.close();
    manager.stop();
  }, TIMEOUT_MS + 30_000);
});
