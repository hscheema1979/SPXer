import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PositionOrderManager } from '../../src/agent/position-order-manager';
import type { EnrichedSignal } from '../../src/agent/position-order-manager';
import type { Config } from '../../src/config/types';
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/storage/db';
import { AccountStream } from '../../src/agent/account-stream';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { todayET, etTimeToUnixTs } from '../../src/utils/et-time';

function getSessionTimestamps() {
  return {
    sessionStart: etTimeToUnixTs('09:30'),
    beforeSession: etTimeToUnixTs('09:29'),
    t_10_00: etTimeToUnixTs('10:00'),
    t_14_00: etTimeToUnixTs('14:00'),
    t_15_44: etTimeToUnixTs('15:44'),
    t_16_00: etTimeToUnixTs('16:00'),
    afterSession: etTimeToUnixTs('16:01'),
  };
}

function makeConfig(overrides: Record<string, any> = {}): Config {
  const base: Config = {
    id: 'test-config',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    scanners: {
      enabled: false, models: [], cycleIntervalSec: 30,
      minConfidenceToEscalate: 0.5, promptAssignments: {}, defaultPromptId: '',
    },
    judges: {
      enabled: false, models: [], activeJudge: '', consensusRule: 'primary-decides',
      confidenceThreshold: 0.5, entryCooldownSec: 180, promptId: '',
    },
    regime: {
      enabled: false, mode: 'disabled',
      classification: { trendThreshold: 0.15, lookbackBars: 30, openingRangeMinutes: 15 },
      timeWindows: { morningEnd: '10:30', middayEnd: '14:00', gammaExpiryStart: '15:00', noTradeStart: '15:45' },
      signalGates: {},
    },
    signals: {
      enableHmaCrosses: true, enableRsiCrosses: false, enableEmaCrosses: false,
      enablePriceCrossHma: false, requireUnderlyingHmaCross: false,
      hmaCrossFast: 3, hmaCrossSlow: 12, emaCrossFast: 9, emaCrossSlow: 21,
      signalTimeframe: '1m', directionTimeframe: '1m', exitTimeframe: '1m',
      hmaCrossTimeframe: null, rsiCrossTimeframe: null, emaCrossTimeframe: null,
      priceCrossHmaTimeframe: null, targetOtmDistance: 5,
      targetContractPrice: null, maxEntryPrice: null,
      rsiOversold: 30, rsiOverbought: 70, optionRsiOversold: 40, optionRsiOverbought: 60,
      enableKeltnerGate: false, kcEmaPeriod: 20, kcAtrPeriod: 14, kcMultiplier: 2.5,
      kcSlopeLookback: 5, kcSlopeThreshold: 0.3,
      allowedSides: 'both', reverseSignals: false,
    },
    position: {
      stopLossPercent: 25, takeProfitMultiplier: 1.25, maxPositionsOpen: 1,
      defaultQuantity: 1, positionSizeMultiplier: 1,
    },
    risk: {
      maxDailyLoss: 500, maxTradesPerDay: 20, maxRiskPerTrade: 500,
      cutoffTimeET: '15:45', minMinutesToClose: 15,
    },
    strikeSelector: {
      strikeSearchRange: 100, contractPriceMin: 0.20, contractPriceMax: 8.00,
      strikeMode: 'otm',
    },
    timeWindows: {
      sessionStart: '09:30', sessionEnd: '16:00',
      activeStart: '09:30', activeEnd: '15:45',
      skipWeekends: true, skipHolidays: true,
    },
    escalation: {
      signalTriggersJudge: false, scannerTriggersJudge: false,
      requireScannerAgreement: false, requireSignalAgreement: false,
    },
    exit: {
      strategy: 'scannerReverse', trailingStopEnabled: false, trailingStopPercent: 20,
      timeBasedExitEnabled: false, timeBasedExitMinutes: 5, reversalSizeMultiplier: 1,
    },
    narrative: { buildOvernightContext: false, barHistoryDepth: 100, trackTrajectory: false },
    pipeline: {
      pollUnderlyingMs: 10000, pollOptionsRthMs: 30000, pollOptionsOvernightMs: 60000,
      pollScreenerMs: 60000, strikeBand: 100, strikeInterval: 5,
      gapInterpolateMaxMins: 60, maxBarsMemory: 1000, timeframe: '1m',
    },
    contracts: { stickyBandWidth: 100 },
    calendar: { holidays: [], earlyCloseDays: [] },
    sizing: { baseDollarsPerTrade: 1500, sizeMultiplier: 1, minContracts: 1, maxContracts: 10 },
  };

  for (const key of Object.keys(overrides)) {
    if (typeof overrides[key] === 'object' && !Array.isArray(overrides[key]) && overrides[key] !== null) {
      (base as any)[key] = { ...(base as any)[key], ...overrides[key] };
    } else {
      (base as any)[key] = overrides[key];
    }
  }
  return base;
}

