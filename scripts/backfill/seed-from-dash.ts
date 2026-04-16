/**
 * Seed SPXer database from SPX-0DTE market_data ticks.
 * Aggregates ~10s ticks → 1m OHLCV bars, runs indicator engine, upserts into SPXer DB.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { initDb } from '../../src/storage/db';
import { upsertBars } from '../../src/storage/queries';
import { rawToBar } from '../../src/pipeline/bar-builder';
import { computeIndicators } from '../../src/pipeline/indicator-engine';
import type { Bar, Timeframe } from '../../src/types';

const DASH_DB = path.resolve('/home/ubuntu/SPX-0DTE/data.db');
const SPXER_DB = process.env.DB_PATH ?? './data/spxer.db';

// Symbols to seed (skip expired expirations or ones too old to matter)
const SKIP_EXPIRIES_BEFORE = '2026-03-18'; // skip contracts that expired before today

function symbolToSpxer(sym: string): string {
  return sym === '$SPX' ? 'SPX' : sym;
}

function floorMinute(isoTimestamp: string): number {
  return Math.floor(new Date(isoTimestamp + 'Z').getTime() / 60000) * 60;
}

interface Tick { ts: number; price: number }

function ticksToBar(symbol: string, tf: Timeframe, ts: number, ticks: Tick[]): Bar {
  const prices = ticks.map(t => t.price);
  return rawToBar(symbol, tf, {
    ts,
    open: prices[0],
    high: Math.max(...prices),
    low: Math.min(...prices),
    close: prices[prices.length - 1],
    volume: 0,
  });
}

async function main() {
  console.log('[seed] Opening SPX-0DTE DB:', DASH_DB);
  const src = new Database(DASH_DB, { readonly: true });

  console.log('[seed] Initialising SPXer DB:', SPXER_DB);
  initDb(SPXER_DB);

  // Get all distinct symbols from source
  const symbols: { symbol: string }[] = src.prepare(
    "SELECT DISTINCT symbol FROM market_data ORDER BY symbol"
  ).all() as any[];

  console.log(`[seed] Found ${symbols.length} symbols`);

  let totalBars = 0;

  for (const { symbol } of symbols) {
    const spxerSym = symbolToSpxer(symbol);

    // Skip expired contracts
    if (symbol.startsWith('SPXW')) {
      // Extract expiry date from symbol: SPXW260318C... → 2026-03-18
      const m = symbol.match(/^SPXW(\d{2})(\d{2})(\d{2})/);
      if (m) {
        const expiry = `20${m[1]}-${m[2]}-${m[3]}`;
        if (expiry < SKIP_EXPIRIES_BEFORE) continue;
      }
    }

    // Fetch all ticks for this symbol ordered by time
    const rows: { timestamp: string; price: number }[] = src.prepare(
      "SELECT timestamp, price FROM market_data WHERE symbol = ? ORDER BY timestamp ASC"
    ).all(symbol) as any[];

    if (rows.length === 0) continue;

    // Group ticks into 1-minute buckets
    const buckets = new Map<number, Tick[]>();
    for (const row of rows) {
      const ts = floorMinute(row.timestamp);
      if (!buckets.has(ts)) buckets.set(ts, []);
      buckets.get(ts)!.push({ ts, price: row.price });
    }

    // Build 1m bars
    const bars: Bar[] = [];
    for (const [ts, ticks] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      const bar = ticksToBar(spxerSym, '1m', ts, ticks);
      bars.push(bar);
    }

    // Run indicator engine (tier 1 for options, tier 2 for underlying)
    const tier = symbol === '$SPX' ? 2 : 1;
    const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, tier) }));

    upsertBars(enriched);
    totalBars += enriched.length;
    console.log(`[seed] ${spxerSym}: ${enriched.length} bars (from ${rows.length} ticks)`);
  }

  src.close();
  console.log(`[seed] Done. Total bars inserted: ${totalBars}`);
}

main().catch(e => { console.error(e); process.exit(1); });
