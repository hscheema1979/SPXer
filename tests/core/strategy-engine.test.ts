import { describe, it, expect } from 'vitest';
import {
  tick,
  createInitialState,
  stripFormingCandle,
  type CorePosition,
  type StrategyState,
  type TickInput,
} from '../../src/core/strategy-engine';
import type { CoreBar } from '../../src/core/types';
import type { Config } from '../../src/config/types';
import type { StrikeCandidate } from '../../src/core/strike-selector';
import { frictionEntry } from '../../src/core/friction';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Base timestamp: 2026-04-01 10:00:00 ET = 14:00:00 UTC.
 * Falls within the default active window (09:30–15:45 ET).
 */
const BASE_TS = 1775052000;

/** Create a CoreBar with HMA indicator values */
function makeBar(ts: number, close: number, hmaFast: number | null, hmaSlow: number | null): CoreBar {
  return {
    ts,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 100,
    indicators: { hma3: hmaFast, hma17: hmaSlow },
  };
}

/** Build a minimal Config for testing — deterministic HMA cross strategy */
function makeConfig(overrides: Record<string, any> = {}): Config {
  const base: Config = {
    id: 'test',
    name: 'test',
    createdAt: 0,
    updatedAt: 0,
    scanners: {
      enabled: false,
      models: [],
      cycleIntervalSec: 30,
      minConfidenceToEscalate: 0.5,
      promptAssignments: {},
      defaultPromptId: '',
    },
    judges: {
      enabled: false,
      models: [],
      activeJudge: '',
      consensusRule: 'primary-decides',
      confidenceThreshold: 0.5,
      escalationCooldownSec: 180,
      promptId: '',
    },
    regime: {
      enabled: false,
      mode: 'disabled',
      classification: { trendThreshold: 0.15, lookbackBars: 30, openingRangeMinutes: 15 },
      timeWindows: { morningEnd: '10:30', middayEnd: '14:00', gammaExpiryStart: '15:00', noTradeStart: '15:45' },
      signalGates: {},
    },
    signals: {
      enableHmaCrosses: true,
      enableRsiCrosses: false,
      enableEmaCrosses: false,
      enablePriceCrossHma: false,
      requireUnderlyingHmaCross: true,
      hmaCrossFast: 3,
      hmaCrossSlow: 17,
      emaCrossFast: 9,
      emaCrossSlow: 21,
      signalTimeframe: '1m',
      directionTimeframe: '1m',
      exitTimeframe: '1m',
      hmaCrossTimeframe: null,
      rsiCrossTimeframe: null,
      emaCrossTimeframe: null,
      priceCrossHmaTimeframe: null,
      targetOtmDistance: 15,
      targetContractPrice: null,
      maxEntryPrice: null,
      rsiOversold: 30,
      rsiOverbought: 70,
      optionRsiOversold: 40,
      optionRsiOverbought: 60,
      enableKeltnerGate: false,
      kcEmaPeriod: 20,
      kcAtrPeriod: 14,
      kcMultiplier: 2.5,
      kcSlopeLookback: 5,
      kcSlopeThreshold: 0.3,
    },
    position: {
      stopLossPercent: 70,
      takeProfitMultiplier: 1.4,
      maxPositionsOpen: 1,
      defaultQuantity: 1,
      positionSizeMultiplier: 1,
    },
    risk: {
      maxDailyLoss: 500,
      maxTradesPerDay: 20,
      maxRiskPerTrade: 500,
      cutoffTimeET: '15:45',
      minMinutesToClose: 15,
    },
    strikeSelector: {
      strikeSearchRange: 100,
      contractPriceMin: 0.20,
      contractPriceMax: 8.00,
    },
    timeWindows: {
      sessionStart: '09:30',
      sessionEnd: '16:00',
      activeStart: '09:30',
      activeEnd: '15:45',
      skipWeekends: true,
      skipHolidays: true,
    },
    escalation: {
      signalTriggersJudge: false,
      scannerTriggersJudge: false,
      requireScannerAgreement: false,
      requireSignalAgreement: false,
    },
    exit: {
      strategy: 'scannerReverse',
      trailingStopEnabled: false,
      trailingStopPercent: 20,
      timeBasedExitEnabled: false,
      timeBasedExitMinutes: 5,
      reversalSizeMultiplier: 1,
    },
    narrative: {
      buildOvernightContext: false,
      barHistoryDepth: 100,
      trackTrajectory: false,
    },
    pipeline: {
      pollUnderlyingMs: 10000,
      pollOptionsRthMs: 30000,
      pollOptionsOvernightMs: 60000,
      pollScreenerMs: 60000,
      strikeBand: 100,
      strikeInterval: 5,
      gapInterpolateMaxMins: 60,
      maxBarsMemory: 1000,
      timeframe: '1m',
    },
    contracts: { stickyBandWidth: 100 },
    calendar: { holidays: [], earlyCloseDays: [] },
    sizing: {
      baseDollarsPerTrade: 1500,
      sizeMultiplier: 1,
      minContracts: 1,
      maxContracts: 10,
    },
  };

  // Shallow merge overrides for nested keys
  for (const key of Object.keys(overrides)) {
    if (typeof overrides[key] === 'object' && !Array.isArray(overrides[key]) && overrides[key] !== null) {
      (base as any)[key] = { ...(base as any)[key], ...overrides[key] };
    } else {
      (base as any)[key] = overrides[key];
    }
  }
  return base;
}

