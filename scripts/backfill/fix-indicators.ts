import Database from 'better-sqlite3';
import path from 'path';
import { initDb } from '../../src/storage/db';
import { upsertBars } from '../../src/storage/queries';
import { computeIndicators } from '../../src/pipeline/indicator-engine';
import { aggregate } from '../../src/pipeline/aggregator';
import type { Bar, Timeframe } from '../../src/types';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
initDb(DB_PATH);
const db = new Database(DB_PATH);

const HIGHER_TIMEFRAMES: [Timeframe, number][] = [['3m', 180], ['5m', 300], ['10m', 600], ['15m', 900], ['1h', 3600]];

// Get all 1m bars with empty indicators (Polygon backfill)
const rows = db.prepare(`
  SELECT id, symbol, timeframe, ts, open, high, low, close, volume
  FROM bars
  WHERE indicators = '{}' AND symbol LIKE 'SPXW%' AND timeframe = '1m'
  ORDER BY symbol, ts
`).all() as any[];

console.log(`Found ${rows.length} 1m bars with empty indicators`);

// Group by symbol for proper indicator state tracking
const bySymbol = new Map<string, any[]>();
for (const r of rows) {
  if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
  bySymbol.get(r.symbol)!.push(r);
}

let totalUpdated = 0;
let totalHigherTf = 0;

for (const [symbol, symRows] of bySymbol) {
  // Convert to Bar objects
  const bars1m: Bar[] = symRows.map((r: any) => ({
    symbol: r.symbol,
    timeframe: r.timeframe as Timeframe,
    ts: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    synthetic: false,
    gapType: null,
    indicators: {},
  }));

  // Compute 1m indicators
  const enriched1m = bars1m.map(b => ({
    ...b,
    indicators: computeIndicators(b, 2),
  }));
  upsertBars(enriched1m);
  totalUpdated += enriched1m.length;

  // Aggregate to higher timeframes with indicators
  for (const [tf, secs] of HIGHER_TIMEFRAMES) {
    const agg = aggregate(enriched1m, tf, secs).map(b => ({
      ...b, indicators: computeIndicators(b, 2),
    }));
    if (agg.length > 0) {
      upsertBars(agg as any);
      totalHigherTf += agg.length;
    }
  }
}

db.close();

console.log(`✓ Updated ${totalUpdated} 1m bars with indicators`);
console.log(`✓ Created ${totalHigherTf} higher-timeframe bars (3m/5m/15m/1h)`);
