import { describe, it, expect } from 'vitest';
import { OptionCandleBuilder, type FormingCandle } from '../../src/pipeline/option-candle-builder';

describe('OptionCandleBuilder', () => {
  const SYM1 = 'SPXW260401C06500000';
  const SYM2 = 'SPXW260401P06450000';

  // Use a minute-aligned base timestamp (divisible by 60)
  const BASE = 1700000040 - (1700000040 % 60); // 1699999980

  // Helper: create a builder and capture closed candles
  function createBuilder() {
    const closed: Array<{ symbol: string; candle: FormingCandle }> = [];
    const builder = new OptionCandleBuilder((symbol, candle) => {
      closed.push({ symbol, candle: { ...candle } }); // snapshot the candle
    });
    return { builder, closed };
  }

  // Helper: convert seconds to ms for tick timestamps
  function msAt(ts: number): number {
    return ts * 1000;
  }

  describe('processTick', () => {
    it('builds correct OHLCV from a sequence of trades', () => {
      const { builder, closed } = createBuilder();

      // Several ticks in the same minute
      builder.processTick(SYM1, 5.00, 10, msAt(BASE + 0));
      builder.processTick(SYM1, 5.50, 20, msAt(BASE + 10));
      builder.processTick(SYM1, 4.80, 5,  msAt(BASE + 30));
      builder.processTick(SYM1, 5.20, 15, msAt(BASE + 50));

      // No candle closed yet (all same minute)
      expect(closed).toHaveLength(0);

      // Verify forming candle
      const forming = builder.getFormingCandle(SYM1);
      expect(forming).toBeDefined();
      expect(forming!.open).toBe(5.00);
      expect(forming!.high).toBe(5.50);
      expect(forming!.low).toBe(4.80);
      expect(forming!.close).toBe(5.20);
      expect(forming!.volume).toBe(50);  // 10 + 20 + 5 + 15
      expect(forming!.ticks).toBe(4);

      // New minute triggers close of previous candle
      builder.processTick(SYM1, 5.30, 10, msAt(BASE + 60));

      expect(closed).toHaveLength(1);
      expect(closed[0].symbol).toBe(SYM1);
      expect(closed[0].candle.open).toBe(5.00);
      expect(closed[0].candle.high).toBe(5.50);
      expect(closed[0].candle.low).toBe(4.80);
      expect(closed[0].candle.close).toBe(5.20);
      expect(closed[0].candle.volume).toBe(50);
      expect(closed[0].candle.ticks).toBe(4);
      expect(closed[0].candle.minuteTs).toBe(BASE);
    });

    it('handles single-tick candles', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 3.00, 1, msAt(BASE));
      // Move to next minute
      builder.processTick(SYM1, 3.10, 1, msAt(BASE + 60));

      expect(closed).toHaveLength(1);
      expect(closed[0].candle.open).toBe(3.00);
      expect(closed[0].candle.high).toBe(3.00);
      expect(closed[0].candle.low).toBe(3.00);
      expect(closed[0].candle.close).toBe(3.00);
      expect(closed[0].candle.volume).toBe(1);
      expect(closed[0].candle.ticks).toBe(1);
    });

    it('ignores zero and negative prices', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 0, 10, msAt(BASE));
      builder.processTick(SYM1, -5, 10, msAt(BASE));

      expect(builder.getFormingCandle(SYM1)).toBeUndefined();
      expect(closed).toHaveLength(0);
    });

    it('tracks multiple symbols independently', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      builder.processTick(SYM2, 3.00, 20, msAt(BASE + 5));
      builder.processTick(SYM1, 5.50, 10, msAt(BASE + 10));
      builder.processTick(SYM2, 2.80, 10, msAt(BASE + 20));

      expect(builder.activeSymbols).toBe(2);

      // New minute for both
      builder.processTick(SYM1, 5.60, 5, msAt(BASE + 60));
      builder.processTick(SYM2, 3.10, 5, msAt(BASE + 65));

      expect(closed).toHaveLength(2);
      const sym1Closed = closed.find(c => c.symbol === SYM1)!;
      const sym2Closed = closed.find(c => c.symbol === SYM2)!;

      expect(sym1Closed.candle.open).toBe(5.00);
      expect(sym1Closed.candle.high).toBe(5.50);
      expect(sym1Closed.candle.volume).toBe(20);

      expect(sym2Closed.candle.open).toBe(3.00);
      expect(sym2Closed.candle.low).toBe(2.80);
      expect(sym2Closed.candle.volume).toBe(30);
    });

    it('handles multi-minute gaps (skipped minutes)', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      // Jump 5 minutes ahead
      builder.processTick(SYM1, 6.00, 10, msAt(BASE + 300));

      expect(closed).toHaveLength(1);
      expect(closed[0].candle.minuteTs).toBe(BASE);
      expect(closed[0].candle.close).toBe(5.00);

      // New forming candle at BASE + 300
      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.minuteTs).toBe(BASE + 300);
      expect(forming!.open).toBe(6.00);
    });

    it('accumulates volume correctly', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 100, msAt(BASE));
      builder.processTick(SYM1, 5.10, 200, msAt(BASE + 5));
      builder.processTick(SYM1, 5.05, 50,  msAt(BASE + 15));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.volume).toBe(350);
    });
  });

  describe('processQuote', () => {
    it('does NOT open a new candle from quote-only activity', () => {
      const { builder, closed } = createBuilder();

      // Only quotes, no trades
      builder.processQuote(SYM1, 4.90, 5.10, msAt(BASE));
      builder.processQuote(SYM1, 4.95, 5.15, msAt(BASE + 10));

      expect(builder.getFormingCandle(SYM1)).toBeUndefined();
      expect(builder.activeSymbols).toBe(0);
      expect(closed).toHaveLength(0);
    });

    it('updates existing candle high/low/close from quote midpoint', () => {
      const { builder } = createBuilder();

      // Open candle with a trade
      builder.processTick(SYM1, 5.00, 10, msAt(BASE));

      // Quote with midpoint 5.30 (higher than trade)
      builder.processQuote(SYM1, 5.20, 5.40, msAt(BASE + 10));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.high).toBeCloseTo(5.30, 10); // updated by quote mid
      expect(forming!.close).toBeCloseTo(5.30, 10);
      expect(forming!.low).toBe(5.00); // unchanged
    });

    it('updates low from quote midpoint', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));

      // Quote with midpoint 4.70 (lower than trade)
      builder.processQuote(SYM1, 4.60, 4.80, msAt(BASE + 10));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.low).toBeCloseTo(4.70, 10);
      expect(forming!.close).toBeCloseTo(4.70, 10);
      expect(forming!.high).toBe(5.00); // unchanged
    });

    it('ignores quotes for a different minute than current candle', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));

      // Quote from the next minute — should be ignored
      builder.processQuote(SYM1, 5.50, 5.70, msAt(BASE + 60));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.high).toBe(5.00);
      expect(forming!.close).toBe(5.00);
    });

    it('ignores quotes with zero or negative bid/ask', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));

      builder.processQuote(SYM1, 0, 5.20, msAt(BASE + 5));
      builder.processQuote(SYM1, -1, 5.20, msAt(BASE + 10));
      builder.processQuote(SYM1, 5.00, 0, msAt(BASE + 15));

      const forming = builder.getFormingCandle(SYM1);
      // Should remain unchanged — all quotes were invalid
      expect(forming!.close).toBe(5.00);
      expect(forming!.high).toBe(5.00);
    });

    it('does not increment ticks or volume', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      builder.processQuote(SYM1, 5.10, 5.30, msAt(BASE + 10));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.ticks).toBe(1);   // only the trade
      expect(forming!.volume).toBe(10);  // only from the trade
    });
  });

  describe('flushAll', () => {
    it('closes all forming candles with trades', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      builder.processTick(SYM2, 3.00, 20, msAt(BASE + 5));

      expect(closed).toHaveLength(0);
      builder.flushAll();

      expect(closed).toHaveLength(2);
      expect(closed.map(c => c.symbol).sort()).toEqual([SYM1, SYM2].sort());
    });

    it('skips candles with zero ticks (quote-only after trade moved to new minute)', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      // Force a new minute candle, closing the old one
      builder.processTick(SYM1, 5.10, 5, msAt(BASE + 60));
      // closed[0] is the first candle

      // Now manually clear closed to track only flushAll output
      closed.length = 0;

      // The forming candle at BASE+60 has 1 tick
      builder.flushAll();

      expect(closed).toHaveLength(1);
      expect(closed[0].candle.open).toBe(5.10);
    });

    it('clears all candles after flush', () => {
      const { builder, closed } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      builder.processTick(SYM2, 3.00, 20, msAt(BASE));

      builder.flushAll();
      expect(builder.activeSymbols).toBe(0);

      // Second flush should not emit anything
      closed.length = 0;
      builder.flushAll();
      expect(closed).toHaveLength(0);
    });

    it('does nothing when no candles exist', () => {
      const { builder, closed } = createBuilder();
      builder.flushAll();
      expect(closed).toHaveLength(0);
    });
  });

  describe('integration: trade + quote sequence', () => {
    it('builds realistic candle from mixed trade/quote stream', () => {
      const { builder, closed } = createBuilder();

      // Minute 0: trade opens, quotes update, more trades
      builder.processTick(SYM1, 5.00, 10, msAt(BASE + 1));
      builder.processQuote(SYM1, 4.90, 5.10, msAt(BASE + 3)); // mid 5.00 — no change
      builder.processTick(SYM1, 5.20, 15, msAt(BASE + 12));
      builder.processQuote(SYM1, 5.30, 5.50, msAt(BASE + 15)); // mid 5.40 — new high
      builder.processTick(SYM1, 4.70, 5, msAt(BASE + 30));      // new low
      builder.processQuote(SYM1, 4.60, 4.80, msAt(BASE + 35)); // mid 4.70 — ties low
      builder.processTick(SYM1, 5.10, 20, msAt(BASE + 55));     // close

      // Minute 1: new tick closes minute 0
      builder.processTick(SYM1, 5.15, 10, msAt(BASE + 62));

      expect(closed).toHaveLength(1);
      const c = closed[0].candle;
      expect(c.open).toBe(5.00);
      expect(c.high).toBeCloseTo(5.40, 10);  // set by quote mid
      expect(c.low).toBeCloseTo(4.70, 10);   // set by both trade and quote
      expect(c.close).toBe(5.10); // last trade at :55
      expect(c.volume).toBe(50);  // 10 + 15 + 5 + 20
      expect(c.ticks).toBe(4);    // quotes don't count
    });
  });

  describe('edge cases', () => {
    it('handles rapid ticks at exact minute boundary', () => {
      const { builder, closed } = createBuilder();
      // BASE is minute-aligned, so BASE+59 is in minute BASE, BASE+60 is in minute BASE+60

      builder.processTick(SYM1, 5.00, 10, msAt(BASE + 59));   // last second of minute 0
      builder.processTick(SYM1, 5.10, 10, msAt(BASE + 60));   // first second of minute 1

      expect(closed).toHaveLength(1);
      expect(closed[0].candle.close).toBe(5.00);
      expect(closed[0].candle.minuteTs).toBe(BASE);
    });

    it('handles same-price ticks', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 5.00, 10, msAt(BASE));
      builder.processTick(SYM1, 5.00, 20, msAt(BASE + 10));
      builder.processTick(SYM1, 5.00, 30, msAt(BASE + 20));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.open).toBe(5.00);
      expect(forming!.high).toBe(5.00);
      expect(forming!.low).toBe(5.00);
      expect(forming!.close).toBe(5.00);
      expect(forming!.volume).toBe(60);
    });

    it('handles very small fractional prices', () => {
      const { builder } = createBuilder();

      builder.processTick(SYM1, 0.05, 100, msAt(BASE));
      builder.processTick(SYM1, 0.10, 50,  msAt(BASE + 10));
      builder.processTick(SYM1, 0.01, 200, msAt(BASE + 20));

      const forming = builder.getFormingCandle(SYM1);
      expect(forming!.open).toBe(0.05);
      expect(forming!.high).toBe(0.10);
      expect(forming!.low).toBe(0.01);
      expect(forming!.volume).toBe(350);
    });
  });
});
