import { describe, it, expect } from 'vitest';
import {
  deriveMemberConfig,
  aggregateBasketResults,
} from '../../src/replay/basket-runner';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import type { Config, BasketMember } from '../../src/config/types';
import type { ReplayResult, Trade } from '../../src/replay/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function basketConfig(members: BasketMember[], overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    id: 'test-basket',
    name: 'Test Basket',
    basket: { enabled: true, members },
    ...overrides,
  };
}

function trade(entryTs: number, pnl$: number, member = 'atm'): Trade {
  return {
    symbol: `SPXW260420C06600000`,
    side: 'call',
    strike: 6600,
    qty: 1,
    entryTs,
    entryET: '10:00 ET',
    entryPrice: 9.0,
    exitTs: entryTs + 300,
    exitET: '10:05 ET',
    exitPrice: 9.0 + pnl$ / 100,
    reason: pnl$ >= 0 ? 'take_profit' : 'stop_loss',
    pnlPct: pnl$ / 900,
    pnl$,
    signalType: 'hmaCross',
  };
}

function memberResult(configId: string, trades: Trade[]): ReplayResult {
  const wins = trades.filter(t => t.pnl$ > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl$, 0);
  return {
    runId: `run-${configId}`,
    configId,
    date: '2026-03-20',
    trades: trades.length,
    wins,
    winRate: trades.length > 0 ? wins / trades.length : 0,
    totalPnl,
    avgPnlPerTrade: trades.length > 0 ? totalPnl / trades.length : 0,
    maxWin: trades.reduce((m, t) => Math.max(m, t.pnl$), 0),
    maxLoss: trades.reduce((m, t) => Math.min(m, t.pnl$), 0),
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    trades_json: JSON.stringify(trades),
  };
}

// ── deriveMemberConfig ──────────────────────────────────────────────────────

describe('deriveMemberConfig', () => {
  it('sets composite ID and atm-offset mode', () => {
    const basket = basketConfig([]);
    const member: BasketMember = { id: 'atm', strikeOffset: 0 };
    const derived = deriveMemberConfig(basket, member);

    expect(derived.id).toBe('test-basket:atm');
    expect(derived.strikeSelector.strikeMode).toBe('atm-offset');
    expect(derived.strikeSelector.atmOffset).toBe(0);
    expect(derived.basket?.enabled).toBe(false);
    expect(derived.baselineId).toBe('test-basket');
  });

  it('maps each offset correctly', () => {
    const basket = basketConfig([]);
    const offsets = [-10, -5, 0, 5, 10];
    for (const offset of offsets) {
      const derived = deriveMemberConfig(basket, { id: `x${offset}`, strikeOffset: offset });
      expect(derived.strikeSelector.atmOffset).toBe(offset);
    }
  });

  it('applies per-member overrides via deep merge', () => {
    const basket = basketConfig([], {
      sizing: { ...DEFAULT_CONFIG.sizing, sizingMode: 'percent_of_account', sizingValue: 11 },
    });
    const member: BasketMember = {
      id: 'otm10',
      strikeOffset: 10,
      overrides: {
        sizing: { sizingValue: 8 } as any,
      },
    };
    const derived = deriveMemberConfig(basket, member);

    expect(derived.sizing.sizingMode).toBe('percent_of_account');
    expect(derived.sizing.sizingValue).toBe(8);           // override wins
    expect(derived.strikeSelector.atmOffset).toBe(10);    // offset preserved
  });

  it('prevents overrides from re-enabling basket mode', () => {
    const basket = basketConfig([]);
    const member: BasketMember = {
      id: 'atm',
      strikeOffset: 0,
      overrides: {
        basket: { enabled: true, members: [{ id: 'x', strikeOffset: 0 }] },
      } as any,
    };
    const derived = deriveMemberConfig(basket, member);
    expect(derived.basket?.enabled).toBe(false);
    expect(derived.basket?.members).toEqual([]);
  });

  it('prevents overrides from changing the member strikeOffset', () => {
    const basket = basketConfig([]);
    const member: BasketMember = {
      id: 'atm',
      strikeOffset: 0,
      overrides: {
        strikeSelector: {
          ...DEFAULT_CONFIG.strikeSelector,
          strikeMode: 'otm',
          atmOffset: 99,
        },
      },
    };
    const derived = deriveMemberConfig(basket, member);
    expect(derived.strikeSelector.strikeMode).toBe('atm-offset');
    expect(derived.strikeSelector.atmOffset).toBe(0);
  });
});

