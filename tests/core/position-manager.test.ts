import { describe, it, expect } from 'vitest';
import { checkExit, type ExitContext } from '../../src/core/position-manager';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import type { Position } from '../../src/core/types';
import type { Config } from '../../src/config/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE_TS = 1775052000; // 2026-04-01 10:00 ET

function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'SPXW260401C06600000',
    side: 'call',
    strike: 6600,
    qty: 10,
    entryPrice: 1.00,
    stopLoss: 0.80,      // -20%
    takeProfit: 1.20,    // +20% (i.e. TP multiplier 1.2)
    entryTs: BASE_TS,
    entryET: '10:00',
    ...overrides,
  };
}

function makeConfig(exitPricing: 'close' | 'intrabar' = 'close', overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    exit: {
      ...DEFAULT_CONFIG.exit,
      exitPricing,
      ...(overrides.exit ?? {}),
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: 20,
      ...(overrides.position ?? {}),
    },
  };
}

/** Config with Phase 2 slippage disabled — used to isolate Phase 1 clamp logic. */
function makeConfigNoSlip(exitPricing: 'close' | 'intrabar' = 'close'): Config {
  return { ...makeConfig(exitPricing), fill: undefined };
}

function makeCtx(overrides: Partial<ExitContext> = {}): ExitContext {
  return {
    ts: BASE_TS + 60,
    closeCutoffTs: BASE_TS + 3600 * 6,
    hmaCrossDirection: null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('checkExit — close-based TP/SL clamp (Phase 1 fix)', () => {
  it('TP hit: fills at takeProfit exactly, not at currentPrice', () => {
    const pos = makePosition({ entryPrice: 1.00, takeProfit: 1.20 });
    // Bar closed at $2.50 — catastrophic TP overshoot. Must clamp to $1.20.
    const result = checkExit(pos, 2.50, makeConfig('close'), makeCtx());

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('take_profit');
    expect(result.exitPrice).toBe(1.20);
  });

  it('TP hit: fills at takeProfit when currentPrice barely breaches', () => {
    const pos = makePosition({ entryPrice: 1.00, takeProfit: 1.20 });
    const result = checkExit(pos, 1.21, makeConfig('close'), makeCtx());

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('take_profit');
    expect(result.exitPrice).toBe(1.20);
  });

  it('SL hit: fills at stopLoss exactly, not at currentPrice (slippage off)', () => {
    const pos = makePosition({ entryPrice: 1.00, stopLoss: 0.80 });
    // Bar closed at $0.40 — price gapped well through the stop.
    // With slippage disabled (Phase 1 isolation), fills at stopLoss exactly.
    const result = checkExit(pos, 0.40, makeConfigNoSlip('close'), makeCtx());

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.80);
  });

  it('no exit: returns shouldExit=false with no exitPrice', () => {
    const pos = makePosition();
    const result = checkExit(pos, 1.05, makeConfig('close'), makeCtx());

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.exitPrice).toBeUndefined();
  });

  it('time_exit has no exitPrice (caller uses bar close)', () => {
    const pos = makePosition();
    const ctx = makeCtx({
      ts: BASE_TS + 3600 * 10, // well past closeCutoffTs
    });
    const result = checkExit(pos, 0.95, makeConfig('close'), ctx);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('time_exit');
    expect(result.exitPrice).toBeUndefined();
  });

  it('signal_reversal has no exitPrice (caller uses bar close)', () => {
    const pos = makePosition({ side: 'call' });
    const cfg = makeConfig('close', {
      exit: { ...DEFAULT_CONFIG.exit, strategy: 'scannerReverse' } as Config['exit'],
    });
    const ctx = makeCtx({
      hmaCrossDirection: 'bearish',
      hmaCrossFresh: true,
    });
    const result = checkExit(pos, 0.95, cfg, ctx);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('signal_reversal');
    expect(result.exitPrice).toBeUndefined();
  });
});