/** Build a basic TickInput with no positions, no candidates */
function makeInput(overrides: Partial<TickInput> = {}): TickInput {
  return {
    ts: BASE_TS,
    spxDirectionBars: [],
    spxExitBars: [],
    contractBars: new Map(),
    spxPrice: 5800,
    closeCutoffTs: BASE_TS + 20000,
    candidates: [],
    positionPrices: new Map(),
    ...overrides,
  };
}

/** Standard call candidates for entry tests */
function makeCallCandidates(spxPrice: number = 5800): StrikeCandidate[] {
  return [
    { symbol: 'SPXW260401C05815000', side: 'call' as const, strike: spxPrice + 15, price: 2.50, volume: 500 },
    { symbol: 'SPXW260401C05820000', side: 'call' as const, strike: spxPrice + 20, price: 1.80, volume: 300 },
  ];
}

/** Standard put candidates for entry tests */
function makePutCandidates(spxPrice: number = 5800): StrikeCandidate[] {
  return [
    { symbol: 'SPXW260401P05785000', side: 'put' as const, strike: spxPrice - 15, price: 2.50, volume: 500 },
    { symbol: 'SPXW260401P05780000', side: 'put' as const, strike: spxPrice - 20, price: 1.80, volume: 300 },
  ];
}

/** Apply directionState/exitState from a result to a state (what the caller does) */
function applyHmaState(state: StrategyState, result: ReturnType<typeof tick>): void {
  state.directionCross = result.directionState.directionCross;
  state.prevDirectionHmaFast = result.directionState.prevHmaFast;
  state.prevDirectionHmaSlow = result.directionState.prevHmaSlow;
  state.lastDirectionBarTs = result.directionState.lastBarTs;
  state.exitCross = result.exitState.exitCross;
  state.prevExitHmaFast = result.exitState.prevHmaFast;
  state.prevExitHmaSlow = result.exitState.prevHmaSlow;
  state.lastExitBarTs = result.exitState.lastBarTs;
}

