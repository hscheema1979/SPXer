/**
 * Tests for src/agent/position-manager.ts
 *
 * Focuses on:
 * - P0-1: Failed close must NOT delete position from memory
 * - P1-5: Bracket cancel retry + order status check
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
vi.mock('../../src/utils/et-time', () => ({
  etTimeToUnixTs: vi.fn(() => Math.floor(Date.now() / 1000) + 3600), // 1hr from now
}));

import axios from 'axios';
import { PositionManager } from '../../src/agent/position-manager';
import { closePosition, cancelOcoLegs } from '../../src/agent/trade-executor';
import { logClose } from '../../src/agent/audit-log';
import type { OpenPosition } from '../../src/agent/types';
import type { Config } from '../../src/config/types';

const mockedAxios = vi.mocked(axios);
const mockedClosePosition = vi.mocked(closePosition);
const mockedCancelOcoLegs = vi.mocked(cancelOcoLegs);
const mockedLogClose = vi.mocked(logClose);

/**
 * Helper: Set HMA cross direction on the PositionManager.
 *
 * updateHmaCross reads the SECOND-TO-LAST bar (last closed candle).
 * It needs to be called twice to detect a crossover:
 *   1st call: establishes prev state
 *   2nd call: detects cross from prev → current
 *
 * For bullish cross: fast was below slow, now fast above slow.
 * For bearish cross: fast was above slow, now fast below slow.
 */
function setHmaCross(pm: PositionManager, direction: 'bullish' | 'bearish'): void {
  const bar = (hma3: number, hma17: number) => ({
    ts: Date.now(), close: 100, rsi14: 50, ema9: 100, ema21: 100,
    hma3, hma5: hma3, hma17, hma19: hma17,
  });

  if (direction === 'bullish') {
    // Step 1: fast < slow (bearish state)
    pm.updateHmaCross([bar(99, 101), bar(99, 101), bar(99, 101)]);
    // Step 2: fast > slow (bullish cross)
    pm.updateHmaCross([bar(102, 100), bar(102, 100), bar(102, 100)]);
  } else {
    // Step 1: fast > slow (bullish state)
    pm.updateHmaCross([bar(102, 100), bar(102, 100), bar(102, 100)]);
    // Step 2: fast < slow (bearish cross)
    pm.updateHmaCross([bar(99, 101), bar(99, 101), bar(99, 101)]);
  }
}

