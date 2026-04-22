import { describe, it, expect } from 'vitest';
import { evaluateReentry, type ReentryState, type ReentryGateContext } from '../../src/core/reentry-evaluator';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import type { Config } from '../../src/config/types';

function makeConfig(overrides: Partial<NonNullable<Config['exit']['reentryOnTakeProfit']>> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    // Widen the active window so synthetic test timestamps (ts=1000 etc.) pass
    // the shared entry-gate's time-window check. The reentry-specific gates are
    // what these tests target; the shared gate has its own dedicated test file.
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeStart: '00:00',
      activeEnd: '23:59',
    },
    exit: {
      ...DEFAULT_CONFIG.exit,
      reentryOnTakeProfit: {
        enabled: true,
        strategy: 'same_direction',
        maxReentriesPerDay: 3,
        maxReentriesPerSignal: 1,
        cooldownSec: 30,
        sizeMultiplier: 1.0,
        requireOptionHmaConfirm: false,
        ...overrides,
      },
    },
  };
}

/** Neutral gate context — all entry-gate checks pass. */
function makeGateCtx(currentTs: number, overrides: Partial<ReentryGateContext> = {}): ReentryGateContext {
  return {
    openPositions: 0,
    tradesCompleted: 0,
    dailyPnl: 0,
    closeCutoffTs: currentTs + 100000,
    lastEntryTs: 0,
    ...overrides,
  };
}

function makeState(overrides: Partial<ReentryState> = {}): ReentryState {
  return {
    reentriesToday: 0,
    reentriesThisChain: 0,
    lastReentryTs: 0,
    closedExitReason: 'take_profit',
    closedSide: 'bullish',
    optionHmaDirection: 'bullish',
    ...overrides,
  };
}

describe('evaluateReentry', () => {
  it('returns disallowed when feature disabled', () => {
    const config = makeConfig({ enabled: false });
    const result = evaluateReentry(makeState(), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it('returns disallowed when feature config missing entirely', () => {
    const config = { ...DEFAULT_CONFIG, exit: { ...DEFAULT_CONFIG.exit, reentryOnTakeProfit: undefined } };
    const result = evaluateReentry(makeState(), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
  });

  it('returns disallowed when exit reason is not take_profit', () => {
    const config = makeConfig();
    const result = evaluateReentry(makeState({ closedExitReason: 'stop_loss' }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('stop_loss');
  });

  it('returns disallowed when daily cap reached', () => {
    const config = makeConfig({ maxReentriesPerDay: 2 });
    const result = evaluateReentry(makeState({ reentriesToday: 2 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('daily cap');
  });

  it('returns disallowed when chain cap reached', () => {
    const config = makeConfig({ maxReentriesPerSignal: 1 });
    const result = evaluateReentry(makeState({ reentriesThisChain: 1 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('chain cap');
  });

  it('returns disallowed during cooldown', () => {
    const config = makeConfig({ cooldownSec: 60 });
    const result = evaluateReentry(makeState({ lastReentryTs: 950 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cooldown');
  });

  it('allows once cooldown elapsed', () => {
    const config = makeConfig({ cooldownSec: 60 });
    const result = evaluateReentry(makeState({ lastReentryTs: 900 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(true);
  });

  it('cooldown ignored when lastReentryTs is 0 (no prior re-entry)', () => {
    const config = makeConfig({ cooldownSec: 600 });
    const result = evaluateReentry(makeState({ lastReentryTs: 0 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(true);
  });

  it('blocks when option HMA flipped against side (fresh_signal_required)', () => {
    const config = makeConfig({ strategy: 'fresh_signal_required' });
    const result = evaluateReentry(
      makeState({ closedSide: 'bullish', optionHmaDirection: 'bearish' }),
      config,
      1000,
      makeGateCtx(1000),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('HMA flipped');
  });

  it('blocks when option HMA unknown (fresh_signal_required)', () => {
    const config = makeConfig({ strategy: 'fresh_signal_required' });
    const result = evaluateReentry(
      makeState({ optionHmaDirection: null }),
      config,
      1000,
      makeGateCtx(1000),
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unknown');
  });

  it('allows when option HMA still confirms (fresh_signal_required)', () => {
    const config = makeConfig({ strategy: 'fresh_signal_required' });
    const result = evaluateReentry(
      makeState({ closedSide: 'bullish', optionHmaDirection: 'bullish' }),
      config,
      1000,
      makeGateCtx(1000),
    );
    expect(result.allowed).toBe(true);
  });

  it('respects requireOptionHmaConfirm even in same_direction mode', () => {
    const config = makeConfig({ strategy: 'same_direction', requireOptionHmaConfirm: true });
    const result = evaluateReentry(
      makeState({ closedSide: 'bullish', optionHmaDirection: 'bearish' }),
      config,
      1000,
      makeGateCtx(1000),
    );
    expect(result.allowed).toBe(false);
  });

  it('returns side and sizeMultiplier on allow', () => {
    const config = makeConfig({ sizeMultiplier: 0.5 });
    const result = evaluateReentry(makeState({ closedSide: 'bearish' }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(true);
    expect(result.side).toBe('bearish');
    expect(result.sizeMultiplier).toBe(0.5);
  });

  it('maxReentriesPerDay=0 disables the daily cap (treats 0 as unlimited)', () => {
    // Per the implementation, 0 means "no cap is enforced"
    const config = makeConfig({ maxReentriesPerDay: 0 });
    const result = evaluateReentry(makeState({ reentriesToday: 999 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(true);
  });

  it('maxReentriesPerSignal=0 disables the chain cap', () => {
    const config = makeConfig({ maxReentriesPerSignal: 0 });
    const result = evaluateReentry(makeState({ reentriesThisChain: 999 }), config, 1000, makeGateCtx(1000));
    expect(result.allowed).toBe(true);
  });

  it('blocks via shared entry gate when open positions at cap', () => {
    const config = makeConfig();
    const result = evaluateReentry(
      makeState(),
      config,
      1000,
      makeGateCtx(1000, { openPositions: config.position.maxPositionsOpen }),
    );
    expect(result.allowed).toBe(false);
  });

  it('blocks via shared entry gate past closeCutoffTs', () => {
    const config = makeConfig();
    const result = evaluateReentry(
      makeState(),
      config,
      1000,
      makeGateCtx(1000, { closeCutoffTs: 900 }),
    );
    expect(result.allowed).toBe(false);
  });
});
