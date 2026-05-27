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

// In-memory LRU cache: { date -> { symbol -> Bar[] } }
const cache = new Map<string, Map<string, Bar[]>>();
const maxCacheSize = 12; // roughly one trading week

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
 * Parse a gunzipped Polygon options day-file CSV into per-symbol RTH bars.
 * @param csv  decompressed CSV text (header row + data rows)
 * @param date 'YYYY-MM-DD' (for RTH window)
 * @param symbols OCC symbols WITHOUT the 'O:' prefix to keep
 * @returns Map of symbol -> RTH bars sorted ascending by ts
 *
 * CSV columns: ticker,volume,open,close,high,low,window_start(ns),transactions
 */
export function parseDayCsv(csv: string, date: string, symbols: string[]): Map<string, Bar[]> {
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

    if (!withinRth(ts, date)) continue;

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
  // Check cache
  if (cache.has(date)) {
    const dayCache = cache.get(date)!;
    const missing = symbols.filter(s => !dayCache.has(s));
    if (missing.length === 0) {
      // All symbols cached
      const result = new Map<string, Bar[]>();
      for (const s of symbols) {
        result.set(s, dayCache.get(s)!);
      }
      return result;
    }
  }

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

    const dayCache = parseDayCsv(csv, date, symbols);

    // Cache the day
    cache.set(date, dayCache);
    if (cache.size > maxCacheSize) {
      // Evict oldest (first insert)
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }

    // Return requested symbols (some may be empty if no prints)
    const result = new Map<string, Bar[]>();
    for (const s of symbols) {
      result.set(s, dayCache.get(s) || []);
    }
    return result;
  } catch (e) {
    console.error(`Failed to download ${date} from S3:`, (e as any).message);
    const result = new Map<string, Bar[]>();
    for (const s of symbols) {
      result.set(s, []);
    }
    return result;
  }
}
