/**
 * day-check.ts — for one date, show the afternoon SPX path + which timed ATM
 * iron-fly window/width would have paid (held to 15:45 settle).
 *   npx tsx scripts/diag/day-check.ts --symbol SPX --date 2026-06-11
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, loadDay } from './sweep-symbol';
import { optPx, applyExit, buildLegs } from './flat-fly-study';

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;
const date = (process.argv.find(a => a.startsWith('--date='))?.split('=')[1])
  || process.argv[process.argv.indexOf('--date') + 1];
const SLIPPAGE = 25;

function sessOpenTs(d: string): number {
  const [y, mo, da] = d.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, da, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, da, 9 + (12 - etHour), 30, 0) / 1000);
}
const clk = (sess: number, hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return sess + ((h * 60 + m) - 570) * 60; };

const c1: any = loadDay(TARGET, date, '1m');
const s1: any[] = c1.spxBars;
const sess = sessOpenTs(date);
const settle = sess + 6 * 3600 + 15 * 60;       // 15:45 ET (engine settle)
const lastTs = s1[s1.length - 1].ts;
const spxSettle = optPx(s1, settle)!;
const spxClose = s1[s1.length - 1].close;

console.log(`\n=== ${TARGET.symbol} ${date} — afternoon SPX path ===`);
const marks = ['14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45'];
for (const t of marks) { const p = optPx(s1, clk(sess, t)); if (p != null) console.log(`  ${t}  ${p.toFixed(2)}`); }
console.log(`  close ${spxClose.toFixed(2)}  (last bar ${new Date(lastTs * 1000).toISOString().slice(11, 16)} UTC)`);

const p1530 = optPx(s1, clk(sess, '15:30'))!;
console.log(`\nLast-30-min move (15:30 -> 15:45 settle): ${(spxSettle - p1530 >= 0 ? '+' : '') + (spxSettle - p1530).toFixed(2)} pts`);
console.log(`Last-30-min move (15:30 -> 16:00 close):  ${(spxClose - p1530 >= 0 ? '+' : '') + (spxClose - p1530).toFixed(2)} pts`);

console.log(`\n=== Which window/width PAID (ATM fly, held to 15:45 settle), net $ per 1 ct ===`);
const slots = ['14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30'];
const widths = [10, 15, 20, 30];
console.log('  slot    ' + widths.map(w => ('w' + w).padStart(9)).join('') + '     | body(entry SPX)  |settle-body|');
for (const t of slots) {
  const entryTs = clk(sess, t);
  const center = optPx(s1, entryTs - 1);
  if (center == null) { console.log(`  ${t}   (no entry px)`); continue; }
  let line = `  ${t} `;
  for (const w of widths) {
    const wing = w;                                  // dollars (SI handled inside via strikes)
    const legs = buildLegs(c1, center, wing);
    if (!legs) { line += 'n/a'.padStart(9); continue; }
    const epx = legs.map(l => optPx(l.bars, entryTs - 1));
    if (epx.some(p => p == null)) { line += 'n/a'.padStart(9); continue; }
    const credit = legs.reduce((s, l, i) => s + l.sign * (epx[i] as number), 0);
    if (credit <= 0.10 || credit >= wing * 0.95) { line += 'skip'.padStart(9); continue; }
    const nat = applyExit([], settle, settle, legs, credit, 0, spxSettle, wing, 0);
    const net = Math.round((credit - nat.exitV) * 100 - SLIPPAGE);
    line += ((net >= 0 ? '+' : '') + net).padStart(9);
  }
  line += `     |   ${center.toFixed(2)}      |  ${Math.abs(spxSettle - center).toFixed(1)}`;
  console.log(line);
}
