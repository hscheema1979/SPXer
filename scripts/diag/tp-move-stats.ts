/**
 * tp-move-stats.ts
 *
 * For each TP'd trade, compute the FAVORABLE SPX move from entry to TP fire.
 *   move_signed = (spxAtExit − spxAtEntry) × (dir === 'bull' ? +1 : −1)
 *
 * This tells us empirically how much SPX has to move in the signal direction
 * for each variant's TP to fire. Distribution + per-hour breakdown.
 *
 * Usage:
 *   npx tsx scripts/diag/tp-move-stats.ts [emit-dir]
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
function fmt(x: number, w = 6): string { return (isNaN(x) ? '--' : x.toFixed(1)).padStart(w); }

function etHour(ts: number, sessOpen: number): number {
  const minSinceOpen = (ts - sessOpen) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHr = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHr), 30, 0) / 1000);
}

const variants = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory()).sort();

console.log(`SPX favorable move at TP fire — across ${variants.length} variants\n`);

type V = { tpMoves: number[]; missMoves: number[]; byHour: Map<number, { tp: number[]; miss: number[] }> };
const all: { name: string; data: V }[] = [];

for (const v of variants) {
  const days = fs.readdirSync(path.join(DIR, v)).filter(f => f.endsWith('.json'));
  const d: V = { tpMoves: [], missMoves: [], byHour: new Map() };
  for (const day of days) {
    const date = day.replace('.json', '');
    const sess = sessOpenTs(date);
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, v, day), 'utf8'));
    for (const t of raw.trades) {
      const sign = t.dir === 'bull' ? 1 : -1;
      const move = (t.spxAtExit - t.spxAtEntry) * sign;
      const hr = etHour(t.entryTs, sess);
      let bucket = d.byHour.get(hr); if (!bucket) { bucket = { tp: [], miss: [] }; d.byHour.set(hr, bucket); }
      if (t.exitReason === 'TP') { d.tpMoves.push(move); bucket.tp.push(move); }
      else                       { d.missMoves.push(move); bucket.miss.push(move); }
    }
  }
  all.push({ name: v, data: d });
}

console.log('=== SPX favorable move (pts) AT TP FIRE — per variant ===');
console.log('Variant                                            N(TP)   p10    p25    p50    p75    p90');
console.log('-'.repeat(100));
for (const { name, data } of all) {
  const s = [...data.tpMoves].sort((a, b) => a - b);
  console.log(`${name.padEnd(50)} ${String(s.length).padStart(5)}  ${fmt(quantile(s,0.10))} ${fmt(quantile(s,0.25))} ${fmt(quantile(s,0.50))} ${fmt(quantile(s,0.75))} ${fmt(quantile(s,0.90))}`);
}

console.log('\n=== SPX favorable move (pts) at exit FOR MISSED TPs (rode to settle / SL) — per variant ===');
console.log('Variant                                            N(miss) p10    p25    p50    p75    p90');
console.log('-'.repeat(100));
for (const { name, data } of all) {
  const s = [...data.missMoves].sort((a, b) => a - b);
  console.log(`${name.padEnd(50)} ${String(s.length).padStart(5)}  ${fmt(quantile(s,0.10))} ${fmt(quantile(s,0.25))} ${fmt(quantile(s,0.50))} ${fmt(quantile(s,0.75))} ${fmt(quantile(s,0.90))}`);
}

console.log('\n=== SPX favorable move at TP, by entry hour — per variant ===');
for (const { name, data } of all) {
  console.log(`\n${name}`);
  console.log(`  Hour  N(TP)  p10    p25    p50    p75    p90`);
  for (let h = 9; h <= 15; h++) {
    const b = data.byHour.get(h);
    if (!b || b.tp.length === 0) continue;
    const s = [...b.tp].sort((a, b) => a - b);
    console.log(`  ${String(h).padStart(2)}    ${String(s.length).padStart(4)}  ${fmt(quantile(s,0.10))} ${fmt(quantile(s,0.25))} ${fmt(quantile(s,0.50))} ${fmt(quantile(s,0.75))} ${fmt(quantile(s,0.90))}`);
  }
}
