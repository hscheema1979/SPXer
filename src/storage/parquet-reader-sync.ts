/**
 * parquet-reader-sync.ts — Synchronous parquet reader for the replay engine.
 *
 * Uses DuckDB CLI (execFileSync) to read parquet files synchronously.
 * machine.ts loadBarCache() is synchronous, so we can't use the async
 * duckdb node module there. This module provides the sync bridge.
 *
 * Performance: ~300ms for a full day (underlying + 80 contracts, 23K bars).
 * After first read, machine.ts writes a binary cache file, so subsequent
 * reads of the same date bypass DuckDB entirely.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const PARQUET_ROOT = path.resolve(process.cwd(), process.env.PARQUET_ROOT || 'data/parquet/bars');

// Indicator columns matching machine.ts
const INDICATOR_COLUMNS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
];

const INDICATOR_SELECT = INDICATOR_COLUMNS.join(', ');

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, number | null>;
  spread?: number;
}

interface BarCache {
  spxBars: Bar[];
  contractBars: Map<string, Bar[]>;
  contractStrikes: Map<string, number>;
  timestamps: number[];
}

function parquetPath(profileId: string, date: string): string {
  return path.join(PARQUET_ROOT, profileId, `${date}.parquet`);
}

/** Run a DuckDB query synchronously, return parsed JSON rows. */
function duckQuery(sql: string): any[] {
  try {
    const result = execFileSync('duckdb', ['-json', '-c', sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
      maxBuffer: 512 * 1024 * 1024,
    });
    const text = result.toString().trim();
    if (!text || text === '[]') return [];
    return JSON.parse(text);
  } catch (err: any) {
    console.error(`[parquet-reader-sync] Query failed: ${err.stderr?.toString() || err.message}`);
    return [];
  }
}

function rowToIndicators(r: any): Record<string, number | null> {
  const ind: Record<string, number | null> = {};
  for (const col of INDICATOR_COLUMNS) {
    const v = r[col];
    if (v != null) ind[col] = typeof v === 'number' ? v : Number(v);
  }
  return ind;
}

const EMPTY_INDICATORS: Record<string, number | null> = Object.freeze({});

/**
 * Load a full BarCache from parquet — synchronous, drop-in for loadBarCache().
 */
export function loadBarCacheFromParquetSync(opts: {
  profileId: string;
  date: string;
  underlyingSymbol: string;
  symbolRange: { lo: string; hi: string };
  timeframe: string;
  startTs: number;
  endTs: number;
  skipContractIndicators?: boolean;
}): BarCache {
  const fp = parquetPath(opts.profileId, opts.date);
  if (!fs.existsSync(fp)) {
    return { spxBars: [], contractBars: new Map(), contractStrikes: new Map(), timestamps: [] };
  }

  const skipInd = opts.skipContractIndicators ?? false;

  // Load underlying + contracts in one query for efficiency
  // DuckDB reads the parquet file once and applies both filters
  const contractIndCols = skipInd ? '' : `, ${INDICATOR_SELECT}`;
  const sql = `
    SELECT symbol, ts, open, high, low, close, volume, spread,
           ${INDICATOR_SELECT},
           CASE WHEN symbol != '${opts.underlyingSymbol}' THEN CAST(substr(symbol, -8) AS INTEGER) / 1000.0 ELSE NULL END as strike
    FROM read_parquet('${fp}')
    WHERE timeframe = '${opts.timeframe}'
      AND ts >= ${opts.startTs} AND ts <= ${opts.endTs}
      AND (
        symbol = '${opts.underlyingSymbol}'
        OR (symbol >= '${opts.symbolRange.lo}' AND symbol < '${opts.symbolRange.hi}')
      )
    ORDER BY symbol, ts
  `;

  const rows = duckQuery(sql);

  const spxBars: Bar[] = [];
  const contractBars = new Map<string, Bar[]>();
  const contractStrikes = new Map<string, number>();

  for (const r of rows) {
    const sym = r.symbol as string;
    const bar: Bar = {
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
      indicators: (sym === opts.underlyingSymbol || !skipInd)
        ? rowToIndicators(r)
        : EMPTY_INDICATORS,
    };
    if (r.spread != null && !Number.isNaN(r.spread)) bar.spread = r.spread;

    if (sym === opts.underlyingSymbol) {
      spxBars.push(bar);
    } else {
      if (!contractBars.has(sym)) contractBars.set(sym, []);
      contractBars.get(sym)!.push(bar);
      if (!contractStrikes.has(sym) && r.strike != null) {
        contractStrikes.set(sym, r.strike);
      }
    }
  }

  const timestamps = spxBars.map(b => b.ts);
  return { spxBars, contractBars, contractStrikes, timestamps };
}
