/**
 * parquet-writer.ts — Flush replay_bars from SQLite to per-date parquet files.
 *
 * Strategy: Read from SQLite via better-sqlite3 (handles WAL correctly),
 * write to a temp CSV, then use DuckDB to convert CSV → parquet with zstd.
 * DuckDB's sqlite extension can't reliably read DBs with large WAL files.
 *
 * File layout: data/parquet/bars/{profileId}/{date}.parquet
 * Each file has ALL symbols (underlying + option contracts), ALL timeframes.
 * Compression: zstd level 3 (~5x ratio on real bar data).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as duckdb from 'duckdb';
import Database from 'better-sqlite3';

/** Default output root. Override via opts.outDir. */
const DEFAULT_PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');

/**
 * All columns exported to parquet. Matches replay_bars schema minus `id` and
 * `created_at` (not needed downstream). Order matches what parquet-reader
 * expects — keep them in sync.
 */
export const EXPORT_COLUMNS = [
  'symbol', 'timeframe', 'ts',
  'open', 'high', 'low', 'close', 'volume',
  'synthetic', 'gap_type', 'indicators', 'source', 'spread',
  // Denormalized indicator columns (must match DENORM_COLS in mtf-builder.ts)
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

export interface FlushResult {
  filePath: string;
  rowCount: number;
  sourceRowCount: number;
  fileSize: number;
}

export interface FlushOptions {
  /** Absolute path to the SQLite DB containing replay_bars. */
  sqliteDbPath: string;
  /** Profile id — used as subdirectory name (e.g. 'spx', 'ndx'). */
  profileId: string;
  /** Date to flush (YYYY-MM-DD). */
  date: string;
  /** Table name in the SQLite DB. Default: 'replay_bars'. */
  tableName?: string;
  /** Output root directory. Default: data/parquet/bars/ */
  outDir?: string;
  /**
   * SQL WHERE filter to scope which symbols belong to this profile.
   * Uses SQLite syntax (better-sqlite3 reads the data).
   * E.g. "(symbol = 'SPX' OR symbol LIKE 'SPXW%')"
   */
  symbolFilter?: string;
  /** Skip verification read after write. Default: false. */
  skipVerify?: boolean;
}

// ── DuckDB helpers ───────────────────────────────────────────────────────────

function duckRun(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => err ? reject(err) : resolve());
  });
}

function duckQuery(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows));
  });
}

function duckClose(db: duckdb.Database): Promise<void> {
  return new Promise((resolve) => db.close(() => resolve()));
}

/**
 * Flush one date of replay_bars from SQLite to a parquet file.
 *
 * Pipeline: better-sqlite3 → temp CSV → DuckDB → parquet (zstd).
 * Writes to a .tmp file first, verifies row count, then atomically renames.
 */
export async function flushToParquet(opts: FlushOptions): Promise<FlushResult> {
  const tableName = opts.tableName ?? 'replay_bars';
  const outRoot = opts.outDir ?? DEFAULT_PARQUET_ROOT;
  const profileDir = path.join(outRoot, opts.profileId);
  const finalPath = path.join(profileDir, `${opts.date}.parquet`);
  const tmpPath = `${finalPath}.tmp`;
  const csvPath = `${finalPath}.csv`;

  fs.mkdirSync(profileDir, { recursive: true });

  // ── Phase 1: Read from SQLite via better-sqlite3 ──────────────────────────
  const dayStart = Math.floor(new Date(`${opts.date}T00:00:00Z`).getTime() / 1000);
  const dayEnd = dayStart + 86400 - 1;

  const conditions = [`ts >= ${dayStart}`, `ts <= ${dayEnd}`];
  if (opts.symbolFilter) conditions.push(`(${opts.symbolFilter})`);
  const where = conditions.join(' AND ');

  const colList = EXPORT_COLUMNS.join(', ');
  const sql = `SELECT ${colList} FROM ${tableName} WHERE ${where} ORDER BY symbol, timeframe, ts`;

  const sqliteDb = new Database(opts.sqliteDbPath, { readonly: true });
  let sourceRowCount = 0;

  try {
    const rows = sqliteDb.prepare(sql).all() as any[];
    sourceRowCount = rows.length;

    if (sourceRowCount === 0) {
      throw new Error(`No rows in ${tableName} for ${opts.profileId}/${opts.date}`);
    }

    // Write CSV with header
    const header = EXPORT_COLUMNS.join(',');
    const csvLines = [header];
    for (const row of rows) {
      const vals = EXPORT_COLUMNS.map(col => {
        const v = row[col];
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') {
          // Escape quotes in strings (indicators JSON, gap_type, etc.)
          return `"${v.replace(/"/g, '""')}"`;
        }
        return String(v);
      });
      csvLines.push(vals.join(','));
    }
    fs.writeFileSync(csvPath, csvLines.join('\n'));
  } finally {
    sqliteDb.close();
  }

  // ── Phase 2: Convert CSV → parquet via DuckDB ─────────────────────────────
  const duck = new duckdb.Database(':memory:');
  try {
    // Define column types to match the schema exactly
    const typeDefs = EXPORT_COLUMNS.map(col => {
      if (col === 'symbol' || col === 'timeframe' || col === 'gap_type' ||
          col === 'indicators' || col === 'source') return `'${col}': 'VARCHAR'`;
      if (col === 'ts' || col === 'volume' || col === 'synthetic') return `'${col}': 'INTEGER'`;
      return `'${col}': 'DOUBLE'`;
    }).join(', ');

    await duckRun(duck, `
      COPY (
        SELECT * FROM read_csv('${csvPath}',
          header=true,
          columns={${typeDefs}},
          ignore_errors=true
        )
      ) TO '${tmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3)
    `);

    // Verify row count
    if (!opts.skipVerify) {
      const [{ cnt }] = await duckQuery(duck,
        `SELECT COUNT(*) as cnt FROM read_parquet('${tmpPath}')`
      );
      const parquetRowCount = Number(cnt);
      if (parquetRowCount !== sourceRowCount) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw new Error(
          `Row count mismatch for ${opts.profileId}/${opts.date}: ` +
          `SQLite=${sourceRowCount}, parquet=${parquetRowCount}`
        );
      }
    }

    // Atomic rename
    fs.renameSync(tmpPath, finalPath);

    const stat = fs.statSync(finalPath);
    return {
      filePath: finalPath,
      rowCount: sourceRowCount,
      sourceRowCount,
      fileSize: stat.size,
    };
  } finally {
    // Clean up CSV
    try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
    await duckClose(duck);
  }
}

