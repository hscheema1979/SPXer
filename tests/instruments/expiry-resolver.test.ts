/**
 * Tests for the expiry resolver.
 *
 * Coverage:
 *   - Date primitives (addDays, dateDiffDays, dayOfWeek, isTradingDay)
 *   - resolveExpiry for each policy (0DTE, 1DTE, nearestAfterMinDte)
 *   - Holiday skipping
 *   - Weekend skipping
 *   - maxDte enforcement
 */
import { describe, it, expect } from 'vitest';
import {
  addDays,
  dateDiffDays,
  dayOfWeek,
  isMarketHoliday,
  isTradingDay,
  nextTradingDay,
  tradingDayOnOrAfter,
  resolveExpiry,
} from '../../src/instruments/expiry-resolver';

describe('date primitives', () => {
  it('addDays handles month/year boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('dateDiffDays counts calendar days', () => {
    expect(dateDiffDays('2026-04-17', '2026-04-20')).toBe(3);
    expect(dateDiffDays('2026-04-20', '2026-04-17')).toBe(-3);
    expect(dateDiffDays('2026-04-20', '2026-04-20')).toBe(0);
  });

  it('dayOfWeek: 2026-04-20 is Monday (1)', () => {
    expect(dayOfWeek('2026-04-20')).toBe(1); // Monday
    expect(dayOfWeek('2026-04-18')).toBe(6); // Saturday
    expect(dayOfWeek('2026-04-19')).toBe(0); // Sunday
    expect(dayOfWeek('2026-04-17')).toBe(5); // Friday
  });

  it('isMarketHoliday recognizes known US holidays', () => {
    // 2026-04-03 is Good Friday per MARKET_HOLIDAYS
    expect(isMarketHoliday('2026-04-03')).toBe(true);
    // 2026-07-03 is observed July 4 per MARKET_HOLIDAYS
    expect(isMarketHoliday('2026-07-03')).toBe(true);
    // 2026-04-20 is a normal Monday
    expect(isMarketHoliday('2026-04-20')).toBe(false);
  });

  it('isTradingDay excludes weekends and holidays', () => {
    expect(isTradingDay('2026-04-20')).toBe(true);  // Mon
    expect(isTradingDay('2026-04-18')).toBe(false); // Sat
    expect(isTradingDay('2026-04-19')).toBe(false); // Sun
    expect(isTradingDay('2026-04-03')).toBe(false); // Good Friday
  });
});

describe('tradingDayOnOrAfter / nextTradingDay', () => {
  it('Friday → Friday itself', () => {
    expect(tradingDayOnOrAfter('2026-04-17')).toBe('2026-04-17');
  });

  it('Saturday → Monday', () => {
    expect(tradingDayOnOrAfter('2026-04-18')).toBe('2026-04-20');
  });

  it('Sunday → Monday', () => {
    expect(tradingDayOnOrAfter('2026-04-19')).toBe('2026-04-20');
  });

  it('Good Friday 2026-04-03 → Monday 2026-04-06', () => {
    expect(tradingDayOnOrAfter('2026-04-03')).toBe('2026-04-06');
  });

  it('nextTradingDay(Friday) → Monday', () => {
    expect(nextTradingDay('2026-04-17')).toBe('2026-04-20');
  });

  it('nextTradingDay(Thursday before Good Friday) → Monday', () => {
    // 2026-04-02 is Thursday, 2026-04-03 Good Friday, 2026-04-06 Monday
    expect(nextTradingDay('2026-04-02')).toBe('2026-04-06');
  });
});

describe('resolveExpiry — 0DTE', () => {
  it('on a trading day returns today', () => {
    const r = resolveExpiry({ policy: '0DTE' }, { todayET: '2026-04-20' });
    expect(r.expiryET).toBe('2026-04-20');
    expect(r.dte).toBe(0);
    expect(r.cadence).toBe('daily');
  });

  it('on a weekend rolls forward to next trading day', () => {
    const r = resolveExpiry({ policy: '0DTE' }, { todayET: '2026-04-18' });
    expect(r.expiryET).toBe('2026-04-20');
    expect(r.dte).toBe(2);
  });

  it('on a holiday rolls forward', () => {
    // Good Friday 2026-04-03 → Mon 2026-04-06
    const r = resolveExpiry({ policy: '0DTE' }, { todayET: '2026-04-03' });
    expect(r.expiryET).toBe('2026-04-06');
    expect(r.dte).toBe(3);
  });
});