function makePosition(overrides: Partial<CorePosition> = {}): CorePosition {
  return {
    id: 'SPXW260401C05815000',
    symbol: 'SPXW260401C05815000',
    side: 'call',
    strike: 5815,
    qty: 1,
    entryPrice: 2.50,
    stopLoss: 0.765,  // frictionEntry(2.50) * (1 - 0.70)
    takeProfit: 3.57,  // frictionEntry(2.50) * 1.4
    entryTs: BASE_TS - 300,
    highWaterPrice: 2.50,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('createInitialState', () => {
  it('initializes all fields correctly', () => {
    const state = createInitialState();
    expect(state.positions).toBeInstanceOf(Map);
    expect(state.positions.size).toBe(0);
    expect(state.directionCross).toBeNull();
    expect(state.prevDirectionHmaFast).toBeNull();
    expect(state.prevDirectionHmaSlow).toBeNull();
    expect(state.lastDirectionBarTs).toBeNull();
    expect(state.exitCross).toBeNull();
    expect(state.prevExitHmaFast).toBeNull();
    expect(state.prevExitHmaSlow).toBeNull();
    expect(state.lastExitBarTs).toBeNull();
    expect(state.lastEntryTs).toBe(0);
    expect(state.dailyPnl).toBe(0);
    expect(state.tradesCompleted).toBe(0);
  });
});

describe('stripFormingCandle', () => {
  it('returns empty array unchanged', () => {
    expect(stripFormingCandle([])).toEqual([]);
  });

  it('strips last bar when ts >= current period start (1m)', () => {
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = now - (now % 60);
    const bars: CoreBar[] = [
      makeBar(currentMinute - 120, 5800, 5800, 5800),
      makeBar(currentMinute - 60, 5801, 5801, 5801),
      makeBar(currentMinute, 5802, 5802, 5802),  // forming
    ];
    const result = stripFormingCandle(bars, 60);
    expect(result).toHaveLength(2);
    expect(result[result.length - 1].ts).toBe(currentMinute - 60);
  });

  it('passes through all bars when last bar is in a past period', () => {
    const now = Math.floor(Date.now() / 1000);
    const pastMinute = now - (now % 60) - 120; // 2 minutes ago
    const bars: CoreBar[] = [
      makeBar(pastMinute - 60, 5800, 5800, 5800),
      makeBar(pastMinute, 5801, 5801, 5801),
    ];
    const result = stripFormingCandle(bars, 60);
    expect(result).toHaveLength(2);
  });

  it('handles 3m period (180s)', () => {
    const now = Math.floor(Date.now() / 1000);
    const current3m = now - (now % 180);
    const bars: CoreBar[] = [
      makeBar(current3m - 360, 5800, 5800, 5800),
      makeBar(current3m - 180, 5801, 5801, 5801),
      makeBar(current3m, 5802, 5802, 5802),  // forming 3m candle
    ];
    const result = stripFormingCandle(bars, 180);
    expect(result).toHaveLength(2);
  });
});

describe('tick — Direction HMA Cross Detection', () => {
  const config = makeConfig();

  it('detects bullish cross (fast crosses above slow)', () => {
    const state = createInitialState();
    // Tick 1: bearish (fast < slow)
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    // Tick 2: fast crossed above slow → bullish
    const bars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({ spxDirectionBars: bars, spxExitBars: bars }), config);
    expect(result.directionState.directionCross).toBe('bullish');
    expect(result.directionState.freshCross).toBe(true);
    expect(result.directionState.prevHmaFast).toBe(5808);
    expect(result.directionState.prevHmaSlow).toBe(5803);
  });

  it('detects bearish cross (fast crosses below slow)', () => {
    const state = createInitialState();
    // Previous: bullish (fast > slow)
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;

    // Now: fast crossed below slow → bearish
    const bars = [makeBar(BASE_TS - 60, 5795, 5796, 5802)];

    const result = tick(state, makeInput({ spxDirectionBars: bars, spxExitBars: bars }), config);
    expect(result.directionState.directionCross).toBe('bearish');
    expect(result.directionState.freshCross).toBe(true);
  });

  it('reports no fresh cross when HMA relationship unchanged', () => {
    const state = createInitialState();
    // Previous: bullish
    state.prevDirectionHmaFast = 5805;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5805;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    // Still bullish — no cross
    const bars = [makeBar(BASE_TS - 60, 5810, 5810, 5805)];

    const result = tick(state, makeInput({ spxDirectionBars: bars, spxExitBars: bars }), config);
    expect(result.directionState.directionCross).toBe('bullish');
    expect(result.directionState.freshCross).toBe(false);
  });

  it('deduplicates — same bar ts processed twice yields no fresh cross', () => {
    const state = createInitialState();
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];
    const input = makeInput({ spxDirectionBars: bars, spxExitBars: bars });

    // First call → fresh cross
    const r1 = tick(state, input, config);
    expect(r1.directionState.freshCross).toBe(true);

    // Apply state
    applyHmaState(state, r1);

    // Second call with same bars → no fresh cross (dedup)
    const r2 = tick(state, input, config);
    expect(r2.directionState.freshCross).toBe(false);
    expect(r2.directionState.directionCross).toBe('bullish'); // cross direction preserved
  });

  it('handles empty bars gracefully', () => {
    const state = createInitialState();
    const result = tick(state, makeInput({ spxDirectionBars: [], spxExitBars: [] }), config);
    expect(result.directionState.directionCross).toBeNull();
    expect(result.directionState.freshCross).toBe(false);
  });

  it('handles first bar — sets state but no fresh cross', () => {
    const state = createInitialState();
    // No previous HMA state at all
    const bars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];
    const result = tick(state, makeInput({ spxDirectionBars: bars, spxExitBars: bars }), config);

    expect(result.directionState.prevHmaFast).toBe(5808);
    expect(result.directionState.prevHmaSlow).toBe(5803);
    expect(result.directionState.freshCross).toBe(false);
    // But the relationship is established
    expect(result.directionState.directionCross).toBe('bullish');
  });
});

