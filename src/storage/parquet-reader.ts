/**
 * parquet-reader.ts — Read replay bars from per-date parquet files via DuckDB.
 *
 * Provides the same data shapes as the SQLite replay_bars queries in
 * machine.ts and replay-routes.ts, but reads from:
 *   data/parquet/bars/{profileId}/{date}.parquet
 *
 * DuckDB reads parquet natively with predicate pushdown — only touches
 * the row groups and columns actually needed.
 *
 * The module holds a singleton DuckDB :memory: database for the process
 * lifetime. First call lazily initializes it (~200ms cold start).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as duckdb from 'duckdb';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');

/** Indicator columns — must match machine.ts INDICATOR_COLUMNS and DENORM_COLS. */
const INDICATOR_COLUMNS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

const INDICATOR_SELECT = INDICATOR_COLUMNS.join(', ');

// ── Types (mirrors machine.ts Bar/BarCache) ──────────────────────────────────

export interface ParquetBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, number | null>;
  spread?: number;
}

export interface ParquetBarCache {
  spxBars: ParquetBar[];
  contractBars: Map<string, ParquetBar[]>;
  contractStrikes: Map<string, number>;
  timestamps: number[];
}

// ── Singleton DuckDB instance ────────────────────────────────────────────────

let duckDb: duckdb.Database | null = null;

function getDb(): duckdb.Database {
  if (!duckDb) {
    duckDb = new duckdb.Database(':memory:');
  }
  return duckDb;
}

/** Helper: run a DuckDB statement (no result). */
function run(db: duckdb.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => err ? reject(err) : resolve());
  });
}

/** Helper: run a DuckDB query, return rows. */
function query(db: duckdb.Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: any[]) => err ? reject(err) : resolve(rows));
  });
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function parquetRoot(): string {
  return process.env.PARQUET_ROOT || DEFAULT_PARQUET_ROOT;
}

function parquetPath(profileId: string, date: string): string {
  return path.join(parquetRoot(), profileId, `${date}.parquet`);
}

/**
 * Check if a parquet file exists for a given profile + date.
 */
export function hasParquetDate(profileId: string, date: string): boolean {
  return fs.existsSync(parquetPath(profileId, date));
}

/**
 * List all dates available in parquet for a profile.
 * Returns sorted YYYY-MM-DD strings.
 */
export function listParquetDates(profileId: string): string[] {
  const dir = path.join(parquetRoot(), profileId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.parquet') && !f.endsWith('.tmp'))
    .map(f => f.replace('.parquet', ''))
    .sort();
}

// ── Coerce DuckDB values to JS numbers ──────────────────────────────────────
// DuckDB returns BigInt for INTEGER columns. SQLite returns JS number.
// Coerce to number for compatibility.

function num(v: any): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'bigint' ? Number(v) : v;
}

function numOrNull(v: any): number | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? Number(v) : v;
}

/** Build indicators object from a row's denormalized columns. */
function rowToIndicators(r: any): Record<string, number | null> {
  const ind: Record<string, number | null> = {};
  for (const col of INDICATOR_COLUMNS) {
    const v = r[col];
    if (v != null) ind[col] = numOrNull(v);
  }
  return ind;
}

// ── Core read functions ──────────────────────────────────────────────────────

/**
 * Load underlying bars from parquet for a single date.
 * Returns the same shape as the SPX query in machine.ts loadBarCache().
 */
export async function loadUnderlyingBars(opts: {
  profileId: string;
  date: string;
  underlyingSymbol: string;
  timeframe: string;
  startTs: number;
  endTs: number;
}): Promise<ParquetBar[]> {
  const fp = parquetPath(opts.profileId, opts.date);
  if (!fs.existsSync(fp)) return [];

  const db = getDb();
  const sql = `
    SELECT ts, open, high, low, close, volume, ${INDICATOR_SELECT}
    FROM read_parquet('${fp}')
    WHERE symbol = '${opts.underlyingSymbol}'
      AND timeframe = '${opts.timeframe}'
      AND ts >= ${opts.startTs} AND ts <= ${opts.endTs}
    ORDER BY ts
  `;

  const rows = await query(db, sql);
  return rows.map((r: any) => ({
    ts: num(r.ts),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
    indicators: rowToIndicators(r),
  }));
}

