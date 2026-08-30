/**
 * time-iron-slot-study.ts
 *
 * "Each 15-min entry slot as its OWN standalone strategy."
 *
 * For every fixed clock slot from 10:00 to 15:15 ET, evaluate a single ATM
 * 0DTE iron butterfly opened at exactly that time each day and HELD TO SETTLE.
 * This is NOT one bot trading every 15 min — it's 22 independent strategies
 * ("only ever enter at 10:15", "only at 10:30", …), each measured across the
 * full history, so the per-slot stats line up 1:1 with the Option Alpha 0DTE
 * test-service results being scraped for comparison.
 *
 * Engine math (strike snap, entry credit, friction, 0DTE intrinsic settle) is
 * imported VERBATIM from flat-fly-study.ts (which copies iron-sweep), so this
 * is byte-for-byte consistent with the hourly heatmap — only the bucketing
 * changes (exact entry slot instead of entry hour). hold-to-settle needs no
 * trajectory, so this is a single fast pass.
 *
 * Run:
 *   npx tsx scripts/diag/time-iron-slot-study.ts --symbol SPX
 *   SWEEP_DAYS=60 npx tsx scripts/diag/time-iron-slot-study.ts --symbol SPX
 *   SWEEP_TIME_WIDTHS=2,4,6,8,10,12,16,20 (strike counts → w10..w100; default below)
 *
 * Output: console tables (avg $/trade, WR%, n) + /tmp/time-iron-slot-study.json
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx, applyExit, buildLegs } from './flat-fly-study';
import * as fs from 'fs';

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;
// Entry friction model. SWEEP_SLIPPAGE forces a FLAT $/structure (legacy).
// Otherwise STRUCTURE-SCALED: commission (fixed, does NOT scale with size) +
// a half-spread that's a fraction of the gross premium traded (Σ|leg mids|).
// This makes expensive near-ATM legs and pricier products (NDX) pay realistic
// spread cost, while cheap far-OTM legs pay little — floored at a minimum so
// even a deep-OTM combo still pays commission + a token spread.
const FLAT_SLIPPAGE = process.env.SWEEP_SLIPPAGE ? Number(process.env.SWEEP_SLIPPAGE) : null;
const FRIC_COMM  = Number(process.env.SWEEP_COMM ?? 2.6);    // commission per 4-leg structure (entry)
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003); // combo half-spread as frac of gross premium
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);   // min $/structure (commission + token spread)
// grossPrem = Σ|leg mid|; friction in $/structure.
function entryFriction(grossPrem: number): number {
  if (FLAT_SLIPPAGE != null) return FLAT_SLIPPAGE;
  return Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
}
// 0DTE index options (SPXW / NDXP) are PM-CASH-SETTLED on the 16:00 ET close.
const SETTLE_HHMM = 6 * 3600 + 30 * 60;                  // 16:00 ET — real 0DTE settlement
const CUTOFF_HHMM = 6 * 3600;                            // 15:30 ET — last allowable entry
const SLOT_SEC = 15 * 60;                                // 15-min grid
// SWEEP_ITM_CLOSE=1 → AMERICAN / physically-settled exit (QQQ, SPY): if a SHORT
// leg is in-the-money near the close we'd be assigned shares after hours, so we
// close the whole position at 15:45 (MTM + a second round of spread cost). If
// all legs are OTM we let it expire worthless (free, 16:00 intrinsic). Cash-
// settled index products (SPX/NDX/XSP) leave this off — they just settle to cash.
const ITM_CLOSE = !!process.env.SWEEP_ITM_CLOSE;
const ITM_CLOSE_HHMM = 6 * 3600 + 15 * 60;              // 15:45 ET — assignment-avoidance close

// Widths in STRIKE COUNTS (× SI → dollars); default = the existing dashboard grid w10..w100.
const WIDTHS_S = (process.env.SWEEP_TIME_WIDTHS ?? '2,4,6,8,10,12,16,20')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);

// Short-strike OTM offsets in STRIKE COUNTS (× SI → dollars). 0 = ATM iron
// butterfly (legacy behaviour); >0 = iron condor with shorts that far OTM each
// side. SWEEP_SLOT_OFFSETS overrides; default 0 keeps the ATM-fly study intact.
const OFFSETS_S = (process.env.SWEEP_SLOT_OFFSETS ?? '0')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n >= 0);

// Session open (verbatim helper used across the sweep scripts).
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
// 09:30 ET + slotSec → 'HH:MM' label.
function slotLabel(slotSec: number): string {
  const mins = 9 * 60 + 30 + Math.round(slotSec / 60);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// SWEEP_SLOT_EMIT=1 → also dump every per-day trade to /tmp/slot-trades.csv
// (date, slot, width, entry SPX/body, credit, settle, P&L, win) for drill-down.
const EMIT = !!process.env.SWEEP_SLOT_EMIT;
const emitRows: string[] = [];

interface Bucket {
  n: number; wins: number; pnl: number; pnlGross: number; creditSum: number;
  winSum: number; lossSum: number; bestWin: number; worstLoss: number;
  cum: number; peak: number; maxDD: number;            // equity-curve DD (dates iterated in order)
}
// key = `${slotSec}|${offS}|${wS}`
const stats = new Map<string, Bucket>();
function rec(slotSec: number, offS: number, wS: number, pnlGross: number, friction: number) {
  const k = `${slotSec}|${offS}|${wS}`;
  let b = stats.get(k);
  if (!b) { b = { n: 0, wins: 0, pnl: 0, pnlGross: 0, creditSum: 0, winSum: 0, lossSum: 0, bestWin: 0, worstLoss: 0, cum: 0, peak: 0, maxDD: 0 }; stats.set(k, b); }
  const net = pnlGross - friction;
  b.n++; b.pnl += net; b.pnlGross += pnlGross;
  if (net > 0) { b.wins++; b.winSum += net; if (net > b.bestWin) b.bestWin = net; }
  else { b.lossSum += -net; if (net < b.worstLoss) b.worstLoss = net; }
  b.cum += net; if (b.cum > b.peak) b.peak = b.cum; if (b.peak - b.cum > b.maxDD) b.maxDD = b.peak - b.cum;
}

const ALL = listDatesFor(TARGET);
const N = parseInt(process.env.SWEEP_DAYS || '0', 10);
const DATES = (Number.isFinite(N) && N > 0 && N < ALL.length) ? ALL.slice(-N) : ALL;
const SLOTS: number[] = [];
for (let t = 1800; t <= CUTOFF_HHMM; t += SLOT_SEC) SLOTS.push(t);  // 10:00 … 15:30 (last entry before 15:45 settle)

const STRUCT = OFFSETS_S.length === 1 && OFFSETS_S[0] === 0 ? 'ATM fly' : `condor offsets ${OFFSETS_S.map(o => o * SI).join('/')}pt`;
console.error(`[${TARGET.symbol}] SLOT study — ${STRUCT}, hold-to-settle, ${SLOTS.length} slots × ${OFFSETS_S.length} offsets × ${WIDTHS_S.length} widths, dates: ${DATES.length}`);

let traded = 0;
for (let di = 0; di < DATES.length; di++) {
  const date = DATES[di];
  if (di % 20 === 0) console.error(`  ${di}/${DATES.length}  ${date}`);
  let c1: any;
  try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  const spxAtSettle = optPx(s1, settle);
  if (spxAtSettle == null) continue;
  const itmCloseTs = sess + ITM_CLOSE_HHMM;              // 15:45
  const spxAtItmClose = ITM_CLOSE ? optPx(s1, itmCloseTs) : null;
  traded++;

  for (const slotSec of SLOTS) {
    const entryTs = sess + slotSec;
    const center = optPx(s1, entryTs - 1);                 // ATM at the slot
    if (center == null) continue;
    for (const offS of OFFSETS_S) {
      const shortOffset = offS * SI;
      for (const wS of WIDTHS_S) {
        const wingWidth = wS * SI;
        const legs = buildLegs(c1, center, wingWidth, shortOffset);
        if (!legs) continue;
        const entriesPx = legs.map(lg => optPx(lg.bars, entryTs - 1));
        if (entriesPx.some(p => p == null)) continue;
        const credit = legs.reduce((s, lg, i) => s + lg.sign * (entriesPx[i] as number), 0);
        if (credit <= 0.10) continue;
        if (credit >= wingWidth * 0.95) continue;
        const grossPrem = entriesPx.reduce((s, p) => s + Math.abs(p as number), 0);  // Σ|leg mid| → spread-cost proxy
        let exitV: number, exitFriction = 0;
        // American assignment-avoidance: if a short is ITM at 15:45, close at the
        // 15:45 mark (pay to close + a 2nd round of spread) rather than be assigned.
        const shortPutK = legs[0].strike, shortCallK = legs[2].strike;
        const shortItm = ITM_CLOSE && spxAtItmClose != null && (spxAtItmClose < shortPutK || spxAtItmClose > shortCallK);
        if (shortItm) {
          const marks = legs.map(lg => optPx(lg.bars, itmCloseTs));
          if (marks.some(m => m == null)) { exitV = applyExit([], settle, settle, legs, credit, 0, spxAtSettle, wingWidth, 0).exitV; }
          else {
            exitV = Math.max(0, legs.reduce((s, lg, i) => s + lg.sign * (marks[i] as number), 0));
            exitFriction = entryFriction(marks.reduce((s, m) => s + Math.abs(m as number), 0));  // closing the 4 legs costs spread too
          }
        } else {
          // cash-settle / all-OTM expiry → 16:00 intrinsic (no exit cost).
          exitV = applyExit([], settle, settle, legs, credit, 0, spxAtSettle, wingWidth, 0).exitV;
        }
        const pnlGross = (credit - exitV) * 100;
        const friction = entryFriction(grossPrem) + exitFriction;
        rec(slotSec, offS, wS, pnlGross, friction);
        const b = stats.get(`${slotSec}|${offS}|${wS}`)!; b.creditSum += credit;
        if (EMIT) {
          const pnlNet = pnlGross - friction;
          // Per-SIDE net P&L (each credit spread as its own 2-leg strategy w/ own
          // friction + assignment close) so put/call sides can be optimized
          // independently and recombined into an asymmetric condor (put-offset
          // ≠ call-offset, equal wings).
          const sideNet = (shortLeg: any, longLeg: any, sEntry: number, lEntry: number, isPut: boolean) => {
            const sideCredit = sEntry - lEntry;
            const intrAt = (px: number) => isPut
              ? Math.max(0, shortLeg.strike - px) - Math.max(0, longLeg.strike - px)
              : Math.max(0, px - shortLeg.strike) - Math.max(0, px - longLeg.strike);
            let eV = Math.max(0, intrAt(spxAtSettle as number)), eFric = 0;
            const itm = ITM_CLOSE && spxAtItmClose != null && (isPut ? spxAtItmClose < shortLeg.strike : spxAtItmClose > shortLeg.strike);
            if (itm) { const sm = optPx(shortLeg.bars, itmCloseTs), lm = optPx(longLeg.bars, itmCloseTs);
              if (sm != null && lm != null) { eV = Math.max(0, sm - lm); eFric = entryFriction(Math.abs(sm) + Math.abs(lm)); } }
            return Math.round((sideCredit - eV) * 100 - (entryFriction(Math.abs(sEntry) + Math.abs(lEntry)) + eFric));
          };
          const putNet = sideNet(legs[0], legs[1], entriesPx[0] as number, entriesPx[1] as number, true);
          const callNet = sideNet(legs[2], legs[3], entriesPx[2] as number, entriesPx[3] as number, false);
          emitRows.push([date, slotLabel(slotSec), shortOffset, `w${wingWidth}`, center.toFixed(2), legs[0].strike, legs[2].strike,
            credit.toFixed(2), grossPrem.toFixed(2), (spxAtSettle as number).toFixed(2), (spxAtSettle as number - center).toFixed(2),
            exitV.toFixed(2), Math.round(pnlGross), friction.toFixed(2), Math.round(pnlNet), pnlNet > 0 ? 1 : 0, putNet, callNet].join(','));
        }
      }
    }
  }
}
console.error(`  traded ${traded} days`);

// ── Tables ───────────────────────────────────────────────────────────────────
const widthLabels = WIDTHS_S.map(w => `w${w * SI}`);
function table(title: string, offS: number, cell: (b: Bucket) => string) {
  const offLbl = offS === 0 ? 'ATM fly' : `condor ${offS * SI}pt OTM`;
  console.log(`\n=== ${title}  [${offLbl}] ===  (rows = entry slot ET, cols = wing width)`);
  console.log('  slot '.padEnd(8) + widthLabels.map(l => l.padStart(8)).join(''));
  for (const slotSec of SLOTS) {
    let line = '  ' + slotLabel(slotSec).padEnd(6);
    for (const wS of WIDTHS_S) { const b = stats.get(`${slotSec}|${offS}|${wS}`); line += (b ? cell(b) : '·').padStart(8); }
    console.log(line);
  }
}
for (const offS of OFFSETS_S) {
  table('avg $P/L per trade (net)', offS, b => (b.pnl / b.n >= 0 ? '+' : '') + Math.round(b.pnl / b.n));
  table('WIN RATE %',               offS, b => (100 * b.wins / b.n).toFixed(0) + '%');
  table('avg entry CREDIT',         offS, b => '$' + (b.creditSum / b.n).toFixed(1));
  table('sample N',                 offS, b => String(b.n));
}

// ── Detailed per (slot × width) breakdown ────────────────────────────────────
const fmt = (n: number, d = 0) => (n >= 0 ? '+' : '') + n.toFixed(d);
console.log(`\n=== DETAILED — each slot×offset×width = one standalone strategy (${DATES.length} days) ===`);
console.log('  ' +
  'slot'.padEnd(7) + 'OTM'.padStart(5) + 'width'.padStart(6) + 'N'.padStart(5) + 'WR%'.padStart(6) +
  'totPnl'.padStart(9) + '$/trade'.padStart(8) + 'avgWin'.padStart(8) + 'avgLoss'.padStart(8) +
  'PF'.padStart(6) + 'bestW'.padStart(7) + 'worstL'.padStart(8) + 'maxDD'.padStart(9) + 'credit'.padStart(8));
for (const slotSec of SLOTS) {
  for (const offS of OFFSETS_S) for (const wS of WIDTHS_S) {
    const b = stats.get(`${slotSec}|${offS}|${wS}`); if (!b) continue;
    const losses = b.n - b.wins;
    const avgWin = b.wins ? b.winSum / b.wins : 0;
    const avgLoss = losses ? b.lossSum / losses : 0;
    const pf = b.lossSum > 0 ? b.winSum / b.lossSum : Infinity;
    console.log('  ' +
      slotLabel(slotSec).padEnd(7) + `${offS * SI}`.padStart(5) + `w${wS * SI}`.padStart(6) + String(b.n).padStart(5) +
      (100 * b.wins / b.n).toFixed(0).padStart(5) + '%' +
      fmt(b.pnl).padStart(9) + fmt(b.pnl / b.n).padStart(8) +
      fmt(avgWin).padStart(8) + fmt(-avgLoss).padStart(8) +
      (pf === Infinity ? '∞' : pf.toFixed(2)).padStart(6) +
      fmt(b.bestWin).padStart(7) + fmt(b.worstLoss).padStart(8) +
      ('-' + Math.round(b.maxDD)).padStart(9) + ('$' + (b.creditSum / b.n).toFixed(1)).padStart(8));
  }
  console.log('  ' + '-'.repeat(100));
}

// Enriched JSON: full per-strategy metrics for our dataset.
const rows: any[] = [];
for (const slotSec of SLOTS) for (const offS of OFFSETS_S) for (const wS of WIDTHS_S) {
  const b = stats.get(`${slotSec}|${offS}|${wS}`); if (!b) continue;
  const losses = b.n - b.wins;
  rows.push({
    slot: slotLabel(slotSec), shortOffset: offS * SI, wing: wS * SI, n: b.n,
    wr: +(100 * b.wins / b.n).toFixed(1),
    avgPnl: +(b.pnl / b.n).toFixed(2), totalPnl: +b.pnl.toFixed(0),
    avgWin: +(b.wins ? b.winSum / b.wins : 0).toFixed(2),
    avgLoss: +(losses ? -b.lossSum / losses : 0).toFixed(2),
    profitFactor: b.lossSum > 0 ? +(b.winSum / b.lossSum).toFixed(2) : null,
    bestWin: +b.bestWin.toFixed(0), worstLoss: +b.worstLoss.toFixed(0),
    maxDD: +Math.round(b.maxDD), avgCredit: +(b.creditSum / b.n).toFixed(3),
  });
}
// Distinct output names for condor runs so the ATM-fly slot data is preserved.
const IS_CONDOR = !(OFFSETS_S.length === 1 && OFFSETS_S[0] === 0);
const SYM = TARGET.symbol.toLowerCase();
const JSON_OUT = IS_CONDOR ? `/tmp/ic-slot-study-${SYM}.json` : '/tmp/time-iron-slot-study.json';
const CSV_OUT  = IS_CONDOR ? `/tmp/ic-slot-trades-${SYM}.csv` : '/tmp/slot-trades.csv';
fs.writeFileSync(JSON_OUT, JSON.stringify({
  symbol: TARGET.symbol, anchor: IS_CONDOR ? 'OTM-condor' : 'ATM', exit: 'hold-to-settle',
  days: DATES.length, dateRange: [DATES[0], DATES[DATES.length - 1]],
  slots: SLOTS.map(slotLabel), offsets: OFFSETS_S.map(o => o * SI), widths: widthLabels, rows,
}, null, 2));
console.log(`\nWrote ${JSON_OUT} (${rows.length} slot×offset×width rows).`);
if (EMIT) {
  const hdr = 'date,slot,short_offset,width,entry_spx,short_put_strike,short_call_strike,credit,gross_premium,settle_spx,dist_from_center,exit_value,pnl_gross,friction,pnl_net,win,put_net,call_net';
  fs.writeFileSync(CSV_OUT, hdr + '\n' + emitRows.join('\n'));
  console.log(`Wrote ${CSV_OUT} (${emitRows.length} per-trade rows).`);
}
