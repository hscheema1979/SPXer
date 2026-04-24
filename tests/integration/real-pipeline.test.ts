/**
 * Integration tests for the REAL event-driven signal → position pipeline.
 *
 * These tests use the actual PositionOrderManager from src/agent/position-order-manager.ts
 * and test it against real infrastructure components (not mocks).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { unlinkSync, existsSync } from 'fs';
import { PositionOrderManager, type EnrichedSignal } from '../../src/agent/position-order-manager';
import type { Config } from '../../src/config/types';
import { todayET } from '../../src/utils/et-time';
import { initAccountDb, closeAccountDb, getAccountDb } from '../../src/storage/db';

// Mock AccountStream for testing (external dependency)
class MockAccountStream {
  private eventHandlers: Array<(event: any) => void> = [];

  onEvent(handler: (event: any) => void): void {
    this.eventHandlers.push(handler);
  }

  stop(): void {
    // No-op for mock
  }

  // Test helper: simulate order fill event
  simulateFill(positionId: string, fillPrice: number): void {
    const event = {
      order_id: 'test-order',
      position_id: positionId,
      status: 'filled',
      fill_price: fillPrice,
      quantity: 1,
      timestamp: Date.now() / 1000,
    };
    this.eventHandlers.forEach(h => h(event));
  }
}

// Test database path
const TEST_DB_PATH = '/tmp/test-real-pipeline.db';

// Helper: Create test config
function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    id: 'test-config',
    description: 'Test config for real pipeline tests',
    symbol: 'SPX',
    timeframe: '1m',
    position: {
      maxPositionsOpen: 3,
      stopLossPercent: 25,
      takeProfitMultiplier: 1.25,
      ...overrides.position,
    },
    risk: {
      maxDailyLoss: 1000,
      maxTradesPerDay: 10,
      cooldownSec: 180,
      ...overrides.risk,
    },
    trading: {
      activeStart: 10,
      activeEnd: 16,
      ...overrides.trading,
    },
    signals: {
      hmaCrossFast: 3,
      hmaCrossSlow: 12,
      ...overrides.signals,
    },
    ...overrides,
  } as Config;
}

// Helper: Create enriched signal
function createEnrichedSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    symbol: 'SPXW260423C07100000',
    strike: 7100,
    expiry: todayET(),
    side: 'call',
    direction: 'bullish',
    price: 10.0,
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    channel: 'otm5:3_12:call',
    receivedTs: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// Helper: Setup test database
function setupTestDb(): void {
  // Remove existing test DB
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }

  // Initialize the real account DB system
  initAccountDb(TEST_DB_PATH);
}

describe('Real PositionOrderManager Pipeline', () => {
  let manager: PositionOrderManager;
  let mockAccountStream: MockAccountStream;

  beforeEach(() => {
    setupTestDb();
    mockAccountStream = new MockAccountStream();
    manager = new PositionOrderManager(mockAccountStream as any);
    manager.start();
  });

  afterEach(() => {
    manager.stop();
    closeAccountDb();
    if (existsSync(TEST_DB_PATH)) {
      unlinkSync(TEST_DB_PATH);
    }
  });

  describe('PositionOrderManager.evaluate()', () => {
    it('should approve opening position when all gates pass', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      const decision = manager.evaluate(signal, 'test-config', config);

      expect(decision.action).toBe('open');
      expect(decision.reason).toBe('no positions, gates passed');
    });

    it('should skip when signal expiry is not today', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal({ expiry: '2099-01-01' });

      const decision = manager.evaluate(signal, 'test-config', config);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('wrong day');
    });

    it('should skip when same direction position exists', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal({ side: 'call' });

      // Open a call position first
      const positionId = manager.openPosition(signal, 'test-config', config, 1);

      // Simulate fill to move to OPEN status
      mockAccountStream.simulateFill(positionId, 10.0);

      // Try to open another call
      const decision = manager.evaluate(signal, 'test-config', config);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('same direction');
    });

    it('should flip when opposite direction signal received', () => {
      const config = createTestConfig();

      // Open a call position first
      const callSignal = createEnrichedSignal({ side: 'call', symbol: 'SPXW260423C07100000' });
      const positionId = manager.openPosition(callSignal, 'test-config', config, 1);
      mockAccountStream.simulateFill(positionId, 10.0);

      // Send a put signal (should trigger flip)
      const putSignal = createEnrichedSignal({
        side: 'put',
        symbol: 'SPXW260423P00700000',
        strike: 7100,
      });

      const decision = manager.evaluate(putSignal, 'test-config', config);

      expect(decision.action).toBe('flip');
      expect(decision.reason).toContain('direction reversal');
      expect(decision.position?.id).toBe(positionId);
    });

    it('should skip when max positions reached', () => {
      const config = createTestConfig({ position: { maxPositionsOpen: 1 } });

      // Open first position
      const signal1 = createEnrichedSignal({ symbol: 'SPXW260423C07100000' });
      const pos1 = manager.openPosition(signal1, 'test-config', config, 1);
      mockAccountStream.simulateFill(pos1, 10.0);

      // Try to open second (should skip - max is 1)
      const signal2 = createEnrichedSignal({ symbol: 'SPXW260423C07150000', strike: 7150 });
      const decision = manager.evaluate(signal2, 'test-config', config);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('max positions');
    });

    it('should skip when transition in progress', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      // Open a position (will be in OPENING state until fill)
      const positionId = manager.openPosition(signal, 'test-config', config, 1);

      // Don't simulate fill - position stays in OPENING
      // Try to open another position
      const signal2 = createEnrichedSignal({ symbol: 'SPXW260423C07150000', strike: 7150 });
      const decision = manager.evaluate(signal2, 'test-config', config);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('transition in progress');
    });
  });

  describe('PositionOrderManager.openPosition()', () => {
    it('should create position record in database', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal({ price: 10.0 });

      const positionId = manager.openPosition(signal, 'test-config', config, 1);

      // Check position was persisted
      const position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);

      expect(position).toBeDefined();
      expect(position!.id).toBe(positionId);
      expect(position!.status).toBe('OPENING');
      expect(position!.side).toBe('call');
      expect(position!.entry_price).toBe(10.0);
      expect(position!.stop_loss).toBe(7.5); // 25% SL
      expect(position!.take_profit).toBeCloseTo(13.125, 2); // 10 * (1 + 0.25 * 1.25)
    });

    it('should create order record in database', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      const positionId = manager.openPosition(signal, 'test-config', config, 5);

      // Check order was persisted
      const order = getAccountDb().prepare('SELECT * FROM orders WHERE position_id = ?').get(positionId);

      expect(order).toBeDefined();
      expect(order!.position_id).toBe(positionId);
      expect(order!.side).toBe('buy_to_open');
      expect(order!.order_type).toBe('market');
      expect(order!.quantity).toBe(5);
      expect(order!.status).toBe('PENDING');
    });

    it('should update config state with lastEntryTs', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      manager.openPosition(signal, 'test-config', config, 1);

      // Check config state was updated
      const state = getAccountDb().prepare('SELECT * FROM config_state WHERE config_id = ?').get('test-config');

      expect(state).toBeDefined();
      expect(state!.last_entry_ts).toBe(signal.receivedTs);
      expect(state!.session_signal_count).toBe(1);
    });

    it('should calculate SL/TP correctly', () => {
      const config = createTestConfig({
        position: {
          stopLossPercent: 20,  // 20% SL
          takeProfitMultiplier: 1.5,  // TP = 20% * 1.5 = 30% gain
        },
      });
      const signal = createEnrichedSignal({ price: 10.0 });

      const positionId = manager.openPosition(signal, 'test-config', config, 1);
      const position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);

      expect(position!.stop_loss).toBe(8.0); // 10 * (1 - 0.20)
      expect(position!.take_profit).toBe(13.0); // 10 * (1 + 0.20 * 1.5)
    });
  });

  describe('Complete signal → position flow', () => {
    it('should process signal → evaluate → open → fill → open position', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      // Step 1: Evaluate signal
      const decision = manager.evaluate(signal, 'test-config', config);
      expect(decision.action).toBe('open');

      // Step 2: Open position
      const positionId = manager.openPosition(signal, 'test-config', config, 1);

      // Step 3: Verify position persisted
      let position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(position!.status).toBe('OPENING');

      // Step 4: Simulate fill event
      mockAccountStream.simulateFill(positionId, 10.25);

      // Step 5: Verify position moved to OPEN
      position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(position!.status).toBe('OPEN');
    });

    it('should handle basket configs with multiple members', () => {
      const config = createTestConfig();
      const callSignal = createEnrichedSignal({ side: 'call', symbol: 'SPXW260423C07050000', strike: 7050 });
      const putSignal = createEnrichedSignal({ side: 'put', symbol: 'SPXW260423P00705000', strike: 7050 });

      // Open multiple basket members
      const callPosId = manager.openPosition(callSignal, 'test-config', config, 1, 'member1');
      const putPosId = manager.openPosition(putSignal, 'test-config', config, 1, 'member2');

      // Verify both positions have correct basket_member
      const callPos = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(callPosId);
      const putPos = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(putPosId);

      expect(callPos!.basket_member).toBe('member1');
      expect(putPos!.basket_member).toBe('member2');

      // Both should be tracked
      const positions = manager.getOpenPositions('test-config');
      expect(positions.length).toBe(2);
    });
  });

  describe('Position lifecycle: OPENING → OPEN → CLOSED', () => {
    it('should transition from OPENING to OPEN on fill', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();
      const positionId = manager.openPosition(signal, 'test-config', config, 1);

      let position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(position!.status).toBe('OPENING');

      // Simulate fill
      mockAccountStream.simulateFill(positionId, 10.25);

      position = getAccountDb().prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(position!.status).toBe('OPEN');
    });
  });

  describe('Real entry gate integration', () => {
    it('should use real checkEntryGates from core module', () => {
      const config = createTestConfig();
      const signal = createEnrichedSignal();

      // The real PositionOrderManager uses checkEntryGates from src/core/entry-gate.ts
      // This test verifies that integration works
      const decision = manager.evaluate(signal, 'test-config', config);

      // If we get here without throwing, the integration works
      expect(decision).toBeDefined();
      expect(decision.action).toBe('open');
    });

    it('should respect maxTradesPerDay gate', () => {
      const config = createTestConfig({
        risk: { maxTradesPerDay: 1 },
      });

      // Open and complete first trade
      const signal1 = createEnrichedSignal({ symbol: 'SPXW260423C07100000' });
      const pos1 = manager.openPosition(signal1, 'test-config', config, 1);

      // Mark trade as completed
      const state = getAccountDb().prepare('SELECT * FROM config_state WHERE config_id = ?').get('test-config');
      getAccountDb().prepare('UPDATE config_state SET trades_completed = ? WHERE config_id = ?')
        .run(1, 'test-config');

      // Try to open second trade
      const signal2 = createEnrichedSignal({ symbol: 'SPXW260423C07150000', strike: 7150 });
      const decision = manager.evaluate(signal2, 'test-config', config);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('entry gate');
    });
  });
});
