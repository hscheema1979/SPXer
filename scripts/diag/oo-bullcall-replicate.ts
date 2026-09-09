/**
 * oo-bullcall-replicate.ts — reconcile the OptionOmega "12:45 bull-call debit +
 * 3>5 daily SMA" result against our own data, per-1-contract (NO compounding) to
 * isolate the per-trade EDGE rather than the compounding/regime amplification.
 *
 * Structure (matches the uploaded trade log exactly):
 *   SPX 0DTE, enter 12:45 ET, SHORT call at nearest-5 strike (≈ATM),
 *   LONG call at (short − 5)  → 5-wide bull-call DEBIT spread.
 *   Hold to 16:00 cash settle. Trade only when SMA3(close) > SMA5(close),
 *   using ONLY prior completed daily closes (no look-ahead).
 *
 * Reports mid-fill P&L (≈OptionOmega) vs realistic-friction P&L, win rate, and
 * avg P/L% on the debit — directly comparable to OO's 64.1% WR / +9.9%/trade.
 *
 * Run: npx tsx scripts/diag/oo-bullcall-replicate.ts [--entry 12:45] [--width 5]
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx } from './flat-fly-study';

const TARGET = resolveSymbolTarget(['--symbol', 'SPX', '--dte', '0']);
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const ENTRY = arg('entry', '12:45');
const WIDTH = Number(arg('width', '5'));
const [eh, em] = ENTRY.split(':').map(Number);
const ENTRY_SEC = (eh * 60 + em - (9 * 60 + 30)) * 60;     // seconds after 09:30
const SETTLE_SEC = 6.5 * 3600;                              // 16:00

// realistic per-spread entry friction (same model as the slot/condor engines)
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
const entryFriction = (grossPrem: number) => Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
// conservative bracket: explicit per-leg half-spread in points (both legs, entry only)
const HS_PER_LEG = Number(process.env.HS_PER_LEG ?? 0.20);

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}
function callAtStrike(c1: any, k: number): { sym: string; px: number } | null {
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== 'C') continue;
    if (c1.contractStrikes.get(sym) === k) return { sym, px: 0 }; }
  return null;
}

const DATES = listDatesFor(TARGET);
const closes: number[] = [];          // prior completed daily closes (chronological)
const sma = (n: number) => closes.length >= n ? closes.slice(-n).reduce((a, b) => a + b, 0) / n : null;

interface Rec { mid: number; real: number; cons: number; debit: number; win: number; }
const recs: Rec[] = [];
let gated = 0, traded = 0, skipNoPx = 0;

for (const date of DATES) {
  let c1: any; try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  const s1: any[] = c1?.spxBars ?? []; if (!s1.length) continue;
  const sess = sessOpenTs(date);
  const settleSpx = optPx(s1, sess + SETTLE_SEC);

  const s3 = sma(3), s5 = sma(5);
  const pass = s3 != null && s5 != null && s3 > s5;     // 3>5 uptrend gate (prior closes only)
  if (settleSpx != null) closes.push(settleSpx);        // record AFTER gating → no look-ahead
  if (!pass) continue;
  gated++;
  if (settleSpx == null) continue;

  const spot = optPx(s1, sess + ENTRY_SEC - 1); if (spot == null) continue;
  const shortK = Math.round(spot / 5) * 5;              // ≈ATM (nearest 5)
  const longK = shortK - WIDTH;                         // one width ITM
  const sc = callAtStrike(c1, shortK), lc = callAtStrike(c1, longK);
  if (!sc || !lc) { skipNoPx++; continue; }
  const shortPx = optPx(c1.contractBars.get(sc.sym), sess + ENTRY_SEC - 1);
  const longPx = optPx(c1.contractBars.get(lc.sym), sess + ENTRY_SEC - 1);
  if (shortPx == null || longPx == null || shortPx <= 0 || longPx <= 0) { skipNoPx++; continue; }

  const debit = longPx - shortPx;                       // bull call debit (long lower − short higher)
  if (debit <= 0.10 || debit >= WIDTH * 0.99) { skipNoPx++; continue; }
  const value = Math.max(0, settleSpx - longK) - Math.max(0, settleSpx - shortK);   // 0..WIDTH
  const grossPrem = longPx + shortPx;

  const midPnl = (value - debit) * 100;                                   // ≈ OptionOmega (mid fill, no friction)
  const realPnl = midPnl - entryFriction(grossPrem);                      // our standard friction model
  const consPnl = midPnl - HS_PER_LEG * 2 * 100 - FRIC_COMM;              // conservative: 0.20/leg half-spread
  recs.push({ mid: midPnl, real: realPnl, cons: consPnl, debit, win: midPnl > 0 ? 1 : 0 });
  traded++;
}

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const avg = (a: number[]) => sum(a) / a.length;
const wr = (a: Rec[], k: 'mid' | 'real' | 'cons') => 100 * a.filter(r => (r as any)[k] > 0).length / a.length;
const avgPct = (a: Rec[], k: 'mid' | 'real' | 'cons') => 100 * avg(a.map(r => (r as any)[k] / (r.debit * 100)));

console.log(`\n=== SPX 0DTE bull-call debit (${ENTRY} entry, ${WIDTH}-wide ATM, hold-to-settle, 3>5 SMA gate) ===`);
console.log(`dates available ${DATES.length} | passed SMA gate ${gated} | traded ${traded} | skipped(no px) ${skipNoPx}`);
console.log(`date range: ${DATES[0]} → ${DATES[DATES.length - 1]}\n`);
console.log(`avg debit paid: $${(avg(recs.map(r => r.debit)) * 100).toFixed(0)}/spread`);
console.log('');
console.log('  fill model           win%    avg P/L%/trade   total $/1-contract   avg $/trade');
for (const [label, k] of [['mid (≈OptionOmega)', 'mid'], ['realistic friction', 'real'], ['conservative 0.20/leg', 'cons']] as const) {
  const tot = sum(recs.map(r => (r as any)[k]));
  console.log(`  ${label.padEnd(20)} ${wr(recs, k).toFixed(1).padStart(5)}   ${avgPct(recs, k).toFixed(2).padStart(8)}%        ${('$' + Math.round(tot).toLocaleString()).padStart(10)}        ${('$' + (tot / recs.length).toFixed(0)).padStart(7)}`);
}
console.log(`\nOptionOmega log for comparison: 64.1% WR, +9.9% avg/trade (then ×10% compounding → 50× w/ 64% max DD).`);
