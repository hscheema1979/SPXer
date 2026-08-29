/**
 * compare-sl-risk.ts — Compare TP-only vs TP+SL%risk variants from the
 * latest sweep shards.
 */
// Reads the dashboard JSON directly (which is what sweep-parallel writes after merge+post).
import * as fs from 'fs';
const rows: any[] = JSON.parse(fs.readFileSync('/home/ubuntu/SPXer/scripts/autoresearch/output/spread-sweep.json', 'utf8'));

const sig = 'HMA  1m 3x12';
const spreads = ['IB±15 w10', 'IB±20 w10', 'IB±25 w10'];
const exits = [
  'TP5 only',
  'TP5 SL80%', 'TP5 SL70%', 'TP5 SL60%', 'TP5 SL50%',
  'TP10 only',
  'TP10 SL80%', 'TP10 SL70%', 'TP10 SL60%', 'TP10 SL50%',
  'TP15 only',
  'TP15 SL80%', 'TP15 SL70%', 'TP15 SL60%', 'TP15 SL50%',
];

console.log('Effect of risk-based stop-loss on directional iron flies');
console.log('Signal: HMA 1m 3x12, hard fill model');
console.log('='.repeat(100));
console.log();

for (const spread of spreads) {
  console.log(`--- ${spread} ---`);
  console.log('Exit          N      WR%   $/tr     Net$        DD       Ratio');
  console.log('-'.repeat(75));
  for (const exit of exits) {
    const r = rows.find(x => x.signal === sig && x.spread === spread && x.exit === exit);
    if (!r) { console.log(`${exit.padEnd(13)} (not found)`); continue; }
    const ratio = r.dd > 0 ? (r.pnl / r.dd).toFixed(2) : '--';
    console.log(`${exit.padEnd(13)} ${String(r.n).padStart(5)}  ${r.wr.toFixed(1).padStart(5)}  $${r.avgPnlPerTrade.toString().padStart(5)}  $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)}  $${Math.round(r.dd).toString().padStart(7)}   ${ratio.padStart(6)}`);
  }
  console.log();
}
