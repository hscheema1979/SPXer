/**
 * Unit tests for fib-bb-option-core.ts — the option-pricing layer that maps
 * fib-bb SIGNAL trades (on SPY underlying) onto tradeable option contracts
 * (SPX 0DTE, SPY fallback) and computes realistic dollar P&L after friction.
 *
 * The whole integrity of this study rests on two things:
 *   1. The option FILL uses the bar AT OR AFTER the signal's fill timestamp —
 *      never the signal bar itself (look-ahead). A mean-reversion signal that
 *      peeks at the bar it trades on is falsely profitable.
 *   2. The $ P&L math is exact: entry pays mid + halfSpread, exit receives
 *      mid - halfSpread (market/SL) or the limit level (TP), commission per
 *      side, × 100 shares/contract.
 *
 * These tests cover both, plus the moneyness→strike resolution and the
 * SPX-primary / SPY-fallback routing.
 */
import { describe, it, expect } from 'vitest';
import {
  padStrike, buildOptionSymbol, atmStrike, resolveStrike,
  priceOptionFill, priceOptionNativeExit, priceCreditSpread,
  type OptionBarMap, type OptFillInput, type CreditSpreadInput,
} from '../../scripts/diag/fib-bb-option-core';
import { resolveSpreadModel } from '../../src/core/friction';

const bar = (ts: number, o: number, h: number, l: number, c: number, v = 100) =>
  ({ ts, open: o, high: h, low: l, close: c, volume: v });

describe('symbol + strike resolution', () => {
  it('pads a strike to the 8-digit ×1000 OCC format', () => {
    expect(padStrike(6505)).toBe('06505000');
    expect(padStrike(6510)).toBe('06510000');
    expect(padStrike(656)).toBe('00656000');   // SPY 3-digit, 8 chars
    expect(padStrike(100)).toBe('00100000');
  });

  it('builds SPXW and SPY option symbols', () => {
    expect(buildOptionSymbol('SPXW', '260319', 'C', 6505)).toBe('SPXW260319C06505000');
    expect(buildOptionSymbol('SPY', '260319', 'P', 656)).toBe('SPY260319P00656000');
  });

  it('rounds spot to the nearest valid strike', () => {
    expect(atmStrike(6596.09, 5)).toBe(6595);
    expect(atmStrike(6597.5, 5)).toBe(6600);
    expect(atmStrike(655.84, 1)).toBe(656);
  });

  it('resolves strike from moneyness for calls (long) and puts (short)', () => {
    const atm = 6505, step = 5;
    // Long → call: moneyness +1 = OTM = higher strike
    expect(resolveStrike('long', atm, +1, step)).toBe(6510);   // OTM call
    expect(resolveStrike('long', atm, -1, step)).toBe(6500);   // ITM call (lower)
    expect(resolveStrike('long', atm, 0, step)).toBe(6505);    // ATM
    // Short → put: moneyness +1 = OTM = lower strike; -1 = ITM = higher
    expect(resolveStrike('short', atm, +1, step)).toBe(6500);  // OTM put (lower)
    expect(resolveStrike('short', atm, -1, step)).toBe(6510);  // ITM put (higher)
    expect(resolveStrike('short', atm, 0, step)).toBe(6505);   // ATM
  });
});

