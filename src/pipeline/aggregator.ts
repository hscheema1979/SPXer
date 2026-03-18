import type { Bar, Timeframe } from '../types';

export function aggregate(bars: Bar[], targetTf: Timeframe, periodSeconds: number): Bar[] {
  if (bars.length === 0) return [];

  const origin = bars[0].ts;
  const buckets = new Map<number, Bar[]>();
  for (const bar of bars) {
    const offset = Math.floor((bar.ts - origin) / periodSeconds) * periodSeconds;
    const bucket = origin + offset;
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(bar);
  }

  const result: Bar[] = [];
  for (const [bucketTs, group] of Array.from(buckets.entries()).sort(([a], [b]) => a - b)) {
    result.push({
      symbol: group[0].symbol,
      timeframe: targetTf,
      ts: bucketTs,
      open: group[0].open,
      high: Math.max(...group.map(b => b.high)),
      low: Math.min(...group.map(b => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, b) => s + b.volume, 0),
      synthetic: group.some(b => b.synthetic),
      gapType: group.some(b => b.gapType === 'stale') ? 'stale'
              : group.some(b => b.gapType === 'interpolated') ? 'interpolated'
              : null,
      indicators: {},
    });
  }
  return result;
}
