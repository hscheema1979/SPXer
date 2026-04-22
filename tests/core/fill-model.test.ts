import { describe, it, expect } from 'vitest';
import { slipSellPrice, slipBuyPrice, resolveSlippage, type ResolvedSlippage } from '../../src/core/fill-model';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import type { Config } from '../../src/config/types';

// ── slipSellPrice ───────────────────────────────────────────────────────────

const NO_SLIP: ResolvedSlippage = {
  slSlipPerContract: 0, slSlipMax: 0,
  entrySlipPerContract: 0, entrySlipMax: 0,
  slSpreadFactor: 0, slEodPenalty: 0, slEodWindowMin: 15,
};
const SMALL: ResolvedSlippage = {
  slSlipPerContract: 0.002, slSlipMax: 0.50,
  entrySlipPerContract: 0.002, entrySlipMax: 0.50,
  slSpreadFactor: 0, slEodPenalty: 0, slEodWindowMin: 15,
};
const AGGRESSIVE: ResolvedSlippage = {
  slSlipPerContract: 0.010, slSlipMax: 1.00,
  entrySlipPerContract: 0.010, entrySlipMax: 1.00,
  slSpreadFactor: 0, slEodPenalty: 0, slEodWindowMin: 15,
};

describe('slipSellPrice', () => {
  it('returns stop price unchanged when slippage is zero', () => {
    expect(slipSellPrice(1.00, 100, NO_SLIP)).toBe(1.00);
    expect(slipSellPrice(5.50, 1, NO_SLIP)).toBe(5.50);
  });

  it('applies size-proportional slippage', () => {
    // 10-lot at $0.002/contract = $0.02 impact
    expect(slipSellPrice(1.00, 10, SMALL)).toBeCloseTo(0.98, 4);
    // 100-lot = $0.20 impact
    expect(slipSellPrice(1.00, 100, SMALL)).toBeCloseTo(0.80, 4);
    // 1-lot = $0.002 impact (rounds to same penny but math is exact)
    expect(slipSellPrice(1.00, 1, SMALL)).toBeCloseTo(0.998, 4);
  });

  it('respects slSlipMax cap', () => {
    // 1000-lot would be $2.00 raw, capped at $0.50
    expect(slipSellPrice(1.00, 1000, SMALL)).toBeCloseTo(0.50, 4);
    // Right at the cap boundary: 250 * 0.002 = 0.50 exactly
    expect(slipSellPrice(1.00, 250, SMALL)).toBeCloseTo(0.50, 4);
    // Just under the cap
    expect(slipSellPrice(1.00, 200, SMALL)).toBeCloseTo(0.60, 4);
  });

  it('floors at $0.01 (options cannot trade sub-penny)', () => {
    // Aggressive slippage that would push below $0.01
    expect(slipSellPrice(0.10, 1000, AGGRESSIVE)).toBe(0.01);
    // Extreme case: stop at $0.05, big slippage
    expect(slipSellPrice(0.05, 500, AGGRESSIVE)).toBe(0.01);
  });

  it('handles zero qty gracefully', () => {
    expect(slipSellPrice(1.00, 0, SMALL)).toBe(1.00);
  });

  it('negative qty clamped to zero impact', () => {
    expect(slipSellPrice(1.00, -10, SMALL)).toBe(1.00);
  });

  it('monotonically non-increasing in qty', () => {
    const prices = [1, 5, 10, 50, 100, 500, 1000].map(q => slipSellPrice(2.00, q, SMALL));
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
    }
  });
});

// ── slipBuyPrice ────────────────────────────────────────────────────────────

