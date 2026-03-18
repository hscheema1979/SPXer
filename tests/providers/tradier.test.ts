import { describe, it, expect } from 'vitest';
import { normalizeSymbol } from '../../src/providers/tradier';

describe('tradier provider', () => {
  it('normalizes option symbol format', () => {
    expect(normalizeSymbol('SPXW260318C6700.0')).toBe('SPXW260318C06700000');
    expect(normalizeSymbol('SPXW260318P6650.0')).toBe('SPXW260318P06650000');
    expect(normalizeSymbol('SPXW260318C06700000')).toBe('SPXW260318C06700000');
  });
});
