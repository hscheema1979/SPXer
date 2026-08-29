/**
 * flat-file-reader.ts
 *
 * Downloads Polygon S3 flat files for options minute aggregates.
 * Filters to specific OCC symbols, converts nanosecond timestamps to seconds,
 * applies RTH filter, and caches recent day-files in memory to avoid re-downloads.
 *
 * Pure helpers (parseDayCsv, isDST, sessOpenTs, nsToSec, withinRth, s3KeyForDate)
 * are exported separately so they can be unit-tested without touching S3.
 */

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';

export interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Lazily construct the S3 client on first use. Module imports are hoisted above
// the dotenv.config() call in the entry scripts, so reading credentials at
// module-load time gets empty env. Building the client on first getOptionsForDay
// call ensures dotenv has populated process.env first.
let _s3: S3Client | null = null;
function getS3(): S3Client {
  if (_s3) return _s3;
  _s3 = new S3Client({
    endpoint: process.env.POLYGON_S3_ENDPOINT,
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.POLYGON_S3_ACCESS_KEY || '',
      secretAccessKey: process.env.POLYGON_S3_SECRET_KEY || '',
    },
    forcePathStyle: true,
  });
  return _s3;
}

function getBucket(): string {
  return process.env.POLYGON_S3_BUCKET || 'flatfiles';
}

// In-memory LRU cache: { `${date}|${prefix}` -> { symbol -> Bar[] } }
const cache = new Map<string, Map<string, Bar[]>>();
const maxCacheSize = 12; // roughly one trading week

// ── Persistent on-disk day cache ────────────────────────────────────────────
// Download + extract each (prefix, date) flat file ONCE, store a compact gzip
// locally. Every DTE/profile/run then reads the same local file — no repeat S3.
// Format: gzipped JSON { [symbol]: [[ts,o,h,l,c,v], ...] } (tuples = compact).
function diskCacheRoot(): string {
  // Read per-call so tests (and FLATFILE_CACHE_DIR overrides) take effect
  // regardless of import order.
  return process.env.FLATFILE_CACHE_DIR || path.resolve(__dirname, '../../data/flatfile-cache');
}

function diskCachePath(date: string, prefix: string): string {
  const [year, month] = date.split('-');
  return path.join(diskCacheRoot(), prefix, year, month, `${date}.json.gz`);
}

/** Read a (prefix,date) from the on-disk cache. null if not present. */
export function readDiskCache(date: string, prefix: string): Map<string, Bar[]> | null {
  const fp = diskCachePath(date, prefix);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(fp)).toString('utf-8');
    const obj: Record<string, number[][]> = JSON.parse(raw);
    const m = new Map<string, Bar[]>();
    for (const [sym, rows] of Object.entries(obj)) {
      m.set(sym, rows.map(r => ({ ts: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] })));
    }
    return m;
  } catch { return null; }
}

/** Write a parsed (prefix,date) day to the on-disk cache (compact tuples). */
export function writeDiskCache(date: string, prefix: string, day: Map<string, Bar[]>): void {
  const fp = diskCachePath(date, prefix);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const obj: Record<string, number[][]> = {};
  for (const [sym, bars] of day) {
    obj[sym] = bars.map(b => [b.ts, b.open, b.high, b.low, b.close, b.volume]);
  }
  fs.writeFileSync(fp, zlib.gzipSync(Buffer.from(JSON.stringify(obj))));
}

// ── Pure helpers (no I/O — unit-testable) ──────────────────────────────────────

/** S3 object key for a given trading date's options minute aggregates. */
export function s3KeyForDate(date: string): string {
  const [year, month] = date.split('-');
  return `us_options_opra/minute_aggs_v1/${year}/${month}/${date}.csv.gz`;
}

/** Convert a nanosecond window_start value to integer Unix seconds. */
export function nsToSec(windowStartNs: bigint): number {
  return Number(windowStartNs / BigInt(1_000_000_000));
}

/**
 * Is the given date in DST (EDT)?
 * EDT runs from the 2nd Sunday of March through the 1st Sunday of November.
 */
