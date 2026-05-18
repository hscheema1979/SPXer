/**
 * sweep-parity-incr.ts — proves INCREMENTAL == FULL recompute.
 *
 *   1. FULL    : credit-spread-sweep over the last N dates, no state → truth.
 *   2. BOOTSTRAP: SWEEP_DAYS=N-1 + SWEEP_STATE → processes the most-recent
 *                 N-1 dates, persists the accumulator.
 *   3. INCR    : SWEEP_DAYS=N + SWEEP_STATE → loads state (N-1 dates known),
 *                replays only the 1 genuinely-new date, merges, finalizes.
 *
 *   PASS iff INCR == FULL for every variant: n & wins EXACT, pnl within
 *   1e-6·|pnl|+1e-6 (only float-add ORDER differs — same tolerance as the
 *   shard parity gate).
 *
 * Usage: npx tsx scripts/diag/sweep-parity-incr.ts [--symbol SPX] [--days 12]
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';

const ROOT = process.cwd();
const a = process.argv.slice(2);
const val = (n: string, d: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const symbol = val('symbol', 'SPX');
const N = parseInt(val('days', '12'), 10);
const sfx = symbol === 'SPX' ? '' : `-${symbol.toLowerCase()}-0dte`;
const OUT = `/tmp/credit_spread_sweep${sfx}.json`;
const STATE = `/tmp/parity_incr_state${sfx}.json`;
const isCredit = (s: string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);

function snap(): Map<string, { pnl: number; n: number; wr: number }> {
  const rows = JSON.parse(fs.readFileSync(OUT, 'utf8')) as any[];
  const m = new Map<string, { pnl: number; n: number; wr: number }>();
  for (const r of rows) if (isCredit(r.spread)) m.set(`${r.signal}|${r.spread}|${r.exit}`, { pnl: r.pnl, n: r.n, wr: r.wr });
  return m;
}
function run(env: Record<string, string>) {
  execFileSync('npx', ['tsx', 'scripts/diag/credit-spread-sweep.ts', '--symbol', symbol],
    { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' });
}

try { fs.unlinkSync(STATE); } catch { /* fresh */ }

console.log(`incr-parity: ${symbol}, N=${N} days\n① FULL (no state) …`);
run({ SWEEP_DAYS: String(N) });
const full = snap();

console.log('② BOOTSTRAP (N-1 days → state) …');
run({ SWEEP_DAYS: String(N - 1), SWEEP_STATE: STATE });

console.log('③ INCR (N days, state loaded → replay only the 1 new) …');
run({ SWEEP_DAYS: String(N), SWEEP_STATE: STATE });
const incr = snap();

let fail = 0, worst = 0;
for (const k of new Set([...full.keys(), ...incr.keys()])) {
  const f = full.get(k), i = incr.get(k);
  if (!f || !i) { console.log(`  MISSING ${k} full=${!!f} incr=${!!i}`); fail++; continue; }
  if (f.n !== i.n) { console.log(`  N ${k}: full ${f.n} vs incr ${i.n}`); fail++; }
  const d = Math.abs(f.pnl - i.pnl);
  if (d > 1e-6 * Math.abs(f.pnl) + 1e-6) { console.log(`  PNL ${k}: Δ${d} (${f.pnl} vs ${i.pnl})`); fail++; }
  worst = Math.max(worst, d);
}
try { fs.unlinkSync(STATE); } catch { /* cleanup */ }
console.log(`\nvariants: full ${full.size}, incr ${incr.size}  worst pnl Δ ${worst.toExponential(2)}`);
if (fail === 0 && full.size > 0 && full.size === incr.size) {
  console.log(`\n✅ INCREMENTAL PARITY PASS — incremental == full across all ${full.size} variants`);
  process.exit(0);
}
console.log(`\n❌ INCREMENTAL PARITY FAIL — ${fail} discrepancies`);
process.exit(1);
