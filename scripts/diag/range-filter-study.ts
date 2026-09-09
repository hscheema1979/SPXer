/**
 * range-filter-study.ts — does the "price hasn't moved yet" entry gate earn its keep?
 *
 * Question this answers: for a 0DTE credit spread entered at a fixed afternoon
 * slot and HELD TO 16:00 CASH SETTLE, is it better to gate entry on
 *   (a) no move either way   — symmetric ±X%   (a quiet-day / realized-vol proxy)
 *   (b) no move toward the short side only     (a pure risk gate)
 *   (c) no gate at all                         (control)
 *
 * Method: consume the per-trade CSVs already emitted by delta-condor-slot.ts
 * (SWEEP_SIDE=put → pcs-slot-trades-*.csv, =call → scs-slot-trades-*.csv), keep
 * only the target slot, and re-bucket those SAME trades under each gate. Because
 * every arm is a subset of one trade population, arms differ ONLY by which days
 * they admit — no re-pricing, no friction drift, no strike differences.
 *
 * Reported per arm: trades kept, P&L/trade, win rate, the BREAK-EVEN win rate
 * that structure required, edge (wr − beWr), and the left tail (p5 / worst).
 * A gate that raises win rate while raising break-even win rate more has made
 * things worse, and only the edge column shows that.
 *
 * Train/test: dates are split chronologically in half. A gate that only works
 * in-sample is a fitted threshold, not an edge.
 *
 * Run:
 *   npx tsx scripts/diag/range-filter-study.ts --symbol SPX
 * Env:
 *   RF_SLOT=13:45              entry slot to analyse
 *   RF_THRESHOLDS=0.4,0.5      gate thresholds in %
 *   RF_REFRESH=1               force rebuild of the per-day excursion cache
 *   RF_EXTRA_FRICTION=20       extra $ charged per trade (round-turn) on top of
 *                              the engine's model. The sweep's default fill is
 *                              known to be optimistic for SPX 0DTE NBBO, and at
 *                              $15-50/trade edges that assumption decides the
 *                              answer — so sweep this before believing a row.
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { preEntryExcursion, passesRangeFilter, GUARD_FOR, type Excursion, type FilterMode } from './preentry-range';
import { summarize } from './study-stats';

const TARGET = resolveSymbolTarget(process.argv);
const SYM = TARGET.symbol.toLowerCase();
const SLOT = process.env.RF_SLOT ?? '13:45';
const THRESHOLDS = (process.env.RF_THRESHOLDS ?? '0.4,0.5').split(',').map(s => parseFloat(s.trim())).filter(n => n > 0);
const CACHE = `/tmp/rf-excursions-${SYM}-${SLOT.replace(':', '')}.json`;
const EXTRA_FRIC = Number(process.env.RF_EXTRA_FRICTION ?? 0);

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}
const [SH, SM] = SLOT.split(':').map(Number);
const SLOT_SEC = (SH * 60 + SM - (9 * 60 + 30)) * 60;

/** Per-day excursion vs both reference prices, measured up to the entry slot. */
interface DayRange { open: Excursion; priorClose: Excursion | null }

function buildCache(): Record<string, DayRange> {
  const dates = listDatesFor(TARGET);
  const out: Record<string, DayRange> = {};
  let prevClose: number | null = null;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (i % 40 === 0) console.error(`  range ${i}/${dates.length} ${date}`);
    let c: any; try { c = loadDay(TARGET, date, '1m'); } catch { prevClose = null; continue; }
    const bars = c?.spxBars;
    if (!bars?.length) { prevClose = null; continue; }
    const cutoff = sessOpenTs(date) + SLOT_SEC;
    const openPx = bars[0].close;
    const eOpen = preEntryExcursion(bars, openPx, cutoff);
    const ePc = prevClose != null ? preEntryExcursion(bars, prevClose, cutoff) : null;
    if (eOpen) out[date] = { open: eOpen, priorClose: ePc };
    prevClose = bars[bars.length - 1].close;
  }
  return out;
}

let RANGES: Record<string, DayRange>;
if (!process.env.RF_REFRESH && fs.existsSync(CACHE)) {
  RANGES = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  console.error(`Loaded excursion cache (${Object.keys(RANGES).length} days) from ${CACHE}`);
} else {
  console.error(`Building excursion cache to ${SLOT} …`);
  RANGES = buildCache();
  fs.writeFileSync(CACHE, JSON.stringify(RANGES));
  console.error(`Wrote ${CACHE} (${Object.keys(RANGES).length} days)`);
}

// ── Load trades ─────────────────────────────────────────────────────────────
interface Trade { date: string; delta: number; wing: string; credit: number; pnl: number }
function loadTrades(file: string): Trade[] {
  if (!fs.existsSync(file)) { console.error(`MISSING ${file} — run delta-condor-slot.ts with SWEEP_SLOT_EMIT=1`); return []; }
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const hdr = lines[0].split(',');
  const iDate = hdr.indexOf('date'), iSlot = hdr.indexOf('slot'), iD = hdr.indexOf('short_delta');
  const iW = hdr.indexOf('wing_req'), iC = hdr.indexOf('credit'), iP = hdr.indexOf('pnl_net');
  const out: Trade[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f[iSlot] !== SLOT) continue;
    out.push({ date: f[iDate], delta: +f[iD], wing: f[iW], credit: +f[iC], pnl: +f[iP] - EXTRA_FRIC });
  }
  return out;
}

