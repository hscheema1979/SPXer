/**
 * Tests for src/agent/position-manager.ts
 *
 * PositionManager now handles broker-side position tracking only.
 * HMA cross detection and exit monitoring are handled by
 * src/core/strategy-engine.ts tick().
 *
 * Tests cover: add/remove/count/getAll, reconcileFromBroker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock all external dependencies before importing the module under test
vi.mock('axios');
vi.mock('../../src/agent/trade-executor', () => ({
  closePosition: vi.fn(),
  cancelOcoLegs: vi.fn(),
}));
vi.mock('../../src/agent/audit-log', () => ({
  logClose: vi.fn(),
}));
vi.mock('../../src/config', () => ({
  config: {
    tradierToken: 'test-token',
    tradierAccountId: 'test-account',
  },
  TRADIER_BASE: 'https://api.tradier.com/v1',
}));

import axios from 'axios';
import { PositionManager } from '../../src/agent/position-manager';
import type { OpenPosition } from '../../src/agent/types';
import type { Config } from '../../src/config/types';

const mockedAxios = vi.mocked(axios);

// Minimal config for PositionManager
function makeConfig(overrides?: Partial<Config>): Config {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    scanners: { enabled: false, models: [], cycleIntervalSec: 60, minConfidenceToEscalate: 0.5, promptAssignments: {}, defaultPromptId: '' },
    judges: { enabled: false, models: [], activeJudge: '', consensusRule: 'primary-decides', confidenceThreshold: 0.5, entryCooldownSec: 0, promptId: '' },
    regime: { enabled: false, mode: 'disabled', classification: { trendThreshold: 0.15, lookbackBars: 20, openingRangeMinutes: 15 }, timeWindows: { morningEnd: '10:15', middayEnd: '14:00', gammaExpiryStart: '14:00', noTradeStart: '15:55' }, signalGates: {} as any },
    signals: {
      enableRsiCrosses: false, enableHmaCrosses: true, enablePriceCrossHma: false, enableEmaCrosses: false,
      requireUnderlyingHmaCross: false, hmaCrossFast: 3, hmaCrossSlow: 17,
      emaCrossFast: 9, emaCrossSlow: 21,
      signalTimeframe: '1m', directionTimeframe: '1m', exitTimeframe: '',
      hmaCrossTimeframe: null, rsiCrossTimeframe: null, emaCrossTimeframe: null, priceCrossHmaTimeframe: null,
      targetOtmDistance: null, targetContractPrice: null, maxEntryPrice: null,
      rsiOversold: 20, rsiOverbought: 80, optionRsiOversold: 40, optionRsiOverbought: 60,
      enableKeltnerGate: false, kcEmaPeriod: 20, kcAtrPeriod: 14, kcMultiplier: 2.5, kcSlopeLookback: 5, kcSlopeThreshold: 0.3,
    },
    position: { stopLossPercent: 70, takeProfitMultiplier: 1.4, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1.0 },
    risk: { maxDailyLoss: 999, maxTradesPerDay: 999, maxRiskPerTrade: 2000, cutoffTimeET: '16:00', minMinutesToClose: 15 },
    strikeSelector: { strikeSearchRange: 80, contractPriceMin: 0.2, contractPriceMax: 9999 },
    timeWindows: { sessionStart: '09:30', sessionEnd: '15:45', activeStart: '09:30', activeEnd: '15:45', skipWeekends: true, skipHolidays: true },
    escalation: { signalTriggersJudge: false, scannerTriggersJudge: false, requireScannerAgreement: false, requireSignalAgreement: false },
    exit: { strategy: 'scannerReverse', trailingStopEnabled: false, trailingStopPercent: 20, timeBasedExitEnabled: false, timeBasedExitMinutes: 30, reversalSizeMultiplier: 1.0 },
    narrative: { buildOvernightContext: false, barHistoryDepth: 60, trackTrajectory: false },
    pipeline: { providers: { tradier: { enabled: true }, yahoo: { enabled: true }, tvScreener: { enabled: true } } },
    sizing: { baseDollarsPerTrade: 200 },
    execution: { accountId: 'test-account', symbol: 'XSP', optionPrefix: 'XSP', strikeDivisor: 10, strikeInterval: 1 },
    ...overrides,
  } as Config;
}

function makePosition(overrides?: Partial<OpenPosition>): OpenPosition {
  return {
    id: 'pos-1',
    symbol: 'XSP260331P00643000',
    side: 'put',
    strike: 643,
    expiry: '2026-03-31',
    entryPrice: 1.63,
    quantity: 1,
    stopLoss: 0.49,
    takeProfit: 2.28,
    openedAt: Date.now() - 60000,
    ...overrides,
  };
}

describe('PositionManager', () => {
  let pm: PositionManager;
  let cfg: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    cfg = makeConfig();
    pm = new PositionManager(cfg, false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic operations', () => {
    it('add/count/getAll/remove', () => {
      expect(pm.count()).toBe(0);

      const pos = makePosition();
      pm.add(pos);
      expect(pm.count()).toBe(1);
      expect(pm.getAll()).toHaveLength(1);
      expect(pm.getAll()[0].symbol).toBe('XSP260331P00643000');

      pm.remove(pos.id);
      expect(pm.count()).toBe(0);
    });

    it('tracks multiple positions', () => {
      pm.add(makePosition({ id: 'p1', symbol: 'XSP260331C00650000' }));
      pm.add(makePosition({ id: 'p2', symbol: 'XSP260331P00640000' }));
      expect(pm.count()).toBe(2);
      expect(pm.getAll()).toHaveLength(2);

      pm.remove('p1');
      expect(pm.count()).toBe(1);
      expect(pm.getAll()[0].symbol).toBe('XSP260331P00640000');
    });

    it('remove is a no-op for unknown IDs', () => {
      pm.add(makePosition());
      pm.remove('nonexistent');
      expect(pm.count()).toBe(1);
    });
  });

  describe('reconcileFromBroker', () => {
    it('skips reconciliation in paper mode', async () => {
      const paperPm = new PositionManager(cfg, true);
      const count = await paperPm.reconcileFromBroker();
      expect(count).toBe(0);
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('handles empty positions from broker', async () => {
      mockedAxios.get = vi.fn().mockResolvedValue({
        data: { positions: { position: null } },
      });

      const count = await pm.reconcileFromBroker(cfg.execution);
      expect(count).toBe(0);
      expect(pm.count()).toBe(0);
    });

    it('adopts orphan positions from broker', async () => {
      // First call: positions, second call: orders
      mockedAxios.get = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/positions')) {
          return Promise.resolve({
            data: {
              positions: {
                position: {
                  symbol: 'XSP260401C00650000',
                  quantity: 2,
                  cost_basis: 326, // $1.63 per contract × 2 × 100
                  date_acquired: '2026-04-01T10:00:00Z',
                },
              },
            },
          });
        }
        if (url.includes('/orders')) {
          return Promise.resolve({ data: { orders: { order: null } } });
        }
        return Promise.resolve({ data: {} });
      });

      // Mock the OCO submission
      mockedAxios.post = vi.fn().mockResolvedValue({
        data: { order: { id: 99999 } },
      });

      const count = await pm.reconcileFromBroker(cfg.execution);
      expect(count).toBe(1);
      expect(pm.count()).toBe(1);

      const adopted = pm.getAll()[0];
      expect(adopted.symbol).toBe('XSP260401C00650000');
      expect(adopted.side).toBe('call');
      expect(adopted.strike).toBe(650);
      expect(adopted.quantity).toBe(2);
    });

    it('handles API errors gracefully', async () => {
      mockedAxios.get = vi.fn().mockRejectedValue(new Error('Network error'));

      const count = await pm.reconcileFromBroker(cfg.execution);
      expect(count).toBe(0);
      expect(pm.count()).toBe(0);
    });
  });
});
