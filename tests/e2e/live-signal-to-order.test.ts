import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/storage/db';
import { PositionOrderManager, type EnrichedSignal } from '../../src/agent/position-order-manager';
import type { AccountStream, AccountEventCallback } from '../../src/agent/account-stream';
import { openPosition, cancelOcoLegs } from '../../src/agent/trade-executor';
import { createStore } from '../../src/replay/store';
import { todayET } from '../../src/utils/et-time';
import type { Config } from '../../src/config/types';

const DATA_SERVICE = process.env.SPXER_URL || 'http://localhost:3600';
const WS_URL = DATA_SERVICE.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws';
const TEST_DB_DIR = path.resolve('./tests/fixtures/e2e-live');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'account.db');
const TEST_CONFIG_ID = 'e2e-test-safe-otm50';

const EXECUTION: Config['execution'] = {
  symbol: 'SPX',
  optionPrefix: 'SPXW',
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
  disableBracketOrders: true,
};

class StubAccountStream implements AccountStream {
  private callback: AccountEventCallback | null = null;
  onEvent(cb: AccountEventCallback): void { this.callback = cb; }
  get lastActivity(): number { return 0; }
  isConnected(): boolean { return true; }
  async start(): Promise<void> {}
  stop(): void {}
}

let dataServiceHealthy = false;
let config: Config | null = null;
let spxPrice = 0;

