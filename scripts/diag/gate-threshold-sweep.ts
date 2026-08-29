/**
 * gate-threshold-sweep.ts — Post-filter emitted trades at multiple trend-gate
 * thresholds. A trade is SKIPPED if it's counter-trend beyond the threshold:
 *   bear signal + drift30 > +T  → skip (bear in uptrend)
 *   bull signal + drift30 < −T  → skip (bull in downtrend)
 *
 * Computes net P&L / WR / DD for each (variant × threshold), so we can see
 * whether any threshold helps net under the realistic fill model.
 *
 * Trades already carry realistic-fill P&L (emitted with $0.60 close penalty).
 */
import * as fs from 'fs';
import * as path from 'path';

const DIR = '/tmp/gate-thresh-trades';
const THRESHOLDS = [Infinity, 5, 10, 15, 20, 25];  // Infinity = no gate (baseline)
const SLIPPAGE = 25;  // per-structure, already excluded from pnlNet? No — pnlNet includes it.

const variants = fs.readdirSync(DIR).filter(d => fs.statSync(path.join(DIR, d)).isDirectory()).sort();

interface T { dir: string; drift30: number; pnlNet: number; date: string; }

console.log('Trend-gate threshold sweep under REALISTIC fill ($0.60 combo penalty)');
console.log('A trade is skipped if counter-trend beyond threshold T (bear & drift>+T, or bull & drift<−T)\n');

for (const v of variants) {
  const days = fs.readdirSync(path.join(DIR, v)).filter(f => f.endsWith('.json'));
  const trades: T[] = [];
  for (const day of days) {
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, v, day), 'utf8'));
    for (const t of raw.trades) trades.push({ dir: t.dir, drift30: t.drift30, pnlNet: t.pnlNet, date: day });
  }

  console.log(`━━━ ${v.replace('HMA_1m_3x12__','').replace('__',' ')} ━━━`);
  console.log('  Threshold   N      WR%     $/tr     Net$       DD       Ratio   (skipped)');
  console.log('  ' + '─'.repeat(78));
  for (const T of THRESHOLDS) {
    const kept = trades.filter(t => {
      if (t.dir === 'bear' && t.drift30 > T) return false;
      if (t.dir === 'bull' && t.drift30 < -T) return false;
      return true;
    });
    const skipped = trades.length - kept.length;
    const n = kept.length;
    const wins = kept.filter(t => t.pnlNet > 0).length;
    const wr = 100 * wins / Math.max(1, n);
    const net = kept.reduce((s, t) => s + t.pnlNet, 0);
    const perTr = net / Math.max(1, n);
    // Daily DD
    const daily = new Map<string, number>();
    for (const t of kept) daily.set(t.date, (daily.get(t.date) || 0) + t.pnlNet);
    let cum = 0, peak = 0, mdd = 0;
    for (const d of [...daily.keys()].sort()) { cum += daily.get(d)!; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
    const ratio = mdd > 0 ? net / mdd : 0;
    const label = T === Infinity ? 'none' : `±${T}pt`;
    console.log(`  ${label.padEnd(9)}  ${String(n).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  $${perTr.toFixed(2).padStart(6)}  $${((net>=0?'+':'')+Math.round(net)).padStart(8)}  $${Math.round(mdd).toString().padStart(6)}   ${ratio.toFixed(1).padStart(5)}   ${skipped}`);
  }
  console.log();
}
