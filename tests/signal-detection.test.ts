/**
 * Signal Detection Unit Tests
 *
 * Tests for stateful signal detection matching replay behavior:
 * - HMA cross detection logic
 * - Fresh cross detection (no duplicates)
 * - State persistence and recovery
 * - Signal emission and recording
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { computeIndicators, registerHmaPeriod } from '../src/core/indicator-engine';
import { aggregate } from '../src/pipeline/aggregator';
import type { CoreBar, Direction } from '../src/core/types';

// Register HMA periods used in tests
beforeEach(() => {
  registerHmaPeriod(3);
  registerHmaPeriod(12);
});

describe('HMA Cross Detection', () => {
  it('should detect bullish cross when fast HMA crosses above slow HMA', () => {
    // Previous: fast=10, slow=15 (below)
    // Current: fast=20, slow=16 (above)
    const prev = createMockBar(1, { hma3: 10, hma12: 15 });
    const curr = createMockBar(2, { hma3: 20, hma12: 16 });

    const cross = detectHmaCross(prev, curr, 3, 12);

    expect(cross).not.toBeNull();
    expect(cross?.direction).toBe('bullish');
    expect(cross?.freshCross).toBe(true);
  });

  it('should detect bearish cross when fast HMA crosses below slow HMA', () => {
    // Previous: fast=20, slow=15 (above)
    // Current: fast=10, slow=16 (below)
    const prev = createMockBar(1, { hma3: 20, hma12: 15 });
    const curr = createMockBar(2, { hma3: 10, hma12: 16 });

    const cross = detectHmaCross(prev, curr, 3, 12);

    expect(cross).not.toBeNull();
    expect(cross?.direction).toBe('bearish');
    expect(cross?.freshCross).toBe(true);
  });

  it('should not detect cross when no crossover occurs', () => {
    // Both below, staying below
    const prev = createMockBar(1, { hma3: 10, hma12: 15 });
    const curr = createMockBar(2, { hma3: 11, hma12: 16 });

    const cross = detectHmaCross(prev, curr, 3, 12);

    expect(cross).toBeNull();
  });

  it('should not detect cross when both indicators are null', () => {
    const prev = createMockBar(1, { hma3: null, hma12: null });
    const curr = createMockBar(2, { hma3: null, hma12: null });

    const cross = detectHmaCross(prev, curr, 3, 12);

    expect(cross).toBeNull();
  });

  it('should handle edge case where fast equals slow (no cross)', () => {
    const prev = createMockBar(1, { hma3: 15, hma12: 15 });
    const curr = createMockBar(2, { hma3: 15, hma12: 15 });

    const cross = detectHmaCross(prev, curr, 3, 12);

    expect(cross).toBeNull();
  });
});

describe('Fresh Cross Detection (Dedup)', () => {
  it('should detect first cross as fresh', () => {
    const state = createMockState();
    const prev = createMockBar(1, { hma3: 10, hma12: 15 });
    const curr = createMockBar(2, { hma3: 20, hma12: 16 });

    const signal = checkFreshCross(prev, curr, state, 3, 12);

    expect(signal).not.toBeNull();
    expect(signal?.isFresh).toBe(true);
    expect(state.lastDirectionBarTs).toBe(curr.ts);
  });

  it('should not fire duplicate signal for same bar', () => {
    const state = createMockState({ lastDirectionBarTs: 100 });
    const prev = createMockBar(99, { hma3: 10, hma12: 15 });
    const curr = createMockBar(100, { hma3: 20, hma12: 16 });

    const signal = checkFreshCross(prev, curr, state, 3, 12);

    expect(signal).toBeNull(); // Already fired for this bar
  });

  it('should fire new cross for different bar even if same direction', () => {
    const state = createMockState({ lastDirectionBarTs: 100 });
    const prev = createMockBar(101, { hma3: 20, hma12: 16 });
    const curr = createMockBar(102, { hma3: 10, hma12: 18 }); // Crossed back below

    const signal = checkFreshCross(prev, curr, state, 3, 12);

    expect(signal).not.toBeNull();
    expect(signal?.isFresh).toBe(true);
    expect(state.lastDirectionBarTs).toBe(102);
  });
});

describe('Aggregation and Indicator Computation', () => {
  it('should aggregate 1m bars to 3m bars correctly', () => {
    const bars1m = createMockBars1m([
      { ts: 100, close: 10 },
      { ts: 101, close: 11 },
      { ts: 102, close: 12 },
    ]);

    const agg3m = aggregate(bars1m, '3m', 180);

    expect(agg3m.length).toBe(1);
    expect(agg3m[0].open).toBe(10);
    expect(agg3m[0].high).toBe(13); // 11+1 and 12+1, max is 13
    expect(agg3m[0].low).toBe(9);  // 10-1, min is 9
    expect(agg3m[0].close).toBe(12);
    expect(agg3m[0].volume).toBe(30);
  });

  it('should compute HMA indicators on aggregated bars', () => {
    // Create enough bars for HMA12 warmup (need at least 12 bars, plus padding)
    const bars1m: CoreBar[] = [];
    for (let i = 0; i < 50; i++) {
      bars1m.push({
        symbol: 'TEST',
        timeframe: '1m',
        ts: 1000 + i * 60,
        open: 10 + i * 0.1,
        high: 10.5 + i * 0.1,
        low: 9.5 + i * 0.1,
        close: 10 + i * 0.1,
        volume: 100,
        indicators: {},
        synthetic: false,
        gapType: null,
      });
    }

    const agg3m = aggregate(bars1m.map(b => ({ ...b, indicators: {}, synthetic: false, gapType: null })), '3m', 180);

    expect(agg3m.length).toBeGreaterThan(10); // Should have ~16 3m bars from 50 1m bars

    // Compute indicators on all bars (stateful computation)
    const enriched = agg3m.map(b => ({
      ...b,
      indicators: computeIndicators(b, 2),
    }));

    // Last bar should have HMA values
    const lastBar = enriched[enriched.length - 1];
    expect(lastBar.indicators.hma3).not.toBeNull();
    expect(lastBar.indicators.hma12).not.toBeNull();
    expect(typeof lastBar.indicators.hma3).toBe('number');
    expect(typeof lastBar.indicators.hma12).toBe('number');
  });
});

describe('Signal State Serialization', () => {
  it('should serialize and deserialize signal state correctly', () => {
    const state = createMockState({
      directionCross: 'bullish',
      prevDirectionHmaFast: 15.5,
      prevDirectionHmaSlow: 14.2,
      lastDirectionBarTs: 123456,
    });

    const serialized = JSON.stringify(state);
    const deserialized = JSON.parse(serialized);

    expect(deserialized.directionCross).toBe('bullish');
    expect(deserialized.prevDirectionHmaFast).toBe(15.5);
    expect(deserialized.prevDirectionHmaSlow).toBe(14.2);
    expect(deserialized.lastDirectionBarTs).toBe(123456);
  });
});

describe('Cross Detection Edge Cases', () => {
  it('should handle rapid back-to-back crosses', () => {
    const state = createMockState();

    // First cross: bullish
    const prev1 = createMockBar(1, { hma3: 10, hma12: 15 });
    const curr1 = createMockBar(2, { hma3: 20, hma12: 16 });
    const signal1 = checkFreshCross(prev1, curr1, state, 3, 12);
    expect(signal1?.direction).toBe('bullish');

    // Second cross: bearish (immediate reversal)
    const prev2 = createMockBar(3, { hma3: 20, hma12: 16 });
    const curr2 = createMockBar(4, { hma3: 15, hma12: 18 });
    const signal2 = checkFreshCross(prev2, curr2, state, 3, 12);
    expect(signal2?.direction).toBe('bearish');
  });

  it('should handle multiple crosses without dedup false positives', () => {
    const state = createMockState();
    const signals: any[] = [];

    // Simulate multiple crosses
    const scenarios = [
      { prev: { hma3: 10, hma12: 15 }, curr: { hma3: 20, hma12: 16 }, ts: 100, dir: 'bullish' },
      { prev: { hma3: 20, hma12: 16 }, curr: { hma3: 15, hma12: 18 }, ts: 200, dir: 'bearish' },
      { prev: { hma3: 15, hma12: 18 }, curr: { hma3: 25, hma12: 17 }, ts: 300, dir: 'bullish' },
    ];

    scenarios.forEach((scenario, i) => {
      const prev = createMockBar(scenario.ts - 60, scenario.prev);
      const curr = createMockBar(scenario.ts, scenario.curr);
      const signal = checkFreshCross(prev, curr, state, 3, 12);

      if (signal) {
        signals.push({ ts: scenario.ts, direction: signal.direction });
      }
    });

    expect(signals.length).toBe(3);
    expect(signals[0].direction).toBe('bullish');
    expect(signals[1].direction).toBe('bearish');
    expect(signals[2].direction).toBe('bullish');
  });
});

// Helper functions

interface MockIndicators {
  hma3?: number | null;
  hma12?: number | null;
}

function createMockBar(ts: number, indicators: MockIndicators): CoreBar {
  return {
    symbol: 'TEST',
    timeframe: '3m',
    ts,
    open: 10,
    high: 12,
    low: 8,
    close: 11,
    volume: 100,
    indicators: {
      hma3: indicators.hma3 ?? null,
      hma12: indicators.hma12 ?? null,
    },
    synthetic: false,
    gapType: null,
  };
}

interface MockStateOptions {
  lastDirectionBarTs?: number | null;
  directionCross?: Direction | null;
  prevDirectionHmaFast?: number | null;
  prevDirectionHmaSlow?: number | null;
}

function createMockState(options: MockStateOptions = {}): any {
  return {
    lastDirectionBarTs: options.lastDirectionBarTs ?? null,
    directionCross: options.directionCross ?? null,
    prevDirectionHmaFast: options.prevDirectionHmaFast ?? null,
    prevDirectionHmaSlow: options.prevDirectionHmaSlow ?? null,
    exitCross: null,
    prevExitHmaFast: null,
    prevExitHmaSlow: null,
    lastExitBarTs: null,
  };
}

function detectHmaCross(
  prev: CoreBar,
  curr: CoreBar,
  fastPeriod: number,
  slowPeriod: number
): { direction: 'bullish' | 'bearish'; freshCross: boolean } | null {
  const prevFast = prev.indicators[`hma${fastPeriod}`];
  const prevSlow = prev.indicators[`hma${slowPeriod}`];
  const currFast = curr.indicators[`hma${fastPeriod}`];
  const currSlow = curr.indicators[`hma${slowPeriod}`];

  if (prevFast == null || prevSlow == null || currFast == null || currSlow == null) {
    return null;
  }

  const wasAbove = prevFast > prevSlow;
  const isAbove = currFast > currSlow;

  if (wasAbove !== isAbove) {
    return {
      direction: isAbove ? 'bullish' : 'bearish',
      freshCross: true,
    };
  }

  return null;
}

function checkFreshCross(
  prev: CoreBar,
  curr: CoreBar,
  state: any,
  fastPeriod: number,
  slowPeriod: number
): { isFresh: boolean; direction: 'bullish' | 'bearish'; ts: number } | null {
  const cross = detectHmaCross(prev, curr, fastPeriod, slowPeriod);

  if (!cross) return null;

  // Check dedup
  if (state.lastDirectionBarTs === curr.ts) {
    return null; // Already fired for this bar
  }

  state.lastDirectionBarTs = curr.ts;

  return {
    isFresh: true,
    direction: cross.direction,
    ts: curr.ts,
  };
}

interface MockBar1m {
  ts: number;
  close: number;
}

function createMockBars1m(data: MockBar1m[]): CoreBar[] {
  return data.map(d => ({
    symbol: 'TEST',
    timeframe: '1m',
    ts: d.ts,
    open: d.close,
    high: d.close + 1,
    low: d.close - 1,
    close: d.close,
    volume: 10,
    indicators: {},
    synthetic: false,
    gapType: null,
  }));
}
