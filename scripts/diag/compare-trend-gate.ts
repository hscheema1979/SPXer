/**
 * compare-trend-gate.ts — A/B compare baseline vs trend-gated sweep results.
 * Reads baseline from /tmp/spread-sweep-baseline.json (saved before re-run)
 * and trend-gated results from the dumped shards.
 *
 * Usage: npx tsx scripts/diag/compare-trend-gate.ts
 */
import * as fs from 'fs';
import { loadShardsInto } from './sweep-shard';

const baseline: any[] = JSON.parse(fs.readFileSync('/tmp/spread-sweep-baseline.json', 'utf8'));

// Merge trend-gated shards into a results map
const results = new Map<string, any>();
loadShardsInto('/tmp/sweepshard-trend', results);

// Convert merged results map into rows similar to baseline
const trendRows: any[] = [];
for (const [k, v] of results) {
  const [signal, spread, exit] = k.split('|');
  const dailyArr = [...v.daily.values()] as number[];
  let cum = 0, peak = 0, mdd = 0;
  for (const dp of dailyArr) { cum += dp; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  const pos = dailyArr.filter(x => x > 0.1).length;
  const wr = 100 * v.wins / Math.max(1, v.n);
  const ratio = mdd > 0 ? v.pnl / mdd : 0;
  trendRows.push({ signal, spread, exit, pnl: v.pnl, n: v.n, wr, dd: mdd, ratio, pos,
                   avgPnlPerTrade: +(v.pnl/Math.max(1,v.n)).toFixed(2),
                   numActiveDays: v.daily.size });
}

// Focus comparison: IB±25 w10 + IB±20 w10 + IB±15 w10 across TP10/TP15/TP25
const focusSpreads = ['IB±15 w10', 'IB±20 w10', 'IB±25 w10', 'IB w20', 'IB w25'];
const focusExits = ['TP10 only', 'TP15 only', 'TP20 only', 'TP25 only'];
const focusSignal = 'HMA  1m 3x12';

console.log('='.repeat(120));
console.log('A/B: Baseline (no trend gate) vs Trend-gated (30-min drift, ±5pt threshold)');
console.log('Signal: HMA 1m 3x12, hard fill model');
console.log('='.repeat(120));
console.log();
console.log('Spread        Exit       │  Baseline                                  │  Trend-gated                              │ Delta');
console.log('                         │  N      WR%    $/tr    Net $       DD     │  N      WR%    $/tr    Net $       DD     │ ΔWR    ΔNet    ΔTrades');
console.log('─'.repeat(150));

for (const spread of focusSpreads) {
  for (const exit of focusExits) {
    const b = baseline.find(r => r.signal === focusSignal && r.spread === spread && r.exit === exit);
    const t = trendRows.find(r => r.signal === focusSignal && r.spread === spread && r.exit === exit);
    if (!b || !t) { console.log(`${spread.padEnd(12)} ${exit.padEnd(10)} (missing — b=${!!b} t=${!!t})`); continue; }
    const dWr = t.wr - b.wr;
    const dPnl = t.pnl - b.pnl;
    const dN = t.n - b.n;
    console.log(
      `${spread.padEnd(12)} ${exit.padEnd(10)} │  ${String(b.n).padStart(5)}  ${b.wr.toFixed(1).padStart(5)}  $${b.avgPnlPerTrade.toString().padStart(5)}  $${(b.pnl>=0?'+':'')+Math.round(b.pnl).toString().padStart(8)}  $${Math.round(b.dd).toString().padStart(6)} │  ${String(t.n).padStart(5)}  ${t.wr.toFixed(1).padStart(5)}  $${t.avgPnlPerTrade.toString().padStart(5)}  $${(t.pnl>=0?'+':'')+Math.round(t.pnl).toString().padStart(8)}  $${Math.round(t.dd).toString().padStart(6)} │ ${(dWr>=0?'+':'')+dWr.toFixed(1).padStart(5)}  $${(dPnl>=0?'+':'')+Math.round(dPnl).toString().padStart(8)}  ${(dN>=0?'+':'')+String(dN).padStart(5)}`
    );
  }
  console.log('');
}
