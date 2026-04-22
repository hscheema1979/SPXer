/**
 * Pre-trade quality gate tests.
 * Tests validateTradeQuality() with real inputs — no mocks.
 */
import { describe, it, expect } from 'vitest';
import {
  validateTradeQuality,
  DEFAULT_QUALITY_CONFIG,
  type QualityCheckInput,
} from '../../src/agent/quality-gate';

const NOW = Date.now();

function makeInput(overrides: Partial<QualityCheckInput> = {}): QualityCheckInput {
  return {
    bid: 5.00,
    ask: 5.30,
    quoteTs: NOW - 2000,       // 2s old
    now: NOW,
    recentVolume: 100,
    indicatorsComplete: true,
    signalTs: NOW - 5000,       // 5s old
    config: DEFAULT_QUALITY_CONFIG,
    ...overrides,
  };
}

describe('validateTradeQuality', () => {
  it('passes all checks for a good trade', () => {
    const result = validateTradeQuality(makeInput());
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
    expect(result.spread).toBeCloseTo(0.30, 1);
    expect(result.quoteAgeMs).toBe(2000);
    expect(result.signalAgeMs).toBe(5000);
  });

  // ── Spread checks ──────────────────────────────────────────────────

  it('fails on wide spread', () => {
    const result = validateTradeQuality(makeInput({ bid: 5.00, ask: 6.50 }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('Spread'));
    expect(result.spread).toBeCloseTo(1.50, 1);
  });

  it('passes at exactly max spread', () => {
    const result = validateTradeQuality(makeInput({ bid: 5.00, ask: 6.00 }));
    expect(result.passed).toBe(true);
    expect(result.spread).toBeCloseTo(1.00, 1);
  });

  it('fails when no bid/ask data', () => {
    const result = validateTradeQuality(makeInput({ bid: null, ask: null }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('No bid/ask'));
  });

  // ── Quote freshness ────────────────────────────────────────────────

  it('fails on stale quote', () => {
    const result = validateTradeQuality(makeInput({ quoteTs: NOW - 15_000 }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('Quote stale'));
  });

  it('passes with fresh quote', () => {
    const result = validateTradeQuality(makeInput({ quoteTs: NOW - 500 }));
    expect(result.passed).toBe(true);
  });

  it('passes with null quote timestamp', () => {
    const result = validateTradeQuality(makeInput({ quoteTs: null }));
    expect(result.passed).toBe(true);
  });

  // ── Recent volume ──────────────────────────────────────────────────

  it('fails when no recent trades', () => {
    const result = validateTradeQuality(makeInput({ recentVolume: 0 }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('No recent trades'));
  });

  it('passes with volume > 0', () => {
    const result = validateTradeQuality(makeInput({ recentVolume: 1 }));
    expect(result.passed).toBe(true);
  });

  // ── Indicators ─────────────────────────────────────────────────────

  it('fails when indicators are missing', () => {
    const result = validateTradeQuality(makeInput({ indicatorsComplete: false }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('indicators'));
  });

  // ── Signal freshness ───────────────────────────────────────────────

  it('fails on stale signal', () => {
    const result = validateTradeQuality(makeInput({ signalTs: NOW - 120_000 }));
    expect(result.passed).toBe(false);
    expect(result.failures).toContainEqual(expect.stringContaining('Signal stale'));
  });

  it('passes with fresh signal', () => {
    const result = validateTradeQuality(makeInput({ signalTs: NOW - 1000 }));
    expect(result.passed).toBe(true);
  });

  // ── Multiple failures ──────────────────────────────────────────────

  it('reports all failures at once', () => {
    const result = validateTradeQuality(makeInput({
      bid: 5.00,
      ask: 8.00,           // spread $3
      quoteTs: NOW - 20_000, // stale
      recentVolume: 0,       // no trades
      indicatorsComplete: false,
    }));
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(3);
  });

  // ── Real-world scenarios from audit log ─────────────────────────────

  it('blocks a trade with a $2.97 spread', () => {
    // bid=1.93, ask=4.90
    const result = validateTradeQuality(makeInput({
      bid: 1.93,
      ask: 4.90,
    }));
    expect(result.passed).toBe(false);
    expect(result.spread).toBeCloseTo(2.97, 1);
  });

  it('allows the SPX $0.90 spread trade from today', () => {
    // From audit: bid=27, ask=27.90 — $0.90 spread < $1.00 limit
    const result = validateTradeQuality(makeInput({
      bid: 27,
      ask: 27.90,
    }));
    expect(result.passed).toBe(true);
  });

  it('allows tight SPX spread trades', () => {
    // From audit: bid=6.4, ask=6.6
    const result = validateTradeQuality(makeInput({
      bid: 6.4,
      ask: 6.6,
    }));
    expect(result.passed).toBe(true);
  });
});