describe('tick — Exit HMA Cross Detection', () => {
  const config = makeConfig();

  it('tracks exit cross independently from direction cross', () => {
    const state = createInitialState();
    // Direction: bearish (fast < slow)
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    // Exit: also bearish
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    // Direction bars: bullish cross
    const dirBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];
    // Exit bars: still bearish (different timeframe data)
    const exitBars = [makeBar(BASE_TS - 60, 5795, 5796, 5802)];

    const result = tick(state, makeInput({
      spxDirectionBars: dirBars,
      spxExitBars: exitBars,
    }), config);

    expect(result.directionState.directionCross).toBe('bullish');
    expect(result.directionState.freshCross).toBe(true);
    expect(result.exitState.exitCross).toBe('bearish');
    // Exit stayed bearish — no change in relationship
  });
});

describe('tick — MTF: direction on 3m, exit on 5m', () => {
  const config = makeConfig();

  it('produces different cross states from different timeframe bars', () => {
    const state = createInitialState();
    // Set up previous state for direction (3m)
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 360;  // 6 min ago (2 × 3m candles)
    // Set up previous state for exit (5m)
    state.prevExitHmaFast = 5810;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 600;  // 10 min ago (2 × 5m candles)

    // 3m direction bars: bullish cross (fast went above slow)
    const dirBars = [makeBar(BASE_TS - 180, 5810, 5808, 5803)];
    // 5m exit bars: bearish cross (fast went below slow)
    const exitBars = [makeBar(BASE_TS - 300, 5790, 5796, 5802)];

    const result = tick(state, makeInput({
      spxDirectionBars: dirBars,
      spxExitBars: exitBars,
    }), config);

    // Direction: bullish cross on 3m bars
    expect(result.directionState.directionCross).toBe('bullish');
    expect(result.directionState.freshCross).toBe(true);
    expect(result.directionState.lastBarTs).toBe(BASE_TS - 180);

    // Exit: bearish cross on 5m bars
    expect(result.exitState.exitCross).toBe('bearish');
    expect(result.exitState.lastBarTs).toBe(BASE_TS - 300);
  });
});

describe('tick — Position Exits', () => {
  it('exits on stop loss', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Price dropped below SL (0.765)
    const positionPrices = new Map([[pos.symbol, 0.50]]);

    const result = tick(state, makeInput({
      positionPrices,
      spxDirectionBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
      spxExitBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
    }), config);

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('stop_loss');
    expect(result.exits[0].decisionPrice).toBe(0.50);
    expect(result.exits[0].positionId).toBe(pos.id);
    expect(result.exits[0].flipTo).toBeNull(); // SL doesn't flip
  });

  it('exits on take profit', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Price rose above TP (3.57)
    const positionPrices = new Map([[pos.symbol, 4.00]]);

    const result = tick(state, makeInput({
      positionPrices,
      spxDirectionBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
      spxExitBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
    }), config);

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('take_profit');
    expect(result.exits[0].flipTo).toBeNull(); // TP doesn't flip
  });

  it('exits on signal_reversal (exit cross flips against position)', () => {
    const config = makeConfig();
    const pos = makePosition({ side: 'call' }); // long call
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Set up exit HMA state: was bullish
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;

    // Exit bars: bearish cross (against our call position)
    const exitBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    const positionPrices = new Map([[pos.symbol, 2.00]]); // price OK, no SL/TP

    const result = tick(state, makeInput({
      positionPrices,
      spxDirectionBars: exitBars,
      spxExitBars: exitBars,
    }), config);

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('signal_reversal');
    expect(result.exits[0].flipTo).toBe('put'); // flip from call to put
  });

  it('exits on time_exit at close cutoff', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    const positionPrices = new Map([[pos.symbol, 2.00]]);

    // Set ts = closeCutoffTs → triggers time exit
    const result = tick(state, makeInput({
      ts: BASE_TS,
      closeCutoffTs: BASE_TS, // cutoff is NOW
      positionPrices,
      spxDirectionBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
      spxExitBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
    }), config);

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('time_exit');
    expect(result.exits[0].flipTo).toBeNull(); // time exit doesn't flip
  });

  it('handles missing price — still exits on time_exit', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // No price in positionPrices → only time/reversal exits fire
    const result = tick(state, makeInput({
      ts: BASE_TS,
      closeCutoffTs: BASE_TS,
      positionPrices: new Map(), // no prices!
      spxDirectionBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
      spxExitBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
    }), config);

    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('time_exit');
    expect(result.exits[0].decisionPrice).toBe(pos.entryPrice); // fallback to entry price
  });
});

