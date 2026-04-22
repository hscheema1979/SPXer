/**
 * Tests for the profile-aware option-symbol formatting utilities.
 *
 * Parity goal: symbols produced via `formatOptionSymbol(profile, ...)` must
 * be byte-identical to what spx_agent.ts / trade-executor.ts produce for
 * SPX today. That is the regression guard: if this file fails, the live
 * SPX agent's symbols would no longer round-trip through the abstraction.
 */
import { describe, it, expect } from 'vitest';
import {
  roundStrike,
  formatExpiryCode,
  formatStrikeCode,
  formatOptionSymbol,
  parseOptionSymbol,
} from '../../src/instruments/symbol-format';
import { SPX_0DTE_PROFILE, SPY_1DTE_PROFILE } from '../../src/instruments';

describe('roundStrike', () => {
  it('rounds SPX to nearest $5', () => {
    expect(roundStrike(SPX_0DTE_PROFILE, 7102)).toBe(7100);
    expect(roundStrike(SPX_0DTE_PROFILE, 7103)).toBe(7105);
    expect(roundStrike(SPX_0DTE_PROFILE, 7100)).toBe(7100);
  });

  it('rounds SPY to nearest $1', () => {
    expect(roundStrike(SPY_1DTE_PROFILE, 440.3)).toBe(440);
    expect(roundStrike(SPY_1DTE_PROFILE, 440.7)).toBe(441);
    expect(roundStrike(SPY_1DTE_PROFILE, 440)).toBe(440);
  });

  it('handles zero and small values', () => {
    expect(roundStrike(SPX_0DTE_PROFILE, 0)).toBe(0);
    expect(roundStrike(SPX_0DTE_PROFILE, 3)).toBe(5);
    expect(roundStrike(SPX_0DTE_PROFILE, 2)).toBe(0);
  });
});

describe('formatExpiryCode', () => {
  it('formats ISO YYYY-MM-DD to YYMMDD', () => {
    expect(formatExpiryCode('2026-04-20')).toBe('260420');
    expect(formatExpiryCode('2030-12-31')).toBe('301231');
  });

  it('passes through already-formatted YYMMDD', () => {
    expect(formatExpiryCode('260420')).toBe('260420');
  });

  it('rejects malformed strings', () => {
    expect(() => formatExpiryCode('not-a-date')).toThrow();
    expect(() => formatExpiryCode('2026/04/20')).toThrow();
  });

  it('formats a Date (UTC components)', () => {
    const d = new Date(Date.UTC(2026, 3, 20)); // April=3 (0-indexed)
    expect(formatExpiryCode(d)).toBe('260420');
  });
});

describe('formatStrikeCode', () => {
  it('SPX strike 7100 → 07100000', () => {
    expect(formatStrikeCode(7100)).toBe('07100000');
  });

  it('SPY strike 440 → 00440000', () => {
    expect(formatStrikeCode(440)).toBe('00440000');
  });

  it('rounds to avoid float artifacts', () => {
    expect(formatStrikeCode(440.0)).toBe('00440000');
    expect(formatStrikeCode(5000)).toBe('05000000');
  });
});

describe('formatOptionSymbol — SPX parity', () => {
  // The format must match what trade-executor.ts produces: SPXW260420C07100000
  it('SPX 0DTE call @ 7100 on 2026-04-20', () => {
    const s = formatOptionSymbol(SPX_0DTE_PROFILE, '2026-04-20', 7100, 'C');
    expect(s).toBe('SPXW260420C07100000');
  });

  it('SPX 0DTE put @ 7050 on 2026-04-17', () => {
    const s = formatOptionSymbol(SPX_0DTE_PROFILE, '2026-04-17', 7050, 'P');
    expect(s).toBe('SPXW260417P07050000');
  });

  it('matches live tracked contract symbols observed in /health (spot check)', () => {
    // From the /health response captured in this session: SPXW260420C07100000
    const s = formatOptionSymbol(SPX_0DTE_PROFILE, '2026-04-20', 7100, 'C');
    expect(s).toBe('SPXW260420C07100000');
  });
});

describe('formatOptionSymbol — SPY', () => {
  it('SPY 1DTE call @ 440 on 2026-04-21', () => {
    const s = formatOptionSymbol(SPY_1DTE_PROFILE, '2026-04-21', 440, 'C');
    expect(s).toBe('SPY260421C00440000');
  });

  it('SPY 1DTE put @ 435 on 2026-04-21', () => {
    const s = formatOptionSymbol(SPY_1DTE_PROFILE, '2026-04-21', 435, 'P');
    expect(s).toBe('SPY260421P00435000');
  });
});

describe('parseOptionSymbol', () => {
  it('parses an SPX symbol', () => {
    const p = parseOptionSymbol('SPXW260420C07100000');
    expect(p).toEqual({
      root: 'SPXW',
      expiryYYMMDD: '260420',
      side: 'C',
      strike: 7100,
    });
  });

  it('parses an SPY symbol', () => {
    const p = parseOptionSymbol('SPY260421P00440000');
    expect(p).toEqual({
      root: 'SPY',
      expiryYYMMDD: '260421',
      side: 'P',
      strike: 440,
    });
  });

  it('returns null for malformed input', () => {
    expect(parseOptionSymbol('not-a-symbol')).toBeNull();
    expect(parseOptionSymbol('SPXW260420X07100000')).toBeNull(); // bad side
    expect(parseOptionSymbol('SPXW26042C07100000')).toBeNull();  // short date
  });
});

describe('round-trip: format then parse', () => {
  it('SPX call', () => {
    const s = formatOptionSymbol(SPX_0DTE_PROFILE, '2026-04-20', 7100, 'C');
    const parsed = parseOptionSymbol(s)!;
    expect(parsed.root).toBe('SPXW');
    expect(parsed.strike).toBe(7100);
    expect(parsed.side).toBe('C');
    expect(parsed.expiryYYMMDD).toBe('260420');
  });

  it('SPY put', () => {
    const s = formatOptionSymbol(SPY_1DTE_PROFILE, '2026-04-21', 440, 'P');
    const parsed = parseOptionSymbol(s)!;
    expect(parsed.root).toBe('SPY');
    expect(parsed.strike).toBe(440);
    expect(parsed.side).toBe('P');
    expect(parsed.expiryYYMMDD).toBe('260421');
  });
});
