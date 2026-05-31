import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb } from '../src/storage/db';
import { upsertBar, getBars } from '../src/storage/queries';
import { buildBars } from '../src/pipeline/bar-builder';
import { computeIndicators } from '../src/pipeline/indicator-engine';
import type { OHLCVRaw } from '../src/types';

beforeAll(() => {
  initDb(':memory:');
});

afterAll(() => {
  closeDb();
});

describe('smoke: DB initializes', () => {
  it('DB initializes and can store bars', () => {
    const raw: OHLCVRaw = { ts: 1700000000, open: 5000, high: 5010, low: 4990, close: 5005, volume: 100 };
    const [bar] = buildBars('SPX', '1m', [raw]);
    upsertBar(bar);
    const stored = getBars('SPX', '1m', 10);
    expect(stored).toHaveLength(1);
    expect(stored[0].close).toBe(5005);
  });
});

describe('smoke: bar pipeline produces indicator-enriched bars', () => {
  it('produces indicator-enriched bars from raw data', () => {
    // Build 30 bars so indicators have enough history
    const raws: OHLCVRaw[] = Array.from({ length: 30 }, (_, i) => ({
      ts: 1700100000 + i * 60,
      open: 5000 + i,
      high: 5010 + i,
      low: 4990 + i,
      close: 5005 + i,
      volume: 100 + i * 10,
    }));

    const bars = buildBars('SPX_SMOKE', '1m', raws);
    const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 1) }));

    // Persist all
    for (const b of enriched) upsertBar(b);

    const lastBar = enriched[enriched.length - 1];
    expect(lastBar.indicators).toHaveProperty('hma5');
    expect(lastBar.indicators).toHaveProperty('rsi14');
    expect(lastBar.indicators).toHaveProperty('vwap');
    expect(lastBar.indicators.vwap).not.toBeNull();

    const stored = getBars('SPX_SMOKE', '1m', 100);
    expect(stored.length).toBe(30);
    expect(stored[stored.length - 1].indicators).toHaveProperty('hma5');
  });
});
