/**
 * w10-vs-w15-move.ts — For IB±25 w10 vs w15, measure the SPX move required
 * for the TP to fire, the $ value change captured, and the implied sensitivity
 * ($ captured per SPX point moved). Pairs with the return numbers.
 */
import * as fs from 'fs';
import * as path from 'path';

const DIR = '/tmp/w10-vs-w15';

function quantile(s: number[], q: number): number {
  if (!s.length) return NaN;
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const variants = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory()).sort();

console.log('IB±25 w10 vs w15 — SPX move required for TP, value captured, sensitivity\n');
console.log('Variant                       TPs    AvgCredit  TP$target  | SPX move@TP (signed, pts)        | $/pt');
console.log('                                                          | p25    p50    p75    p90       |');
console.log('─'.repeat(110));

for (const v of variants) {
  const days = fs.readdirSync(path.join(DIR, v)).filter(f => f.endsWith('.json'));
  const moves: number[] = [];      // signed SPX move at TP fire
  const credits: number[] = [];
  const captured: number[] = [];   // credit - exitV (the $ value change captured)
  let tpCount = 0, total = 0;
  for (const day of days) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, v, day), 'utf8'));
    for (const t of raw.trades) {
      total++;
      if (t.exitReason !== 'TP') continue;
      tpCount++;
      const sign = t.dir === 'bull' ? 1 : -1;
      moves.push((t.spxAtExit - t.spxAtEntry) * sign);
      credits.push(t.netCredit);
      captured.push(t.netCredit - t.netExitDebit);
    }
  }
  const ms = [...moves].sort((a, b) => a - b);
  const avgCredit = credits.reduce((s, x) => s + x, 0) / Math.max(1, credits.length);
  const avgCaptured = captured.reduce((s, x) => s + x, 0) / Math.max(1, captured.length);
  const medMove = quantile(ms, 0.50);
  const dollarPerPt = medMove !== 0 ? Math.abs(avgCaptured * 100 / medMove) : NaN;
  console.log(
    `${v.replace('HMA_1m_3x12__', '').replace('__', ' ').padEnd(28)} ${String(tpCount).padStart(5)}    $${avgCredit.toFixed(2).padStart(6)}    $${(avgCaptured*100).toFixed(0).padStart(5)}    | ` +
    `${quantile(ms,0.25).toFixed(1).padStart(5)}  ${medMove.toFixed(1).padStart(5)}  ${quantile(ms,0.75).toFixed(1).padStart(5)}  ${quantile(ms,0.90).toFixed(1).padStart(5)}    | $${isNaN(dollarPerPt)?'--':dollarPerPt.toFixed(0)}`
  );
}

console.log('\nNotes:');
console.log('  TP$target  = avg $ value captured per TP (credit − exit debit) × 100');
console.log('  SPX move@TP = how far SPX moved toward the body (signed +) when TP fired');
console.log('  $/pt       = $ captured per point of SPX move at median (structure responsiveness)');