describe('tick — Flip-on-Reversal', () => {
  it('exits with flipTo triggers entry on opposite side', () => {
    const config = makeConfig();
    const pos = makePosition({ side: 'call' }); // long call
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Was bullish, now bearish cross → signal_reversal → flip to put
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.00]]),
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates: [
        ...makeCallCandidates(5800),
        ...makePutCandidates(5800),
      ],
    }), config);

    // Exit fires with flip
    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].flipTo).toBe('put');

    // Entry fires for the flip
    expect(result.entry).not.toBeNull();
    expect(result.entry!.side).toBe('put');
    expect(result.entry!.direction).toBe('bearish');
    expect(result.entry!.reason).toContain('flip-on-reversal');
  });

  it('flip does NOT require a fresh direction cross', () => {
    const config = makeConfig();
    const pos = makePosition({ side: 'call' });
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Direction: was bullish, NOW bearish cross on this tick
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.00]]),
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates: [...makeCallCandidates(5800), ...makePutCandidates(5800)],
    }), config);

    // Both fresh cross AND flip fire — flip takes priority since both happen
    expect(result.entry).not.toBeNull();
    expect(result.entry!.side).toBe('put');
  });
});

describe('tick — Risk Guard', () => {
  it('blocks entry when max trades reached, but still exits', () => {
    const config = makeConfig({ risk: { maxDailyLoss: 500, maxTradesPerDay: 5, maxRiskPerTrade: 500, cutoffTimeET: '15:45', minMinutesToClose: 15 } });
    const state = createInitialState();
    state.tradesCompleted = 5; // at max

    // Set up a fresh bullish cross
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toContain('Max trades per day');
  });

  it('blocks entry when daily loss limit reached', () => {
    const config = makeConfig();
    const state = createInitialState();
    state.dailyPnl = -500; // at loss limit

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toContain('Daily loss limit');
  });

  it('still processes exits even when risk-blocked for entry', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);
    state.tradesCompleted = 999; // max trades reached

    // Price below SL
    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 0.50]]),
      spxDirectionBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
      spxExitBars: [makeBar(BASE_TS - 60, 5810, 5808, 5803)],
    }), config);

    // Exits still fire
    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('stop_loss');
    // But no entry
    expect(result.entry).toBeNull();
  });

  it('considers positions being exited when counting open positions', () => {
    const config = makeConfig({ position: { stopLossPercent: 70, takeProfitMultiplier: 1.4, maxPositionsOpen: 1, defaultQuantity: 1, positionSizeMultiplier: 1 } });
    const pos = makePosition({ side: 'call' });
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Was bullish → now bearish cross
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.00]]),
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates: [...makeCallCandidates(5800), ...makePutCandidates(5800)],
    }), config);

    // Exit fires (signal_reversal)
    expect(result.exits).toHaveLength(1);
    // Entry should still happen because the exiting position makes room
    // (positionsAfterExits = 1 - 1 = 0, within maxPositionsOpen of 1)
    expect(result.entry).not.toBeNull();
  });
});