describe('slipBuyPrice', () => {
  it('returns raw price unchanged when slippage is zero', () => {
    expect(slipBuyPrice(1.00, 100, NO_SLIP)).toBe(1.00);
    expect(slipBuyPrice(5.50, 1, NO_SLIP)).toBe(5.50);
  });

  it('adds size-proportional slippage', () => {
    expect(slipBuyPrice(1.00, 10, SMALL)).toBeCloseTo(1.02, 4);
    expect(slipBuyPrice(1.00, 100, SMALL)).toBeCloseTo(1.20, 4);
  });

  it('respects entrySlipMax cap', () => {
    // 1000-lot: 1000*0.002=2.00 raw, capped at 0.50
    expect(slipBuyPrice(1.00, 1000, SMALL)).toBeCloseTo(1.50, 4);
  });

  it('floors at $0.01', () => {
    // Extremely low price + negative slip would underflow — still floor at 0.01
    // (negative impact not possible in practice, but guard it)
    expect(slipBuyPrice(0.01, 0, NO_SLIP)).toBe(0.01);
  });

  it('is symmetric with slipSellPrice in magnitude (same defaults)', () => {
    const buyImpact = slipBuyPrice(2.00, 100, SMALL) - 2.00;
    const sellImpact = 2.00 - slipSellPrice(2.00, 100, SMALL);
    expect(buyImpact).toBeCloseTo(sellImpact, 8);
  });

  it('monotonically non-decreasing in qty', () => {
    const prices = [1, 5, 10, 50, 100, 500, 1000].map(q => slipBuyPrice(2.00, q, SMALL));
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]).toBeGreaterThanOrEqual(prices[i - 1]);
    }
  });
});

// ── resolveSlippage ─────────────────────────────────────────────────────────

describe('resolveSlippage', () => {
  it('returns zero for all fields when config.fill is absent', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, fill: undefined };
    const r = resolveSlippage(cfg);
    expect(r.slSlipPerContract).toBe(0);
    expect(r.slSlipMax).toBe(0);
    expect(r.entrySlipPerContract).toBe(0);
    expect(r.entrySlipMax).toBe(0);
    expect(r.slSpreadFactor).toBe(0);
    expect(r.slEodPenalty).toBe(0);
    expect(r.slEodWindowMin).toBe(15); // default window
  });

  it('returns zero for all fields when config.fill.slippage is absent', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, fill: {} };
    const r = resolveSlippage(cfg);
    expect(r.slSlipPerContract).toBe(0);
    expect(r.slSlipMax).toBe(0);
    expect(r.entrySlipPerContract).toBe(0);
    expect(r.entrySlipMax).toBe(0);
    expect(r.slSpreadFactor).toBe(0);
    expect(r.slEodPenalty).toBe(0);
    expect(r.slEodWindowMin).toBe(15);
  });

  it('reads default values from DEFAULT_CONFIG (entry + SL symmetric)', () => {
    const r = resolveSlippage(DEFAULT_CONFIG);
    expect(r.slSlipPerContract).toBe(0.002);
    expect(r.slSlipMax).toBe(0.50);
    expect(r.entrySlipPerContract).toBe(0.002);
    expect(r.entrySlipMax).toBe(0.50);
  });

  it('respects overrides on all four fields', () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      fill: {
        slippage: {
          slSlipPerContract: 0.005, slSlipMax: 2.00,
          entrySlipPerContract: 0.003, entrySlipMax: 1.50,
        },
      },
    };
    const r = resolveSlippage(cfg);
    expect(r.slSlipPerContract).toBe(0.005);
    expect(r.slSlipMax).toBe(2.00);
    expect(r.entrySlipPerContract).toBe(0.003);
    expect(r.entrySlipMax).toBe(1.50);
  });

  it('partial override: missing fields fall back to zero', () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      fill: { slippage: { slSlipPerContract: 0.005 } },
    };
    const r = resolveSlippage(cfg);
    expect(r.slSlipPerContract).toBe(0.005);
    expect(r.slSlipMax).toBe(0);
    expect(r.entrySlipPerContract).toBe(0);
    expect(r.entrySlipMax).toBe(0);
    expect(r.slSpreadFactor).toBe(0);
    expect(r.slEodPenalty).toBe(0);
  });
});