/**
 * A single bar row, shaped to EXPORT_COLUMNS. Base OHLCV+meta required;
 * denormalized indicator columns optional (filled '' / NULL when absent).
 */
export interface BarRow {
  symbol: string;
  timeframe: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic?: number;
  gap_type?: string | null;
  indicators?: string;
  source?: string;
  spread?: number | string | null;
  [col: string]: any;
}

/**
 * Write one (profile,date) of IN-MEMORY BarRows DIRECTLY to parquet — no
 * SQLite. Same atomic CSV → DuckDB(zstd) → verify → rename pipeline as
 * flushToParquet(), only the source is `rows` instead of replay_bars. This
 * is the direct-to-parquet primitive the backfill chain (eod-backfill.ts /
 * backfill-replay-options.ts) depends on. Additive — flushToParquet() and
 * all SQLite-path callers are unaffected.
 */
export async function writeDayParquet(opts: {
  profileId: string;
  date: string;
  rows: BarRow[];
  outDir?: string;
  skipVerify?: boolean;
}): Promise<FlushResult> {
  const outRoot = opts.outDir ?? DEFAULT_PARQUET_ROOT;
  const profileDir = path.join(outRoot, opts.profileId);
  const finalPath = path.join(profileDir, `${opts.date}.parquet`);
  const tmpPath = `${finalPath}.tmp`;
  const csvPath = `${finalPath}.csv`;
  fs.mkdirSync(profileDir, { recursive: true });

  const sourceRowCount = opts.rows.length;
  if (sourceRowCount === 0) {
    throw new Error(`writeDayParquet: no rows for ${opts.profileId}/${opts.date}`);
  }

  // Phase 1: rows → CSV (same escaping/column order as flushToParquet)
  const header = EXPORT_COLUMNS.join(',');
  const csvLines = [header];
  for (const row of opts.rows) {
    const vals = EXPORT_COLUMNS.map(col => {
      const v = (row as any)[col];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
      return String(v);
    });
    csvLines.push(vals.join(','));
  }
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  // Phase 2: CSV → parquet via DuckDB (identical to flushToParquet)
  const duck = new duckdb.Database(':memory:');
  try {
    const typeDefs = EXPORT_COLUMNS.map(col => {
      if (col === 'symbol' || col === 'timeframe' || col === 'gap_type' ||
          col === 'indicators' || col === 'source') return `'${col}': 'VARCHAR'`;
      if (col === 'ts' || col === 'volume' || col === 'synthetic') return `'${col}': 'INTEGER'`;
      return `'${col}': 'DOUBLE'`;
    }).join(', ');

    await duckRun(duck, `
      COPY (
        SELECT * FROM read_csv('${csvPath}',
          header=true,
          columns={${typeDefs}},
          ignore_errors=true
        )
      ) TO '${tmpPath}' (FORMAT PARQUET, COMPRESSION ZSTD, COMPRESSION_LEVEL 3)
    `);

    if (!opts.skipVerify) {
      const [{ cnt }] = await duckQuery(duck,
        `SELECT COUNT(*) as cnt FROM read_parquet('${tmpPath}')`);
      const parquetRowCount = Number(cnt);
      if (parquetRowCount !== sourceRowCount) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw new Error(
          `writeDayParquet row mismatch ${opts.profileId}/${opts.date}: ` +
          `rows=${sourceRowCount}, parquet=${parquetRowCount}`
        );
      }
    }

    fs.renameSync(tmpPath, finalPath);
    const stat = fs.statSync(finalPath);
    return { filePath: finalPath, rowCount: sourceRowCount, sourceRowCount, fileSize: stat.size };
  } finally {
    try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
    await duckClose(duck);
  }
}

/**
 * Build the symbol filter SQL fragment for a profile.
 */
export function profileSymbolFilter(profileId: string, underlyingSymbol: string): string {
  const prefixMap: Record<string, string> = {
    'spx-0dte': 'SPXW', 'spx': 'SPXW',
    'ndx-0dte': 'NDXP', 'ndx': 'NDXP',
    'spy-1dte': 'SPY',  'spy': 'SPY',
    'tsla': 'TSLA',
    'qqq': 'QQQ',
    'nvda': 'NVDA',
  };
  const prefix = prefixMap[profileId];
  if (prefix && prefix !== underlyingSymbol) {
    return `(symbol = '${underlyingSymbol}' OR symbol LIKE '${prefix}%')`;
  }
  return `symbol LIKE '${underlyingSymbol}%'`;
}

/**
 * Get the default parquet root directory path.
 */
export function getParquetRoot(): string {
  return DEFAULT_PARQUET_ROOT;
}
