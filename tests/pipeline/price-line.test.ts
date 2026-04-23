import { describe, it, expect, beforeEach } from 'vitest';
import { PriceLine } from '../../src/pipeline/price-line';

describe('PriceLine', () => {
  let line: PriceLine;

  beforeEach(() => {
    line = new PriceLine();
  });

  const pastMinuteTs = () => {
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = now - (now % 60);
    return currentMinute - 60;
  };
  const pastMinute2Ts = () => pastMinuteTs() - 60;

  it('records trade tick as price point', () => {
    line.processTick('SPXW260401C06500000', 3.50, pastMinuteTs() * 1000, 10);
    expect(line.getPrice('SPXW260401C06500000')).toBe(3.50);
  });

  it('records quote mid when no trade', () => {
    line.processQuote('SPXW260401C06500000', 3.40, 3.60, pastMinuteTs() * 1000);
    expect(line.getPrice('SPXW260401C06500000')).toBe(3.50);
  });

  it('trade overrides quote within same minute', () => {
    const ts = pastMinuteTs() * 1000;
    line.processQuote('SPXW260401C06500000', 3.40, 3.60, ts);
    line.processTick('SPXW260401C06500000', 3.55, ts + 10_000, 5);
    expect(line.getPrice('SPXW260401C06500000')).toBe(3.55);
  });

  it('accumulates volume on repeated trades within same minute', () => {
    const ts = pastMinuteTs() * 1000;
    line.processTick('SPXW260401C06500000', 3.50, ts, 10);
    line.processTick('SPXW260401C06500000', 3.52, ts + 10_000, 5);
    const bars = line.snapshotAndFlush(new Map(), 5);
    const bar = bars.find(b => b.symbol === 'SPXW260401C06500000');
    expect(bar?.volume).toBe(15);
  });

  it('snapshotAndFlush returns bars for past minutes only', () => {
    line.processTick('SPXW260401C06500000', 3.50, pastMinuteTs() * 1000, 10);
    const bars = line.snapshotAndFlush(new Map(), 5);
    expect(bars.length).toBe(1);
    expect(bars[0].symbol).toBe('SPXW260401C06500000');
    expect(bars[0].close).toBe(3.50);
  });

  it('does not close forming minute bar', () => {
    const now = Math.floor(Date.now() / 1000);
    line.processTick('SPXW260401C06500000', 3.50, now * 1000, 10);
    const bars = line.snapshotAndFlush(new Map(), 5);
    expect(bars.length).toBe(0);
  });

  it('REST mid overrides stream close >5% divergence', () => {
    line.processTick('SPXW260401C06500000', 3.50, pastMinuteTs() * 1000, 10);
    const restMids = new Map<string, number>();
    restMids.set('SPXW260401C06500000', 3.00);
    const bars = line.snapshotAndFlush(restMids, 5);
    expect(bars[0].close).toBe(3.00);
  });

  it('REST mid does not override if divergence <5%', () => {
    line.processTick('SPXW260401C06500000', 3.50, pastMinuteTs() * 1000, 10);
    const restMids = new Map<string, number>();
    restMids.set('SPXW260401C06500000', 3.49);
    const bars = line.snapshotAndFlush(restMids, 5);
    expect(bars[0].close).toBe(3.50);
  });

  it('carries forward H/L from previous bar', () => {
    const restMids = new Map<string, number>();
    line.processTick('SPXW260401C06500000', 3.50, pastMinute2Ts() * 1000, 10);
    line.snapshotAndFlush(restMids, 5);
    line.processTick('SPXW260401C06500000', 3.60, pastMinuteTs() * 1000, 10);
    const bars = line.snapshotAndFlush(restMids, 5);
    expect(bars.length).toBe(1);
    expect(bars[0].high).toBeGreaterThanOrEqual(3.60);
    expect(bars[0].low).toBeLessThanOrEqual(3.60);
  });

  it('reports activeCount correctly', () => {
    expect(line.activeCount).toBe(0);
    line.processTick('SPXW260401C06500000', 3.50, pastMinuteTs() * 1000, 10);
    expect(line.activeCount).toBe(1);
    line.processTick('SPXW260401P06500000', 2.80, pastMinuteTs() * 1000, 5);
    expect(line.activeCount).toBe(2);
  });
});