describe('resolveExpiry — 1DTE', () => {
  it('Monday → Tuesday', () => {
    const r = resolveExpiry({ policy: '1DTE' }, { todayET: '2026-04-20' });
    expect(r.expiryET).toBe('2026-04-21');
    expect(r.dte).toBe(1);
    expect(r.cadence).toBe('daily');
  });

  it('Friday → Monday (skips weekend)', () => {
    const r = resolveExpiry({ policy: '1DTE' }, { todayET: '2026-04-17' });
    expect(r.expiryET).toBe('2026-04-20');
    expect(r.dte).toBe(3);
  });

  it('Thursday before Good Friday → Monday', () => {
    const r = resolveExpiry({ policy: '1DTE' }, { todayET: '2026-04-02' });
    expect(r.expiryET).toBe('2026-04-06');
    expect(r.dte).toBe(4);
  });

  it('Saturday → Tuesday (first ref is Monday, next is Tuesday)', () => {
    const r = resolveExpiry({ policy: '1DTE' }, { todayET: '2026-04-18' });
    expect(r.expiryET).toBe('2026-04-21');
  });
});

describe('resolveExpiry — nearestAfterMinDte', () => {
  it('minDte=5 on Monday → following Monday', () => {
    const r = resolveExpiry(
      { policy: 'nearestAfterMinDte', minDte: 5 },
      { todayET: '2026-04-20' }
    );
    expect(r.expiryET).toBe('2026-04-27'); // Mon + 5 days = Sat → next trading day = Mon
    expect(r.dte).toBe(7);
    expect(r.cadence).toBe('weekly');
  });

  it('minDte=7 on Monday → +7 day is next Monday', () => {
    const r = resolveExpiry(
      { policy: 'nearestAfterMinDte', minDte: 7 },
      { todayET: '2026-04-20' }
    );
    expect(r.expiryET).toBe('2026-04-27');
    expect(r.dte).toBe(7);
  });

  it('minDte=0 on Monday → today', () => {
    const r = resolveExpiry(
      { policy: 'nearestAfterMinDte', minDte: 0 },
      { todayET: '2026-04-20' }
    );
    expect(r.expiryET).toBe('2026-04-20');
    expect(r.dte).toBe(0);
  });

  it('default minDte=5 when omitted', () => {
    const r = resolveExpiry(
      { policy: 'nearestAfterMinDte' },
      { todayET: '2026-04-20' }
    );
    expect(r.dte).toBeGreaterThanOrEqual(5);
  });

  it('negative minDte rejected', () => {
    expect(() =>
      resolveExpiry({ policy: 'nearestAfterMinDte', minDte: -1 }, { todayET: '2026-04-20' })
    ).toThrow(/minDte must be >= 0/);
  });
});

describe('resolveExpiry — maxDte enforcement', () => {
  it('rejects when resolved DTE exceeds maxDte', () => {
    expect(() =>
      resolveExpiry(
        { policy: 'nearestAfterMinDte', minDte: 7, maxDte: 5 },
        { todayET: '2026-04-20' }
      )
    ).toThrow(/exceeds maxDte/);
  });

  it('accepts when resolved DTE is within maxDte', () => {
    const r = resolveExpiry(
      { policy: 'nearestAfterMinDte', minDte: 5, maxDte: 10 },
      { todayET: '2026-04-20' }
    );
    expect(r.dte).toBeLessThanOrEqual(10);
  });
});

describe('resolveExpiry — input validation', () => {
  it('rejects malformed todayET', () => {
    expect(() =>
      resolveExpiry({ policy: '0DTE' }, { todayET: 'not-a-date' })
    ).toThrow(/Malformed date/);
  });

  it('rejects unknown policy', () => {
    expect(() =>
      resolveExpiry({ policy: 'BADPOLICY' as never }, { todayET: '2026-04-20' })
    ).toThrow(/Unknown policy/);
  });
});

describe('resolveExpiry — custom holidays (test injection)', () => {
  it('respects a custom holiday set', () => {
    // Pretend Monday 2026-04-20 is a holiday
    const fakeHolidays = new Set(['2026-04-20']);
    const r = resolveExpiry(
      { policy: '0DTE' },
      { todayET: '2026-04-20', holidays: fakeHolidays }
    );
    expect(r.expiryET).toBe('2026-04-21'); // Tuesday
  });
});
