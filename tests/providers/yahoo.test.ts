import { describe, it, expect } from 'vitest';
import { fetchYahooBars } from '../../src/providers/yahoo';

describe('yahoo provider', () => {
  it('fetches ES=F 1m bars with volume', async () => {
    const bars = await fetchYahooBars('ES=F', '1m', '2d');
    expect(bars.length).toBeGreaterThan(100);
    expect(bars[0]).toMatchObject({
      ts: expect.any(Number),
      open: expect.any(Number),
      close: expect.any(Number),
    });
    const withVol = bars.filter(b => b.volume > 0);
    expect(withVol.length).toBeGreaterThan(50);
  }, 15000);

  it('fetches ^VIX bars', async () => {
    const bars = await fetchYahooBars('^VIX', '1m', '1d');
    expect(bars.length).toBeGreaterThan(0);
  }, 15000);
});
