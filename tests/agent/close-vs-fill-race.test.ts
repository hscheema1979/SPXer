/**
 * Task 3.5 — Cancel-vs-fill race tests for closePosition().
 *
 * The race: agent decides to exit a position early (e.g. scannerReverse).
 * Between the decision and the sell order hitting Tradier, the TP limit leg
 * can fill. Three broker states matter:
 *
 *   1. TP already filled BEFORE pre-flight GET /positions → position gone,
 *      closePosition must short-circuit, not submit a naked-short sell.
 *
 *   2. Cancel DELETE "succeeds" (HTTP 200) but TP filled concurrently; sell
 *      POST then rejects because position is gone. closePosition must
 *      surface the error without throwing / leaving state in a bad place.
 *
 *   3. Cancel DELETE fails (409/400); status query reveals leg is 'filled'.
 *      This is the standalone-OCO path handled in PositionManager.
 *      closePosition itself is best-effort on cancel errors — it logs and
 *      continues. The subsequent sell must also fail gracefully.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { closePosition } from '../../src/agent/trade-executor';
import type { OpenPosition } from '../../src/agent/types';

function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    id: 'pos-1',
    symbol: 'SPXW260401C05815000',
    side: 'call',
    strike: 5815,
    expiry: '2026-04-01',
    entryPrice: 2.00,
    quantity: 10,
    stopLoss: 1.60,
    takeProfit: 2.40,
    openedAt: Date.now(),
    tradierOrderId: 9000,
    bracketOrderId: 9001,
    tpLegId: 9002,
    slLegId: 9003,
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

describe('closePosition — cancel-vs-fill race (Task 3.5)', () => {
  beforeEach(() => {
    (axios.post as any).mockReset();
    (axios.get as any).mockReset();
    (axios.delete as any).mockReset();
  });

  it('1. position already gone at broker (TP filled) → short-circuits with explanatory error', async () => {
    // Pre-flight GET /positions returns empty (TP already filled, position flat)
    (axios.get as any).mockImplementation((url: string) => {
      if (url.endsWith('/positions')) {
        return Promise.resolve({ data: { positions: 'null' }}); // Tradier style
      }
      return Promise.resolve({ data: { orders: { order: [] }}});
    });

    const result = await closePosition(
      makePosition(), 'scannerReverse', 2.10, /*paper=*/false, EXEC_CFG,
    );

    expect(result.error).toMatch(/not at broker/i);
    // Must NOT have issued a sell POST — it would short the option.
    expect((axios.post as any)).not.toHaveBeenCalled();
  });

  it('2. cancel succeeds, sell rejects (position gone concurrently) → graceful error, no throw', async () => {
    // Pre-flight: position still visible at GET /positions time, with open
    // OTOCO bracket blocking it.
    (axios.get as any).mockImplementation((url: string) => {
      if (url.endsWith('/positions')) {
        return Promise.resolve({ data: { positions: { position: [
          { symbol: 'SPXW260401C05815000', quantity: 10 },
        ]}}});
      }
      if (url.endsWith('/orders')) {
        return Promise.resolve({ data: { orders: { order: [
          {
            id: 9001,
            status: 'open',
            option_symbol: null,
            leg: [
              { status: 'filled', side: 'buy_to_open', option_symbol: 'SPXW260401C05815000' },
              { status: 'open', side: 'sell_to_close', option_symbol: 'SPXW260401C05815000' },
              { status: 'open', side: 'sell_to_close', option_symbol: 'SPXW260401C05815000' },
            ],
          },
        ]}}});
      }
      return Promise.resolve({ data: { order: { id: 9999, status: 'filled', avg_fill_price: '2.10' }}});
    });

    // DELETE (cancel bracket) succeeds — Tradier accepts the cancel.
    (axios.delete as any).mockResolvedValue({ data: { order: { id: 9001, status: 'canceled' }}});

    // POST (sell) rejects — position was flat by the time sell hit matching engine.
    (axios.post as any).mockRejectedValue({
      response: { data: { errors: { error: 'No position to close' }}},
      message: 'Request failed 400',
    });

    // Must not throw
    const result = await closePosition(
      makePosition(), 'scannerReverse', 2.10, false, EXEC_CFG,
    );

    expect(result.paper).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/no position|close/i);
    // Cancel was attempted
    expect((axios.delete as any)).toHaveBeenCalled();
    // Sell was attempted (and rejected)
    expect((axios.post as any)).toHaveBeenCalledTimes(1);
  });

  it('3. cancel DELETE throws (bracket already gone) → pre-flight swallows, sell proceeds and fills', async () => {
    // Pre-flight sees position + blocking sell leg, issues DELETE.
    (axios.get as any).mockImplementation((url: string) => {
      if (url.endsWith('/positions')) {
        return Promise.resolve({ data: { positions: { position: {
          symbol: 'SPXW260401C05815000', quantity: 10,
        }}}});
      }
      if (url.endsWith('/orders')) {
        return Promise.resolve({ data: { orders: { order: {
          id: 9001, status: 'open',
          leg: [
            { status: 'filled', side: 'buy_to_open', option_symbol: 'SPXW260401C05815000' },
            { status: 'open', side: 'sell_to_close', option_symbol: 'SPXW260401C05815000' },
            { status: 'open', side: 'sell_to_close', option_symbol: 'SPXW260401C05815000' },
          ],
        }}}});
      }
      // waitForFill GET on the sell order
      return Promise.resolve({ data: { order: {
        id: 9500, status: 'filled', avg_fill_price: '2.10',
      }}});
    });

    // Cancel fails — bracket may already be in canceled state
    (axios.delete as any).mockRejectedValue({
      response: { data: { errors: { error: 'Order already canceled' }}},
      message: 'Request failed 400',
    });

    // Sell POST succeeds
    (axios.post as any).mockResolvedValueOnce({ data: { order: { id: 9500 }}});

    const result = await closePosition(
      makePosition(), 'scannerReverse', 2.10, false, EXEC_CFG,
    );

    // closePosition is best-effort on cancel failures and proceeds with sell
    expect(result.error).toBeUndefined();
    expect(result.fillPrice).toBeCloseTo(2.10, 4);
    // Verify cancel was at least attempted
    expect((axios.delete as any)).toHaveBeenCalled();
  });

  it('4. partial broker qty (5 remaining after partial TP fill) → adjusts sell qty down, no throw', async () => {
    // Pre-flight sees 5 contracts instead of the agent's 10 (partial TP fill).
    (axios.get as any).mockImplementation((url: string) => {
      if (url.endsWith('/positions')) {
        return Promise.resolve({ data: { positions: { position: {
          symbol: 'SPXW260401C05815000', quantity: 5, // partial
        }}}});
      }
      if (url.endsWith('/orders')) {
        return Promise.resolve({ data: { orders: { order: [] }}});
      }
      return Promise.resolve({ data: { order: {
        id: 9700, status: 'filled', avg_fill_price: '2.05',
      }}});
    });
    (axios.post as any).mockResolvedValueOnce({ data: { order: { id: 9700 }}});

    const pos = makePosition({ quantity: 10 });
    const result = await closePosition(pos, 'scannerReverse', 2.05, false, EXEC_CFG);

    expect(result.error).toBeUndefined();
    // closePosition mutates position.quantity to match broker (5)
    expect(pos.quantity).toBe(5);
    // Sell POST carries the adjusted qty
    const postBody = (axios.post as any).mock.calls[0][1] as string;
    expect(postBody).toMatch(/quantity=5/);
  });
});
