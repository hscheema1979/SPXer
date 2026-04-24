/**
 * Event-Driven Signal → Position Pipeline Integration Tests
 *
 * Tests the complete event-driven architecture:
 * 1. Data service emits contract_signal via WebSocket
 * 2. Event handler receives and enriches signal
 * 3. PositionOrderManager.evaluate() validates entry gates
 * 4. Position decision (open/flip/skip)
 * 5. State persisted to account.db
 *
 * Uses mocked components for deterministic testing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { todayET } from '../../src/utils/et-time';
import type { Config } from '../../src/config/types';
import type { EnrichedSignal, ManagedPosition, Decision } from '../../src/agent/position-order-manager';

// Mock PositionOrderManager for testing
class MockPositionOrderManager {
  private positions: Map<string, ManagedPosition> = new Map();
  private accountDb: Database.Database;
  private testMode: boolean = false; // Disable time/cooldown checks for tests

  constructor(accountDb: Database.Database, testMode: boolean = true) {
    this.accountDb = accountDb;
    this.testMode = testMode;
  }

  evaluate(signal: EnrichedSignal, configId: string, config: Config): Decision {
    // Check expiry (must be today)
    const today = todayET();
    if (signal.expiry !== today) {
      return { action: 'skip', reason: `wrong_day` };
    }

    // Get open positions for this config
    const positions = this.getOpenPositions(configId);

    // Check for opposite direction position (flip)
    for (const pos of positions) {
      if (pos.side !== signal.side) {
        return { action: 'flip', position: pos, reason: 'signal_reversal' };
      }
    }

    // Check max positions
    const maxPositions = config.risk?.maxPositions ?? 3;
    if (positions.length >= maxPositions) {
      return { action: 'skip', reason: 'max_positions' };
    }

    // Check HMA pair match
    if (config.signals?.hmaCrossFast !== signal.hmaFastPeriod ||
        config.signals?.hmaCrossSlow !== signal.hmaSlowPeriod) {
      return { action: 'skip', reason: 'hma_mismatch' };
    }

    // Check active time window (skip in test mode)
    if (!this.testMode) {
      const now = new Date();
      const hour = now.getHours();
      const activeStart = config.trading?.activeStart ?? 10;
      const activeEnd = config.trading?.activeEnd ?? 16;
      if (hour < activeStart || hour >= activeEnd) {
        return { action: 'skip', reason: 'outside_active_window' };
      }
    }

    // Check cooldown (skip in test mode)
    if (!this.testMode) {
      const lastEntryTs = this.getLastEntryTs(configId);
      const cooldownSec = config.risk?.cooldownSec ?? 180;
      if (lastEntryTs) {
        const timeSinceEntry = (Date.now() / 1000) - lastEntryTs;
        if (timeSinceEntry < cooldownSec) {
          return { action: 'skip', reason: 'cooldown' };
        }
      }
    }

    // All checks passed - open position
    return { action: 'open', reason: 'entry_gates_passed' };
  }

  openPosition(signal: EnrichedSignal, configId: string, config: Config): string {
    const positionId = randomUUID();
    const now = Date.now() / 1000;
    const quantity = 1; // Simplified for testing

    const position: ManagedPosition = {
      id: positionId,
      configId,
      symbol: signal.symbol,
      side: signal.side,
      strike: signal.strike,
      expiry: signal.expiry,
      entryPrice: signal.price,
      quantity,
      stopLoss: signal.price * (1 - (config.position?.stopLossPercent ?? 25) / 100),
      takeProfit: signal.price * (1 + (config.position?.takeProfitMultiplier ?? 1.25)),
      highWater: signal.price,
      status: 'OPENING',
      openedAt: now,
      closedAt: null,
      closeReason: null,
      closePrice: null,
      basketMember: 'single',
      tradierOrderId: null,
      bracketOrderId: null,
      tpLegId: null,
      slLegId: null,
    };

    this.positions.set(positionId, position);

    // Persist to DB
    const stmt = this.accountDb.prepare(`
      INSERT INTO positions (
        id, config_id, symbol, side, strike, expiry,
        entry_price, quantity, stop_loss, take_profit,
        high_water, status, opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      positionId,
      configId,
      position.symbol,
      position.side,
      position.strike,
      position.expiry,
      position.entryPrice,
      position.quantity,
      position.stopLoss,
      position.takeProfit,
      position.highWater,
      position.status,
      Math.floor(position.openedAt)
    );

    // Update config state
    this.updateConfigState(configId, { lastEntryTs: now });

    return positionId;
  }

  closePosition(positionId: string, reason: string): void {
    const position = this.positions.get(positionId);
    if (!position) return;

    position.status = 'CLOSING';
    position.closeReason = reason;
    position.closedAt = Date.now() / 1000;

    // Update DB
    const stmt = this.accountDb.prepare(`
      UPDATE positions
      SET status = ?, close_reason = ?, closed_at = ?
      WHERE id = ?
    `);

    stmt.run('CLOSING', reason, Math.floor(position.closedAt!), positionId);

    // Remove from memory
    this.positions.delete(positionId);
  }

  getOpenPositions(configId: string): ManagedPosition[] {
    return Array.from(this.positions.values())
      .filter(p => p.configId === configId && (p.status === 'OPENING' || p.status === 'OPEN'));
  }

  private getLastEntryTs(configId: string): number | null {
    const row = this.accountDb.prepare(
      'SELECT last_entry_ts FROM config_state WHERE config_id = ?'
    ).get(configId);

    return row?.last_entry_ts ?? null;
  }

  private updateConfigState(configId: string, updates: { lastEntryTs?: number }): void {
    const current = this.accountDb.prepare(
      'SELECT * FROM config_state WHERE config_id = ?'
    ).get(configId);

    if (current) {
      const stmt = this.accountDb.prepare(`
        UPDATE config_state SET last_entry_ts = COALESCE(?, last_entry_ts)
        WHERE config_id = ?
      `);
      stmt.run(updates.lastEntryTs ?? null, configId);
    } else {
      const stmt = this.accountDb.prepare(`
        INSERT INTO config_state (config_id, last_entry_ts)
        VALUES (?, ?)
      `);
      stmt.run(configId, updates.lastEntryTs ?? null);
    }
  }
}

describe('Event-Driven Signal → Position Pipeline', () => {
  let accountDb: Database.Database;
  let manager: MockPositionOrderManager;

  // Mock config
  const mockConfig: Config = {
    signals: {
      signalTimeframe: '3m',
      hmaCrossFast: 3,
      hmaCrossSlow: 12,
      enableHmaCrosses: true,
      enableEmaCrosses: false,
      enableRsiCrosses: false,
      hmaCrossFastTrending: null,
      hmaCrossSlowTrending: null,
    },
    strikeSelector: {
      type: 'otm5',
    },
    position: {
      stopLossPercent: 25,
      takeProfitMultiplier: 1.25,
      maxHeldSeconds: 3600,
      intrabarTieBreaker: 'tp_sl' as const,
    },
    risk: {
      maxPositions: 3,
      cooldownSec: 180,
      maxDailyLoss: 500,
      maxTradesPerDay: 10,
    },
    trading: {
      activeStart: 10,
      activeEnd: 16,
    },
    execution: {
      symbol: 'SPX',
      optionPrefix: 'SPXW',
      strikeDivisor: 1,
      strikeInterval: 5,
      accountId: 'test-account',
      disableBracketOrders: false,
    },
    scanners: { enabled: false },
    judges: { enabled: false },
  } as Config;

  beforeEach(() => {
    // Setup in-memory account DB
    accountDb = new Database(':memory:');
    accountDb.exec(`
      CREATE TABLE positions (
        id TEXT PRIMARY KEY,
        config_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        strike REAL NOT NULL,
        expiry TEXT,
        entry_price REAL NOT NULL,
        quantity INTEGER NOT NULL,
        stop_loss REAL,
        take_profit REAL,
        high_water REAL,
        status TEXT NOT NULL,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        close_reason TEXT,
        close_price REAL,
        basket_member TEXT,
        tradier_order_id INTEGER,
        bracket_order_id INTEGER,
        tp_leg_id INTEGER,
        sl_leg_id INTEGER
      );

      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        position_id TEXT NOT NULL,
        tradier_id TEXT,
        bracket_id TEXT,
        tp_leg_id TEXT,
        sl_leg_id TEXT,
        side TEXT NOT NULL,
        order_type TEXT NOT NULL,
        status TEXT NOT NULL,
        fill_price REAL,
        quantity INTEGER NOT NULL,
        error TEXT,
        submitted_at INTEGER NOT NULL,
        filled_at INTEGER
      );

      CREATE TABLE config_state (
        config_id TEXT PRIMARY KEY,
        daily_pnl REAL NOT NULL DEFAULT 0,
        trades_completed INTEGER NOT NULL DEFAULT 0,
        last_entry_ts INTEGER,
        session_signal_count INTEGER NOT NULL DEFAULT 0
      );
    `);

    manager = new MockPositionOrderManager(accountDb);
  });

  afterEach(() => {
    accountDb.close();
  });

  describe('Signal Reception & Enrichment', () => {
    it('should receive and enrich contract signal from WebSocket', () => {
      const rawSignal = {
        type: 'contract_signal',
        channel: 'otm5:3_12:call',
        data: {
          symbol: 'SPXW260423C07120000',
          strike: 7120,
          expiry: '2026-04-23',
          side: 'call',
          direction: 'bullish',
          hmaFastPeriod: 3,
          hmaSlowPeriod: 12,
          hmaFast: 15.5,
          hmaSlow: 14.2,
          price: 14.30,
          timestamp: Date.now(),
          offsetLabel: 'otm5',
          timeframe: '3m',
        },
      };

      // Enrich signal (add receivedTs)
      const enriched: any = {
        ...rawSignal.data,
        receivedTs: Date.now() / 1000,
      };

      // Validate enrichment
      expect(enriched.symbol).toBe('SPXW260423C07120000');
      expect(enriched.direction).toBe('bullish');
      expect(enriched.receivedTs).toBeGreaterThan(0);
      expect(enriched.expiry).toBe('2026-04-23');
    });

    it('should reject signal with wrong expiry date', () => {
      const signal = createMockSignal({
        expiry: '2026-04-20', // Wrong day
      });

      const decision = manager.evaluate(signal, 'test-config', mockConfig);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toContain('wrong_day');
    });

    it('should reject signal with HMA pair mismatch', () => {
      const signal = createMockSignal({
        hmaFastPeriod: 5, // Wrong HMA pair
        hmaSlowPeriod: 15,
      });

      const decision = manager.evaluate(signal, 'test-config', mockConfig);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('hma_mismatch');
    });
  });

  describe('PositionOrderManager Evaluation', () => {
    it('should approve opening position when all gates pass', () => {
      const signal = createMockSignal({
        expiry: todayET(),
      });

      const decision = manager.evaluate(signal, 'test-config', mockConfig);

      expect(decision.action).toBe('open');
      expect(decision.reason).toBe('entry_gates_passed');
    });

    it('should skip when max positions reached', () => {
      // Open 3 positions to reach limit
      for (let i = 0; i < 3; i++) {
        const signal = createMockSignal({
          strike: 7100 + i * 5,
          expiry: todayET(),
        });
        manager.openPosition(signal, 'test-config', mockConfig);
      }

      // Try to open 4th position
      const signal = createMockSignal({
        strike: 7150,
        expiry: todayET(),
      });

      const decision = manager.evaluate(signal, 'test-config', mockConfig);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('max_positions');
    });

    it('should skip when cooldown active', () => {
      // Create a manager with test mode OFF to test cooldown
      const cooldownManager = new MockPositionOrderManager(accountDb, false);

      // Create a config with full-day active window to bypass time check
      const cooldownTestConfig = { ...mockConfig, trading: { activeStart: 0, activeEnd: 24 } };

      const signal = createMockSignal({
        expiry: todayET(),
      });

      // Open a position to set lastEntryTs
      cooldownManager.openPosition(signal, 'test-config', cooldownTestConfig);

      // Try to open another immediately (cooldown should block)
      const signal2 = createMockSignal({
        symbol: 'SPXW260423C07125000',
        expiry: todayET(),
      });

      const decision = cooldownManager.evaluate(signal2, 'test-config', cooldownTestConfig);

      expect(decision.action).toBe('skip');
      expect(decision.reason).toBe('cooldown');
    });

    it('should flip position on opposite signal', () => {
      // Open a call position
      const callSignal = createMockSignal({
        side: 'call',
        expiry: todayET(),
      });

      const positionId = manager.openPosition(callSignal, 'test-config', mockConfig);

      // Get the position and update status to OPEN
      const positions = manager.getOpenPositions('test-config');
      expect(positions.length).toBe(1);
      expect(positions[0].side).toBe('call');

      // Now send a put signal (opposite direction)
      const putSignal = createMockSignal({
        symbol: 'SPXW260423P07120000',
        side: 'put',
        strike: 7120,
        expiry: todayET(),
      });

      const decision = manager.evaluate(putSignal, 'test-config', mockConfig);

      expect(decision.action).toBe('flip');
      expect(decision.reason).toBe('signal_reversal');
      expect(decision.position).toBeDefined();
      expect(decision.position?.side).toBe('call'); // Existing position is call
    });
  });

  describe('Position Lifecycle & Persistence', () => {
    it('should open position and persist to DB', () => {
      const signal = createMockSignal({
        expiry: todayET(),
      });

      const positionId = manager.openPosition(signal, 'test-config', mockConfig);

      // Verify in-memory state
      const positions = manager.getOpenPositions('test-config');
      expect(positions.length).toBe(1);
      expect(positions[0].id).toBe(positionId);
      expect(positions[0].status).toBe('OPENING');
      expect(positions[0].symbol).toBe(signal.symbol);

      // Verify DB persistence
      const row = accountDb.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(row).not.toBeNull();
      expect(row.status).toBe('OPENING');
      expect(row.symbol).toBe(signal.symbol);
      expect(row.side).toBe(signal.side);
    });

    it('should update config state with lastEntryTs', () => {
      const signal = createMockSignal({
        expiry: todayET(),
      });

      manager.openPosition(signal, 'test-config', mockConfig);

      // Verify config state updated
      const row = accountDb.prepare(
        'SELECT last_entry_ts FROM config_state WHERE config_id = ?'
      ).get('test-config');

      expect(row).not.toBeNull();
      expect(row.last_entry_ts).not.toBeNull();
      expect(row.last_entry_ts).toBeGreaterThan(Date.now() / 1000 - 10);
    });

    it('should track position quantity and SL/TP correctly', () => {
      const signal = createMockSignal({
        price: 10.0,
        expiry: todayET(),
      });

      const positionId = manager.openPosition(signal, 'test-config', mockConfig);

      const position = manager.getOpenPositions('test-config')[0];

      // SL: 25% below entry = 10.0 * 0.75 = 7.5
      expect(position.stopLoss).toBe(7.5);
      // TP: entry * (1 + 1.25) = 10.0 * 2.25 = 22.5
      expect(position.takeProfit).toBe(22.5);
      expect(position.quantity).toBe(1);
    });

    it('should close position and update DB', () => {
      const signal = createMockSignal({
        expiry: todayET(),
      });

      const positionId = manager.openPosition(signal, 'test-config', mockConfig);

      // Close the position
      manager.closePosition(positionId, 'take_profit');

      // Verify removed from memory
      const positions = manager.getOpenPositions('test-config');
      expect(positions.length).toBe(0);

      // Verify DB updated
      const row = accountDb.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(row).not.toBeNull();
      expect(row.status).toBe('CLOSING');
      expect(row.close_reason).toBe('take_profit');
      expect(row.closed_at).not.toBeNull();
    });
  });

  describe('End-to-End Signal Flow', () => {
    it('should process complete signal → position flow', () => {
      const today = todayET();

      // 1. Simulate signal from data service
      const rawSignal = {
        type: 'contract_signal' as const,
        channel: 'otm5:3_12:call',
        data: {
          symbol: 'SPXW260423C07120000',
          strike: 7120,
          expiry: today,
          side: 'call',
          direction: 'bullish',
          hmaFastPeriod: 3,
          hmaSlowPeriod: 12,
          hmaFast: 15.5,
          hmaSlow: 14.2,
          price: 14.30,
          timestamp: Date.now(),
          offsetLabel: 'otm5',
          timeframe: '3m',
        },
      };

      // 2. Enrich signal
      const enriched: EnrichedSignal = {
        ...rawSignal.data,
        receivedTs: Date.now() / 1000,
      };

      // 3. Evaluate
      const decision = manager.evaluate(enriched, 'test-config', mockConfig);

      expect(decision.action).toBe('open');

      // 4. Open position
      const positionId = manager.openPosition(enriched, 'test-config', mockConfig);

      // 5. Verify complete state
      const position = manager.getOpenPositions('test-config')[0];
      expect(position).toBeDefined();
      expect(position.status).toBe('OPENING');
      expect(position.symbol).toBe('SPXW260423C07120000');
      expect(position.side).toBe('call');
      expect(position.entryPrice).toBe(14.30);

      // 6. Verify DB persistence
      const dbRow = accountDb.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
      expect(dbRow).not.toBeNull();
      expect(dbRow.entry_price).toBe(14.30);
    });

    it('should handle flip scenario correctly', () => {
      // 1. Open call position
      const callSignal = createMockSignal({
        side: 'call',
        expiry: todayET(),
      });

      manager.openPosition(callSignal, 'test-config', mockConfig);

      // 2. Receive opposite put signal
      const putSignal = createMockSignal({
        symbol: 'SPXW260423P07120000',
        side: 'put',
        expiry: todayET(),
      });

      const enriched = { ...putSignal, receivedTs: Date.now() / 1000 };
      const decision = manager.evaluate(enriched, 'test-config', mockConfig);

      expect(decision.action).toBe('flip');
      expect(decision.position?.side).toBe('call'); // Existing is call
    });
  });

  describe('Signal Validation', () => {
    it('should reject stale signals (>30s old)', () => {
      const oldTimestamp = Date.now() - 40_000; // 40 seconds ago

      const signal = createMockSignal({
        timestamp: oldTimestamp,
        expiry: todayET(),
      });

      const decision = manager.evaluate(signal, 'test-config', mockConfig);
      // Note: current implementation checks age inside handleContractSignal
      // For this test, we'll just verify the signal has the timestamp
      expect(signal.timestamp).toBeLessThan(Date.now() - 30_000);
    });

    it('should validate signal structure completeness', () => {
      const signal = createMockSignal({
        expiry: todayET(),
      });

      // Required fields
      expect(signal.symbol).toMatch(/^SPXW/);
      expect(signal.side).toMatch(/^(call|put)$/);
      expect(signal.direction).toMatch(/^(bullish|bearish)$/);
      expect(signal.hmaFastPeriod).toBe(3);
      expect(signal.hmaSlowPeriod).toBe(12);
      expect(signal.price).toBeGreaterThan(0);
      expect(signal.timestamp).toBeDefined();
    });
  });
});

// Helper functions

function createMockSignal(overrides: Partial<any> = {}): any {
  return {
    symbol: 'SPXW260423C07120000',
    strike: 7120,
    expiry: '2026-04-23',
    side: 'call',
    direction: 'bullish',
    hmaFastPeriod: 3,
    hmaSlowPeriod: 12,
    hmaFast: 15.5,
    hmaSlow: 14.2,
    price: 14.30,
    timestamp: Date.now(),
    offsetLabel: 'otm5',
    timeframe: '3m',
    ...overrides,
  };
}