// ── aggregateBasketResults ──────────────────────────────────────────────────

describe('aggregateBasketResults', () => {
  const basket = basketConfig([
    { id: 'atm', strikeOffset: 0 },
    { id: 'otm5', strikeOffset: 5 },
    { id: 'itm5', strikeOffset: -5 },
  ]);

  it('sums trades and P&L across members', () => {
    const members = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm', [trade(1000, 100), trade(2000, -50)]) },
      { member: { id: 'otm5', strikeOffset: 5 }, result: memberResult('test-basket:otm5', [trade(1500, 200)]) },
      { member: { id: 'itm5', strikeOffset: -5 }, result: memberResult('test-basket:itm5', [trade(1200, -30), trade(2100, 80)]) },
    ];
    const agg = aggregateBasketResults(basket, '2026-03-20', members, 'agg-run-1');

    expect(agg.trades).toBe(5);
    expect(agg.wins).toBe(3);                           // 100, 200, 80
    expect(agg.winRate).toBeCloseTo(3 / 5);
    expect(agg.totalPnl).toBeCloseTo(300);              // 100 - 50 + 200 - 30 + 80
    expect(agg.avgPnlPerTrade).toBeCloseTo(300 / 5);
    expect(agg.maxWin).toBe(200);
    expect(agg.maxLoss).toBe(-50);
  });

  it('uses basket config ID for aggregate (not composite)', () => {
    const members = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm', [trade(1000, 100)]) },
    ];
    const agg = aggregateBasketResults(basket, '2026-03-20', members, 'agg-run-2');
    expect(agg.configId).toBe('test-basket');
    expect(agg.runId).toBe('agg-run-2');
  });

  it('computes consecutive streaks over time-ordered merged trades', () => {
    // Time order across members: 1000 (W), 1100 (L), 1200 (L), 1300 (L), 1400 (W), 1500 (W)
    const members = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm',
        [trade(1000, 50), trade(1300, -40), trade(1500, 100)]) },
      { member: { id: 'otm5', strikeOffset: 5 }, result: memberResult('test-basket:otm5',
        [trade(1100, -20), trade(1200, -30), trade(1400, 60)]) },
    ];
    const agg = aggregateBasketResults(basket, '2026-03-20', members, 'agg-run-3');
    expect(agg.maxConsecutiveWins).toBe(2);    // 1400, 1500
    expect(agg.maxConsecutiveLosses).toBe(3);  // 1100, 1200, 1300
  });

  it('handles empty members gracefully', () => {
    const agg = aggregateBasketResults(basket, '2026-03-20', [], 'agg-run-4');
    expect(agg.trades).toBe(0);
    expect(agg.wins).toBe(0);
    expect(agg.winRate).toBe(0);
    expect(agg.totalPnl).toBe(0);
    expect(agg.sharpeRatio).toBeUndefined();
  });

  it('trades_json union is time-sorted and tagged with _member', () => {
    const members = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm',
        [trade(2000, 100)]) },
      { member: { id: 'otm5', strikeOffset: 5 }, result: memberResult('test-basket:otm5',
        [trade(1000, 50)]) },
    ];
    const agg = aggregateBasketResults(basket, '2026-03-20', members, 'agg-run-5');
    const parsed = JSON.parse(agg.trades_json) as Array<Trade & { _member: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].entryTs).toBe(1000);              // time-sorted
    expect(parsed[0]._member).toBe('otm5');
    expect(parsed[1].entryTs).toBe(2000);
    expect(parsed[1]._member).toBe('atm');
  });

  it('computes Sharpe ratio from merged trade P&Ls when ≥2 trades', () => {
    // Two trades with equal positive P&L → std=0 → sharpe=0 (guarded)
    const equal = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm',
        [trade(1000, 100), trade(2000, 100)]) },
    ];
    const aggEqual = aggregateBasketResults(basket, '2026-03-20', equal, 'agg-run-6');
    expect(aggEqual.sharpeRatio).toBe(0);

    // Varied P&L → sharpe > 0
    const varied = [
      { member: { id: 'atm', strikeOffset: 0 }, result: memberResult('test-basket:atm',
        [trade(1000, 100), trade(2000, 50), trade(3000, 200)]) },
    ];
    const aggVaried = aggregateBasketResults(basket, '2026-03-20', varied, 'agg-run-7');
    expect(aggVaried.sharpeRatio).toBeDefined();
    expect(aggVaried.sharpeRatio!).toBeGreaterThan(0);
  });
});