const TODAY = () => todayET();

function makeSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  const today = TODAY();
  const expiryCode = today.replace(/-/g, '').slice(2);
  const ts = getSessionTimestamps().t_10_00;
  return {
    symbol: `SPXW${expiryCode}C06500000`,
    strike: 6500,
    expiry: today,
    side: 'call',
    direction: 'bullish',
    price: 3.50,
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    channel: 'itm5:3_12:call',
    receivedTs: ts,
    ...overrides,
  };
}

function makePutSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  const today = TODAY();
  const expiryCode = today.replace(/-/g, '').slice(2);
  return makeSignal({
    symbol: `SPXW${expiryCode}P06500000`,
    side: 'put',
    direction: 'bearish',
    channel: 'itm5:3_12:put',
    ...overrides,
  });
}

const TEST_DB = path.resolve('data', 'test-account.db');

describe('PositionOrderManager.evaluate()', () => {
  let manager: PositionOrderManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    initAccountDb(TEST_DB);
    const stream = new AccountStream();
    manager = new PositionOrderManager(stream);
  });

  afterEach(() => {
    manager.stop();
    closeAccountDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  it('returns open when no positions exist and within time window', () => {
    const config = makeConfig();
    const ts = getSessionTimestamps();
    const signal = makeSignal({ receivedTs: ts.t_10_00 });

    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('open');
    if (decision.action === 'open') {
      expect(decision.reason).toContain('no positions');
    }
  });

  it('returns skip when expiry does not match today', () => {
    const config = makeConfig();
    const signal = makeSignal({ expiry: '1999-12-31' });

    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toContain('wrong day');
    }
  });

  it('returns skip when outside time window (before session)', () => {
    const config = makeConfig();
    const ts = getSessionTimestamps();
    const signal = makeSignal({ receivedTs: ts.beforeSession });

    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toContain('window');
    }
  });

  it('returns skip when outside time window (after cutoff)', () => {
    const config = makeConfig();
    const ts = getSessionTimestamps();
    const signal = makeSignal({ receivedTs: ts.afterSession });

    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toMatch(/window|cutoff|close/);
    }
  });

  it('returns skip when same-direction position is already open', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'test-config',
      symbol: `SPXW${expiryCode}C06500000`,
      side: 'call',
      strike: 6500,
      status: 'OPEN',
    });

    const signal = makeSignal();
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toContain('same direction');
    }
  });

  it('returns flip when opposite-direction position is open', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'test-config',
      symbol: `SPXW${expiryCode}P06500000`,
      side: 'put',
      strike: 6500,
      status: 'OPEN',
    });

    const signal = makeSignal({ side: 'call', direction: 'bullish' });
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('flip');
    if (decision.action === 'flip') {
      expect(decision.position.side).toBe('put');
    }
  });

  it('returns skip when position is in OPENING state (transition in progress)', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'test-config',
      symbol: `SPXW${expiryCode}P06500000`,
      side: 'put',
      strike: 6500,
      status: 'OPENING',
    });

    const signal = makeSignal();
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toContain('transition');
    }
  });

  it('returns skip when max positions reached', () => {
    const config = makeConfig({ position: { maxPositionsOpen: 0 } });
    const signal = makeSignal();
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toMatch(/max|risk|positions/);
    }
  });

  it('returns skip when cooldown has not elapsed', () => {
    const ts = getSessionTimestamps();
    const config = makeConfig({ judges: { entryCooldownSec: 300 } });
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'test-config',
      symbol: `SPXW${expiryCode}C06500000`,
      side: 'call',
      strike: 6500,
      status: 'CLOSED',
      openedAt: ts.t_10_00,
      closedAt: ts.t_10_00 + 60,
    });
    manager.setConfigState('test-config', { lastEntryTs: ts.t_10_00 });

    const signal = makeSignal({ receivedTs: ts.t_10_00 + 120 });
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('skip');
    if (decision.action === 'skip') {
      expect(decision.reason).toContain('cooldown');
    }
  });

  it('returns open when cooldown has elapsed', () => {
    const ts = getSessionTimestamps();
    const config = makeConfig({ judges: { entryCooldownSec: 60 } });
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'test-config',
      symbol: `SPXW${expiryCode}C06500000`,
      side: 'call',
      strike: 6500,
      status: 'CLOSED',
      openedAt: ts.t_10_00,
      closedAt: ts.t_10_00 + 60,
    });
    manager.setConfigState('test-config', { lastEntryTs: ts.t_10_00 });

    const signal = makeSignal({ receivedTs: ts.t_10_00 + 120 });
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('open');
  });

  it('ignores positions from other configs', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    manager.insertTestPosition({
      configId: 'other-config',
      symbol: `SPXW${expiryCode}C06500000`,
      side: 'call',
      strike: 6500,
      status: 'OPEN',
    });

    const signal = makeSignal();
    const decision = manager.evaluate(signal, 'test-config', config);

    expect(decision.action).toBe('open');
  });
});