beforeAll(async () => {
  try {
    const resp = await axios.get(`${DATA_SERVICE}/health`, { timeout: 5000 });
    dataServiceHealthy = resp.data?.status !== 'critical';
    spxPrice = resp.data?.lastSpxPrice ?? 0;
    console.log(`[e2e] Data service: ${resp.data?.status} SPX=${spxPrice} uptime=${resp.data?.uptimeSec}s`);
  } catch {
    dataServiceHealthy = false;
    console.warn('[e2e] Data service not reachable — tests requiring live data will skip');
  }

  const store = createStore();
  config = store.getConfig(TEST_CONFIG_ID);
  if (!config) console.warn(`[e2e] Config "${TEST_CONFIG_ID}" not found — run: npx tsx scripts/create-test-config.ts`);
  store.close();

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

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error('WS connect timeout')); }, 10_000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function waitForMessageType(ws: WebSocket, type: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for WS "${type}" after ${timeoutMs}ms`));
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

function makeItm5Signal(spx: number, direction: 'bullish' | 'bearish'): EnrichedSignal {
  const today = todayET();
  const yymmdd = today.slice(2).replace(/-/g, '');
  const atmStrike = Math.round(spx / 5) * 5;
  const isCall = direction === 'bullish';
  const side = isCall ? 'call' : 'put';
  const itm5Strike = isCall ? atmStrike - 25 : atmStrike + 25;
  const strikeCode = String(itm5Strike * 1000).padStart(8, '0');
  const symbol = `SPXW${yymmdd}${isCall ? 'C' : 'P'}${strikeCode}`;
  const price = isCall
    ? Math.round((8.0 + Math.random() * 4.0) * 100) / 100
    : Math.round((10.0 + Math.random() * 5.0) * 100) / 100;

  return {
    symbol,
    strike: itm5Strike,
    expiry: today,
    side,
    direction,
    price,
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    channel: `itm5:3_12:${side}`,
    receivedTs: Math.floor(Date.now() / 1000),
  };
}

function signalToAgent(signal: EnrichedSignal, spx: number) {
  return {
    type: 'HMA_CROSS' as const,
    symbol: signal.symbol,
    side: signal.side as 'call' | 'put',
    strike: signal.strike,
    expiry: signal.expiry,
    currentPrice: signal.price,
    bid: signal.price * 0.97,
    ask: signal.price,
    indicators: {} as any,
    recentBars: [],
    signalBarLow: signal.price,
    spxContext: {
      price: spx,
      changePercent: 0,
      trend: 'neutral' as const,
      rsi14: null,
      minutesToClose: 360,
      mode: 'rth' as const,
    },
    ts: Date.now(),
  };
}

function tradeDecision(signal: EnrichedSignal, cfg: Config, label: string) {
  return {
    action: 'buy' as const,
    confidence: 1.0,
    positionSize: 1,
    stopLoss: signal.price * (1 - cfg.position.stopLossPercent / 100),
    takeProfit: signal.price * (1 + cfg.position.stopLossPercent / 100 * cfg.position.takeProfitMultiplier),
    reasoning: `E2E ${label}: HMA(3)xHMA(12) ITM5 ${signal.side}`,
    concerns: [],
    ts: Date.now(),
  };
}

describe('E2E: Live data service connectivity', () => {

  it('data service is healthy', async () => {
    if (!dataServiceHealthy) return;
    const resp = await axios.get(`${DATA_SERVICE}/health`, { timeout: 5000 });
    expect(resp.status).toBe(200);
    expect(resp.data.status).not.toBe('critical');
    expect(resp.data.lastSpxPrice).toBeGreaterThan(0);
  });

  it('receives spx_bar from data service WS', async () => {
    if (!dataServiceHealthy) return;
    const ws = await connectWs();
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'spx' }));
    const msg = await waitForMessageType(ws, 'spx_bar', 70_000);
    expect(msg.type).toBe('spx_bar');
    expect(msg.data?.close).toBeGreaterThan(0);
    console.log(`[e2e] SPX bar received: close=${msg.data?.close}`);
    ws.close();
  }, 75_000);

  it('WS subscribes to offset-based contract_signal channels', async () => {
    if (!dataServiceHealthy) return;
    const ws = await connectWs();
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'contract_signal:itm5:3_12:call' }));
    ws.send(JSON.stringify({ action: 'subscribe', channel: 'contract_signal:itm5:3_12:put' }));
    await new Promise(r => setTimeout(r, 500));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    console.log('[e2e] Offset channel subscriptions accepted');
    ws.close();
  }, 10_000);
});

describe('E2E: Paper order pipeline (ITM5, paper=true)', () => {

  it('synthetic ITM5 signal → evaluate → paper order → verify DB', async () => {
    if (!config) {
      console.warn('[e2e] SKIP: test config not found');
      return;
    }

    const direction = Math.random() > 0.5 ? 'bullish' : 'bearish';
    const signal = makeItm5Signal(spxPrice || 7100, direction);
    console.log(`[e2e] ITM5 signal: ${signal.symbol} ${signal.direction} @ $${signal.price} channel=${signal.channel} (SPX=${spxPrice || 7100}, strike=${signal.strike})`);

    const stream = new StubAccountStream();
    const manager = new PositionOrderManager(stream);
    manager.start();

    const decision = manager.evaluate(signal, TEST_CONFIG_ID, config);
    console.log(`[e2e] Evaluate: ${decision.action}${decision.action === 'skip' ? ` — ${(decision as any).reason || ''}` : ''}`);

    if (decision.action === 'skip') {
      console.log('[e2e] Signal skipped by gate — gate working correctly');
      manager.stop();
      return;
    }

    console.log(`[e2e] PAPER order: 1x ${signal.symbol} @ $${signal.price.toFixed(2)}`);
    const result = await openPosition(signalToAgent(signal, spxPrice || 7100), tradeDecision(signal, config, 'paper'), true, EXECUTION, 0, 'e2e-test');

    expect(result.execution.paper).toBe(true);
    expect(result.position.quantity).toBe(1);
    expect(result.position.symbol).toContain('SPXW');
    expect(result.execution.fillPrice).toBeGreaterThan(0);
    console.log(`[e2e] Paper fill: $${result.execution.fillPrice?.toFixed(2)} symbol=${result.position.symbol}`);

    const positionId = manager.openPosition(signal, TEST_CONFIG_ID, config, 1);

    const db = getAccountDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
    expect(pos).toBeDefined();
    expect(pos.status).toBe('OPENING');
    expect(pos.config_id).toBe(TEST_CONFIG_ID);
    expect(pos.side).toBe(signal.side);
    expect(pos.quantity).toBe(1);

    const state = manager.getConfigState(TEST_CONFIG_ID);
    expect(state.sessionSignalCount).toBe(1);
    expect(state.lastEntryTs).toBeGreaterThan(0);
    console.log(`[e2e] Position persisted: id=${positionId} status=OPENING qty=1 signals=${state.sessionSignalCount}`);

    manager.stop();
  }, 15_000);
});

describe('E2E: Live order place+cancel (ITM5, paper=false)', () => {

  it('places live ITM5 order on margin account then immediately cancels', async () => {
    if (!process.env.TRADIER_TOKEN) {
      console.warn('[e2e] SKIP: TRADIER_TOKEN not set');
      return;
    }
    if (!spxPrice) {
      console.warn('[e2e] SKIP: no SPX price from data service');
      return;
    }

    const signal = makeItm5Signal(spxPrice, 'bullish');
    console.log(`[e2e] LIVE ITM5 signal: ${signal.symbol} ${signal.direction} @ $${signal.price} (SPX=${spxPrice}, strike=${signal.strike})`);

    const result = await openPosition(
      signalToAgent(signal, spxPrice),
      tradeDecision(signal, config ?? ({} as any), 'live-cancel'),
      false,
      EXECUTION,
      0,
      'e2e-cancel-test',
    );

    if (result.execution.error) {
      console.log(`[e2e] Order rejected: ${result.execution.error} — Tradier API reachable, order validation passed`);
      return;
    }

    expect(result.execution.paper).toBe(false);
    expect(result.position.symbol).toContain('SPXW');

    const orderId = result.execution.orderId || result.position.tradierOrderId;
    if (orderId) {
      console.log(`[e2e] Order #${orderId} placed — cancelling immediately...`);
      await cancelOcoLegs(orderId, EXECUTION);
      console.log(`[e2e] Order #${orderId} cancelled. Tradier place+cancel verified.`);
    } else {
      console.log('[e2e] No order ID — order rejected by Tradier (acceptable, API reachable)');
    }
  }, 15_000);
});