/**
 * Load contract bars from parquet for a single date.
 * Uses the same symbol-range query pattern as machine.ts.
 * Returns contractBars map and contractStrikes map.
 */
export async function loadContractBars(opts: {
  profileId: string;
  date: string;
  symbolRange: { lo: string; hi: string };
  timeframe: string;
  startTs: number;
  endTs: number;
  skipIndicators?: boolean;
}): Promise<{
  contractBars: Map<string, ParquetBar[]>;
  contractStrikes: Map<string, number>;
}> {
  const fp = parquetPath(opts.profileId, opts.date);
  if (!fs.existsSync(fp)) return { contractBars: new Map(), contractStrikes: new Map() };

  const db = getDb();
  const indCols = opts.skipIndicators ? '' : `, ${INDICATOR_SELECT}`;
  const sql = `
    SELECT symbol, ts, open, high, low, close, volume, spread,
           CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike
           ${indCols}
    FROM read_parquet('${fp}')
    WHERE symbol >= '${opts.symbolRange.lo}'
      AND symbol < '${opts.symbolRange.hi}'
      AND timeframe = '${opts.timeframe}'
      AND ts >= ${opts.startTs} AND ts <= ${opts.endTs}
    ORDER BY symbol, ts
  `;

  const rows = await query(db, sql);
  const EMPTY_INDICATORS: Record<string, number | null> = Object.freeze({});
  const contractBars = new Map<string, ParquetBar[]>();
  const contractStrikes = new Map<string, number>();

  for (const r of rows) {
    const sym = r.symbol as string;
    if (!contractBars.has(sym)) contractBars.set(sym, []);
    const bar: ParquetBar = {
      ts: num(r.ts),
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      volume: num(r.volume),
      indicators: opts.skipIndicators ? EMPTY_INDICATORS : rowToIndicators(r),
    };
    const spread = numOrNull(r.spread);
    if (spread != null && !Number.isNaN(spread)) bar.spread = spread;
    contractBars.get(sym)!.push(bar);
    if (!contractStrikes.has(sym)) contractStrikes.set(sym, num(r.strike));
  }

  return { contractBars, contractStrikes };
}

/**
 * Load a full BarCache from parquet — drop-in replacement for the
 * SQLite path in machine.ts loadBarCache().
 */
export async function loadBarCacheFromParquet(opts: {
  profileId: string;
  date: string;
  underlyingSymbol: string;
  symbolRange: { lo: string; hi: string };
  timeframe: string;
  startTs: number;
  endTs: number;
  skipContractIndicators?: boolean;
}): Promise<ParquetBarCache> {
  const [spxBars, { contractBars, contractStrikes }] = await Promise.all([
    loadUnderlyingBars({
      profileId: opts.profileId,
      date: opts.date,
      underlyingSymbol: opts.underlyingSymbol,
      timeframe: opts.timeframe,
      startTs: opts.startTs,
      endTs: opts.endTs,
    }),
    loadContractBars({
      profileId: opts.profileId,
      date: opts.date,
      symbolRange: opts.symbolRange,
      timeframe: opts.timeframe,
      startTs: opts.startTs,
      endTs: opts.endTs,
      skipIndicators: opts.skipContractIndicators,
    }),
  ]);

  const timestamps = spxBars.map(b => b.ts);
  return { spxBars, contractBars, contractStrikes, timestamps };
}

/**
 * Load bars for a specific symbol from parquet.
 * Used by replay-routes.ts /api/bars endpoint.
 */
