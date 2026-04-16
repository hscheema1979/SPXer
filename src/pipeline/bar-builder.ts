import type { Bar, GapType, OHLCVRaw, Timeframe } from '../types';
import { GAP_INTERPOLATE_MAX_MINS } from '../config';
import { pipelineHealth } from '../ops/pipeline-health';

export function buildBars(symbol: string, timeframe: Timeframe, raws: OHLCVRaw[]): Bar[] {
  const bars = raws.map(r => rawToBar(symbol, timeframe, r));
  pipelineHealth.barBuilder.barsBuilt += bars.length;
  return bars;
}

export function rawToBar(symbol: string, timeframe: Timeframe, raw: OHLCVRaw): Bar {
  return {
    symbol, timeframe, ts: raw.ts,
    open: raw.open, high: raw.high, low: raw.low, close: raw.close,
    volume: raw.volume, synthetic: false, gapType: null, indicators: {},
  };
}

export function interpolateGap(
  t1: number, p1: number,
  t2: number, p2: number,
  barSeconds: number
): Bar[] {
  const gapBars = Math.floor((t2 - t1) / barSeconds) - 1;
  if (gapBars <= 0) return [];

  const gapMinutes = (t2 - t1) / 60;
  const isStale = gapMinutes > GAP_INTERPOLATE_MAX_MINS;

  const bars: Bar[] = [];
  for (let k = 1; k <= gapBars; k++) {
    const price = isStale ? p1 : p1 + (p2 - p1) * (k / (gapBars + 1));
    const ts = t1 + k * barSeconds;
    bars.push({
      symbol: '', timeframe: '1m', ts,
      open: price, high: price, low: price, close: price,
      volume: 0, synthetic: true,
      gapType: isStale ? 'stale' : 'interpolated',
      indicators: {},
    });
  }
  return bars;
}

export function fillGaps(symbol: string, timeframe: Timeframe, bars: Bar[], barSeconds: number): Bar[] {
  if (bars.length === 0) return bars;
  const result: Bar[] = [bars[0]];

  for (let i = 1; i < bars.length; i++) {
    const prev = result[result.length - 1];
    const curr = bars[i];
    const gap = curr.ts - prev.ts;

    if (gap > barSeconds * 1.5) {
      const synthetic = interpolateGap(prev.ts, prev.close, curr.ts, curr.close, barSeconds);
      synthetic.forEach(b => { b.symbol = symbol; b.timeframe = timeframe; });
      result.push(...synthetic);
      // Track synthetic bar stats
      pipelineHealth.barBuilder.syntheticBars += synthetic.length;
      for (const sb of synthetic) {
        if (sb.gapType === 'stale') pipelineHealth.barBuilder.gapsStale++;
        else pipelineHealth.barBuilder.gapsInterpolated++;
      }
    }
    result.push(curr);
  }
  return result;
}