export function isDST(date: string): boolean {
  const dt = new Date(`${date}T12:00:00Z`);
  const year = dt.getUTCFullYear();
  const month = dt.getUTCMonth() + 1;
  const day = dt.getUTCDate();

  // March: EDT starts 2nd Sunday.
  // daysUntilSunday = days from the 1st to the first Sunday (0 if the 1st IS Sunday).
  if (month === 3) {
    const dow1 = new Date(Date.UTC(year, 2, 1)).getUTCDay();
    const daysUntilSunday = (7 - dow1) % 7;
    const secondSunday = 1 + daysUntilSunday + 7;
    return day >= secondSunday;
  }
  // November: EST starts 1st Sunday.
  if (month === 11) {
    const dow1 = new Date(Date.UTC(year, 10, 1)).getUTCDay();
    const daysUntilSunday = (7 - dow1) % 7;
    const firstSundayDate = 1 + daysUntilSunday;
    return day < firstSundayDate;
  }
  // April-October: EDT
  if (month >= 4 && month <= 10) return true;
  // December-February: EST
  return false;
}

/** Unix seconds for 09:30 ET on a given date (DST-aware). */
export function sessOpenTs(date: string): number {
  const dt = new Date(`${date}T09:30:00Z`);
  const offset = isDST(date) ? 4 * 3600 : 5 * 3600; // EDT or EST
  return Math.floor(dt.getTime() / 1000) + offset;
}

/**
 * Is a timestamp within the RTH window for the given date?
 * Window: 09:30 ET (session open) through 15:31 ET (close + 1 min buffer).
 */
export function withinRth(ts: number, date: string): boolean {
  const open = sessOpenTs(date);
  const close = open + 6 * 3600 + 60; // 6h1m = 15:31 ET
  return ts >= open && ts <= close;
}

/**
 * Parse a gunzipped Polygon options day-file CSV into per-symbol bars.
 *
 * Collects the FULL day's bars with NO time-of-day filter — pre-market, RTH,
 * and after-hours all included. The 15:30 trade cutoff and 15:45 settle are
 * STRATEGY rules applied by the sweep engine, not the data layer; truncating
 * here would discard the real session-close (16:00 ET) prints a multi-day
 * position needs to mark/settle against. (withinRth/sessOpenTs are still
 * exported for callers that want an RTH view.)
 *
 * @param csv  decompressed CSV text (header row + data rows)
 * @param symbols OCC symbols WITHOUT the 'O:' prefix to keep
 * @returns Map of symbol -> bars sorted ascending by ts
 *
 * CSV columns: ticker,volume,open,close,high,low,window_start(ns),transactions
 */
export function parseDayCsv(csv: string, symbols: string[]): Map<string, Bar[]> {
  const dayCache = new Map<string, Bar[]>();
  const symbolSet = new Set(symbols);
  const lines = csv.split('\n');

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 8) continue;

    const ticker = parts[0]; // e.g. 'O:NDXP260112P19000000'
    const symbolKey = ticker.startsWith('O:') ? ticker.slice(2) : ticker;

    if (!symbolSet.has(symbolKey)) continue;

    const volume = parseInt(parts[1], 10) || 0;
    const open = parseFloat(parts[2]);
    const close = parseFloat(parts[3]);
    const high = parseFloat(parts[4]);
    const low = parseFloat(parts[5]);
    const ts = nsToSec(BigInt(parts[6])); // ns to seconds

    const bar: Bar = { ts, open, high, low, close, volume };
    if (!dayCache.has(symbolKey)) {
      dayCache.set(symbolKey, []);
    }
    dayCache.get(symbolKey)!.push(bar);
  }

  // Sort bars per symbol by timestamp
  for (const bars of dayCache.values()) {
    bars.sort((a, b) => a.ts - b.ts);
  }

  return dayCache;
}

/**
 * The OCC root of a symbol = everything before the 6-digit YYMMDD expiry.
 * 'NDXP250519P20000000' -> 'NDXP'. Used to cache a whole product's day at once
 * so any contract of that product is served without re-downloading.
 */
export function occRoot(symbol: string): string {
  const m = /^([A-Z]+)\d{6}[CP]\d{8}$/.exec(symbol);
  return m ? m[1] : symbol;
}

/**
 * Parse a day-file CSV keeping EVERY contract whose OCC root matches `prefix`
 * (e.g. 'NDXP'). Full-day, no time filter (see parseDayCsv). This lets
 * getOptionsForDay cache an entire product's day from a single download, so
 * subsequent requests for any other strike/expiry of that product on the same
 * date are served from memory — the fix for the re-download-per-symbol bug.
 */
