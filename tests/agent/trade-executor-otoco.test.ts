/**
 * Task 3.4 — End-to-end OTOCO scenarios for openPosition():
 *   1. Entry filled + TP rejected (partial accept) — counter should mark protected
 *      (verifyOtocoProtection fires an alert in background; the counter tracks
 *      submission outcome, not background verification).
 *   2. Entry filled + both legs rejected — still "protected" from counter POV;
 *      the partial-accept alert handles the UNPROTECTED case operationally.
 *   3. Full OTOCO POST rejected (axios throws) — falls through to bare order,
 *      re-entry counter must increment tpReentriesUnprotected.
 *   4. Re-entry + bracket disabled (disableBracketOrders=true) — skips OTOCO
 *      entirely, re-entry counter must increment tpReentriesUnprotected.
 *
 * We mock axios at the module boundary so no network calls happen. The test
 * focuses on counter correctness and the orderId/bracketOrderId wiring — not
 * the internals of Tradier's response format.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock axios BEFORE importing the module under test.
vi.mock('axios', () => {
  const post = vi.fn();
  const get = vi.fn();
  const del = vi.fn();
  return {
    default: { post, get, delete: del },
    post, get, delete: del,
  };
});

import axios from 'axios';
import { openPosition } from '../../src/agent/trade-executor';
import {
  getExecutionCounters,
  _resetExecutionCounters,
} from '../../src/agent/execution-counters';
import type { AgentSignal, AgentDecision } from '../../src/agent/types';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeSignal(overrides: Partial<AgentSignal> = {}): AgentSignal {
  return {
    type: 'HMA_CROSS',
    symbol: 'SPXW260401C05815000',
    side: 'call',
    strike: 5815,
    expiry: '2026-04-01',
    currentPrice: 2.00,
    bid: 1.95,
    ask: 2.05, // spread 0.10 → market order
    indicators: {},
    recentBars: [],
    signalBarLow: 1.90,
    spxContext: { price: 5800, changePercent: 0, trend: 'bullish', rsi14: 50, minutesToClose: 120, mode: 'RTH' },
    ts: Date.now(),
    ...overrides,
  };
}

function makeDecision(overrides: Partial<AgentDecision> = {}): AgentDecision {
  return {
    action: 'buy',
    confidence: 0.8,
    positionSize: 10,
    stopLoss: 1.60,
    takeProfit: 2.40,
    reasoning: 'test',
    concerns: [],
    ts: Date.now(),
    ...overrides,
  };
}

const EXEC_CFG = {
  symbol: 'SPX',
  optionPrefix: 'SPXW' as const,
  strikeDivisor: 1,
  strikeInterval: 5,
  accountId: 'TEST-ACCT',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('openPosition — OTOCO scenarios (Task 3.4)', () => {
  beforeEach(() => {
    _resetExecutionCounters();
    (axios.post as any).mockReset();
    (axios.get as any).mockReset();
    (axios.delete as any).mockReset();
  });

  it('1. OTOCO accepted → re-entry counter: protected', async () => {
    // Parent POST accepted with parent+leg ids; background verification
    // GETs show legs open/filled — counter must still mark protected since
    // the submission itself was accepted.
    (axios.post as any).mockResolvedValueOnce({
      data: { order: {
        id: 9001,
        leg: [
          { id: 9101, status: 'open' },
          { id: 9102, status: 'open' },
          { id: 9103, status: 'open' },
        ],
      }},
    });
    (axios.get as any).mockResolvedValue({
      data: { order: {
        id: 9001,
        status: 'open',
        leg: [
          { id: 9101, status: 'filled', avg_fill_price: '2.05' },
          { id: 9102, status: 'open' },
          { id: 9103, status: 'open' },
        ],
      }},
    });

    const { position, execution } = await openPosition(
      makeSignal(), makeDecision(), /*paper=*/false, EXEC_CFG, /*reentryDepth=*/1,
    );

    expect(execution.error).toBeUndefined();
    expect(position.bracketOrderId).toBe(9001);
    expect(position.tpLegId).toBe(9102);
    expect(position.slLegId).toBe(9103);

    const c = getExecutionCounters();
    expect(c.tpReentriesAttempted).toBe(1);
    expect(c.tpReentriesProtected).toBe(1);
    expect(c.tpReentriesUnprotected).toBe(0);
  });

  it('2. OTOCO accepted with partial-leg reject → still counts as protected (verification alerts separately)', async () => {
    // Parent POST returns 200 even though TP/SL will reject later.
    (axios.post as any).mockResolvedValueOnce({
      data: { order: {
        id: 9200,
        leg: [
          { id: 9201, status: 'open' },
          { id: 9202, status: 'open' },
          { id: 9203, status: 'open' },
        ],
      }},
    });
    // Background verifyOtocoProtection GETs see entry filled + legs rejected.
    (axios.get as any).mockResolvedValue({
      data: { order: {
        id: 9200,
        status: 'open',
        leg: [
          { id: 9201, status: 'filled', avg_fill_price: '2.05' },
          { id: 9202, status: 'rejected' },
          { id: 9203, status: 'rejected' },
        ],
      }},
    });

    const { position } = await openPosition(
      makeSignal(), makeDecision(), false, EXEC_CFG, 2,
    );
    expect(position.bracketOrderId).toBe(9200);

    const c = getExecutionCounters();
    // From the counter's POV this is "protected" — submission accepted.
    // The partial-accept alert path (verifyOtocoProtection) handles the
    // operational "position is actually unprotected" signaling.
    expect(c.tpReentriesAttempted).toBe(1);
    expect(c.tpReentriesProtected).toBe(1);
    expect(c.tpReentriesUnprotected).toBe(0);
  });

  it('3. OTOCO POST rejected (throws) → falls back to bare order, counter: unprotected', async () => {
    // First POST (OTOCO) rejects with 400; second POST (bare entry) accepts.
    (axios.post as any)
      .mockRejectedValueOnce({
        response: { data: { errors: { error: 'Invalid stop price — off tick' }}},
        message: 'Request failed 400',
      })
      .mockResolvedValueOnce({
        data: { order: { id: 9300 }},
      });
    // waitForFill GET says filled.
    (axios.get as any).mockResolvedValue({
      data: { order: {
        id: 9300, status: 'filled', avg_fill_price: '2.05',
      }},
    });

    const { position, execution } = await openPosition(
      makeSignal(), makeDecision(), false, EXEC_CFG, 1,
    );

    expect(execution.error).toBeUndefined();
    expect(position.tradierOrderId).toBe(9300);
    expect(position.bracketOrderId).toBeUndefined(); // no bracket on bare path

    const c = getExecutionCounters();
    expect(c.tpReentriesAttempted).toBe(1);
    expect(c.tpReentriesProtected).toBe(0);
    expect(c.tpReentriesUnprotected).toBe(1);
  });

  it('4. Re-entry with disableBracketOrders=true → skips OTOCO, counter: unprotected', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: { order: { id: 9400 }},
    });
    (axios.get as any).mockResolvedValue({
      data: { order: { id: 9400, status: 'filled', avg_fill_price: '2.05' }},
    });

    const execCfg = { ...EXEC_CFG, disableBracketOrders: true };
    const { position } = await openPosition(
      makeSignal(), makeDecision(), false, execCfg, 1,
    );
    expect(position.tradierOrderId).toBe(9400);
    expect(position.bracketOrderId).toBeUndefined();

    const c = getExecutionCounters();
    expect(c.tpReentriesAttempted).toBe(1);
    expect(c.tpReentriesProtected).toBe(0);
    expect(c.tpReentriesUnprotected).toBe(1);
  });

  it('fresh entry (reentryDepth=undefined) → no counters touched', async () => {
    (axios.post as any).mockResolvedValueOnce({
      data: { order: {
        id: 9500,
        leg: [{ id: 9501 }, { id: 9502 }, { id: 9503 }],
      }},
    });
    (axios.get as any).mockResolvedValue({
      data: { order: { id: 9500, status: 'open', leg: [
        { id: 9501, status: 'filled', avg_fill_price: '2.05' },
        { id: 9502, status: 'open' },
        { id: 9503, status: 'open' },
      ]}},
    });

    await openPosition(makeSignal(), makeDecision(), false, EXEC_CFG);

    const c = getExecutionCounters();
    expect(c.tpReentriesAttempted).toBe(0);
    expect(c.tpReentriesProtected).toBe(0);
    expect(c.tpReentriesUnprotected).toBe(0);
  });

  it('paper mode re-entry → attempted counted, no protection increment (paper skips broker path)', async () => {
    const { position, execution } = await openPosition(
      makeSignal(), makeDecision(), /*paper=*/true, EXEC_CFG, 1,
    );
    expect(execution.paper).toBe(true);
    expect(position.bracketOrderId).toBeUndefined();

    const c = getExecutionCounters();
    // Paper mode still counts attempted (agent-side decision) but never
    // reaches the OTOCO path, so protected/unprotected stay 0.
    expect(c.tpReentriesAttempted).toBe(1);
    expect(c.tpReentriesProtected).toBe(0);
    expect(c.tpReentriesUnprotected).toBe(0);
  });
});
