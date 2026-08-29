/**
 * snapshot-writer.ts — write live option-chain snapshots (WITH greeks) to a
 * parquet tree that is SEPARATE from the OHLCV bars tree.
 *
 * File layout: data/parquet/snapshots/{profileId}/{date}.parquet
 * One file per profile per day; one row per (minute, contract). Rewritten in
 * full on each flush from the day's SQLite accumulation (see live-capture.ts),
 * using the same atomic CSV → DuckDB(zstd) → verify → rename pipeline as
 * parquet-writer.ts so a crash never leaves a torn file.
 *
 * Kept deliberately additive: the existing bars parquet schema (OHLCV +
 * indicators, no greeks) is untouched, so every existing reader/backtest keeps
 * working. Greeks + bid/ask live here.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as duckdb from 'duckdb';

/** Default output root for snapshots. Override via opts.outDir. */
export const DEFAULT_SNAPSHOT_ROOT = path.resolve(process.cwd(), 'data/parquet/snapshots');

/**
 * Snapshot columns. Order matters — must match the CSV header and the DuckDB
 * column type map below.
 *   ts           minute-aligned epoch SECONDS (bucket key, matches bars `ts`)
 *   captured_at  actual epoch SECONDS the row was polled
 *   symbol       full OCC contract symbol
 *   underlying   underlying Tradier symbol (SPX, NDX, SPY, QQQ, XSP)
 *   underlying_px live underlying price at capture
 *   expiry       YYYY-MM-DD
 *   dte          calendar days to expiry
 *   strike / right (C|P)
 *   bid/ask/mid/last, volume, open_interest
 *   iv           Tradier implied vol (annualized)
 *   delta/gamma/theta/vega  Tradier (ORATS) greeks, ~hourly refresh
 *   bs_delta     Black-Scholes delta recomputed live from underlying_px + iv
 */
export const SNAPSHOT_COLUMNS = [
  'ts', 'captured_at', 'symbol', 'underlying', 'underlying_px',
  'expiry', 'dte', 'strike', 'right',
  'bid', 'ask', 'mid', 'last', 'volume', 'open_interest',
  'iv', 'delta', 'gamma', 'theta', 'vega', 'bs_delta',
] as const;

export interface SnapshotRow {
  ts: number;
  captured_at: number;
  symbol: string;
  underlying: string;
  underlying_px: number;
  expiry: string;
  dte: number;
  strike: number;
  right: 'C' | 'P';
  bid: number | null;
  ask: number | null;
  mid: number | null;
  last: number | null;
  volume: number | null;
  open_interest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  bs_delta: number | null;
  [col: string]: any;
}

const VARCHAR_COLS = new Set(['symbol', 'underlying', 'expiry', 'right']);
const INT_COLS = new Set(['ts', 'captured_at', 'dte', 'volume', 'open_interest']);

function duckRun(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => db.run(sql, (e: Error | null) => (e ? reject(e) : resolve())));
}
function duckQuery(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => db.all(sql, (e: Error | null, rows: any[]) => (e ? reject(e) : resolve(rows))));
}
function duckClose(db: duckdb.Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

export interface SnapshotWriteResult {
  filePath: string;
  rowCount: number;
  fileSize: number;
}

/**
 * Write one (profile, date) of snapshot rows to parquet. Full-file atomic
 * rewrite — safe to call repeatedly through the day with the growing row set.
 */
export async function writeDaySnapshots(opts: {
  profileId: string;
  date: string;
  rows: SnapshotRow[];
  outDir?: string;
}): Promise<SnapshotWriteResult> {
  const outRoot = opts.outDir ?? DEFAULT_SNAPSHOT_ROOT;
  const profileDir = path.join(outRoot, opts.profileId);
  const finalPath = path.join(profileDir, `${opts.date}.parquet`);
  const tmpPath = `${finalPath}.tmp`;
  const csvPath = `${finalPath}.csv`;
  fs.mkdirSync(profileDir, { recursive: true });

  if (opts.rows.length === 0) {
    throw new Error(`writeDaySnapshots: no rows for ${opts.profileId}/${opts.date}`);
  }

  // Phase 1: rows → CSV (same escaping/column order as parquet-writer.ts).
  const header = SNAPSHOT_COLUMNS.join(',');
  const csvLines = [header];
  for (const row of opts.rows) {
    const vals = SNAPSHOT_COLUMNS.map((col) => {
      const v = (row as any)[col];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
      return String(v);
    });
    csvLines.push(vals.join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // Phase 2: CSV → parquet via DuckDB.
  const duck = new duckdb.Database(':memory:');
  try {
    const typeDefs = SNAPSHOT_COLUMNS.map((col) => {
      if (VARCHAR_COLS.has(col)) return `'${col}': 'VARCHAR'`;
      if (INT_COLS.has(col)) return `'${col}': 'BIGINT'`;
      return `'${col}': 'DOUBLE'`;
    }).join(', ');

    await duckRun(duck, `
      COPY (
        SELECT * FROM read_csv('${csvPath}',
          header=true,
          columns={${typeDefs}},
          nullstr='',
          ignore_errors=true
        )
      ) TO '${tmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3)
    `);

    const [{ cnt }] = await duckQuery(duck, `SELECT COUNT(*) as cnt FROM read_parquet('${tmpPath}')`);
    const parquetRowCount = Number(cnt);
    if (parquetRowCount !== opts.rows.length) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new Error(
        `writeDaySnapshots row mismatch ${opts.profileId}/${opts.date}: ` +
        `rows=${opts.rows.length}, parquet=${parquetRowCount}`
      );
    }

    fs.renameSync(tmpPath, finalPath);
    const stat = fs.statSync(finalPath);
    return { filePath: finalPath, rowCount: opts.rows.length, fileSize: stat.size };
  } finally {
    try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
    await duckClose(duck);
  }
}