// Minimal config for PositionManager — only fields used by monitor()
function makeConfig(overrides?: Partial<Config>): Config {
  return {
    id: 'test',
    name: 'Test',
    description: '',
    createdAt: 0,
    updatedAt: 0,
    scanners: { enabled: false, models: [], cycleIntervalSec: 60, minConfidenceToEscalate: 0.5, promptAssignments: {}, defaultPromptId: '' },
    judges: { enabled: false, models: [], activeJudge: '', consensusRule: 'primary-decides', confidenceThreshold: 0.5, escalationCooldownSec: 0, promptId: '' },
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
  let dailyLossCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    cfg = makeConfig();
    pm = new PositionManager(cfg, false); // paper=false for live mode
    dailyLossCallback = vi.fn();

    // Default: Tradier quote returns a valid price triggering signal_reversal
    // (by making the price equal to entry — checkExit with scannerReverse will
    // trigger if HMA cross direction opposes position side)
    mockedAxios.get = vi.fn().mockResolvedValue({
      data: { quotes: { quote: { last: 1.50, bid: 1.48, ask: 1.52 } } },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('P0-1: Failed close must NOT delete position from memory', () => {
    it('keeps position in memory when closePosition returns an error', async () => {
      const pos = makePosition();
      pm.add(pos);

      // Set up HMA cross direction opposing the position (put) → bullish = reversal
      setHmaCross(pm, 'bullish');

      // Close fails with an error
      mockedClosePosition.mockResolvedValue({
        error: 'Sell order is for more shares than your current long position',
        paper: false,
      });

      const events = await pm.monitor(dailyLossCallback);

      // Position should still be tracked
      expect(pm.count()).toBe(1);
      expect(pm.getAll()[0].symbol).toBe('XSP260331P00643000');

      // No close events should be emitted — the caller should NOT flip
      expect(events).toHaveLength(0);

      // dailyLossCallback and logClose should NOT be called
      expect(dailyLossCallback).not.toHaveBeenCalled();
      expect(mockedLogClose).not.toHaveBeenCalled();
    });

    it('increments closeFailCount on each failed close attempt', async () => {
      const pos = makePosition();
      pm.add(pos);

      // HMA bullish → put position triggers signal_reversal
      setHmaCross(pm, 'bullish');

      mockedClosePosition.mockResolvedValue({
        error: 'You do not have enough buying power for this trade.',
        paper: false,
      });

      // First attempt
      await pm.monitor(dailyLossCallback);
      expect(pm.getAll()[0].closeFailCount).toBe(1);

      // Second attempt
      await pm.monitor(dailyLossCallback);
      expect(pm.getAll()[0].closeFailCount).toBe(2);

      // Third attempt
      await pm.monitor(dailyLossCallback);
      expect(pm.getAll()[0].closeFailCount).toBe(3);

      // Position still tracked all 3 times
      expect(pm.count()).toBe(1);
    });

    it('deletes position and emits close event when close succeeds', async () => {
      const pos = makePosition();
      pm.add(pos);

      // HMA bullish → put position triggers signal_reversal
      setHmaCross(pm, 'bullish');

      mockedClosePosition.mockResolvedValue({
        fillPrice: 1.50,
        paper: false,
      });

      const events = await pm.monitor(dailyLossCallback);

      // Position should be removed
      expect(pm.count()).toBe(0);

      // Close event emitted with correct P&L
      expect(events).toHaveLength(1);
      expect(events[0].reason).toBe('signal_reversal');
      expect(events[0].pnl).toBeCloseTo((1.50 - 1.63) * 1 * 100); // -$13

      // P&L callback and audit log called
      expect(dailyLossCallback).toHaveBeenCalledWith(expect.closeTo(-13, 0));
      expect(mockedLogClose).toHaveBeenCalledTimes(1);
    });

    it('handles paper mode — close always succeeds (no broker interaction)', async () => {
      const paperPm = new PositionManager(cfg, true); // paper=true
      const pos = makePosition();
      paperPm.add(pos);

      // HMA bullish → put position triggers signal_reversal
      setHmaCross(paperPm, 'bullish');

      // Paper closePosition always succeeds
      mockedClosePosition.mockResolvedValue({
        fillPrice: 1.50,
        paper: true,
      });

      const events = await paperPm.monitor(dailyLossCallback);

      // Paper mode: cancelBracketLegs not called
      expect(mockedCancelOcoLegs).not.toHaveBeenCalled();

      // Position closed, event emitted
      expect(paperPm.count()).toBe(0);
      expect(events).toHaveLength(1);
    });
  });

  describe('P1-5: Bracket cancel retry with status check', () => {
    it('retries cancel once on failure, succeeds on retry', async () => {
      const pos = makePosition({ bracketOrderId: 12345 });
      pm.add(pos);

      // HMA bullish → signal_reversal on put
      setHmaCross(pm, 'bullish');

      // First cancel fails, retry succeeds
      mockedCancelOcoLegs
        .mockRejectedValueOnce(new Error('Request failed with status code 400'))
        .mockResolvedValueOnce(undefined);

      mockedClosePosition.mockResolvedValue({ fillPrice: 1.50, paper: false });

      const events = await pm.monitor(dailyLossCallback);

      // cancelOcoLegs called twice (attempt + retry)
      expect(mockedCancelOcoLegs).toHaveBeenCalledTimes(2);

      // Close should succeed since retry worked
      expect(events).toHaveLength(1);
      expect(pm.count()).toBe(0);
    });

    it('checks order status when both cancel attempts fail — safe statuses allow close', async () => {
      const pos = makePosition({ bracketOrderId: 12345 });
      pm.add(pos);

      // HMA bullish → signal_reversal on put
      setHmaCross(pm, 'bullish');

      // Both cancel attempts fail
      mockedCancelOcoLegs.mockRejectedValue(new Error('Request failed with status code 400'));

      // Order status query shows the bracket was already filled
      mockedAxios.get = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/orders/12345')) {
          return Promise.resolve({ data: { order: { status: 'filled' } } });
        }
        // Default: Tradier quote
        return Promise.resolve({ data: { quotes: { quote: { last: 1.50, bid: 1.48, ask: 1.52 } } } });
      });

      mockedClosePosition.mockResolvedValue({ fillPrice: 1.50, paper: false });

      const events = await pm.monitor(dailyLossCallback);

      // Close should proceed because order was already 'filled'
      expect(events).toHaveLength(1);
      expect(pm.count()).toBe(0);
    });

    it('skips close when bracket is still pending after all cancel attempts', async () => {
      const pos = makePosition({ bracketOrderId: 12345 });
      pm.add(pos);

      // HMA bullish → signal_reversal on put
      setHmaCross(pm, 'bullish');

      // Both cancel attempts fail
      mockedCancelOcoLegs.mockRejectedValue(new Error('Request failed with status code 400'));

      // Order is still 'pending' — bracket is active
      mockedAxios.get = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/orders/12345')) {
          return Promise.resolve({ data: { order: { status: 'pending' } } });
        }
        return Promise.resolve({ data: { quotes: { quote: { last: 1.50, bid: 1.48, ask: 1.52 } } } });
      });

      const events = await pm.monitor(dailyLossCallback);

      // Close should NOT proceed — bracket legs would cause rejection
      expect(events).toHaveLength(0);
      expect(pm.count()).toBe(1);

      // closePosition should not even be called
      expect(mockedClosePosition).not.toHaveBeenCalled();

      // closeFailCount incremented
      expect(pm.getAll()[0].closeFailCount).toBe(1);
    });

    it('returns true when position has no bracket legs', async () => {
      const pos = makePosition(); // no bracketOrderId, tpLegId, slLegId
      pm.add(pos);

      // HMA bullish → signal_reversal on put
      setHmaCross(pm, 'bullish');

      mockedClosePosition.mockResolvedValue({ fillPrice: 1.50, paper: false });

      const events = await pm.monitor(dailyLossCallback);

      // No cancel attempts needed
      expect(mockedCancelOcoLegs).not.toHaveBeenCalled();

      // Close proceeds normally
      expect(events).toHaveLength(1);
      expect(pm.count()).toBe(0);
    });

    it('deduplicates bracket IDs when bracketOrderId equals a leg ID', async () => {
      const pos = makePosition({
        bracketOrderId: 12345,
        tpLegId: 12345,      // same as bracketOrderId
        slLegId: 67890,
      });
      pm.add(pos);

      // HMA bullish → signal_reversal on put
      setHmaCross(pm, 'bullish');

      mockedCancelOcoLegs.mockResolvedValue(undefined);
      mockedClosePosition.mockResolvedValue({ fillPrice: 1.50, paper: false });

      await pm.monitor(dailyLossCallback);

      // Should only cancel 2 unique IDs (12345, 67890), not 3
      expect(mockedCancelOcoLegs).toHaveBeenCalledTimes(2);
    });
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

    it('monitor returns empty when no positions', async () => {
      const events = await pm.monitor(dailyLossCallback);
      expect(events).toHaveLength(0);
    });

    it('does not exit when no exit condition is met', async () => {
      const pos = makePosition({
        entryPrice: 1.00,
        stopLoss: 0.30,    // SL far away
        takeProfit: 5.00,   // TP far away
      });
      pm.add(pos);

      // No HMA cross set → no signal_reversal trigger
      // Price is 1.50 → between SL (0.30) and TP (5.00)

      const events = await pm.monitor(dailyLossCallback);
      expect(events).toHaveLength(0);
      expect(pm.count()).toBe(1);
    });
  });
});