// ── Task 2.3: spread-scaled SL slippage + EOD penalty ───────────────────────

describe('slipSellPrice (Task 2.3 — spread + EOD)', () => {
  const WITH_SPREAD: ResolvedSlippage = {
    slSlipPerContract: 0, slSlipMax: 0, // size impact disabled
    entrySlipPerContract: 0, entrySlipMax: 0,
    slSpreadFactor: 0.5, slEodPenalty: 0, slEodWindowMin: 15,
  };
  const WITH_EOD: ResolvedSlippage = {
    slSlipPerContract: 0, slSlipMax: 0,
    entrySlipPerContract: 0, entrySlipMax: 0,
    slSpreadFactor: 0, slEodPenalty: 0.10, slEodWindowMin: 15,
  };
  const FULL: ResolvedSlippage = {
    slSlipPerContract: 0.002, slSlipMax: 2.00,
    entrySlipPerContract: 0, entrySlipMax: 0,
    slSpreadFactor: 0.5, slEodPenalty: 0.10, slEodWindowMin: 15,
  };

  it('no context → behaves like size-only model', () => {
    expect(slipSellPrice(1.00, 10, WITH_SPREAD)).toBe(1.00);
    expect(slipSellPrice(1.00, 10, WITH_EOD)).toBe(1.00);
  });

  it('spread-scaled impact subtracts spread * factor', () => {
    // 0.20 spread * 0.5 factor = 0.10 off
    const fill = slipSellPrice(1.00, 10, WITH_SPREAD, { spread: 0.20 });
    expect(fill).toBeCloseTo(0.90, 4);
  });

  it('zero or negative spread is a no-op', () => {
    expect(slipSellPrice(1.00, 10, WITH_SPREAD, { spread: 0 })).toBe(1.00);
    expect(slipSellPrice(1.00, 10, WITH_SPREAD, { spread: -0.05 })).toBe(1.00);
  });

  it('EOD penalty applies strictly inside window', () => {
    // Inside window (10 min left, window=15)
    expect(slipSellPrice(1.00, 10, WITH_EOD, { minutesToClose: 10 })).toBeCloseTo(0.90, 4);
    // On boundary
    expect(slipSellPrice(1.00, 10, WITH_EOD, { minutesToClose: 15 })).toBeCloseTo(0.90, 4);
    // Outside window — no penalty
    expect(slipSellPrice(1.00, 10, WITH_EOD, { minutesToClose: 20 })).toBe(1.00);
    // No minutesToClose — no penalty
    expect(slipSellPrice(1.00, 10, WITH_EOD, {})).toBe(1.00);
  });

  it('combined: size + spread + EOD all stack under cap', () => {
    // size: 10 * 0.002 = 0.02; spread: 0.10 * 0.5 = 0.05; EOD: 0.10 → total 0.17
    const fill = slipSellPrice(1.50, 10, FULL, { spread: 0.10, minutesToClose: 5 });
    expect(fill).toBeCloseTo(1.50 - 0.17, 4);
  });

  it('combined: capped at slSlipMax', () => {
    // Spread 2.00 * 0.5 = 1.00; size 100*0.002 = 0.20; EOD 0.10 → 1.30 raw, cap 2.00
    const fill = slipSellPrice(5.00, 100, FULL, { spread: 2.00, minutesToClose: 5 });
    expect(5.00 - fill).toBeCloseTo(1.30, 4);
    // Now blow through cap
    const capped = { ...FULL, slSlipMax: 0.50 };
    const fill2 = slipSellPrice(5.00, 100, capped, { spread: 2.00, minutesToClose: 5 });
    expect(5.00 - fill2).toBeCloseTo(0.50, 4);
  });

  it('floor at $0.01 still enforced with combined impacts', () => {
    const fill = slipSellPrice(0.05, 100, FULL, { spread: 1.00, minutesToClose: 5 });
    expect(fill).toBe(0.01);
  });
});