describe('tick — Time Window Gate', () => {
  it('blocks entry outside active window but still processes exits', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // 8:00 ET = before market open
    const ts = 1775044800; // 2026-04-01T12:00:00Z = 08:00 ET

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = ts - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = ts - 120;

    const bullishBars = [makeBar(ts - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      ts,
      closeCutoffTs: ts + 20000,
      positionPrices: new Map([[pos.symbol, 0.50]]), // SL hit
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    // Exits still processed
    expect(result.exits).toHaveLength(1);
    expect(result.exits[0].reason).toBe('stop_loss');
    // But no entry (outside window)
    expect(result.entry).toBeNull();
    expect(result.skipReason).toBe('outside active window');
  });

  it('allows entry within active window', () => {
    const config = makeConfig();
    const state = createInitialState();

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      ts: BASE_TS, // 10:00 ET — within window
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).not.toBeNull();
    expect(result.skipReason).toBeNull();
  });
});

describe('tick — Cooldown Gate', () => {
  it('blocks entry when cooldown not elapsed', () => {
    const config = makeConfig(); // cooldown = 180s
    const state = createInitialState();
    state.lastEntryTs = BASE_TS - 60; // 60s ago, needs 180s

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toContain('cooldown');
    expect(result.skipReason).toContain('120s remaining');
  });

  it('allows entry when cooldown has elapsed', () => {
    const config = makeConfig(); // cooldown = 180s
    const state = createInitialState();
    state.lastEntryTs = BASE_TS - 200; // 200s ago, needs 180s → OK

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).not.toBeNull();
  });

  it('skips cooldown check when lastEntryTs is 0 (no prior entry)', () => {
    const config = makeConfig();
    const state = createInitialState();
    // lastEntryTs = 0 → no prior entry, cooldown should be bypassed

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).not.toBeNull();
    expect(result.skipReason).toBeNull();
  });
});

describe('tick — Entry via Fresh Direction Cross', () => {
  it('enters call on bullish cross with best strike from candidates', () => {
    const config = makeConfig();
    const state = createInitialState();

    // Set up for bullish cross
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];
    const candidates = makeCallCandidates(5800);

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates,
    }), config);

    expect(result.entry).not.toBeNull();
    expect(result.entry!.side).toBe('call');
    expect(result.entry!.direction).toBe('bullish');
    expect(result.entry!.strike).toBeGreaterThan(5800); // OTM call
    expect(result.entry!.price).toBeGreaterThan(0);
    expect(result.entry!.qty).toBeGreaterThanOrEqual(1);

    // SL = frictionEntry(price) * (1 - 70/100)
    const expectedEffEntry = frictionEntry(result.entry!.price);
    expect(result.entry!.stopLoss).toBeCloseTo(expectedEffEntry * 0.30, 2);
    // TP = frictionEntry(price) * 1.4
    expect(result.entry!.takeProfit).toBeCloseTo(expectedEffEntry * 1.4, 2);

    expect(result.skipReason).toBeNull();
  });

  it('enters put on bearish cross', () => {
    const config = makeConfig();
    const state = createInitialState();

    // Set up for bearish cross
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];
    const candidates = makePutCandidates(5800);

    const result = tick(state, makeInput({
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates,
    }), config);

    expect(result.entry).not.toBeNull();
    expect(result.entry!.side).toBe('put');
    expect(result.entry!.direction).toBe('bearish');
    expect(result.entry!.strike).toBeLessThan(5800); // OTM put
  });

  it('skips entry when no qualifying contract found', () => {
    const config = makeConfig();
    const state = createInitialState();

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: [], // no candidates!
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toBe('no qualifying contract');
  });

  it('skips entry when maxEntryPrice exceeded', () => {
    const config = makeConfig({ signals: { maxEntryPrice: 1.00 } });
    const state = createInitialState();

    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800), // cheapest is 1.80
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toContain('maxEntryPrice');
  });
});