export async function loadBarsFromParquet(opts: {
  profileId: string;
  date: string;
  symbol: string;
  timeframe: string;
  startTs?: number;
  endTs?: number;
  limit?: number;
}): Promise<any[]> {
  const fp = parquetPath(opts.profileId, opts.date);
  if (!fs.existsSync(fp)) return [];

  const db = getDb();
  const conditions = [
    `symbol = '${opts.symbol}'`,
    `timeframe = '${opts.timeframe}'`,
  ];
  if (opts.startTs != null) conditions.push(`ts >= ${opts.startTs}`);
  if (opts.endTs != null) conditions.push(`ts <= ${opts.endTs}`);
  const where = conditions.join(' AND ');
  const limitClause = opts.limit ? `LIMIT ${opts.limit}` : '';

  const sql = `
    SELECT ts, open, high, low, close, volume, synthetic, gap_type,
           indicators, source, spread, ${INDICATOR_SELECT}
    FROM read_parquet('${fp}')
    WHERE ${where}
    ORDER BY ts
    ${limitClause}
  `;

  const rows = await query(db, sql);
  return rows.map((r: any) => ({
    ts: num(r.ts),
    open: num(r.open),
    high: num(r.high),
    low: num(r.low),
    close: num(r.close),
    volume: num(r.volume),
    synthetic: num(r.synthetic),
    gap_type: r.gap_type,
    indicators: r.indicators,
    source: r.source,
    spread: numOrNull(r.spread),
    ...rowToIndicators(r),
  }));
}

/**
 * List distinct symbols in a parquet file for a date.
 * Used by replay-routes /api/contracts endpoint.
 */
export async function listSymbolsFromParquet(
  profileId: string,
  date: string,
): Promise<string[]> {
  const fp = parquetPath(profileId, date);
  if (!fs.existsSync(fp)) return [];

  const db = getDb();
  const rows = await query(db, `
    SELECT DISTINCT symbol FROM read_parquet('${fp}')
    WHERE timeframe = '1m'
    ORDER BY symbol
  `);
  return rows.map((r: any) => r.symbol as string);
}

/**
 * Get a single bar's close price from parquet — used by position price lookups.
 */
export async function getClosePriceFromParquet(opts: {
  profileId: string;
  date: string;
  symbolPrefix: string;
  ts: number;
}): Promise<number | null> {
  const fp = parquetPath(opts.profileId, opts.date);
  if (!fs.existsSync(fp)) return null;

  const db = getDb();
  const rows = await query(db, `
    SELECT close FROM read_parquet('${fp}')
    WHERE symbol LIKE '${opts.symbolPrefix}%'
      AND timeframe = '1m'
      AND ts <= ${opts.ts}
    ORDER BY ts DESC
    LIMIT 1
  `);
  return rows.length > 0 ? num(rows[0].close) : null;
}

/**
 * Count rows in a parquet file. Used for verification.
 */
export async function countParquetRows(
  profileId: string,
  date: string,
): Promise<number> {
  const fp = parquetPath(profileId, date);
  if (!fs.existsSync(fp)) return 0;

  const db = getDb();
  const [{ cnt }] = await query(db, `SELECT COUNT(*) as cnt FROM read_parquet('${fp}')`);
  return Number(cnt);
}

/**
 * Shut down the DuckDB singleton. Call on process exit.
 */
export function closeParquetReader(): void {
  if (duckDb) {
    duckDb.close();
    duckDb = null;
  }
}

/**
 * Map an underlying symbol to its profile id.
 * Used when the caller only has the symbol (e.g. 'SPX') and needs
 * to find the right parquet directory.
 */
export function symbolToProfileId(underlyingSymbol: string): string {
  const map: Record<string, string> = {
    SPX: 'spx',
    NDX: 'ndx',
    SPY: 'spy',
    QQQ: 'qqq',
    TSLA: 'tsla',
    NVDA: 'nvda',
  };
  return map[underlyingSymbol] || underlyingSymbol.toLowerCase();
}

/**
 * Map any symbol (underlying or option contract) to its parquet profile id.
 * e.g. 'SPX' → 'spx', 'SPXW260320C06560000' → 'spx', 'NDXP260320P21000000' → 'ndx'
 */
export function anySymbolToProfileId(symbol: string): string {
  if (symbol.startsWith('SPXW') || symbol === 'SPX') return 'spx';
  if (symbol.startsWith('NDXP') || symbol === 'NDX') return 'ndx';
  if (symbol.startsWith('SPY')) return 'spy';
  if (symbol.startsWith('QQQ')) return 'qqq';
  if (symbol.startsWith('TSLA')) return 'tsla';
  if (symbol.startsWith('NVDA')) return 'nvda';
  return symbol.toLowerCase();
}