describe('PositionOrderManager.openPosition()', () => {
  let manager: PositionOrderManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    initAccountDb(TEST_DB);
    const stream = new AccountStream();
    manager = new PositionOrderManager(stream);
  });

  afterEach(() => {
    manager.stop();
    closeAccountDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  it('creates position with OPENING status and computed SL/TP', () => {
    const config = makeConfig();
    const signal = makeSignal({ price: 4.00 });
    const ts = getSessionTimestamps();

    const positionId = manager.openPosition(signal, 'test-config', config, 2);

    const pos = manager.getOpenPositions('test-config');
    expect(pos).toHaveLength(1);
    expect(pos[0].id).toBe(positionId);
    expect(pos[0].status).toBe('OPENING');
    expect(pos[0].side).toBe('call');
    expect(pos[0].symbol).toBe(signal.symbol);
    expect(pos[0].strike).toBe(6500);
    expect(pos[0].expiry).toBe(TODAY());
    expect(pos[0].quantity).toBe(2);
    expect(pos[0].stopLoss).toBeCloseTo(4.00 * (1 - 0.25), 4);
    expect(pos[0].takeProfit).toBeCloseTo(4.00 * (1 + 0.25 * 1.25), 4);
  });

  it('creates a buy_to_open order linked to the position', () => {
    const config = makeConfig();
    const signal = makeSignal();

    const positionId = manager.openPosition(signal, 'test-config', config, 1);

    const db = getAccountDb();
    const orders = db.prepare('SELECT * FROM orders WHERE position_id = ?').all(positionId);
    expect(orders).toHaveLength(1);
    expect(orders[0].side).toBe('buy_to_open');
    expect(orders[0].order_type).toBe('market');
    expect(orders[0].status).toBe('PENDING');
    expect(orders[0].quantity).toBe(1);
  });

  it('updates config_state lastEntryTs and increments sessionSignalCount', () => {
    const config = makeConfig();
    const ts = getSessionTimestamps();
    const signal = makeSignal({ receivedTs: ts.t_10_00 });

    manager.setConfigState('test-config', { sessionSignalCount: 3 });
    manager.openPosition(signal, 'test-config', config, 1);

    const state = manager.getConfigState('test-config');
    expect(state.lastEntryTs).toBe(ts.t_10_00);
    expect(state.sessionSignalCount).toBe(4);
  });

  it('sets basket_member to provided value', () => {
    const config = makeConfig();
    const signal = makeSignal();

    const positionId = manager.openPosition(signal, 'test-config', config, 1, 'strike-7090');

    const pos = manager.getOpenPositions('test-config');
    expect(pos[0].basketMember).toBe('strike-7090');
  });

  it('defaults basket_member to "default" when not provided', () => {
    const config = makeConfig();
    const signal = makeSignal();

    manager.openPosition(signal, 'test-config', config, 1);

    const pos = manager.getOpenPositions('test-config');
    expect(pos[0].basketMember).toBe('default');
  });
});

