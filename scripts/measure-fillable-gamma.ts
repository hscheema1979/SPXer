/**
 * Measure fillable-$ exposure per strike offset across ALL cached days.
 *
 * Reads .po.brc (price-only binary bar cache) files directly.
 * For each 1-minute bar between 10:00-15:30 ET, computes each contract's
 * offset from SPX spot (rounded to $5), then aggregates:
 *   - sample count (bar-minutes observed)
 *   - median 1m volume
 *   - median close price
 *   - fillable qty at 5% participation
 *   - fillable $ notional = qty * price * 100
 *
 * Output: CSV + summary table grouped by (option_type, strike_offset_usd).
 *
 * Usage: npx tsx scripts/measure-fillable-gamma.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.resolve(process.cwd(), 'data/cache');
const PARTICIPATION_RATE = 0.05;
const WINDOW_START_ET = 10 * 60;      // 10:00 AM ET in minutes-of-day
const WINDOW_END_ET = 15 * 60 + 30;   // 3:30 PM ET

const MAGIC = 0x58435242;
const IND_COLS_COUNT = 21;
const BYTES_PER_BAR_PRICE = 40;
const BYTES_PER_BAR_FULL = 40 + IND_COLS_COUNT * 8;

interface Bar {
  ts: number;
  close: number;
  volume: number;
}
interface Parsed {
  spxByTs: Map<number, number>;
  contracts: { symbol: string; strike: number; type: 'C' | 'P'; bars: Bar[] }[];
}

function parseCache(filePath: string): Parsed | null {
  const buf = fs.readFileSync(filePath);
  let o = 0;
  if (buf.readUInt32LE(o) !== MAGIC) return null;
  o += 4;
  const version = buf.readUInt16LE(o); o += 2;
  if (version !== 1 && version !== 2) return null;
  const hasSpread = version >= 2;
  const flags = buf.readUInt16LE(o); o += 2;
  const isPriceOnly = (flags & 0x01) !== 0;

  const spxCount = buf.readUInt32LE(o); o += 4;
  const spxByTs = new Map<number, number>();
  for (let i = 0; i < spxCount; i++) {
    const ts = buf.readUInt32LE(o); o += 4;
    o += 8 * 3;                         // open, high, low
    const close = buf.readDoubleLE(o); o += 8;
    o += 4;                             // volume
    o += IND_COLS_COUNT * 8;            // SPX always full indicators
    spxByTs.set(ts, close);
  }

  const contractCount = buf.readUInt32LE(o); o += 4;
  const contracts: Parsed['contracts'] = [];
  const barSize = isPriceOnly ? BYTES_PER_BAR_PRICE : BYTES_PER_BAR_FULL;

  for (let c = 0; c < contractCount; c++) {
    const symLen = buf.readUInt16LE(o); o += 2;
    const symbol = buf.subarray(o, o + symLen).toString('utf8'); o += symLen;
    const strike = buf.readDoubleLE(o); o += 8;
    const type = symbol.charAt(10) as 'C' | 'P';

    const barCount = buf.readUInt32LE(o); o += 4;
    const bars: Bar[] = new Array(barCount);
    for (let i = 0; i < barCount; i++) {
      const ts = buf.readUInt32LE(o); o += 4;
      o += 8 * 3;                       // open, high, low
      const close = buf.readDoubleLE(o); o += 8;
      const volume = buf.readUInt32LE(o); o += 4;
      if (!isPriceOnly) o += IND_COLS_COUNT * 8;
      if (hasSpread) o += 8;
      bars[i] = { ts, close, volume };
    }
    contracts.push({ symbol, strike, type, bars });
  }
  return { spxByTs, contracts };
}

/** Get ET minute-of-day for a Unix timestamp */
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function etMinuteOfDay(tsSec: number): number {
  const parts = ET_FMT.formatToParts(new Date(tsSec * 1000));
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  let h = Number(p.hour);
  if (h === 24) h = 0; // Intl sometimes emits "24" at midnight
  return h * 60 + Number(p.minute);
}

/**
 * Bucket key: signed offset from ATM in $5 strike units, per option type.
 *   Calls: positive = OTM (strike > spot), negative = ITM
 *   Puts:  positive = OTM (strike < spot), negative = ITM
 *   0 = ATM
 */
function offsetBucket(type: 'C' | 'P', strike: number, spot: number): number {
  const raw = type === 'C' ? strike - spot : spot - strike;
  return Math.round(raw / 5) * 5;
}

// ───── main ─────
const files = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith('_1m.po.brc'))
  .sort();

console.error(`[measure] found ${files.length} cache files`);