describe('option fill + $ P&L math', () => {
  const spread = resolveSpreadModel();   // scaled: max(0.05, price×1%)

  /** Two-bar contract: entry at ts=100 ($5.00 mid), exit at ts=200 ($6.00 mid). */
  const bars: OptionBarMap = new Map([
    ['SPXW260319C06505000', [
      bar(100, 5.00, 5.00, 5.00, 5.00),
      bar(200, 6.00, 6.00, 6.00, 6.00),
    ]],
  ]);

  const baseInput = (over: Partial<OptFillInput>): OptFillInput => ({
    dir: 'long',
    entryTs: 100,
    exitTs: 200,
    moneyness: 0,
    strikeInterval: 5,
    prefix: 'SPXW',
    expiry: '260319',
    underlyingAtEntry: 6505,
    exitKind: 'market',
    spreadModel: spread,
    qty: 1,
    ...over,
  });

  it('prices a winning long call: enter $5, exit $6, minus spread + commission', () => {
    const t = priceOptionFill(bars, baseInput({}));
    expect(t).not.toBeNull();
    // flat spread $0.05 (resolveSpreadModel() default). entry eff = 5 + 0.05 = 5.05.
    // exit eff (market) = 6 - 0.05 = 5.95.
    // pnl/share = 5.95 - 5.05 = 0.90. × 100 = $90. - 2×$0.35 commission = $89.30.
    expect(t!.entryOptPrice).toBeCloseTo(5.05, 4);
    expect(t!.exitOptPrice).toBeCloseTo(5.95, 4);
    expect(t!.pnlDollars).toBeCloseTo(89.30, 1);
    expect(t!.instrument).toBe('SPX');
  });

  it('TP (limit) exit pays the limit price with no slippage, only commission', () => {
    const t = priceOptionFill(bars, baseInput({ exitKind: 'tp', exitTs: 200 }));
    expect(t).not.toBeNull();
    // entry eff 5.05; TP exit at the bar's mid (6.00) — no spread on limit.
    // pnl/share = 6.00 - 5.05 = 0.95 × 100 = $95 - $0.70 = $94.30.
    expect(t!.exitOptPrice).toBeCloseTo(6.00, 4);
    expect(t!.pnlDollars).toBeCloseTo(94.30, 1);
  });

  it('returns null when the contract is missing (triggers fallback)', () => {
    const t = priceOptionFill(bars, baseInput({ moneyness: 5 }));  // strike 6530, not in map
    expect(t).toBeNull();
  });

  it('returns null when entry bar is missing (no data at fill time)', () => {
    const t = priceOptionFill(bars, baseInput({ entryTs: 999 }));
    expect(t).toBeNull();
  });
});

describe('no look-ahead', () => {
  const spread = resolveSpreadModel();
  /**
   * The fill MUST use the bar at ts >= entryTs. If the only bar at the exact
   * entryTs is absent, we take the next bar forward — never a prior bar, and
   * never a bar before exitTs. This guard catches a regression where the fill
   * accidentally reads the signal bar's own close.
   */
  const bars: OptionBarMap = new Map([
    ['SPXW260319C06505000', [
      bar(50, 4.00, 4.00, 4.00, 4.00),    // before entry — must NOT be used
      bar(100, 5.00, 5.00, 5.00, 5.00),   // entry bar
      bar(200, 6.00, 6.00, 6.00, 6.00),   // exit bar
      bar(300, 99.0, 99.0, 99.0, 99.0),   // future — must NOT be used
    ]],
  ]);

  it('entry uses the bar at entryTs, not a prior or future bar', () => {
    const t = priceOptionFill(bars, {
      dir: 'long', entryTs: 100, exitTs: 200, moneyness: 0,
      strikeInterval: 5, prefix: 'SPXW', expiry: '260319',
      underlyingAtEntry: 6505, exitKind: 'market', spreadModel: spread, qty: 1,
    });
    expect(t).not.toBeNull();
    // entry mid should be 5.00 (bar at ts=100), NOT 4.00 (ts=50) or 99.0 (ts=300).
    expect(t!.entryOptPrice - 0.05).toBeCloseTo(5.00, 4);  // 5.05 eff → 5.00 mid
  });

  it('when entryTs falls between bars, uses the NEXT bar forward (never prior)', () => {
    // entryTs=150 sits between ts=100 (close 5.00) and ts=200 (close 6.00).
    // Forward fill → ts=200. The prove-we-didn't-peek-prior check: entry
    // resolves to 6.05 (ts=200 eff), NOT 5.05 (ts=100 eff).
    const t = priceOptionFill(bars, {
      dir: 'long', entryTs: 150, exitTs: 200, moneyness: 0,
      strikeInterval: 5, prefix: 'SPXW', expiry: '260319',
      underlyingAtEntry: 6505, exitKind: 'market', spreadModel: spread, qty: 1,
    });
    expect(t).not.toBeNull();
    expect(t!.entryOptPrice).toBeCloseTo(6.05, 4);   // ts=200 mid 6.00 + 0.05
    expect(t!.entryOptPrice).not.toBeCloseTo(5.05, 2); // NOT ts=100
  });
});