describe('PositionOrderManager.onOrderEvent()', () => {
  let manager: PositionOrderManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    initAccountDb(TEST_DB);
    const stream = new AccountStream();
    manager = new PositionOrderManager(stream);
  });

  afterEach(() => {
    manager.stop();
    closeAccountDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  function setupOpenPosition(price = 4.00, qty = 1): string {
    const config = makeConfig();
    const signal = makeSignal({ price });
    const posId = manager.openPosition(signal, 'test-config', config, qty);
    return posId;
  }

  function setOrderTradierId(positionId: string, tradierId: number, side = 'buy_to_open'): void {
    const db = getAccountDb();
    db.prepare('UPDATE orders SET tradier_id = ? WHERE position_id = ? AND side = ?')
      .run(tradierId, positionId, side);
  }

  function addSellOrder(positionId: string, tradierId: number, orderType = 'limit'): void {
    const db = getAccountDb();
    const orderId = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO orders (id, position_id, tradier_id, side, order_type, status, quantity, submitted_at) VALUES (?, ?, ?, 'sell_to_close', ?, 'PENDING', 1, ?)")
      .run(orderId, positionId, tradierId, orderType, now);
  }

  function makeFillEvent(tradierId: number, fillPrice: number, side = 'buy_to_open', eventType = 'market'): AccountOrderEvent {
    return {
      id: tradierId,
      event: 'order',
      status: 'filled',
      type: eventType,
      price: 0,
      stop_price: 0,
      avg_fill_price: fillPrice,
      executed_quantity: 1,
      last_fill_quantity: 1,
      remaining_quantity: 0,
      transaction_date: '',
      create_date: '',
      account: '6YA51425',
      side,
    };
  }

  it('moves position to OPEN on buy_to_open fill', () => {
    const posId = setupOpenPosition(4.00);
    setOrderTradierId(posId, 12345);

    manager.onOrderEvent(makeFillEvent(12345, 4.05, 'buy_to_open'));

    const db = getAccountDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('OPEN');
    expect(pos.entry_price).toBe(4.05);
    expect(pos.high_water).toBe(4.05);

    const order = db.prepare('SELECT * FROM orders WHERE tradier_id = ?').get(12345) as any;
    expect(order.status).toBe('FILLED');
    expect(order.fill_price).toBe(4.05);
  });

  it('closes position with tp reason when fill price >= take_profit', () => {
    const posId = setupOpenPosition(4.00);

    const db = getAccountDb();
    db.prepare("UPDATE positions SET status = 'OPEN', entry_price = 4.00, high_water = 4.00 WHERE id = ?").run(posId);
    addSellOrder(posId, 54321, 'limit');

    manager.onOrderEvent(makeFillEvent(54321, 5.25, 'sell_to_close', 'limit'));

    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('CLOSED');
    expect(pos.close_reason).toBe('tp');
    expect(pos.close_price).toBe(5.25);
  });

  it('closes position with sl reason when fill price <= stop_loss', () => {
    const posId = setupOpenPosition(4.00);

    const db = getAccountDb();
    db.prepare("UPDATE positions SET status = 'OPEN', entry_price = 4.00, high_water = 4.00 WHERE id = ?").run(posId);
    addSellOrder(posId, 54322, 'stop');

    manager.onOrderEvent(makeFillEvent(54322, 2.90, 'sell_to_close', 'stop'));

    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('CLOSED');
    expect(pos.close_reason).toBe('sl');
    expect(pos.close_price).toBe(2.90);
  });

  it('closes position with exit reason when fill is between SL and TP', () => {
    const posId = setupOpenPosition(4.00);

    const db = getAccountDb();
    db.prepare("UPDATE positions SET status = 'OPEN', entry_price = 4.00, high_water = 4.00 WHERE id = ?").run(posId);
    addSellOrder(posId, 54323, 'market');

    manager.onOrderEvent(makeFillEvent(54323, 4.20, 'sell_to_close', 'market'));

    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('CLOSED');
    expect(pos.close_reason).toBe('exit');
    expect(pos.close_price).toBe(4.20);
  });

  it('closes OPENING position on rejected order', () => {
    const posId = setupOpenPosition(4.00);
    setOrderTradierId(posId, 99999);

    manager.onOrderEvent({
      id: 99999,
      event: 'order',
      status: 'rejected',
      type: 'market',
      price: 0,
      stop_price: 0,
      avg_fill_price: 0,
      executed_quantity: 0,
      last_fill_quantity: 0,
      remaining_quantity: 0,
      transaction_date: '',
      create_date: '',
      account: '6YA51425',
    });

    const db = getAccountDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('CLOSED');
    expect(pos.close_reason).toBe('rejected');
  });

  it('ignores events for unknown order IDs', () => {
    const posId = setupOpenPosition(4.00);

    manager.onOrderEvent(makeFillEvent(77777, 5.00));

    const db = getAccountDb();
    const pos = db.prepare('SELECT * FROM positions WHERE id = ?').get(posId) as any;
    expect(pos.status).toBe('OPENING');
  });
});

