import { describe, it, expect } from 'vitest';
import {
  checkEntryGates,
  computeCloseCutoffTs,
  type EntryGateInput,
} from '../../src/core/entry-gate';
import type { Config } from '../../src/config/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * 2026-04-01 09:30:00 ET = 13:30:00 UTC (EDT, UTC-4).
 * Used as the session start reference. All timestamps below derive from this.
 */
const SESSION_START = 1775050200; // 2026-04-01 09:30 ET
const T_10_00 = SESSION_START + 30 * 60;          // 10:00 ET
const T_15_44_59 = SESSION_START + 6 * 3600 + 14 * 60 + 59; // 15:44:59 ET
const T_15_45_00 = SESSION_START + 6 * 3600 + 15 * 60;      // 15:45:00 ET
const T_15_45_01 = SESSION_START + 6 * 3600 + 15 * 60 + 1;  // 15:45:01 ET
const T_16_00 = SESSION_START + 6 * 3600 + 30 * 60;         // 16:00 ET

function makeConfig(overrides: Record<string, any> = {}): Config {
  const base: Config = {
    id: 'test',
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
      enablePriceCrossHma: false, requireUnderlyingHmaCross: true,
      hmaCrossFast: 3, hmaCrossSlow: 17, emaCrossFast: 9, emaCrossSlow: 21,
      signalTimeframe: '1m', directionTimeframe: '1m', exitTimeframe: '1m',
      hmaCrossTimeframe: null, rsiCrossTimeframe: null, emaCrossTimeframe: null,
      priceCrossHmaTimeframe: null, targetOtmDistance: 15,
      targetContractPrice: null, maxEntryPrice: null,
      rsiOversold: 30, rsiOverbought: 70, optionRsiOversold: 40, optionRsiOverbought: 60,
      enableKeltnerGate: false, kcEmaPeriod: 20, kcAtrPeriod: 14, kcMultiplier: 2.5,
      kcSlopeLookback: 5, kcSlopeThreshold: 0.3,
    },
    position: {
      stopLossPercent: 70, takeProfitMultiplier: 1.4, maxPositionsOpen: 1,
      defaultQuantity: 1, positionSizeMultiplier: 1,
    },
    risk: {
      maxDailyLoss: 500, maxTradesPerDay: 20, maxRiskPerTrade: 500,
      cutoffTimeET: '15:45', minMinutesToClose: 15,
    },
    strikeSelector: { strikeSearchRange: 100, contractPriceMin: 0.20, contractPriceMax: 8.00 },
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

function makeInput(overrides: Partial<EntryGateInput> = {}): EntryGateInput {
  return {
    ts: T_10_00,
    kind: 'fresh_cross',
    openPositionsAfterExits: 0,
    tradesCompleted: 0,
    dailyPnl: 0,
    closeCutoffTs: T_16_00,
    lastEntryTs: 0,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('computeCloseCutoffTs', () => {
  it('derives the cutoff from config.risk.cutoffTimeET', () => {
    const cfg = makeConfig({ risk: { cutoffTimeET: '15:45' } });
    const cutoff = computeCloseCutoffTs(cfg, new Date('2026-04-01T14:00:00Z'));
    expect(cutoff).toBe(T_15_45_00);
  });

  it('defaults to 16:00 when cutoffTimeET is missing', () => {
    const cfg = makeConfig();
    // force missing cutoffTimeET
    (cfg.risk as any).cutoffTimeET = undefined;
    const cutoff = computeCloseCutoffTs(cfg, new Date('2026-04-01T14:00:00Z'));
    expect(cutoff).toBe(T_16_00);
  });
});

describe('checkEntryGates — time-window boundary', () => {
  it('allows entry at 15:44:59 ET (one second before activeEnd)', () => {
    const cfg = makeConfig();
    const result = checkEntryGates(makeInput({ ts: T_15_44_59 }), cfg);
    expect(result.allowed).toBe(true);
  });

  it('blocks entry at exactly 15:45:00 ET (activeEnd is exclusive)', () => {
    const cfg = makeConfig();
    const result = checkEntryGates(makeInput({ ts: T_15_45_00 }), cfg);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/outside active window|past close cutoff|cutoff/i);
  });

  it('blocks entry at 15:45:01 ET', () => {
    const cfg = makeConfig();
    const result = checkEntryGates(makeInput({ ts: T_15_45_01 }), cfg);
    expect(result.allowed).toBe(false);
  });
});

describe('checkEntryGates — close cutoff applies to every EntryKind', () => {
  const kinds: Array<EntryGateInput['kind']> = ['fresh_cross', 'flip_on_reversal', 'tp_reentry', 'judge_buy'];
  for (const kind of kinds) {
    it(`blocks ${kind} past cutoffTimeET`, () => {
      const cfg = makeConfig();
      const result = checkEntryGates(
        makeInput({ ts: T_15_45_01, kind, closeCutoffTs: T_15_45_00 }),
        cfg,
      );
      expect(result.allowed).toBe(false);
    });
  }
});

describe('checkEntryGates — cooldown semantics', () => {
  it('fresh_cross respects cooldown', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 60; // only 60s elapsed < 180s cooldown
    const result = checkEntryGates(
      makeInput({ ts, kind: 'fresh_cross', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/cooldown/i);
  });

  it('fresh_cross allowed once cooldown has elapsed', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 181;
    const result = checkEntryGates(
      makeInput({ ts, kind: 'fresh_cross', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(true);
  });

  it('judge_buy respects cooldown (same rule as fresh_cross)', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 60;
    const result = checkEntryGates(
      makeInput({ ts, kind: 'judge_buy', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(false);
  });

  it('flip_on_reversal respects cooldown (post-2026-04-21 fix)', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 5; // very recent entry — should be blocked
    const result = checkEntryGates(
      makeInput({ ts, kind: 'flip_on_reversal', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toMatch(/cooldown/i);
  });

  it('flip_on_reversal allowed once cooldown has elapsed', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 200; // 200s > 180s cooldown
    const result = checkEntryGates(
      makeInput({ ts, kind: 'flip_on_reversal', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(true);
  });

  it('tp_reentry BYPASSES cooldown (own cooldown lives in evaluateReentry)', () => {
    const cfg = makeConfig({ judges: { entryCooldownSec: 180 } });
    const ts = T_10_00;
    const lastEntryTs = ts - 5;
    const result = checkEntryGates(
      makeInput({ ts, kind: 'tp_reentry', lastEntryTs }),
      cfg,
    );
    expect(result.allowed).toBe(true);
  });
});

describe('checkEntryGates — risk guard passthrough', () => {
  it('blocks when max positions already open', () => {
    const cfg = makeConfig({ position: { maxPositionsOpen: 1 } });
    const result = checkEntryGates(
      makeInput({ openPositionsAfterExits: 1 }),
      cfg,
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks when daily loss exceeded', () => {
    const cfg = makeConfig({ risk: { maxDailyLoss: 500 } });
    const result = checkEntryGates(
      makeInput({ dailyPnl: -600 }),
      cfg,
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks when trades-per-day cap reached', () => {
    const cfg = makeConfig({ risk: { maxTradesPerDay: 5 } });
    const result = checkEntryGates(
      makeInput({ tradesCompleted: 5 }),
      cfg,
    );
    expect(result.allowed).toBe(false);
  });
});

describe('checkEntryGates — happy path', () => {
  it('allows entry with all gates passing', () => {
    const cfg = makeConfig();
    const result = checkEntryGates(makeInput(), cfg);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.kind).toBe('fresh_cross');
  });
});
