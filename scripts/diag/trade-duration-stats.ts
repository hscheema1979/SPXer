/**
 * trade-duration-stats.ts
 *
 * Reads emitted per-trade JSON from iron-sweep and reports time-to-TP
 * distributions per variant, also bucketed by entry time-of-day.
 *
 * Question: "If a trade is going to TP, how long does it take?" — across
 * different TP%s and different body offsets, and across different intra-day
 * times (which proxy for SPX move regimes).
 *
 * Usage:
 *   npx tsx scripts/diag/trade-duration-stats.ts [emit-dir]
 */
import * as fs from 'fs';
import * as path from 'path';

const DIR = process.argv[2] || path.join(process.cwd(), 'scripts/autoresearch/output/iron-trades-fresh');

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtMin(s: number): string {
  if (isNaN(s)) return '   --';
  if (s < 60) return `${s.toFixed(0)}s`.padStart(6);
  return `${(s/60).toFixed(1)}m`.padStart(6);
}

// ET hour from unix ts, given the day's sess open (09:30 ET in unix sec).
function etHour(ts: number, sessOpen: number): number {
  const minSinceOpen = (ts - sessOpen) / 60;
  return Math.floor((570 + minSinceOpen) / 60);  // 570 = 9*60+30
}
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHr = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHr), 30, 0) / 1000);
}

const variants = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory());
variants.sort();

console.log(`Time-to-TP analysis across ${variants.length} variants from ${DIR}\n`);

// Per-variant: collect TP durations overall + by entry hour
type V = { total: number; tps: number[]; byHour: Map<number, number[]> };
const all: { name: string; data: V }[] = [];

for (const v of variants) {
  const days = fs.readdirSync(path.join(DIR, v)).filter(f => f.endsWith('.json'));
  const d: V = { total: 0, tps: [], byHour: new Map() };
  for (const day of days) {
    const date = day.replace('.json', '');
    const sess = sessOpenTs(date);
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, v, day), 'utf8'));
    for (const t of raw.trades) {
      d.total++;
      if (t.exitReason !== 'TP') continue;
      d.tps.push(t.durationSec);
      const hr = etHour(t.entryTs, sess);
      let bucket = d.byHour.get(hr); if (!bucket) { bucket = []; d.byHour.set(hr, bucket); }
      bucket.push(t.durationSec);
    }
  }
  all.push({ name: v, data: d });
}

// ── Headline: TP-duration distribution per variant
console.log('=== TP-only duration per variant (across all entry times) ===');
console.log('Variant'.padEnd(50), 'Trades', 'TPs', 'TP%', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95');
console.log('-'.repeat(110));
for (const { name, data } of all) {
  const s = [...data.tps].sort((a, b) => a - b);
  const tpPct = data.total > 0 ? (100 * data.tps.length / data.total).toFixed(1) : '0';
  console.log(
    name.padEnd(50),
    String(data.total).padStart(5),
    String(data.tps.length).padStart(5),
    tpPct.padStart(5) + '%',
    fmtMin(quantile(s, 0.10)),
    fmtMin(quantile(s, 0.25)),
    fmtMin(quantile(s, 0.50)),
    fmtMin(quantile(s, 0.75)),
    fmtMin(quantile(s, 0.90)),
    fmtMin(quantile(s, 0.95)),
  );
}

// ── Per-hour breakdown for each variant
console.log('\n=== TP-only duration by entry hour (ET) — for each variant ===');
for (const { name, data } of all) {
  console.log(`\n${name}`);
  console.log(`  Hour  N      p10    p25    p50    p75    p90`);
  for (let h = 9; h <= 15; h++) {
    const arr = data.byHour.get(h);
    if (!arr || arr.length === 0) { continue; }
    const s = [...arr].sort((a, b) => a - b);
    console.log(`  ${h.toString().padStart(2)}    ${String(arr.length).padStart(4)}  ${fmtMin(quantile(s,0.10))} ${fmtMin(quantile(s,0.25))} ${fmtMin(quantile(s,0.50))} ${fmtMin(quantile(s,0.75))} ${fmtMin(quantile(s,0.90))}`);
  }
}