const RESERVOIR_MAX = 5000;
interface Bucket {
  volumes: number[];
  prices: number[];
  count: number;
}
const buckets = new Map<string, Bucket>();
function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) { b = { volumes: [], prices: [], count: 0 }; buckets.set(key, b); }
  return b;
}

let totalSamples = 0;
let daysProcessed = 0;
let daysSkipped = 0;

for (const file of files) {
  const filePath = path.join(CACHE_DIR, file);
  let parsed: Parsed | null;
  try {
    parsed = parseCache(filePath);
  } catch (err) {
    console.error(`[measure] parse failed for ${file}: ${(err as Error).message}`);
    daysSkipped++;
    continue;
  }
  if (!parsed || parsed.spxByTs.size === 0) { daysSkipped++; continue; }

  let daySamples = 0;
  for (const ct of parsed.contracts) {
    for (const bar of ct.bars) {
      if (bar.volume <= 0) continue;
      const spot = parsed.spxByTs.get(bar.ts);
      if (spot === undefined) continue;
      const mod = etMinuteOfDay(bar.ts);
      if (mod < WINDOW_START_ET || mod > WINDOW_END_ET) continue;

      const off = offsetBucket(ct.type, ct.strike, spot);
      if (off < -50 || off > 50) continue;

      const key = `${ct.type}|${off}`;
      const b = getBucket(key);
      b.count++;
      if (b.volumes.length < RESERVOIR_MAX) {
        b.volumes.push(bar.volume);
        b.prices.push(bar.close);
      } else {
        const idx = Math.floor(Math.random() * b.count);
        if (idx < RESERVOIR_MAX) {
          b.volumes[idx] = bar.volume;
          b.prices[idx] = bar.close;
        }
      }
      daySamples++;
    }
  }
  totalSamples += daySamples;
  daysProcessed++;
  if (daysProcessed % 25 === 0) {
    console.error(`[measure] processed ${daysProcessed}/${files.length} days, ${totalSamples.toLocaleString()} samples`);
  }
}

console.error(`[measure] done: ${daysProcessed} days processed, ${daysSkipped} skipped, ${totalSamples.toLocaleString()} samples total`);

// ───── summary ─────
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

interface Row {
  type: 'C' | 'P';
  offset: number;
  label: string;
  samples: number;
  medVol: number;
  medPrice: number;
  p25Vol: number;
  p75Vol: number;
  fillableQty: number;
  fillable$: number;
}
const rows: Row[] = [];
for (const [key, b] of buckets) {
  const [type, offStr] = key.split('|');
  const offset = Number(offStr);
  const medVol = pct(b.volumes, 0.5);
  const medPrice = pct(b.prices, 0.5);
  const fillableQty = Math.floor(medVol * PARTICIPATION_RATE);
  rows.push({
    type: type as 'C' | 'P',
    offset,
    label: offset === 0 ? 'ATM' : offset > 0 ? `OTM${offset}` : `ITM${-offset}`,
    samples: b.count,
    medVol,
    medPrice,
    p25Vol: pct(b.volumes, 0.25),
    p75Vol: pct(b.volumes, 0.75),
    fillableQty,
    fillable$: fillableQty * medPrice * 100,
  });
}
rows.sort((a, b) => a.type.localeCompare(b.type) || a.offset - b.offset);

console.log(`\n# Fillable-$ per strike offset — ${daysProcessed} days, 10:00–15:30 ET, 5% participation\n`);
console.log(`| Type | Offset | Label | Samples | Med 1m Vol | Med Price | Fillable Qty | Fillable $ |`);
console.log(`|------|-------:|-------|--------:|-----------:|----------:|-------------:|-----------:|`);
for (const r of rows) {
  console.log(`| ${r.type} | ${r.offset >= 0 ? '+' : ''}${r.offset} | ${r.label} | ${r.samples.toLocaleString()} | ${r.medVol.toLocaleString()} | $${r.medPrice.toFixed(2)} | ${r.fillableQty} | $${Math.round(r.fillable$).toLocaleString()} |`);
}

const csvPath = path.resolve(process.cwd(), 'data/fillable-gamma.csv');
const csv = [
  'type,offset,label,samples,med_volume,med_price,p25_volume,p75_volume,fillable_qty,fillable_dollars',
  ...rows.map(r => `${r.type},${r.offset},${r.label},${r.samples},${r.medVol},${r.medPrice.toFixed(4)},${r.p25Vol},${r.p75Vol},${r.fillableQty},${r.fillable$.toFixed(2)}`),
].join('\n');
fs.writeFileSync(csvPath, csv);
console.error(`[measure] wrote ${csvPath}`);
