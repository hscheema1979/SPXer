/**
 * compare-realistic.ts — 3-way comparison:
 *   1. Idealized   ($0.40 penalty, no gate) — from spread-sweep.json
 *   2. Realistic   ($0.60 penalty, no gate) — /tmp/ss-real-nogate shards
 *   3. Realistic+gate ($0.60, trend gate)  — /tmp/ss-real-gate shards
 * For IB±25 w10 and w15 at TP10/TP15.
 */
import * as fs from 'fs';
import { loadShardsInto } from './sweep-shard';

function rowsFromShards(dir: string): any[] {
  const results = new Map<string, any>();
  loadShardsInto(dir, results);
  const out: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    const dailyArr = [...v.daily.values()] as number[];
    let cum = 0, peak = 0, mdd = 0;
    for (const dp of dailyArr) { cum += dp; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
    const wr = 100 * v.wins / Math.max(1, v.n);
    out.push({ signal, spread, exit, pnl: v.pnl, n: v.n, wr, dd: mdd, avgPnlPerTrade: +(v.pnl/Math.max(1,v.n)).toFixed(2) });
  }
  return out;
}

const ideal: any[] = JSON.parse(fs.readFileSync('/tmp/spread-sweep-baseline.json', 'utf8'));
const realNg = rowsFromShards('/tmp/ss-real-nogate');
const realG = rowsFromShards('/tmp/ss-real-gate');

const sig = 'HMA  1m 3x12';
const targets = [
  ['IB±25 w10', 'TP10 only'], ['IB±25 w10', 'TP15 only'],
  ['IB±25 w15', 'TP10 only'], ['IB±25 w15', 'TP15 only'],
];

function find(rows: any[], sp: string, ex: string) {
  return rows.find(r => r.signal === sig && r.spread === sp && r.exit === ex);
}
function fmt(r: any): string {
  if (!r) return 'missing'.padEnd(38);
  return `${String(r.n).padStart(5)}  ${r.wr.toFixed(1).padStart(5)}%  $${r.avgPnlPerTrade.toString().padStart(6)}/tr  $${((r.pnl>=0?'+':'')+Math.round(r.pnl)).padStart(8)}  DD$${Math.round(r.dd).toString().padStart(6)}`;
}

console.log('3-WAY: Idealized ($0.40) vs Realistic ($0.60) vs Realistic+TrendGate');
console.log('Signal: HMA 1m 3x12\n');
for (const [sp, ex] of targets) {
  console.log(`━━━ ${sp} ${ex} ━━━`);
  console.log(`  Idealized   ($0.40, no gate):  ${fmt(find(ideal, sp, ex))}`);
  console.log(`  Realistic   ($0.60, no gate):  ${fmt(find(realNg, sp, ex))}`);
  console.log(`  Realistic + trend gate:        ${fmt(find(realG, sp, ex))}`);
  console.log();
}