describe('PositionOrderManager.reconcileFromBroker()', () => {
  let manager: PositionOrderManager;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
    initAccountDb(TEST_DB);
    const stream = new AccountStream();
    manager = new PositionOrderManager(stream);
  });

  afterEach(() => {
    manager.stop();
    closeAccountDb();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(TEST_DB + '-wal')) fs.unlinkSync(TEST_DB + '-wal');
    if (fs.existsSync(TEST_DB + '-shm')) fs.unlinkSync(TEST_DB + '-shm');
  });

  it('adopts broker position not in DB as OPENING', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    const symbol = `SPXW${expiryCode}C06500000`;

    const brokerPositions = [{
      symbol,
      side: 'call',
      strike: 6500,
      expiry: today,
      quantity: 2,
      entryPrice: 3.80,
    }];

    const adopted = manager.reconcileFromBroker('test-config', config, brokerPositions);

    expect(adopted).toHaveLength(1);
    const pos = manager.getOpenPositions('test-config');
    expect(pos).toHaveLength(1);
    expect(pos[0].status).toBe('OPEN');
    expect(pos[0].symbol).toBe(symbol);
    expect(pos[0].quantity).toBe(2);
    expect(pos[0].basketMember).toBe('reconciled');
  });

  it('warns about OPEN position not at broker but does not close it', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    const symbol = `SPXW${expiryCode}C06500000`;

    manager.insertTestPosition({
      configId: 'test-config',
      symbol,
      side: 'call',
      strike: 6500,
      status: 'OPEN',
    });

    const orphaned = manager.reconcileFromBroker('test-config', config, []);

    expect(orphaned).toHaveLength(0);
    const db = getAccountDb();
    const pos = db.prepare("SELECT * FROM positions WHERE config_id = 'test-config'").get() as any;
    expect(pos.status).toBe('OPEN');
  });

  it('does nothing when DB and broker agree', () => {
    const config = makeConfig();
    const today = TODAY();
    const expiryCode = today.replace(/-/g, '').slice(2);
    const symbol = `SPXW${expiryCode}C06500000`;

    manager.insertTestPosition({
      configId: 'test-config',
      symbol,
      side: 'call',
      strike: 6500,
      status: 'OPEN',
    });

    const brokerPositions = [{
      symbol,
      side: 'call',
      strike: 6500,
      expiry: today,
      quantity: 1,
      entryPrice: 5.00,
    }];

    const adopted = manager.reconcileFromBroker('test-config', config, brokerPositions);

    expect(adopted).toHaveLength(0);
    const db = getAccountDb();
    const positions = db.prepare("SELECT * FROM positions WHERE config_id = 'test-config'").all() as any[];
    expect(positions).toHaveLength(1);
    expect(positions[0].status).toBe('OPEN');
  });

  it('ignores broker positions from other expiries', () => {
    const config = makeConfig();

    const brokerPositions = [{
      symbol: 'SPXW260401C06500000',
      side: 'call',
      strike: 6500,
      expiry: '2026-04-01',
      quantity: 1,
      entryPrice: 5.00,
    }];

    const adopted = manager.reconcileFromBroker('test-config', config, brokerPositions);

    expect(adopted).toHaveLength(0);
  });
});
