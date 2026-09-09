/**
 * gap-entry-time-study.ts — Does waiting to enter tighten the condor boundary?
 *
 * For each day, take the price at several ET entry times and measure the
 * REMAINING move to the 16:00 close: |close - p_entry|/p_entry. A condor entered
 * at time t with shorts at ±X% wins (held to European cash settle) iff the close
 * lands within ±X% of p_entry. Smaller remaining move ⇒ tighter tradable boundary.
 *
 * Uses 1m parquet (≈1yr). Reports per entry time: median/mean |remaining move|,
 * and within-±band capture. Compare to 09:30 open entry.
 *
 * Usage: npx tsx scripts/diag/gap-entry-time-study.ts [--profiles spx,ndx]
 */
import fs from 'fs';
import path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
function arg(name: string, def: string): string { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def; }
const PROFILES = arg('profiles', 'spx,ndx').split(',').map(s => s.trim()).filter(Boolean);

// ET entry minutes-of-day to test (close uses last RTH bar ~16:00)
const ENTRY_TIMES: [string, number][] = [['09:30 open', 570], ['10:00', 600], ['11:00', 660], ['12:00', 720], ['13:00', 780], ['14:00', 840], ['14:30', 870]];
const BANDS = [0.25, 0.5, 1.0];

interface Bar { ts: number; open: number; close: number }
function etMin(tsSec: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsSec * 1000));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60 + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function loadDay(profileId: string, date: string): Map<number, Bar> {
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const cache = loadBarCacheFromParquetSync({ profileId, date, underlyingSymbol: profileId.toUpperCase(), symbolRange: { lo: '￿', hi: '￿' }, timeframe: '1m', startTs: dayStart, endTs: dayStart + 86400 - 1, skipContractIndicators: true }) as any;
  const m = new Map<number, Bar>();
  for (const b of (cache?.spxBars ?? [])) { const mm = etMin(b.ts); if (mm >= 570 && mm <= 959) m.set(mm, { ts: b.ts, open: b.open, close: b.close }); }
  return m;
}
function priceAt(day: Map<number, Bar>, minute: number): number | null {
  // entry uses the bar's OPEN at that minute (09:30 uses the session open)
  const b = day.get(minute); if (b) return b.open;
  // fall back to nearest prior bar's close within 5 min
  for (let k = 1; k <= 5; k++) { const p = day.get(minute - k); if (p) return p.close; }
  return null;
}
function closeOf(day: Map<number, Bar>): number | null {
  for (let mm = 959; mm >= 570; mm--) { const b = day.get(mm); if (b) return b.close; }
  return null;
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function run(profileId: string) {
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) { console.error(`! no parquet dir ${profileId}`); return; }
  const dates = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f)).map(f => f.slice(0, 10)).sort();
  // per-entry-time arrays of |remaining move %|
  const moves = new Map<number, number[]>(); for (const [, m] of ENTRY_TIMES) moves.set(m, []);
  let nDays = 0;
  for (const date of dates) {
    const day = loadDay(profileId, date); const close = closeOf(day);
    if (close == null || day.size < 100) continue; nDays++;
    for (const [, minute] of ENTRY_TIMES) {
      const p = priceAt(day, minute); if (p == null) continue;
      moves.get(minute)!.push((close - p) / p * 100);
    }
  }
  console.log(`\n${'='.repeat(108)}\n${profileId.toUpperCase()} — remaining move to 16:00 close by ENTRY TIME (${nDays} days). Tighter ⇒ closer/safer condor.\n${'='.repeat(108)}`);
  console.log('  entry        n   med|rem|  mean|rem|   within ±0.25%  ±0.5%   ±1%    drift');
  for (const [label, minute] of ENTRY_TIMES) {
    const arr = moves.get(minute)!; const n = arr.length; if (n < 10) { console.log(`  ${label.padEnd(11)} n=${n} (few)`); continue; }
    const abs = arr.map(Math.abs);
    const within = BANDS.map(b => arr.filter(x => Math.abs(x) <= b).length / n * 100);
    console.log(
      `  ${label.padEnd(11)} ${String(n).padStart(3)}   ${median(abs).toFixed(2)}%    ${mean(abs).toFixed(2)}%       ` +
      `${within[0].toFixed(0).padStart(3)}%        ${within[1].toFixed(0).padStart(3)}%   ${within[2].toFixed(0).padStart(3)}%   ${(mean(arr) >= 0 ? '+' : '') + mean(arr).toFixed(3)}%`);
  }
}
for (const p of PROFILES) run(p);
console.log('\nNote: ~1yr 1m parquet. "within ±X%" = condor win rate (held to close) with shorts ±X% from the entry-time price.');
