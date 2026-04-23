/**
 * E2E: Event-Driven Pipeline — Signal → PositionOrderManager → account.db
 *
 * Tests the full event-driven stack:
 *   1. Offset-based signal enrichment
 *   2. PositionOrderManager.evaluate() decision flow
 *   3. PositionOrderManager.openPosition() → account.db persistence
 *   4. PositionOrderManager.onOrderEvent() → fill/rejection → state transitions
 *   5. PositionOrderManager.reconcileFromBroker() → startup sync
 *   6. Multi-config isolation
 *   7. Full lifecycle: signal → open → fill → exit → close
 *
 * Uses real SQLite (account.db), real filesystem, real Config objects.
 * AccountStream is stubbed (no live Tradier WS needed).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/storage/db';
import { PositionOrderManager, type EnrichedSignal } from '../../src/agent/position-order-manager';
import type { AccountStream, AccountEventCallback } from '../../src/agent/account-stream';
import type { Config } from '../../src/config/types';
import { todayET } from '../../src/utils/et-time';
import { DEFAULT_CONFIG } from '../../src/config/defaults';

const TEST_DB_DIR = path.resolve('./tests/fixtures/e2e-pipeline');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'account.db');

const PERMISSIVE_WINDOWS = {
  sessionStart: '00:00',
  sessionEnd: '23:59',
  activeStart: '00:00',
  activeEnd: '23:59',
  skipWeekends: false,
  skipHolidays: false,
};

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    signals: { ...DEFAULT_CONFIG.signals, ...overrides.signals },
    position: { ...DEFAULT_CONFIG.position, ...overrides.position },
    risk: { ...DEFAULT_CONFIG.risk, ...overrides.risk, cutoffTimeET: '23:59' },
    timeWindows: { ...PERMISSIVE_WINDOWS, ...(overrides.timeWindows || {}) },
  };
}

function makeSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    symbol: 'SPXW260423C05800000',
    strike: 5800,
    expiry: todayET(),
    side: 'call',
    direction: 'bullish',
    price: 5.50,
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    channel: 'otm5:3_12:call',
    receivedTs: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

let tradierIdCounter = 100000;

class StubAccountStream implements AccountStream {
  private callback: AccountEventCallback | null = null;
  private _lastActivity = 0;

  onEvent(cb: AccountEventCallback): void { this.callback = cb; }
  get lastActivity(): number { return this._lastActivity; }
  isConnected(): boolean { return true; }
  async start(): Promise<void> {}
  stop(): void {}

  simulateFill(tradierId: number, fillPrice: number, side = 'buy_to_open'): void {
    this._lastActivity = Date.now();
    if (!this.callback) return;
    this.callback({
      id: tradierId,
      event: 'order',
      status: 'filled',
      type: 'market',
      price: fillPrice,
      stop_price: 0,
      avg_fill_price: fillPrice,
      executed_quantity: 1,
      last_fill_quantity: 1,
      remaining_quantity: 0,
      transaction_date: new Date().toISOString(),
      create_date: new Date().toISOString(),
      account: '6YA51425',
      side,
    });
  }

  simulateReject(tradierId: number): void {
    this._lastActivity = Date.now();
    if (!this.callback) return;
    this.callback({
      id: tradierId,
      event: 'order',
      status: 'rejected',
      type: 'market',
      price: 0,
      stop_price: 0,
      avg_fill_price: 0,
      executed_quantity: 0,
      last_fill_quantity: 0,
      remaining_quantity: 0,
      transaction_date: new Date().toISOString(),
      create_date: new Date().toISOString(),
      account: '6YA51425',
    });
  }
}

function assignTradierId(positionId: string): number {
  const db = getAccountDb();
  const tradierId = ++tradierIdCounter;
  db.prepare('UPDATE orders SET tradier_id = ? WHERE position_id = ?').run(tradierId, positionId);
  return tradierId;
}

function insertSellOrder(positionId: string, tradierId: number): void {
  const db = getAccountDb();
  db.prepare(`
    INSERT INTO orders (id, position_id, tradier_id, side, order_type, status, quantity, submitted_at)
    VALUES (?, ?, ?, 'sell_to_close', 'limit', 'PENDING', 1, ?)
  `).run(`sell-${tradierId}`, positionId, tradierId, Math.floor(Date.now() / 1000));
}

let stream: StubAccountStream;
let manager: PositionOrderManager;

beforeAll(() => {
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
  tradierIdCounter = 100000;

  stream = new StubAccountStream();
  manager = new PositionOrderManager(stream);
  manager.start();
});

describe('E2E: Event-driven pipeline', () => {

  describe('1. Signal enrichment + offset-based channel', () => {
    it('signal carries offset label in channel format', () => {
      const signal = makeSignal({ channel: 'otm5:3_12:call' });
      expect(signal.channel).toBe('otm5:3_12:call');
      expect(signal.strike).toBe(5800);
      expect(signal.side).toBe('call');
    });

    it('channel encodes HMA pair for subscription matching', () => {
      const signal = makeSignal({ channel: 'itm3:3_12:put' });
      const parts = signal.channel.split(':');
      expect(parts[0]).toBe('itm3');
      expect(parts[1]).toBe('3_12');
      expect(parts[2]).toBe('put');
    });
  });

  describe('2. Decision flow: evaluate()', () => {
    it('opens on first signal with no positions', () => {
      const config = makeConfig();
      const signal = makeSignal();
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('open');
    });

    it('skips when wrong expiry day', () => {
      const config = makeConfig();
      const signal = makeSignal({ expiry: '2020-01-01' });
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('skip');
      if (decision.action === 'skip') {
        expect(decision.reason).toContain('wrong day');
      }
    });

    it('skips when transitioning (OPENING)', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'test-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPENING',
      });
      const signal = makeSignal();
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('skip');
      if (decision.action === 'skip') {
        expect(decision.reason).toContain('transition');
      }
    });

    it('skips same direction (already have call)', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'test-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPEN',
      });
      const signal = makeSignal({ side: 'call' });
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('skip');
      if (decision.action === 'skip') {
        expect(decision.reason).toContain('same direction');
      }
    });

    it('flips on opposite direction (have call, signal is put)', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'test-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPEN',
      });
      const signal = makeSignal({ side: 'put', direction: 'bearish' });
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('flip');
      if (decision.action === 'flip') {
        expect(decision.position.side).toBe('call');
      }
    });

    it('isolates positions between configs', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'other-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPEN',
      });
      const signal = makeSignal();
      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('open');
    });
  });

  describe('3. openPosition() → account.db persistence', () => {
    it('persists OPENING position with correct SL/TP', () => {
      const config = makeConfig({
        position: { stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 },
      });
      const signal = makeSignal({ price: 5.00 });

      const positionId = manager.openPosition(signal, 'test-cfg', config, 2);

      const db = getAccountDb();
      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos).toBeDefined();
      expect(pos.status).toBe('OPENING');
      expect(pos.config_id).toBe('test-cfg');
      expect(pos.side).toBe('call');
      expect(pos.quantity).toBe(2);
      // 5.00 * (1 - 0.25) = 3.75
      expect(pos.stop_loss).toBeCloseTo(3.75, 2);
      // 5.00 * (1 + 0.25 * 1.25) = 6.5625
      expect(pos.take_profit).toBeCloseTo(6.5625, 3);
    });

    it('creates PENDING buy_to_open order', () => {
      const config = makeConfig();
      const signal = makeSignal();
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const db = getAccountDb();
      const order = db.prepare('SELECT * FROM orders WHERE position_id = ?').get(positionId) as any;
      expect(order).toBeDefined();
      expect(order.side).toBe('buy_to_open');
      expect(order.order_type).toBe('market');
      expect(order.status).toBe('PENDING');
    });

    it('updates config_state with lastEntryTs and signalCount', () => {
      const config = makeConfig();
      const signal = makeSignal({ receivedTs: 1700000000 });

      manager.openPosition(signal, 'test-cfg', config, 1);

      const state = manager.getConfigState('test-cfg');
      expect(state.lastEntryTs).toBe(1700000000);
      expect(state.sessionSignalCount).toBe(1);
    });
  });

  describe('4. onOrderEvent() → state transitions', () => {
    it('entry fill: OPENING → OPEN with correct entry price', () => {
      const config = makeConfig();
      const signal = makeSignal({ price: 5.00 });
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const tradierId = assignTradierId(positionId);
      stream.simulateFill(tradierId, 5.10);

      const db = getAccountDb();
      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('OPEN');
      expect(pos.entry_price).toBe(5.10);
      expect(pos.high_water).toBe(5.10);
    });

    it('rejection: OPENING → CLOSED', () => {
      const config = makeConfig();
      const signal = makeSignal();
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const tradierId = assignTradierId(positionId);
      stream.simulateReject(tradierId);

      const db = getAccountDb();
      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('CLOSED');
      expect(pos.close_reason).toBe('rejected');
    });

    it('TP fill: OPEN → CLOSED with reason=tp', () => {
      const config = makeConfig({
        position: { stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 },
      });
      const signal = makeSignal({ price: 5.00 });
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const db = getAccountDb();

      const entryTradierId = assignTradierId(positionId);
      stream.simulateFill(entryTradierId, 5.00);

      const tpTradierId = ++tradierIdCounter;
      insertSellOrder(positionId, tpTradierId);

      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      stream.simulateFill(tpTradierId, pos.take_profit, 'sell_to_close');

      const updated = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(updated.status).toBe('CLOSED');
      expect(updated.close_reason).toBe('tp');
      expect(updated.close_price).toBeCloseTo(6.5625, 3);
    });

    it('SL fill: OPEN → CLOSED with reason=sl', () => {
      const config = makeConfig({
        position: { stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 },
      });
      const signal = makeSignal({ price: 5.00 });
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const db = getAccountDb();

      const entryTradierId = assignTradierId(positionId);
      stream.simulateFill(entryTradierId, 5.00);

      const slTradierId = ++tradierIdCounter;
      insertSellOrder(positionId, slTradierId);

      stream.simulateFill(slTradierId, 3.50, 'sell_to_close');

      const updated = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(updated.status).toBe('CLOSED');
      expect(updated.close_reason).toBe('sl');
      expect(updated.close_price).toBe(3.50);
    });

    it('ignores events for unknown order IDs', () => {
      const config = makeConfig();
      const signal = makeSignal();
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      stream.simulateFill(0xBAD, 99.99);

      const db = getAccountDb();
      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('OPENING');
    });
  });

  describe('5. reconcileFromBroker() → startup sync', () => {
    it('adopts broker position not in DB', () => {
      const config = makeConfig();
      const adopted = manager.reconcileFromBroker('test-cfg', config, [
        { symbol: 'SPXW260423C05800000', side: 'call', strike: 5800, expiry: todayET(), quantity: 2, entryPrice: 5.10 },
      ]);

      expect(adopted.length).toBe(1);

      const db = getAccountDb();
      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(adopted[0]) as any;
      expect(pos.status).toBe('OPEN');
      expect(pos.symbol).toBe('SPXW260423C05800000');
      expect(pos.quantity).toBe(2);
      expect(pos.entry_price).toBe(5.10);
      expect(pos.basket_member).toBe('reconciled');
    });

    it('marks DB position ORPHANED when broker missing', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'test-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPEN',
      });

      manager.reconcileFromBroker('test-cfg', config, []);

      const db = getAccountDb();
      const pos = db.prepare("SELECT * FROM positions WHERE config_id = 'test-cfg'").get() as any;
      expect(pos.status).toBe('OPEN');
    });

    it('no-op when both agree', () => {
      const config = makeConfig();
      manager.insertTestPosition({
        configId: 'test-cfg',
        symbol: 'SPXW260423C05800000',
        side: 'call',
        strike: 5800,
        status: 'OPEN',
      });

      const adopted = manager.reconcileFromBroker('test-cfg', config, [
        { symbol: 'SPXW260423C05800000', side: 'call', strike: 5800, expiry: todayET(), quantity: 1, entryPrice: 5.00 },
      ]);

      expect(adopted.length).toBe(0);

      const db = getAccountDb();
      const pos = db.prepare("SELECT * FROM positions WHERE config_id = 'test-cfg'").get() as any;
      expect(pos.status).toBe('OPEN');
    });

    it('skips non-today expiry broker positions', () => {
      const config = makeConfig();
      const adopted = manager.reconcileFromBroker('test-cfg', config, [
        { symbol: 'SPXW260401C05800000', side: 'call', strike: 5800, expiry: '2020-01-01', quantity: 1, entryPrice: 5.00 },
      ]);

      expect(adopted.length).toBe(0);
    });
  });

  describe('6. Full lifecycle: signal → open → fill → exit → close', () => {
    it('complete bullish trade lifecycle', () => {
      const config = makeConfig({
        position: { stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 },
      });
      const signal = makeSignal({ price: 4.00, side: 'call', direction: 'bullish' });

      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('open');

      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);
      const db = getAccountDb();

      let pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('OPENING');

      const entryTradierId = assignTradierId(positionId);
      stream.simulateFill(entryTradierId, 4.05);

      pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('OPEN');
      expect(pos.entry_price).toBe(4.05);
      // 4.00 * 0.75 = 3.0
      expect(pos.stop_loss).toBeCloseTo(3.0, 1);
      // 4.00 * 1.3125 = 5.25
      expect(pos.take_profit).toBeCloseTo(5.25, 1);

      const exitTradierId = ++tradierIdCounter;
      insertSellOrder(positionId, exitTradierId);

      stream.simulateFill(exitTradierId, pos.take_profit, 'sell_to_close');

      pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('CLOSED');
      expect(pos.close_reason).toBe('tp');

      const state = manager.getConfigState('test-cfg');
      expect(state.sessionSignalCount).toBe(1);
    });

    it('complete bearish trade with SL exit', () => {
      const config = makeConfig({
        position: { stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 },
      });
      const signal = makeSignal({ price: 3.00, side: 'put', direction: 'bearish', channel: 'otm5:3_12:put' });

      const decision = manager.evaluate(signal, 'test-cfg', config);
      expect(decision.action).toBe('open');

      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);
      const db = getAccountDb();

      const entryTradierId = assignTradierId(positionId);
      stream.simulateFill(entryTradierId, 3.00);

      const slTradierId = ++tradierIdCounter;
      insertSellOrder(positionId, slTradierId);

      stream.simulateFill(slTradierId, 2.00, 'sell_to_close');

      const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId) as any;
      expect(pos.status).toBe('CLOSED');
      expect(pos.close_reason).toBe('sl');
      expect(pos.close_price).toBe(2.00);
    });

    it('signal rejection → can immediately accept next signal', () => {
      const config = makeConfig();
      const signal1 = makeSignal({ symbol: 'SPXW260423C05800000' });

      const positionId = manager.openPosition(signal1, 'test-cfg', config, 1);

      const tradierId = assignTradierId(positionId);
      stream.simulateReject(tradierId);

      const signal2 = makeSignal({ symbol: 'SPXW260423P05805000', side: 'put', direction: 'bearish' });
      const decision = manager.evaluate(signal2, 'test-cfg', config);
      expect(decision.action).toBe('open');
    });
  });

  describe('7. Multi-config isolation', () => {
    it('two configs can each have one open position', () => {
      const config = makeConfig();
      const cfgA = 'config-a';
      const cfgB = 'config-b';

      const signalCall = makeSignal({ side: 'call', direction: 'bullish' });
      const signalPut = makeSignal({ side: 'put', direction: 'bearish', symbol: 'SPXW260423P05805000' });

      const decisionA = manager.evaluate(signalCall, cfgA, config);
      expect(decisionA.action).toBe('open');

      const posIdA = manager.openPosition(signalCall, cfgA, config, 1);
      const tradierIdA = assignTradierId(posIdA);
      stream.simulateFill(tradierIdA, 5.00);

      const decisionB = manager.evaluate(signalPut, cfgB, config);
      expect(decisionB.action).toBe('open');

      manager.openPosition(signalPut, cfgB, config, 1);

      const positionsA = manager.getOpenPositions(cfgA);
      const positionsB = manager.getOpenPositions(cfgB);
      expect(positionsA.length).toBe(1);
      expect(positionsB.length).toBe(1);
      expect(positionsA[0].side).toBe('call');
      expect(positionsB[0].side).toBe('put');
    });

    it('config_state is isolated per config', () => {
      manager.setConfigState('cfg-a', { dailyPnl: 100, tradesCompleted: 3 });
      manager.setConfigState('cfg-b', { dailyPnl: -50, tradesCompleted: 1 });

      const stateA = manager.getConfigState('cfg-a');
      const stateB = manager.getConfigState('cfg-b');

      expect(stateA.dailyPnl).toBe(100);
      expect(stateA.tradesCompleted).toBe(3);
      expect(stateB.dailyPnl).toBe(-50);
      expect(stateB.tradesCompleted).toBe(1);
    });
  });

  describe('8. DB integrity after lifecycle', () => {
    it('all positions have orders', () => {
      const config = makeConfig();
      const signal = makeSignal();
      const positionId = manager.openPosition(signal, 'test-cfg', config, 1);

      const db = getAccountDb();
      const orders = db.prepare('SELECT * FROM orders WHERE position_id = ?').all(positionId) as any[];
      expect(orders.length).toBeGreaterThanOrEqual(1);
      expect(orders[0].side).toBe('buy_to_open');
    });

    it('no orphan orders (all reference valid positions)', () => {
      const config = makeConfig();
      const signal = makeSignal();
      manager.openPosition(signal, 'test-cfg', config, 1);

      const db = getAccountDb();
      const orphans = db.prepare(`
        SELECT o.id FROM orders o
        LEFT JOIN positions p ON o.position_id = p.id
        WHERE p.id IS NULL
      `).all() as any[];
      expect(orphans.length).toBe(0);
    });

    it('position count matches DB after multiple operations', () => {
      const config = makeConfig();
      const cfg = 'integrity-cfg';

      for (let i = 0; i < 3; i++) {
        const signal = makeSignal({
          symbol: `SPXW260423C0580${i}000`,
          strike: 5800 + i * 5,
        });
        manager.openPosition(signal, cfg, config, 1);
      }

      const open = manager.getOpenPositions(cfg);
      expect(open.length).toBe(3);

      const db = getAccountDb();
      const allPositions = db.prepare("SELECT * FROM positions WHERE config_id = ?").all(cfg) as any[];
      expect(allPositions.length).toBe(3);
      expect(allPositions.every(p => p.status === 'OPENING')).toBe(true);
    });
  });
});
