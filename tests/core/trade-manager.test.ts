import { describe, it, expect } from 'vitest';
import { evaluateEntry, type EntryContext } from '../../src/core/trade-manager';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import { frictionEntry } from '../../src/core/friction';
import type { Config } from '../../src/config/types';
import type { SignalResult } from '../../src/core/strategy-engine';
import type { StrikeCandidate } from '../../src/core/strike-selector';

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE_TS = 1775052000; // 2026-04-01 10:00 ET

/** Minimal SignalResult with a fresh bullish cross to trigger entry. */
function makeBullishSignal(): SignalResult {
  return {
    directionState: {
      cross: 'bullish',
      prevFast: 5800,
      prevSlow: 5802,
      lastBarTs: BASE_TS - 60,
      freshCross: true,
    },
    exitState: {
      cross: null,
      prevFast: null,
      prevSlow: null,
      lastBarTs: null,
      freshCross: false,
    },
  };
}

/** Minimal call candidate at the given price. */
function makeCandidate(price: number): StrikeCandidate {
  return {
    symbol: 'SPXW260401C05815000',
    side: 'call',
    strike: 5815,
    price,
    otm: 15,
  };
}

/** Entry context — open window, no prior trades. */
function makeCtx(overrides: Partial<EntryContext> = {}): EntryContext {
  return {
    ts: BASE_TS,
    spxPrice: 5800,
    candidates: [makeCandidate(2.00)],
    dailyPnl: 0,
    tradesCompleted: 0,
    lastEntryTs: 0,
    closeCutoffTs: BASE_TS + 3600 * 6,
    accountValue: null,
    ...overrides,
  };
}