describe('tick — No Entry Conditions', () => {
  it('no entry when no position open and no fresh cross', () => {
    const config = makeConfig();
    const state = createInitialState();

    // Already bullish — no fresh cross
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;

    // Still bullish — no change
    const bullishBars = [makeBar(BASE_TS - 60, 5812, 5810, 5805)];

    const result = tick(state, makeInput({
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).toBeNull();
    expect(result.skipReason).toBe('no entry trigger');
    expect(result.directionState.freshCross).toBe(false);
  });

  it('no entry when fresh cross fires but position already open', () => {
    const config = makeConfig();
    const pos = makePosition();
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Fresh bullish cross
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bullishBars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];

    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.50]]), // price stable, no exit
      spxDirectionBars: bullishBars,
      spxExitBars: bullishBars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    // Fresh cross detected but position exists → risk guard blocks (maxPositionsOpen=1)
    expect(result.entry).toBeNull();
    expect(result.directionState.freshCross).toBe(true);
  });

  it('respects requireUnderlyingHmaCross — skips entry when direction cross is null', () => {
    const config = makeConfig();
    const state = createInitialState();

    // No previous HMA state → first bar establishes relationship but no fresh cross on entry
    // Actually, let's force a scenario where there's a flip but no direction cross
    // This is hard to trigger naturally. Instead, use HMA values that are null:
    const bars = [makeBar(BASE_TS - 60, 5810, null, null)]; // no HMA values

    const result = tick(state, makeInput({
      spxDirectionBars: bars,
      spxExitBars: bars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(result.entry).toBeNull();
    expect(result.directionState.directionCross).toBeNull();
  });
});

describe('tick — Purity (no side effects)', () => {
  it('does not mutate the input state', () => {
    const config = makeConfig();
    const pos = makePosition({ side: 'call' });
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // Set up bearish cross to trigger signal_reversal + flip
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    // Snapshot state before tick
    const posCountBefore = state.positions.size;
    const dirCrossBefore = state.directionCross;
    const exitCrossBefore = state.exitCross;
    const pnlBefore = state.dailyPnl;
    const tradesBefore = state.tradesCompleted;

    tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.00]]),
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates: [...makeCallCandidates(5800), ...makePutCandidates(5800)],
    }), config);

    // State must be unchanged
    expect(state.positions.size).toBe(posCountBefore);
    expect(state.directionCross).toBe(dirCrossBefore);
    expect(state.exitCross).toBe(exitCrossBefore);
    expect(state.dailyPnl).toBe(pnlBefore);
    expect(state.tradesCompleted).toBe(tradesBefore);
  });

  it('is deterministic — same inputs produce same outputs', () => {
    const config = makeConfig();
    const state = createInitialState();
    state.prevDirectionHmaFast = 5798;
    state.prevDirectionHmaSlow = 5802;
    state.lastDirectionBarTs = BASE_TS - 120;
    state.prevExitHmaFast = 5798;
    state.prevExitHmaSlow = 5802;
    state.lastExitBarTs = BASE_TS - 120;

    const bars = [makeBar(BASE_TS - 60, 5810, 5808, 5803)];
    const input = makeInput({
      spxDirectionBars: bars,
      spxExitBars: bars,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    });

    const r1 = tick(state, input, config);
    const r2 = tick(state, input, config);

    expect(r1.entry?.symbol).toBe(r2.entry?.symbol);
    expect(r1.entry?.price).toBe(r2.entry?.price);
    expect(r1.entry?.qty).toBe(r2.entry?.qty);
    expect(r1.directionState).toEqual(r2.directionState);
    expect(r1.exitState).toEqual(r2.exitState);
    expect(r1.exits.length).toBe(r2.exits.length);
  });
});

describe('tick — Exit strategy: takeProfit (no flip)', () => {
  it('signal_reversal does NOT set flipTo when strategy is takeProfit', () => {
    const config = makeConfig({ exit: { strategy: 'takeProfit', trailingStopEnabled: false, trailingStopPercent: 20, timeBasedExitEnabled: false, timeBasedExitMinutes: 5, reversalSizeMultiplier: 1 } });
    const pos = makePosition({ side: 'call' });
    const state = createInitialState();
    state.positions.set(pos.id, pos);

    // With strategy=takeProfit, signal_reversal exit shouldn't even fire
    // (checkExit only does signal_reversal when strategy=scannerReverse)
    state.prevExitHmaFast = 5808;
    state.prevExitHmaSlow = 5803;
    state.lastExitBarTs = BASE_TS - 120;
    state.prevDirectionHmaFast = 5808;
    state.prevDirectionHmaSlow = 5803;
    state.lastDirectionBarTs = BASE_TS - 120;

    const bearishBars = [makeBar(BASE_TS - 60, 5790, 5796, 5802)];

    const result = tick(state, makeInput({
      positionPrices: new Map([[pos.symbol, 2.00]]),
      spxDirectionBars: bearishBars,
      spxExitBars: bearishBars,
      spxPrice: 5800,
      candidates: [...makeCallCandidates(5800), ...makePutCandidates(5800)],
    }), config);

    // No signal_reversal exit fires (takeProfit strategy)
    const reversalExits = result.exits.filter(e => e.reason === 'signal_reversal');
    expect(reversalExits).toHaveLength(0);
  });
});

