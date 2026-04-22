import { describe, it, expect } from 'vitest';
import { selectStrike, type StrikeCandidate } from '../../src/core/strike-selector';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import type { Config } from '../../src/config/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function candidate(
  side: 'call' | 'put',
  strike: number,
  price: number,
  volume = 100,
): StrikeCandidate {
  const kind = side === 'call' ? 'C' : 'P';
  const padded = String(Math.round(strike * 1000)).padStart(8, '0');
  return {
    symbol: `SPXW260420${kind}${padded}`,
    side,
    strike,
    price,
    volume,
  };
}

function atmOffsetConfig(atmOffset: number, overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    strikeSelector: {
      ...DEFAULT_CONFIG.strikeSelector,
      strikeMode: 'atm-offset',
      atmOffset,
    },
    // targetOtmDistance and targetContractPrice must not interfere
    signals: {
      ...DEFAULT_CONFIG.signals,
      targetOtmDistance: null as any,
      targetContractPrice: null,
    },
  };
}

// SPX at 6602 → rounds to 6600 at $5 interval. Strikes we provide are $5-aligned.
const SPX = 6602;

describe('strike-selector — atm-offset mode', () => {
  const candidates: StrikeCandidate[] = [
    // Calls: ITM10 (6590) → OTM10 (6610)
    candidate('call', 6590, 15.44, 38),
    candidate('call', 6595, 11.90, 97),
    candidate('call', 6600, 9.05, 216),
    candidate('call', 6605, 6.45, 241),
    candidate('call', 6610, 4.60, 207),
    // Puts: ITM10 (6610) → OTM10 (6590)
    candidate('put', 6610, 14.75, 33),
    candidate('put', 6605, 11.60, 80),
    candidate('put', 6600, 9.10, 191),
    candidate('put', 6595, 7.10, 209),
    candidate('put', 6590, 5.28, 174),
  ];

  it('ATM call: picks strike at roundedSpx (6600)', () => {
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(0));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6600);
    expect(result!.candidate.side).toBe('call');
    expect(result!.reason).toContain('ATM');
  });

  it('OTM5 call: picks strike 6605 (spx + 5)', () => {
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6605);
    expect(result!.reason).toContain('OTM5');
  });

  it('OTM10 call: picks strike 6610 (spx + 10)', () => {
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(10));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6610);
    expect(result!.reason).toContain('OTM10');
  });

  it('ITM5 call: picks strike 6595 (spx − 5)', () => {
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(-5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6595);
    expect(result!.reason).toContain('ITM5');
  });

  it('ITM10 call: picks strike 6590 (spx − 10)', () => {
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(-10));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6590);
    expect(result!.reason).toContain('ITM10');
  });

  it('ATM put: picks strike at roundedSpx (6600)', () => {
    const result = selectStrike(candidates, 'bearish', SPX, atmOffsetConfig(0));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6600);
    expect(result!.candidate.side).toBe('put');
    expect(result!.reason).toContain('ATM');
  });

  it('OTM5 put: picks strike 6595 (spx − 5, OTM for puts)', () => {
    const result = selectStrike(candidates, 'bearish', SPX, atmOffsetConfig(5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6595);
    expect(result!.candidate.side).toBe('put');
    expect(result!.reason).toContain('OTM5');
  });

  it('ITM5 put: picks strike 6605 (spx + 5, ITM for puts)', () => {
    const result = selectStrike(candidates, 'bearish', SPX, atmOffsetConfig(-5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6605);
    expect(result!.candidate.side).toBe('put');
    expect(result!.reason).toContain('ITM5');
  });

  it('OTM10 put: picks strike 6590 (spx − 10, OTM for puts)', () => {
    const result = selectStrike(candidates, 'bearish', SPX, atmOffsetConfig(10));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6590);
    expect(result!.candidate.side).toBe('put');
    expect(result!.reason).toContain('OTM10');
  });

  it('ignores contractPriceMin/Max — picks expensive ITM5 despite price band set low', () => {
    const cfg = atmOffsetConfig(-5, {
      strikeSelector: {
        ...DEFAULT_CONFIG.strikeSelector,
        strikeMode: 'atm-offset',
        atmOffset: -5,
        contractPriceMin: 0.20,
        contractPriceMax: 2.00,   // ITM5 call is $11.90 — would be filtered out in other modes
      },
    });
    const result = selectStrike(candidates, 'bullish', SPX, cfg);
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6595);
    expect(result!.candidate.price).toBeCloseTo(11.90);
  });

  it('returns null when no contract exists near target strike', () => {
    // All existing strikes are too far from targeted OTM30 (spx + 30 = 6632)
    const result = selectStrike(candidates, 'bullish', SPX, atmOffsetConfig(30));
    expect(result).toBeNull();
  });

  it('returns null when no candidates on the requested side', () => {
    const callsOnly = candidates.filter(c => c.side === 'call');
    const result = selectStrike(callsOnly, 'bearish', SPX, atmOffsetConfig(0));
    expect(result).toBeNull();
  });

  it('handles SPX not aligned to $5 interval — rounds first', () => {
    // SPX 6598.7 rounds to 6600. OTM5 should be 6605.
    const result = selectStrike(candidates, 'bullish', 6598.7, atmOffsetConfig(5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6605);
  });

  it('accepts strike within one interval of target (tolerates missing exact strike)', () => {
    // Remove exact OTM5 (6605); provide 6604 instead (still within $5 of target 6605)
    const gapped = [
      ...candidates.filter(c => c.strike !== 6605),
      candidate('call', 6604, 6.60, 100),
    ];
    const result = selectStrike(gapped, 'bullish', SPX, atmOffsetConfig(5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6604);
  });

  it('picks exact match over near-miss when both exist', () => {
    // Both 6605 (exact OTM5) and 6604 (1pt away) present — should prefer 6605
    const both = [
      ...candidates,
      candidate('call', 6604, 6.60, 500),  // higher volume but farther from target
    ];
    const result = selectStrike(both, 'bullish', SPX, atmOffsetConfig(5));
    expect(result).not.toBeNull();
    expect(result!.candidate.strike).toBe(6605);
  });
});

describe('strike-selector — existing modes unaffected', () => {
  const candidates: StrikeCandidate[] = [
    candidate('call', 6610, 4.60, 207),
    candidate('call', 6605, 6.45, 241),
    candidate('call', 6600, 9.05, 216),
  ];

  it('otm mode (default): still filters out ITM', () => {
    const cfg: Config = {
      ...DEFAULT_CONFIG,
      strikeSelector: {
        ...DEFAULT_CONFIG.strikeSelector,
        strikeMode: 'otm',
        contractPriceMin: 0.20,
        contractPriceMax: 10,
      },
      signals: {
        ...DEFAULT_CONFIG.signals,
        targetOtmDistance: null as any,
        targetContractPrice: null,
      },
    };
    const result = selectStrike(candidates, 'bullish', SPX, cfg);
    expect(result).not.toBeNull();
    // Should pick an OTM call (strike > 6602)
    expect(result!.candidate.strike).toBeGreaterThan(6602);
  });
});