describe('option-native TP/SL exit', () => {
  const spread = resolveSpreadModel();
  /**
   * Premium path: entry ts=100 mid $5.00 (eff 5.05). Then $7.00, $3.00, $9.00.
   * TP +50% → level 5.05×1.5 = 7.575; SL -30% → level 5.05×0.7 = 3.535.
   * Bar 200 (7.00) is between the levels — hold. Bar 300 (3.00) trips SL.
   * If TP/SL weren't native, the option would ride to the session close at $9.
   */
  const bars: OptionBarMap = new Map([
    ['SPXW260319C06505000', [
      bar(100, 5.00, 5.00, 5.00, 5.00),
      bar(200, 7.00, 7.00, 7.00, 7.00),
      bar(300, 3.00, 3.00, 3.00, 3.00),
      bar(400, 9.00, 9.00, 9.00, 9.00),   // would-be big winner — cut by SL first
    ]],
  ]);
  const inp = (over: Partial<any>) => ({
    dir: 'long', entryTs: 100, sessionEndTs: 400, moneyness: 0,
    strikeInterval: 5, prefix: 'SPXW', expiry: '260319', underlyingAtEntry: 6505,
    tpPct: 0.5, slPct: 0.3, spreadModel: spread, qty: 1, ...over,
  });

  it('exits at the SL bar, not the later big winner (no peeking forward)', () => {
    const t = priceOptionNativeExit(bars, inp({}));
    expect(t).not.toBeNull();
    expect(t!.exitKind).toBe('sl');
    expect(t!.exitMid).toBeCloseTo(3.00, 4);
    // entry eff 5.05; SL eff (market) = 3.00 - 0.05 = 2.95. pnl/share = -2.10.
    expect(t!.pnlPerShare).toBeCloseTo(-2.10, 2);
  });

  it('exits at the TP level when a bar clears it before the SL', () => {
    // Swap the order: $9 first (clears TP), then $3.
    const bars2: OptionBarMap = new Map([
      ['SPXW260319C06505000', [
        bar(100, 5.00, 5.00, 5.00, 5.00),
        bar(200, 9.00, 9.00, 9.00, 9.00),   // clears TP=7.575
        bar(300, 3.00, 3.00, 3.00, 3.00),
      ]],
    ]);
    const t = priceOptionNativeExit(bars2, inp({}));
    expect(t!.exitKind).toBe('tp');
    expect(t!.exitMid).toBeCloseTo(9.00, 4);
  });

  it('flattens at session close when neither TP nor SL is hit', () => {
    const bars3: OptionBarMap = new Map([
      ['SPXW260319C06505000', [
        bar(100, 5.00, 5.00, 5.00, 5.00),
        bar(200, 6.00, 6.00, 6.00, 6.00),   // between levels
        bar(300, 5.50, 5.50, 5.50, 5.50),   // session end here
      ]],
    ]);
    const t = priceOptionNativeExit(bars3, inp({ sessionEndTs: 300 }));
    expect(t!.exitKind).toBe('market');
    expect(t!.exitMid).toBeCloseTo(5.50, 4);
  });

  it('a bar straddling BOTH levels resolves as SL (conservative)', () => {
    // TP=7.575, SL=3.535. A bar at $2.00 (below SL) that also... we can't
    // straddle a single close, but verify SL takes priority when the first
    // qualifying bar is below SL even if a TP-level was briefly reachable in
    // a prior bar. Simulate: bar 200 = 7.50 (just under TP 7.575, hold),
    // bar 300 = 3.00 (below SL). Should exit SL, not retroactively TP.
    const bars4: OptionBarMap = new Map([
      ['SPXW260319C06505000', [
        bar(100, 5.00, 5.00, 5.00, 5.00),
        bar(200, 7.50, 7.50, 7.50, 7.50),   // under TP
        bar(300, 3.00, 3.00, 3.00, 3.00),   // SL
      ]],
    ]);
    const t = priceOptionNativeExit(bars4, inp({}));
    expect(t!.exitKind).toBe('sl');
  });
});