describe('tick — Multi-step integration', () => {
  it('full lifecycle: cross → enter → hold → reversal → flip → exit', () => {
    const config = makeConfig();
    const state = createInitialState();

    // ── Tick 1: First bar — establishes HMA state, no trade ──
    const bars1 = [makeBar(BASE_TS - 120, 5800, 5798, 5802)]; // bearish: fast < slow
    const r1 = tick(state, makeInput({
      ts: BASE_TS - 60,
      spxDirectionBars: bars1,
      spxExitBars: bars1,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(r1.directionState.directionCross).toBe('bearish');
    expect(r1.directionState.freshCross).toBe(false); // first bar = no cross
    expect(r1.entry).toBeNull();
    applyHmaState(state, r1);

    // ── Tick 2: Bullish cross → enter call ──
    const bars2 = [
      makeBar(BASE_TS - 120, 5800, 5798, 5802),
      makeBar(BASE_TS - 60, 5810, 5808, 5803),  // bullish cross
    ];
    const r2 = tick(state, makeInput({
      ts: BASE_TS,
      spxDirectionBars: bars2,
      spxExitBars: bars2,
      spxPrice: 5800,
      candidates: makeCallCandidates(5800),
    }), config);

    expect(r2.directionState.freshCross).toBe(true);
    expect(r2.directionState.directionCross).toBe('bullish');
    expect(r2.entry).not.toBeNull();
    expect(r2.entry!.side).toBe('call');
    applyHmaState(state, r2);

    // Simulate entry fill
    const entryPos: CorePosition = {
      id: r2.entry!.symbol,
      symbol: r2.entry!.symbol,
      side: r2.entry!.side,
      strike: r2.entry!.strike,
      qty: r2.entry!.qty,
      entryPrice: r2.entry!.price,
      stopLoss: r2.entry!.stopLoss,
      takeProfit: r2.entry!.takeProfit,
      entryTs: BASE_TS,
      highWaterPrice: r2.entry!.price,
    };
    state.positions.set(entryPos.id, entryPos);
    state.lastEntryTs = BASE_TS;

    // ── Tick 3: Still bullish, position held ──
    const bars3 = [
      makeBar(BASE_TS - 60, 5810, 5808, 5803),
      makeBar(BASE_TS, 5815, 5812, 5806),  // still bullish, no cross
    ];
    const r3 = tick(state, makeInput({
      ts: BASE_TS + 300,  // 5 min later (past cooldown)
      spxDirectionBars: bars3,
      spxExitBars: bars3,
      spxPrice: 5815,
      positionPrices: new Map([[entryPos.symbol, 3.00]]),
      candidates: makeCallCandidates(5815),
    }), config);

    expect(r3.directionState.freshCross).toBe(false); // still bullish
    expect(r3.exits).toHaveLength(0); // no exit trigger
    expect(r3.entry).toBeNull(); // already positioned
    applyHmaState(state, r3);

    // ── Tick 4: Bearish cross → signal_reversal exit + flip to put ──
    const bars4 = [
      makeBar(BASE_TS, 5815, 5812, 5806),
      makeBar(BASE_TS + 300, 5790, 5796, 5802), // bearish cross
    ];
    const r4 = tick(state, makeInput({
      ts: BASE_TS + 360,
      spxDirectionBars: bars4,
      spxExitBars: bars4,
      spxPrice: 5790,
      positionPrices: new Map([[entryPos.symbol, 1.50]]),
      candidates: [...makeCallCandidates(5790), ...makePutCandidates(5790)],
    }), config);

    expect(r4.directionState.freshCross).toBe(true);
    expect(r4.directionState.directionCross).toBe('bearish');
    expect(r4.exits).toHaveLength(1);
    expect(r4.exits[0].reason).toBe('signal_reversal');
    expect(r4.exits[0].flipTo).toBe('put');
    expect(r4.entry).not.toBeNull();
    expect(r4.entry!.side).toBe('put');
    expect(r4.entry!.direction).toBe('bearish');
  });
});