const SIDES: { side: 'put' | 'call'; label: string; file: string }[] = [
  { side: 'put', label: 'PUT credit (bull put)', file: `/tmp/pcs-slot-trades-${SYM}.csv` },
  { side: 'call', label: 'CALL credit (bear call)', file: `/tmp/scs-slot-trades-${SYM}.csv` },
];

const allDates = [...new Set(Object.keys(RANGES))].sort();
const splitIdx = Math.floor(allDates.length / 2);
const trainSet = new Set(allDates.slice(0, splitIdx));
const period = (d: string) => (trainSet.has(d) ? 'train' : 'test');

const results: any[] = [];
const fmt = (v: any, w: number) => String(v ?? '—').padStart(w);

for (const { side, label, file } of SIDES) {
  const trades = loadTrades(file);
  if (!trades.length) continue;
  const guard = GUARD_FOR[side];
  const combos = [...new Set(trades.map(t => `${t.delta}|${t.wing}`))].sort();

  console.log(`\n${'═'.repeat(122)}`);
  console.log(`${label} — ${TARGET.symbol} 0DTE, entry ${SLOT} ET, hold to 16:00 settle`);
  console.log(`Gate reference: how far price travelled from the SESSION OPEN before ${SLOT}. Guard side = ${guard}`);
  console.log('═'.repeat(122));
  console.log(`${'Δ/wing'.padEnd(12)}${'gate'.padEnd(22)}${fmt('n', 5)}${fmt('%kept', 7)}${fmt('$/trade', 9)}${fmt('WR%', 7)}${fmt('BE-WR%', 8)}${fmt('edge', 7)}${fmt('total$', 9)}${fmt('p5', 8)}${fmt('worst', 8)}${fmt('tr$/t', 8)}${fmt('te$/t', 8)}`);
  console.log('─'.repeat(122));

  for (const combo of combos) {
    const [dStr, wing] = combo.split('|');
    const sub = trades.filter(t => `${t.delta}|${t.wing}` === combo).sort((a, b) => a.date.localeCompare(b.date));
    if (sub.length < 50) continue;

    // All four modes per side. The OPPOSITE-side gate is the decisive control:
    // if symmetric only beats the guard because of its opposite leg, then the
    // gate's value is not "guard my short side" but something else entirely
    // (on SPX, a prior selloff signals vol that threatens BOTH sides).
    const opposite: FilterMode = guard === 'down-only' ? 'up-only' : 'down-only';
    const arms: { name: string; mode: FilterMode; th: number }[] = [{ name: 'none (control)', mode: 'none', th: 0 }];
    for (const th of THRESHOLDS) {
      arms.push({ name: `${guard} ${th}% [guard]`, mode: guard, th });
      arms.push({ name: `${opposite} ${th}% [opp]`, mode: opposite, th });
      arms.push({ name: `symmetric ${th}% [both]`, mode: 'symmetric', th });
    }

    for (const arm of arms) {
      const kept = sub.filter(t => {
        const r = RANGES[t.date]; if (!r) return false;
        return passesRangeFilter(r.open, arm.th, arm.mode);
      });
      if (!kept.length) continue;
      const s = summarize(kept.map(t => t.pnl));
      const tr = kept.filter(t => period(t.date) === 'train').map(t => t.pnl);
      const te = kept.filter(t => period(t.date) === 'test').map(t => t.pnl);
      const trAvg = tr.length ? +(tr.reduce((a, b) => a + b, 0) / tr.length).toFixed(0) : null;
      const teAvg = te.length ? +(te.reduce((a, b) => a + b, 0) / te.length).toFixed(0) : null;
      results.push({ side, delta: +dStr, wing, arm: arm.name, mode: arm.mode, threshold: arm.th,
        pctKept: +(100 * kept.length / sub.length).toFixed(0), ...s, trainAvg: trAvg, testAvg: teAvg });
      console.log(
        `${(arm.mode === 'none' ? `${dStr} ${wing}` : '').padEnd(12)}${arm.name.padEnd(22)}` +
        `${fmt(s.n, 5)}${fmt(`${(100 * kept.length / sub.length).toFixed(0)}%`, 7)}${fmt(s.avgPnl.toFixed(0), 9)}` +
        `${fmt(s.wr.toFixed(1), 7)}${fmt(s.beWr?.toFixed(1), 8)}${fmt(s.edge?.toFixed(1), 7)}` +
        `${fmt(s.totalPnl, 9)}${fmt(s.p5, 8)}${fmt(s.worst, 8)}${fmt(trAvg, 8)}${fmt(teAvg, 8)}`);
    }
    console.log('─'.repeat(122));
  }
}

const outFile = `/tmp/range-filter-${SYM}-${SLOT.replace(':', '')}.json`;
fs.writeFileSync(outFile, JSON.stringify({
  symbol: TARGET.symbol, slot: SLOT, thresholds: THRESHOLDS, ref: 'session-open',
  days: allDates.length, trainDates: [allDates[0], allDates[splitIdx - 1]],
  testDates: [allDates[splitIdx], allDates[allDates.length - 1]], rows: results,
}, null, 2));
console.log(`\nWrote ${outFile} (${results.length} rows).`);
console.log(`Train ${allDates[0]}→${allDates[splitIdx - 1]} | Test ${allDates[splitIdx]}→${allDates[allDates.length - 1]}`);