export function parseDayCsvByPrefix(csv: string, prefix: string): Map<string, Bar[]> {
  const dayCache = new Map<string, Bar[]>();
  const lines = csv.split('\n');
  const pfx = 'O:' + prefix;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    // Cheap prefix gate before splitting (the CSV has millions of rows).
    if (!line.startsWith(pfx) && !line.startsWith(prefix)) continue;

    const parts = line.trim().split(',');
    if (parts.length < 8) continue;

    const ticker = parts[0];
    const symbolKey = ticker.startsWith('O:') ? ticker.slice(2) : ticker;
    // Confirm the root matches exactly (prefix gate above can over-match, e.g.
    // 'NDX' would catch 'NDXP'; occRoot disambiguates).
    if (occRoot(symbolKey) !== prefix) continue;

    const volume = parseInt(parts[1], 10) || 0;
    const open = parseFloat(parts[2]);
    const close = parseFloat(parts[3]);
    const high = parseFloat(parts[4]);
    const low = parseFloat(parts[5]);
    const ts = nsToSec(BigInt(parts[6]));

    const bar: Bar = { ts, open, high, low, close, volume };
    if (!dayCache.has(symbolKey)) dayCache.set(symbolKey, []);
    dayCache.get(symbolKey)!.push(bar);
  }

  for (const bars of dayCache.values()) bars.sort((a, b) => a.ts - b.ts);
  return dayCache;
}

// ── S3 download + cache ─────────────────────────────────────────────────────────

/**
 * Get 1m RTH bars for given OCC symbols on a single trading day.
 * @param date 'YYYY-MM-DD'
 * @param symbols OCC symbols without 'O:' prefix
 * @returns Map of symbol -> RTH bars sorted by ts
 */
export async function getOptionsForDay(
  date: string,
  symbols: string[]
): Promise<Map<string, Bar[]>> {
  if (symbols.length === 0) return new Map();

  // All requested symbols should share one OCC root (a sweep's legs are the
  // same product). Cache the ENTIRE product-day from one download so any
  // strike/expiry of that product is served from memory thereafter.
  const prefix = occRoot(symbols[0]);
  const cacheKey = `${date}|${prefix}`;

  const serve = (dayCache: Map<string, Bar[]>): Map<string, Bar[]> => {
    const result = new Map<string, Bar[]>();
    for (const s of symbols) result.set(s, dayCache.get(s) || []);
    return result;
  };

  const remember = (dayCache: Map<string, Bar[]>) => {
    cache.set(cacheKey, dayCache);
    if (cache.size > maxCacheSize) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  };

  // 1) In-memory hit.
  if (cache.has(cacheKey)) return serve(cache.get(cacheKey)!);

  // 2) On-disk hit — the (prefix,date) was preprocessed in a prior run/profile.
  //    No S3. Promote into memory for this process.
  const fromDisk = readDiskCache(date, prefix);
  if (fromDisk) { remember(fromDisk); return serve(fromDisk); }

  // 3) Cold: download from S3, parse the full product-day, persist to disk +
  //    memory so every later DTE/profile/run reuses it.
  const key = s3KeyForDate(date);

  try {
    const cmd = new GetObjectCommand({ Bucket: getBucket(), Key: key });
    const response = await getS3().send(cmd);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as any) {
      chunks.push(chunk);
    }
    const compressed = Buffer.concat(chunks);
    const csv = zlib.gunzipSync(compressed).toString('utf-8');

    // Parse EVERY contract of this product for the day (one download serves all
    // legs across all trades AND all DTEs on this date).
    const dayCache = parseDayCsvByPrefix(csv, prefix);
    try { writeDiskCache(date, prefix, dayCache); } catch (e) { console.error(`[disk-cache] write failed ${date}/${prefix}: ${(e as any).message}`); }
    remember(dayCache);

    return serve(dayCache);
  } catch (e) {
    console.error(`Failed to download ${date} from S3:`, (e as any).message);
    const result = new Map<string, Bar[]>();
    for (const s of symbols) {
      result.set(s, []);
    }
    return result;
  }
}
