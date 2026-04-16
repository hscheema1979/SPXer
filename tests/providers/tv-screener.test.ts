import { describe, it, expect } from 'vitest';
import { fetchScreenerSnapshot } from '../../src/providers/tv-screener';

describe('tv-screener provider', () => {
  it('fetches ES1! and sector ETFs', async () => {
    const results = await fetchScreenerSnapshot();
    expect(results.length).toBeGreaterThan(5);
    const symbols = results.map(r => r.symbol);
    expect(symbols).toContain('ES1!');
    expect(symbols).toContain('SPY');
    const es = results.find(r => r.symbol === 'ES1!');
    expect(es!.close).toBeGreaterThan(1000);
  }, 15000);
});