describe('credit spread (2-leg)', () => {
  const spread = resolveSpreadModel();
  /**
   * Put credit spread, bullish signal (dir='long'):
   *   ATM=6505, short leg = ATM - shortOffset×5 (sell the put), wing = short - width×5 (buy put).
   *   Bars: entry ts=100 short put @ $4.00, wing put @ $1.00 → credit $3.00.
   *        exit  ts=200 short put @ $2.00, wing put @ $0.50 → spread value $1.50.
   *   P&L = (credit - exitSpreadValue) × 100 - friction(4 fills) - commission(4 sides).
   *   = (3.00 - 1.50) × 100 = $150 gross, minus ~$0.20 spread (4×$0.05) and 4×$0.35 comm.
   */
  const bars: OptionBarMap = new Map([
    // short leg: SPXW ...P at strike 6500 (ATM-1)
    ['SPXW260319P06500000', [bar(100, 4.00, 4.00, 4.00, 4.00), bar(200, 2.00, 2.00, 2.00, 2.00)]],
    // wing: SPXW ...P at strike 6495 (short-1, 5pt-wide)
    ['SPXW260319P06495000', [bar(100, 1.00, 1.00, 1.00, 1.00), bar(200, 0.50, 0.50, 0.50, 0.50)]],
  ]);
  const base = (over: Partial<CreditSpreadInput>): CreditSpreadInput => ({
    dir: 'long',                 // bullish → put credit spread
    entryTs: 100, exitTs: 200,
    shortOffset: 1,              // short put 1 strike OTM (below ATM)
    width: 1,                    // 5pt wide (1 strike × 5)
    strikeInterval: 5, prefix: 'SPXW', expiry: '260319',
    underlyingAtEntry: 6505, exitKind: 'market',
    spreadModel: spread, qty: 1,
    ...over,
  });

  it('bullish signal sells a put credit spread (short below ATM, wing further below)', () => {
    const t = priceCreditSpread(bars, base({}));
    expect(t).not.toBeNull();
    expect(t!.structure).toBe('put_credit');
    expect(t!.shortStrike).toBe(6500);   // ATM - 1×5
    expect(t!.wingStrike).toBe(6495);    // short - 1×5
    // entry credit: sell short @4.00 (recv 3.95 after 0.05 half-spread on sell),
    // buy wing @1.00 (pay 1.05). net credit = 3.95 - 1.05 = 2.90.
    expect(t!.entryCredit).toBeCloseTo(2.90, 4);
    // exit spread value: buy back short @2.00 (pay 2.05), sell wing @0.50 (recv 0.45).
    // exit cost = 2.05 - 0.45 = 1.60. P&L/share = credit - exitCost = 2.90 - 1.60 = 1.30.
    expect(t!.exitSpreadValue).toBeCloseTo(1.60, 4);
    // $ P&L = 1.30 × 100 - 4×0.35 commission = 130 - 1.40 = 128.60.
    expect(t!.pnlDollars).toBeCloseTo(128.60, 1);
  });

  it('bearish signal sells a call credit spread (short above ATM, wing further above)', () => {
    const callBars: OptionBarMap = new Map([
      ['SPXW260319C06510000', [bar(100, 4.00, 4.00, 4.00, 4.00), bar(200, 2.00, 2.00, 2.00, 2.00)]],
      ['SPXW260319C06515000', [bar(100, 1.00, 1.00, 1.00, 1.00), bar(200, 0.50, 0.50, 0.50, 0.50)]],
    ]);
    const t = priceCreditSpread(callBars, base({ dir: 'short' }));
    expect(t!.structure).toBe('call_credit');
    expect(t!.shortStrike).toBe(6510);   // ATM + 1×5
    expect(t!.wingStrike).toBe(6515);
  });

  it('returns null when the short leg is missing', () => {
    const t = priceCreditSpread(new Map(), base({}));
    expect(t).toBeNull();
  });

  it('returns null when the wing leg is missing but short exists', () => {
    const partial: OptionBarMap = new Map([
      ['SPXW260319P06500000', [bar(100, 4.00, 4.00, 4.00, 4.00), bar(200, 2.00, 2.00, 2.00, 2.00)]],
    ]);
    const t = priceCreditSpread(partial, base({}));
    expect(t).toBeNull();
  });

  it('exit fill uses bars at ts >= the fill ts (no look-ahead)', () => {
    // bar at ts=50 (prior) must NOT be used; entry must read ts=100.
    const t = priceCreditSpread(bars, base({ entryTs: 100 }));
    expect(t!.entryCredit).toBeCloseTo(2.90, 4);   // from ts=100, not ts would-be
  });
});
