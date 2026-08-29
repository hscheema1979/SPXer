/**
 * Unit tests for study-stats.ts — break-even win rate, percentile, summarize.
 *
 * These pin the arithmetic that decides whether a study row reads as an edge.
 * The BE-WR cases are deliberately built so a naive "high win rate = good" read
 * gives the WRONG answer: a 90%-WR row that needs 90.9% to break even is a
 * loser, and the numbers below make that explicit.
 */
import { describe, it, expect } from 'vitest';
import { breakEvenWinRate, percentile, summarize } from '../../scripts/diag/study-stats';

describe('breakEvenWinRate', () => {
  it('symmetric win/loss needs 50%', () => {
    expect(breakEvenWinRate(100, 100)).toBeCloseTo(50, 6);
  });

  it('a 1:10 win:loss ratio needs 90.9%', () => {
    // avgWin 100, avgLoss 1000 → 1000/1100
    expect(breakEvenWinRate(100, 1000)).toBeCloseTo(90.909, 3);
  });

  it('a 10:1 win:loss ratio needs 9.1%', () => {
    expect(breakEvenWinRate(1000, 100)).toBeCloseTo(9.0909, 3);
  });

  it('is null when one side has no samples', () => {
    expect(breakEvenWinRate(100, 0)).toBeNull(); // all winners — no honest BE-WR
    expect(breakEvenWinRate(0, 100)).toBeNull();
  });
});

describe('percentile', () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it('p5 of 10 samples is the lowest (nearest-rank)', () => {
    expect(percentile(xs, 5)).toBe(10);
  });

  it('p50 is the 5th of 10 by nearest rank', () => {
    expect(percentile(xs, 50)).toBe(50);
  });

  it('p100 is the max, p0 is the min', () => {
    expect(percentile(xs, 100)).toBe(100);
    expect(percentile(xs, 0)).toBe(10);
  });

  it('does not mutate the caller array', () => {
    const src = [3, 1, 2];
    percentile(src, 50);
    expect(src).toEqual([3, 1, 2]);
  });

  it('handles a single sample and an empty sample', () => {
    expect(percentile([42], 5)).toBe(42);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe('summarize', () => {
  it('computes win rate, averages and profit factor', () => {
    const s = summarize([100, 100, 100, -150]);
    expect(s.n).toBe(4);
    expect(s.wins).toBe(3);
    expect(s.wr).toBe(75);
    expect(s.avgWin).toBe(100);
    expect(s.avgLoss).toBe(150);      // reported positive
    expect(s.totalPnl).toBe(150);
    expect(s.profitFactor).toBe(2);   // 300 / 150
  });

  it('flags a high-WR row that does not clear its break-even', () => {
    // 9 wins of $50, 1 loss of $500 → total -$50. WR 90%, BE-WR 90.9% → edge < 0.
    const s = summarize([...Array(9).fill(50), -500]);
    expect(s.wr).toBe(90);
    expect(s.beWr).toBeCloseTo(90.9, 1);
    expect(s.edge!).toBeLessThan(0);
    expect(s.totalPnl).toBe(-50);
  });

  it('treats a zero P&L trade as a loss, not a win', () => {
    // Ties must not inflate win rate; > 0 is the win test.
    expect(summarize([0, 100]).wins).toBe(1);
  });

  it('computes max drawdown on the chronological curve', () => {
    // cum: 100, 40, 140 → peak 100, trough 40 → DD 60
    expect(summarize([100, -60, 100]).maxDD).toBe(60);
  });

  it('is order-sensitive for maxDD only', () => {
    // Same trades, two orderings. Totals and win rate are order-free; the
    // drawdown path is not — losses front-loaded dig a deeper hole.
    const a = summarize([50, -100, 50, -100]);  // cum 50,-50,0,-100 → peak 50, DD 150
    const b = summarize([-100, -100, 50, 50]);  // cum -100,-200,-150,-100 → peak 0, DD 200
    expect(a.totalPnl).toBe(b.totalPnl);
    expect(a.wr).toBe(b.wr);
    expect(a.maxDD).toBe(150);
    expect(b.maxDD).toBe(200);
  });

  it('reports the left tail', () => {
    const s = summarize([...Array(19).fill(100), -900]);
    expect(s.worst).toBe(-900);
    expect(s.p5).toBe(-900);
  });

  it('returns a null break-even for an all-winners sample', () => {
    const s = summarize([10, 20, 30]);
    expect(s.beWr).toBeNull();
    expect(s.edge).toBeNull();
  });

  it('handles an empty sample without throwing', () => {
    expect(summarize([]).n).toBe(0);
  });
});
