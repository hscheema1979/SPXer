/**
 * sweep-parity.ts — proves the parallel (date-sharded) sweep is identical to
 * the serial sweep. Runs credit-spread-sweep SERIAL then PARALLEL over the
 * same small date window and diffs every variant.
 *
 *   PASS iff: same variant set; n EXACT; pnl within 1e-6·|pnl|+1e-6
 *             (only float-add ORDER differs across shards — integers exact).
 *
 * Usage: npx tsx scripts/diag/sweep-parity.ts [--symbol SPX] [--days 12] [--shards 4]
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();
const a = process.argv.slice(2);
const val = (n: string, d: string) => { const i = a.indexOf(`--${n}`); return i >= 0 ? a[i + 1] : d; };
const symbol = val('symbol', 'SPX');
const days = val('days', '12');
const shards = val('shards', '4');

const sfx = symbol === 'SPX' ? '' : `-${symbol.toLowerCase()}-0dte`;
// Read the GUARANTEED output (/tmp), not the best-effort STUDIO copy.
const OUT = `/tmp/credit_spread_sweep${sfx}.json`;
const isCredit = (s: string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);

function snapshot(): Map<string, { pnl: number; n: number; wr: number }> {
  const rows = JSON.parse(fs.readFileSync(OUT, 'utf8')) as any[];
  const m = new Map<string, { pnl: number; n: number; wr: number }>();
  for (const r of rows) if (isCredit(r.spread)) m.set(`${r.signal}|${r.spread}|${r.exit}`, { pnl: r.pnl, n: r.n, wr: r.wr });
  return m;
}

const env = { ...process.env, SWEEP_DAYS: days };
console.log(`parity: ${symbol}, ${days} days, ${shards} shards\n`);

console.log('① serial run …');
execFileSync('npx', ['tsx', 'scripts/diag/credit-spread-sweep.ts', '--symbol', symbol], { cwd: ROOT, env, stdio: 'ignore' });
const serial = snapshot();

console.log('② parallel run …');
execFileSync('npx', ['tsx', 'scripts/diag/sweep-parallel.ts', '--symbol', symbol, '--engine', 'credit', '--shards', shards], { cwd: ROOT, env, stdio: 'ignore' });
const par = snapshot();

let fail = 0, worstPnl = 0;
const keys = new Set([...serial.keys(), ...par.keys()]);
for (const k of keys) {
  const s = serial.get(k), p = par.get(k);
  if (!s || !p) { console.log(`  MISSING ${k} serial=${!!s} par=${!!p}`); fail++; continue; }
  if (s.n !== p.n) { console.log(`  N MISMATCH ${k}: serial ${s.n} vs par ${p.n}`); fail++; }
  const d = Math.abs(s.pnl - p.pnl);
  if (d > 1e-6 * Math.abs(s.pnl) + 1e-6) { console.log(`  PNL ${k}: Δ${d.toFixed(6)} (${s.pnl} vs ${p.pnl})`); fail++; }
  worstPnl = Math.max(worstPnl, d);
}
console.log(`\nvariants: serial ${serial.size}, parallel ${par.size}`);
console.log(`worst pnl Δ: ${worstPnl.toExponential(2)}  (float-add order only)`);
if (fail === 0 && serial.size > 0 && serial.size === par.size) {
  console.log(`\n✅ PARITY PASS — parallel == serial across all ${serial.size} variants`);
  process.exit(0);
}
console.log(`\n❌ PARITY FAIL — ${fail} discrepancies`);
process.exit(1);