/** Config with fixed-contracts sizing so qty is predictable. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    signals: {
      ...DEFAULT_CONFIG.signals,
      hmaCrossFast: 3,
      hmaCrossSlow: 15,
      enableHmaCrosses: true,
      enableEmaCrosses: false,
      enableRsiCrosses: false,
      ...(overrides.signals ?? {}),
    },
    sizing: {
      ...DEFAULT_CONFIG.sizing,
      sizingMode: 'fixed_contracts',
      sizingValue: 10,
      ...(overrides.sizing ?? {}),
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: 20,
      takeProfitMultiplier: 1.20,
      ...(overrides.position ?? {}),
    },
  };
}

// ── Tests: entry slippage (Phase 3) ─────────────────────────────────────────

describe('evaluateEntry — entry slippage (Phase 3)', () => {
  it('no slippage: entry.price equals candidate.price', () => {
    const cfg = makeConfig({ fill: undefined });
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    expect(entry!.price).toBeCloseTo(2.00, 4);
  });

  it('with default slippage (10-lot, $0.002/contract): entry.price increases by $0.02', () => {
    // DEFAULT_CONFIG.fill.slippage.entrySlipPerContract = 0.002, entrySlipMax = 0.50
    // 10 contracts × $0.002 = $0.02 slip
    const cfg = makeConfig(); // uses DEFAULT_CONFIG.fill (slippage ON)
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    expect(entry!.price).toBeCloseTo(2.02, 4);  // 2.00 + 0.02
  });

  it('entry.price slippage is size-proportional', () => {
    // 100-lot: $0.002 × 100 = $0.20 slip; raise maxContracts to allow 100
    const cfg = makeConfig({
      sizing: { ...DEFAULT_CONFIG.sizing, sizingMode: 'fixed_contracts', sizingValue: 100, maxContracts: 100 },
    });
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    expect(entry!.price).toBeCloseTo(2.20, 4);  // 2.00 + 0.20
  });

  it('entry slippage is capped by entrySlipMax', () => {
    // 1000-lot: $0.002 × 1000 = $2.00, capped at $0.50; raise maxContracts to allow 1000
    const cfg = makeConfig({
      sizing: { ...DEFAULT_CONFIG.sizing, sizingMode: 'fixed_contracts', sizingValue: 1000, maxContracts: 1000 },
    });
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    expect(entry!.price).toBeCloseTo(2.50, 4);  // 2.00 + 0.50 (capped)
  });

  it('SL is computed from slipped effective entry, not raw price (tick-rounded)', () => {
    // 10-lot, slipped raw = 2.02, effectiveEntry = frictionEntry(2.02) = 2.07
    // stopLoss raw = 2.07 * 0.80 = 1.656 → tick-rounded to $0.05 bucket = 1.65
    // (Task 2.4: SL/TP must sit on valid option tick increments.)
    const cfg = makeConfig();
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    // 1.656 rounds to 1.65 (below $3: $0.05 tick)
    expect(entry!.stopLoss).toBeCloseTo(1.65, 4);
  });

  it('TP is computed from slipped effective entry, not raw price (tick-rounded)', () => {
    // 10-lot, slipped raw = 2.02, effectiveEntry = 2.07
    // takeProfit raw = 2.07 * 1.20 = 2.484 → tick-rounded to 2.50 (below $3: $0.05 tick)
    const cfg = makeConfig();
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    expect(entry).not.toBeNull();
    expect(entry!.takeProfit).toBeCloseTo(2.50, 4);
  });

  it('with slippage disabled, SL/TP anchored to raw price friction (tick-rounded)', () => {
    const cfg = makeConfig({ fill: undefined });
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx());

    // effEntry = frictionEntry(2.00) = 2.05
    // SL raw = 2.05 * 0.80 = 1.64 → rounds to 1.65 ($0.05 tick)
    // TP raw = 2.05 * 1.20 = 2.46 → rounds to 2.45 ($0.05 tick)
    expect(entry).not.toBeNull();
    expect(entry!.stopLoss).toBeCloseTo(1.65, 4);
    expect(entry!.takeProfit).toBeCloseTo(2.45, 4);
  });

  it('entry returns null when no candidates provided', () => {
    const cfg = makeConfig();
    const ctx = makeCtx({ candidates: [] });
    const { entry, skipReason } = evaluateEntry(makeBullishSignal(), [], 0, cfg, ctx);

    expect(entry).toBeNull();
    expect(skipReason).toBeTruthy();
  });
});

// ── Tests: liquidity gate (Phase 4) ─────────────────────────────────────────

describe('evaluateEntry — liquidity gate (Phase 4)', () => {
  it('no gate when participationRate is undefined', () => {
    // fill: undefined → no rate → qty unchanged at 10
    const cfg = makeConfig({ fill: undefined });
    const ctx = makeCtx({ candidates: [makeCandidate(2.00)] });
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, ctx);

    expect(entry).not.toBeNull();
    expect(entry!.qty).toBe(10); // default 10-lot, no cap
  });

  it('participationRate=0.20: caps qty to floor(barVol × 0.20)', () => {
    // barVol=100 → maxFill=20; with 10-lot sizing, 10 < 20 so unchanged
    const cfg = makeConfig({
      fill: { participationRate: 0.20, minContracts: 1 },
    });
    const candidate = { ...makeCandidate(2.00), volume: 100 };
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx({ candidates: [candidate] }));

    expect(entry).not.toBeNull();
    expect(entry!.qty).toBe(10); // 10 < maxFill 20 — not capped
  });

  it('caps to maxFill when qty > barVol × rate', () => {
    // barVol=20 → maxFill=4; default 10-lot gets capped to 4
    const cfg = makeConfig({
      fill: { participationRate: 0.20, minContracts: 1 },
    });
    const candidate = { ...makeCandidate(2.00), volume: 20 };
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx({ candidates: [candidate] }));

    expect(entry).not.toBeNull();
    expect(entry!.qty).toBe(4); // floor(20 × 0.20) = 4
  });

  it('skips trade when capped qty < minContracts', () => {
    // barVol=5 → maxFill=1; minContracts=3 → skip
    const cfg = makeConfig({
      fill: { participationRate: 0.20, minContracts: 3 },
    });
    const candidate = { ...makeCandidate(2.00), volume: 5 };
    const { entry, skipReason } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx({ candidates: [candidate] }));

    expect(entry).toBeNull();
    expect(skipReason).toContain('liquidity gate');
  });

  it('zero-volume bar: no cap applied (avoids division/floor(0) edge)', () => {
    // barVol=0 → gate skipped, full qty allowed
    const cfg = makeConfig({
      fill: { participationRate: 0.20, minContracts: 1 },
    });
    const candidate = { ...makeCandidate(2.00), volume: 0 };
    const { entry } = evaluateEntry(makeBullishSignal(), [], 0, cfg, makeCtx({ candidates: [candidate] }));

    expect(entry).not.toBeNull();
    expect(entry!.qty).toBe(10); // not capped when barVol=0
  });

  it('DEFAULT_CONFIG has participationRate=0.20', () => {
    expect(DEFAULT_CONFIG.fill?.participationRate).toBe(0.20);
    expect(DEFAULT_CONFIG.fill?.minContracts).toBe(1);
  });
});
