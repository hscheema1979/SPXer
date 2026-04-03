/**
 * Binary bar cache — serialize/deserialize BarCache to flat files.
 *
 * Format per bar (price-only mode, no indicators):
 *   ts:     uint32 (4 bytes)
 *   open:   float64 (8 bytes)
 *   high:   float64 (8 bytes)
 *   low:    float64 (8 bytes)
 *   close:  float64 (8 bytes)
 *   volume: uint32 (4 bytes)
 *   = 40 bytes per bar
 *
 * SPX bars include indicators (21 float64 = 168 bytes extra = 208 bytes/bar).
 *
 * File layout:
 *   [4B magic "BRCX"] [2B version] [2B flags]
 *   [4B spxBarCount] [spxBars...]
 *   [4B contractCount]
 *   For each contract:
 *     [2B symbolLen] [symbolBytes] [8B strike] [4B barCount] [bars...]
 */

import * as fs from 'fs';
import * as path from 'path';

const MAGIC = 0x58435242; // "BRCX" (little-endian)
const VERSION = 1;
const FLAG_PRICE_ONLY = 0x01;
const FLAG_WITH_INDICATORS = 0x02;

// Indicator columns in fixed order (must match INDICATOR_COLUMNS in machine.ts)
const IND_COLS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

const BYTES_PER_BAR_PRICE = 40;       // 4 + 8*4 + 4
const BYTES_PER_INDICATOR = 8;        // float64
const BYTES_PER_BAR_FULL = BYTES_PER_BAR_PRICE + IND_COLS.length * BYTES_PER_INDICATOR; // 40 + 168 = 208

interface Bar {
  ts: number;
  open: number; high: number; low: number; close: number;
  volume: number;
  indicators: Record<string, number | null>;
}

interface BarCache {
  spxBars: Bar[];
  contractBars: Map<string, Bar[]>;
  contractStrikes: Map<string, number>;
  timestamps: number[];
}

const CACHE_DIR = path.resolve(process.cwd(), 'data/cache');

function getCachePath(date: string, tf: string, priceOnly: boolean): string {
  const suffix = priceOnly ? '.po' : '.full';
  return path.join(CACHE_DIR, `${date}_${tf}${suffix}.brc`);
}

/** Write bar cache to binary file */
export function writeBarCacheFile(
  cache: BarCache, date: string, tf: string, priceOnly: boolean,
): void {
  const filePath = getCachePath(date, tf, priceOnly);
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const barSize = priceOnly ? BYTES_PER_BAR_PRICE : BYTES_PER_BAR_FULL;

  // Calculate total size
  let totalSize = 8; // header
  totalSize += 4 + cache.spxBars.length * BYTES_PER_BAR_FULL; // SPX always full indicators
  totalSize += 4; // contract count

  for (const [symbol, bars] of cache.contractBars) {
    totalSize += 2 + Buffer.byteLength(symbol, 'utf8'); // symbol
    totalSize += 8; // strike
    totalSize += 4 + bars.length * barSize; // bar count + bars
  }

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Header
  buf.writeUInt32LE(MAGIC, offset); offset += 4;
  buf.writeUInt16LE(VERSION, offset); offset += 2;
  buf.writeUInt16LE(priceOnly ? FLAG_PRICE_ONLY : FLAG_WITH_INDICATORS, offset); offset += 2;

  // SPX bars (always with indicators)
  buf.writeUInt32LE(cache.spxBars.length, offset); offset += 4;
  for (const bar of cache.spxBars) {
    buf.writeUInt32LE(bar.ts, offset); offset += 4;
    buf.writeDoubleLE(bar.open, offset); offset += 8;
    buf.writeDoubleLE(bar.high, offset); offset += 8;
    buf.writeDoubleLE(bar.low, offset); offset += 8;
    buf.writeDoubleLE(bar.close, offset); offset += 8;
    buf.writeUInt32LE(bar.volume, offset); offset += 4;
    // Indicators
    for (const col of IND_COLS) {
      buf.writeDoubleLE(bar.indicators[col] ?? NaN, offset); offset += 8;
    }
  }

  // Contract bars
  const contracts = [...cache.contractBars.entries()];
  buf.writeUInt32LE(contracts.length, offset); offset += 4;

  for (const [symbol, bars] of contracts) {
    const symBytes = Buffer.from(symbol, 'utf8');
    buf.writeUInt16LE(symBytes.length, offset); offset += 2;
    symBytes.copy(buf, offset); offset += symBytes.length;

    const strike = cache.contractStrikes.get(symbol) ?? 0;
    buf.writeDoubleLE(strike, offset); offset += 8;

    buf.writeUInt32LE(bars.length, offset); offset += 4;
    for (const bar of bars) {
      buf.writeUInt32LE(bar.ts, offset); offset += 4;
      buf.writeDoubleLE(bar.open, offset); offset += 8;
      buf.writeDoubleLE(bar.high, offset); offset += 8;
      buf.writeDoubleLE(bar.low, offset); offset += 8;
      buf.writeDoubleLE(bar.close, offset); offset += 8;
      buf.writeUInt32LE(bar.volume, offset); offset += 4;
      if (!priceOnly) {
        for (const col of IND_COLS) {
          buf.writeDoubleLE(bar.indicators[col] ?? NaN, offset); offset += 8;
        }
      }
    }
  }

  fs.writeFileSync(filePath, buf);
}

