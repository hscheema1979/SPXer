/**
 * spx-bucket-stats.ts
 *
 * For each 30-min ET bucket across all available SPX dates, compute:
 *   - range:  high − low within the bucket (volatility / max excursion)
 *   - move:   |close − open| within the bucket (net directional move)
 *   - drift:  signed (close − open) (directional bias)
 * Distributions: p10, p25, p50, p75, p90.
 *
 * Use this to size structures realistically — a structure that needs SPX to
 * move 25pts in 30min should only be deployed in buckets where p75 ≥ 25, etc.
 *
 * Usage: npx tsx scripts/diag/spx-bucket-stats.ts
 *
 * Optional flag: --window N    → also report N-minute forward-move stats for
 *                                each bucket open time. e.g. "from 11:00 ET,
 *                                what's the |move| 30/60 min later?". This
 *                                models "entry at bucket open, exit N min later".
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

const TARGET = resolveSymbolTarget(process.argv.concat(['SPX']));
const argv = process.argv.slice(2);
const FORWARD_WINDOWS = (argv.find(a => a.startsWith('--window='))?.split('=')[1] ?? '15,30,60')
  .split(',').map(Number).filter(n => n > 0);

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}

// 30-min buckets from 09:30 to 16:00 ET — 13 windows.
const BUCKET_MIN = 30;
const BUCKET_LABELS = [
  '09:30-10:00', '10:00-10:30', '10:30-11:00', '11:00-11:30',
  '11:30-12:00', '12:00-12:30', '12:30-13:00', '13:00-13:30',
  '13:30-14:00', '14:00-14:30', '14:30-15:00', '15:00-15:30', '15:30-16:00',
];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const dates = listDatesFor(TARGET);
console.log(`Loading ${dates.length} SPX dates …`);

const rangeBuckets: number[][] = BUCKET_LABELS.map(() => []);
const moveBuckets: number[][] = BUCKET_LABELS.map(() => []);
const driftBuckets: number[][] = BUCKET_LABELS.map(() => []);  // signed close-open

// Forward-window |move| from each bucket OPEN time — models "enter at start of
// bucket, where does SPX go in next N minutes". Indexed by bucket × window.
const fwdMoveBuckets: number[][][] = BUCKET_LABELS.map(() => FORWARD_WINDOWS.map(() => []));

let loaded = 0;
for (const date of dates) {
  let day: any;
  try { day = loadDay(TARGET, date, '1m'); } catch { continue; }
  if (!day?.spxBars?.length) continue;
  const bars = day.spxBars as any[];
  const sess = sessOpenTs(date);
  loaded++;

  // Pre-index bars by ts for fast forward-window lookup
  const byTs = new Map<number, any>();
  for (const b of bars) byTs.set(b.ts, b);

  for (let bi = 0; bi < BUCKET_LABELS.length; bi++) {
    const start = sess + bi * BUCKET_MIN * 60;
    const end = start + BUCKET_MIN * 60;
    let hi = -Infinity, lo = Infinity, open: number | null = null, close: number | null = null;
    for (const b of bars) {
      if (b.ts < start || b.ts >= end) continue;
      if (open === null) open = b.open ?? b.close;
      close = b.close;
      if (b.high > hi) hi = b.high;
      if (b.low < lo) lo = b.low;
    }
    if (open === null || close === null || hi === -Infinity) continue;
    rangeBuckets[bi].push(hi - lo);
    moveBuckets[bi].push(Math.abs(close - open));
    driftBuckets[bi].push(close - open);

    // Forward-window |move|: from bucket-open price, look N minutes ahead.
    const openBar = bars.find(b => b.ts === start) || bars.find(b => b.ts > start);
    if (!openBar) continue;
    for (let wi = 0; wi < FORWARD_WINDOWS.length; wi++) {
      const target = openBar.ts + FORWARD_WINDOWS[wi] * 60;
      // Find bar at or before target
      let priceAt: number | null = null;
      for (let i = bars.length - 1; i >= 0; i--) {
        if (bars[i].ts <= target) { priceAt = bars[i].close; break; }
      }
      if (priceAt != null) {
        fwdMoveBuckets[bi][wi].push(Math.abs(priceAt - openBar.open));
      }
    }
  }
}
console.log(`Loaded ${loaded} dates with SPX bars.`);
console.log();

function fmtPad(v: number, w: number): string { return v.toFixed(1).padStart(w); }

// Range / move / drift table
console.log('=== Per-30-min SPX RANGE (high − low, pts) ===');
console.log('Bucket          N      p10    p25    p50    p75    p90');
console.log('-'.repeat(60));
for (let i = 0; i < BUCKET_LABELS.length; i++) {
  const arr = [...rangeBuckets[i]].sort((a, b) => a - b);
  console.log(`${BUCKET_LABELS[i].padEnd(13)} ${String(arr.length).padStart(5)}  ${fmtPad(quantile(arr,0.10),6)} ${fmtPad(quantile(arr,0.25),6)} ${fmtPad(quantile(arr,0.50),6)} ${fmtPad(quantile(arr,0.75),6)} ${fmtPad(quantile(arr,0.90),6)}`);
}

console.log();
console.log('=== Per-30-min SPX |MOVE| (|close − open|, pts) ===');
console.log('Bucket          N      p10    p25    p50    p75    p90');
console.log('-'.repeat(60));
for (let i = 0; i < BUCKET_LABELS.length; i++) {
  const arr = [...moveBuckets[i]].sort((a, b) => a - b);
  console.log(`${BUCKET_LABELS[i].padEnd(13)} ${String(arr.length).padStart(5)}  ${fmtPad(quantile(arr,0.10),6)} ${fmtPad(quantile(arr,0.25),6)} ${fmtPad(quantile(arr,0.50),6)} ${fmtPad(quantile(arr,0.75),6)} ${fmtPad(quantile(arr,0.90),6)}`);
}

console.log();
console.log('=== Per-30-min SPX DRIFT (signed close − open, pts) ===');
console.log('Bucket          N      p10    p25    p50    p75    p90');
console.log('-'.repeat(60));
for (let i = 0; i < BUCKET_LABELS.length; i++) {
  const arr = [...driftBuckets[i]].sort((a, b) => a - b);
  console.log(`${BUCKET_LABELS[i].padEnd(13)} ${String(arr.length).padStart(5)}  ${fmtPad(quantile(arr,0.10),6)} ${fmtPad(quantile(arr,0.25),6)} ${fmtPad(quantile(arr,0.50),6)} ${fmtPad(quantile(arr,0.75),6)} ${fmtPad(quantile(arr,0.90),6)}`);
}

// Forward-window |move| from each bucket open
console.log();
console.log(`=== Forward-window |MOVE| from BUCKET OPEN (entry at bucket start) ===`);
for (let wi = 0; wi < FORWARD_WINDOWS.length; wi++) {
  console.log();
  console.log(`--- ${FORWARD_WINDOWS[wi]}-minute window ---`);
  console.log('Entry bucket    N      p10    p25    p50    p75    p90');
  console.log('-'.repeat(60));
  for (let bi = 0; bi < BUCKET_LABELS.length; bi++) {
    const arr = [...fwdMoveBuckets[bi][wi]].sort((a, b) => a - b);
    const open = BUCKET_LABELS[bi].split('-')[0];
    console.log(`from ${open}      ${String(arr.length).padStart(5)}  ${fmtPad(quantile(arr,0.10),6)} ${fmtPad(quantile(arr,0.25),6)} ${fmtPad(quantile(arr,0.50),6)} ${fmtPad(quantile(arr,0.75),6)} ${fmtPad(quantile(arr,0.90),6)}`);
  }
}