describe('checkExit — SL slippage (Phase 2)', () => {
  it('default DEFAULT_CONFIG slippage: 10-lot SL fills slightly below stop', () => {
    const pos = makePosition({ qty: 10, stopLoss: 0.80 });
    // DEFAULT_CONFIG.fill.slippage = { slSlipPerContract: 0.002, slSlipMax: 0.50 }
    // 10 * 0.002 = 0.02 → fill at 0.78
    const result = checkExit(pos, 0.40, makeConfig('close'), makeCtx());

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBeCloseTo(0.78, 4);
  });

  it('100-lot SL: slippage scales with size', () => {
    const pos = makePosition({ qty: 100, stopLoss: 0.80 });
    // 100 * 0.002 = 0.20 → fill at 0.60
    const result = checkExit(pos, 0.40, makeConfig('close'), makeCtx());

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBeCloseTo(0.60, 4);
  });

  it('1000-lot SL: slippage capped by slSlipMax', () => {
    const pos = makePosition({ qty: 1000, stopLoss: 0.80 });
    // 1000 * 0.002 = 2.00, capped at 0.50 → fill at 0.30
    const result = checkExit(pos, 0.40, makeConfig('close'), makeCtx());

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBeCloseTo(0.30, 4);
  });

  it('slippage floors at $0.01 for low-priced stops', () => {
    const pos = makePosition({ qty: 1000, stopLoss: 0.10 });
    const result = checkExit(pos, 0.05, makeConfig('close'), makeCtx());

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.01);
  });

  it('config with slippage disabled: fills at stop exactly (Phase 1 behavior preserved)', () => {
    const pos = makePosition({ qty: 100, stopLoss: 0.80 });
    const cfg: Config = { ...makeConfig('close'), fill: undefined };
    const result = checkExit(pos, 0.40, cfg, makeCtx());

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.80);
  });

  it('TP fills remain at takeProfit exactly (no slippage applied to limit orders)', () => {
    const pos = makePosition({ qty: 100, entryPrice: 1.00, takeProfit: 1.20 });
    const result = checkExit(pos, 2.50, makeConfig('close'), makeCtx());

    expect(result.reason).toBe('take_profit');
    expect(result.exitPrice).toBe(1.20); // no slippage on limit fills
  });

  it('intrabar SL: slippage also applied', () => {
    const pos = makePosition({ qty: 100, stopLoss: 0.80 });
    const ctx = makeCtx({ barHigh: 1.05, barLow: 0.50 });
    const result = checkExit(pos, 0.95, makeConfig('intrabar'), ctx);

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBeCloseTo(0.60, 4); // 100-lot slippage applied
  });

  it('trailing stop: slippage applied to trail level (not hard SL)', () => {
    const pos = makePosition({ qty: 100, entryPrice: 1.00, stopLoss: 0.80, takeProfit: 99.99 });
    const cfg = makeConfig('close', {
      exit: {
        ...DEFAULT_CONFIG.exit,
        trailingStopEnabled: true,
        trailingStopPercent: 20,
      } as Config['exit'],
    });
    // Position ran up to $2.00 high-water. Trail level = 2.00 * (1 - 0.20) = 1.60.
    // Current price 1.50 < trail stop 1.60, and 1.50 > hard SL 0.80 → trailing fires.
    // Fill price: 1.60 - (100 * 0.002) = 1.60 - 0.20 = 1.40
    const ctx = makeCtx({ highWaterPrice: 2.00 });
    const result = checkExit(pos, 1.50, cfg, ctx);

    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBeCloseTo(1.40, 4);
  });
});

describe('checkExit — intrabar mode still clamps (unchanged)', () => {
  it('intrabar TP: exitPrice = takeProfit when barHigh breaches', () => {
    const pos = makePosition({ takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.95 });
    const result = checkExit(pos, 1.10, makeConfig('intrabar'), ctx);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('take_profit');
    expect(result.exitPrice).toBe(1.20);
  });

  it('intrabar SL: exitPrice = stopLoss when barLow breaches (slippage off)', () => {
    const pos = makePosition({ stopLoss: 0.80 });
    const ctx = makeCtx({ barHigh: 1.05, barLow: 0.50 });
    const result = checkExit(pos, 0.95, makeConfigNoSlip('intrabar'), ctx);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.80);
  });

  it('intrabar SL+TP same bar: SL takes priority (conservative, slippage off)', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50 });
    const result = checkExit(pos, 1.00, makeConfigNoSlip('intrabar'), ctx);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.80);
  });
});

describe('checkExit — configurable intrabar tie-breaker (Task 2.2)', () => {
  it('default (unset) preserves sl_wins behavior', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50 });
    const cfg = makeConfigNoSlip('intrabar');
    // intrabarTieBreaker unset → defaults to sl_wins
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('stop_loss');
  });

  it('sl_wins mode returns stop_loss on tie', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50 });
    const cfg = makeConfigNoSlip('intrabar');
    cfg.position.intrabarTieBreaker = 'sl_wins';
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('stop_loss');
    expect(result.exitPrice).toBe(0.80);
  });

  it('tp_wins mode returns take_profit on tie', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50 });
    const cfg = makeConfigNoSlip('intrabar');
    cfg.position.intrabarTieBreaker = 'tp_wins';
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('take_profit');
    expect(result.exitPrice).toBe(1.20);
  });

  it('by_open: open closer to TP → TP wins', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    // open at 1.15 — much closer to TP (1.20) than SL (0.80)
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50, barOpen: 1.15 });
    const cfg = makeConfigNoSlip('intrabar');
    cfg.position.intrabarTieBreaker = 'by_open';
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('take_profit');
  });

  it('by_open: open closer to SL → SL wins', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    // open at 0.85 — much closer to SL (0.80) than TP (1.20)
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50, barOpen: 0.85 });
    const cfg = makeConfigNoSlip('intrabar');
    cfg.position.intrabarTieBreaker = 'by_open';
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('stop_loss');
  });

  it('by_open with missing barOpen falls back to sl_wins', () => {
    const pos = makePosition({ stopLoss: 0.80, takeProfit: 1.20 });
    const ctx = makeCtx({ barHigh: 1.50, barLow: 0.50 }); // no barOpen
    const cfg = makeConfigNoSlip('intrabar');
    cfg.position.intrabarTieBreaker = 'by_open';
    const result = checkExit(pos, 1.00, cfg, ctx);
    expect(result.reason).toBe('stop_loss'); // defensive fallback
  });
});