/** Read bar cache from binary file. Returns null if cache doesn't exist. */
export function readBarCacheFile(
  date: string, tf: string, priceOnly: boolean,
): BarCache | null {
  const filePath = getCachePath(date, tf, priceOnly);
  if (!fs.existsSync(filePath)) return null;

  const buf = fs.readFileSync(filePath);
  let offset = 0;

  // Validate header
  const magic = buf.readUInt32LE(offset); offset += 4;
  if (magic !== MAGIC) return null;
  const version = buf.readUInt16LE(offset); offset += 2;
  if (version !== VERSION) return null;
  const flags = buf.readUInt16LE(offset); offset += 2;

  const isPriceOnly = (flags & FLAG_PRICE_ONLY) !== 0;
  const emptyInd: Record<string, number | null> = Object.freeze({});

  // SPX bars (always with indicators)
  const spxCount = buf.readUInt32LE(offset); offset += 4;
  const spxBars: Bar[] = new Array(spxCount);
  for (let i = 0; i < spxCount; i++) {
    const ts = buf.readUInt32LE(offset); offset += 4;
    const open = buf.readDoubleLE(offset); offset += 8;
    const high = buf.readDoubleLE(offset); offset += 8;
    const low = buf.readDoubleLE(offset); offset += 8;
    const close = buf.readDoubleLE(offset); offset += 8;
    const volume = buf.readUInt32LE(offset); offset += 4;
    const indicators: Record<string, number | null> = {};
    for (const col of IND_COLS) {
      const val = buf.readDoubleLE(offset); offset += 8;
      if (!Number.isNaN(val)) indicators[col] = val;
    }
    spxBars[i] = { ts, open, high, low, close, volume, indicators };
  }

  const timestamps = spxBars.map(b => b.ts);

  // Contract bars
  const contractCount = buf.readUInt32LE(offset); offset += 4;
  const contractBars = new Map<string, Bar[]>();
  const contractStrikes = new Map<string, number>();

  for (let c = 0; c < contractCount; c++) {
    const symLen = buf.readUInt16LE(offset); offset += 2;
    const symbol = buf.subarray(offset, offset + symLen).toString('utf8'); offset += symLen;
    const strike = buf.readDoubleLE(offset); offset += 8;

    contractStrikes.set(symbol, strike);

    const barCount = buf.readUInt32LE(offset); offset += 4;
    const bars: Bar[] = new Array(barCount);

    for (let i = 0; i < barCount; i++) {
      const ts = buf.readUInt32LE(offset); offset += 4;
      const open = buf.readDoubleLE(offset); offset += 8;
      const high = buf.readDoubleLE(offset); offset += 8;
      const low = buf.readDoubleLE(offset); offset += 8;
      const close = buf.readDoubleLE(offset); offset += 8;
      const volume = buf.readUInt32LE(offset); offset += 4;

      if (isPriceOnly) {
        bars[i] = { ts, open, high, low, close, volume, indicators: emptyInd };
      } else {
        const indicators: Record<string, number | null> = {};
        for (const col of IND_COLS) {
          const val = buf.readDoubleLE(offset); offset += 8;
          if (!Number.isNaN(val)) indicators[col] = val;
        }
        bars[i] = { ts, open, high, low, close, volume, indicators };
      }
    }

    contractBars.set(symbol, bars);
  }

  return { spxBars, contractBars, contractStrikes, timestamps };
}

/** Check if a cache file exists for the given date/tf/mode */
export function hasCacheFile(date: string, tf: string, priceOnly: boolean): boolean {
  return fs.existsSync(getCachePath(date, tf, priceOnly));
}
