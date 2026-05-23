/**
 * time-iron-study.ts
 *
 * VIABILITY STUDY (20 days by default) for TIME-BASED iron butterflies — open an
 * ATM IB at fixed clock intervals (15m / 30m / 60m) instead of on an HMA/DEMA
 * signal cross. This is the "if we just sold an ATM fly every N minutes" study.
 *
 * Valuation, exit, and 0DTE intrinsic-settle logic are copied VERBATIM from
 * iron-sweep.ts (the proven engine) so results are directly comparable to the
 * signal-based sweep on the dashboard. The ONLY thing that differs is the entry
 * generator: a clock grid instead of detectSignals(). Time-based ATM flies are
 * symmetric and direction-free, so there is no flip exit and no directional
 * centering — just TP / SL / hold-to-settle.
 *
 * Matrix:
 *   intervals : 15m, 30m, 60m            (SWEEP_TIME_INTERVALS to override, csv minutes)
 *   widths    : w10, w20, w30, w40, w50  (strike counts × SI; SWEEP_TIME_WIDTHS csv)
 *   exits     : hold-to-settle, TP10/15/25 only, TP15 SL70%   (representative subset)
 *
 * Run:
 *   npx tsx scripts/diag/time-iron-study.ts --symbol SPX            # 20-day viability
 *   SWEEP_DAYS=20 npx tsx scripts/diag/time-iron-study.ts           # explicit
 *
 * Output: /tmp/time-iron-study.json  +  a console table.
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import * as fs from 'fs';
import * as path from 'path';

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

// ── Knobs (kept identical in spirit to iron-sweep) ──────────────────────────
const SLIPPAGE_PER_STRUCTURE = 25;                                   // 4-leg entry-side friction + commissions
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? 0.10);
const CLOSE_PENALTY_V = 4 * CLOSE_HALFSPREAD_PER_LEG;                 // pay-through-ask on exit fills
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? 'shorts-fresh') as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;

const CUTOFF_HHMM = 6 * 3600;            // 15:30 ET — last allowable entry boundary
const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET — forced exit
// First entry, as ET clock 'HH:MM' (SWEEP_TIME_START). Default 10:00 (matches signal sweep TRADESTART).
function startSecFromEnv(): number {
  const s = process.env.SWEEP_TIME_START;
  if (!s) return 1800; // 10:00 ET = 30 min after 09:30 open
  const [h, m] = s.split(':').map(Number);
  return (h * 60 + (m || 0) - 9 * 60 - 30) * 60;
}
const TRADESTART_SEC = startSecFromEnv();

// Matrix
const INTERVALS_MIN = (process.env.SWEEP_TIME_INTERVALS ?? '15,30,60')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
const WIDTHS_S = (process.env.SWEEP_TIME_WIDTHS ?? '10,20,30,40,50')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);

interface ExitSpec { label: string; tpFrac: number; slRiskFrac: number; maxHoldMin?: number; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle', tpFrac: 0,    slRiskFrac: 0 },
  { label: 'TP5 only',       tpFrac: 0.05, slRiskFrac: 0 },
  { label: 'TP10 only',      tpFrac: 0.10, slRiskFrac: 0 },
  { label: 'TP15 only',      tpFrac: 0.15, slRiskFrac: 0 },
  { label: 'TP20 only',      tpFrac: 0.20, slRiskFrac: 0 },
  { label: 'TP25 only',      tpFrac: 0.25, slRiskFrac: 0 },
  // Fixed time-stops (MTM close, no TP). On the matching interval → only 1 IF open at a time.
  { label: 'close@15m',      tpFrac: 0,    slRiskFrac: 0, maxHoldMin: 15 },
  { label: 'close@30m',      tpFrac: 0,    slRiskFrac: 0, maxHoldMin: 30 },
  // TP with a time-stop backstop — take profit early, else close at the stop (no overlap on matching interval).
  { label: 'TP10 close@15m', tpFrac: 0.10, slRiskFrac: 0, maxHoldMin: 15 },
  { label: 'TP15 close@15m', tpFrac: 0.15, slRiskFrac: 0, maxHoldMin: 15 },
  { label: 'TP10 close@30m', tpFrac: 0.10, slRiskFrac: 0, maxHoldMin: 30 },
  { label: 'TP15 close@30m', tpFrac: 0.15, slRiskFrac: 0, maxHoldMin: 30 },
];

// ── Session helpers (verbatim from iron-sweep) ──────────────────────────────
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
let _sessOpenForEtHour = 0;
function setEtHourSessOpen(s: number) { _sessOpenForEtHour = s; }
function etHour(ts: number): number { return Math.floor((570 + (ts - _sessOpenForEtHour) / 60) / 60); }

// ── Strike + price helpers (verbatim from iron-sweep) ───────────────────────
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } }
  return best;
}
function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }
function markAge(bars: any[], ts: number): number { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return ts - bars[i].ts; return Infinity; }

interface Leg { bars: any[]; sign: number; strike: number; symbol: string; }
interface TrajPoint { ts: number; V: number; shortsFresh: boolean; }

// buildTrajectory — verbatim from iron-sweep (incl. shorts-fresh flag).
function buildTrajectory(legs: Leg[], entryTs: number, endTs: number): TrajPoint[] {
  const tsSet = new Set<number>();
  for (const lg of legs) for (const b of lg.bars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a, b) => a - b);
  const ptr = new Array(legs.length).fill(0);
  const last = new Array<number | null>(legs.length).fill(null);
  const lastTs = new Array<number>(legs.length).fill(-1);
  const traj: TrajPoint[] = [];
  for (const t of tsList) {
    for (let i = 0; i < legs.length; i++)
      while (ptr[i] < legs[i].bars.length && legs[i].bars[ptr[i]].ts <= t) { last[i] = legs[i].bars[ptr[i]].close; lastTs[i] = legs[i].bars[ptr[i]].ts; ptr[i]++; }
    if (last.every(v => v != null)) {
      let V = 0; for (let i = 0; i < legs.length; i++) V += legs[i].sign * (last[i] as number);
      let shortsFresh = false; for (let i = 0; i < legs.length; i++) if (legs[i].sign === +1 && lastTs[i] === t) { shortsFresh = true; break; }
      traj.push({ ts: t, V, shortsFresh });
    }
  }
  return traj;
}

// applyExit — verbatim from iron-sweep, minus the flip path (time-based = no flip).
// closeTs = forced close time (time-stop or settle). settleTs = the true 15:45 expiry boundary.
// When closeTs < settleTs we MTM the structure (early time-stop); only at settleTs do we use 0DTE intrinsic.
function applyExit(traj: TrajPoint[], closeTs: number, settleTs: number, legs: Leg[], credit: number, tpFrac: number,
                   spxAtSettle: number | null, wingWidth: number, slRiskFrac: number)
                  : { exitTs: number; exitV: number; reason: string } {
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slRiskFrac > 0 && wingWidth > 0 ? credit + slRiskFrac * (wingWidth - credit) : Infinity;
  const slActive = slRiskFrac > 0;
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  for (const p of traj) {
    if (p.ts > closeTs) break;
    const fillable = !GATE_SHORTS || p.shortsFresh;
    if (tpFrac > 0 && p.V <= tpTrigger && fillable) { const exitV = FILL_MODE === 'hard' ? tpV : p.V + CLOSE_PENALTY_V; return { exitTs: p.ts, exitV: Math.max(0, exitV), reason: 'TP' }; }
    if (slActive && p.V >= slTrigger && fillable) { const exitV = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : p.V + CLOSE_PENALTY_V; return { exitTs: p.ts, exitV, reason: 'SL' }; }
  }
  // No TP/SL by closeTs. If we held to the real 15:45 boundary on a 0DTE → intrinsic settle. Else MTM close.
  const atSettle = closeTs >= settleTs;
  if (atSettle && spxAtSettle != null && TARGET.dte === 0) {
    let V = 0;
    for (const lg of legs) { const isPut = lg.symbol[lg.symbol.length - 9] === 'P';
      V += lg.sign * (isPut ? Math.max(0, lg.strike - spxAtSettle) : Math.max(0, spxAtSettle - lg.strike)); }
    return { exitTs: settleTs, exitV: Math.max(0, V), reason: 'expiry' };
  }
  let V = 0, ok = true;
  for (const lg of legs) { const c = optPx(lg.bars, closeTs); if (c == null) { ok = false; break; } V += lg.sign * c; }
  return { exitTs: closeTs, exitV: ok ? Math.max(0, V + CLOSE_PENALTY_V) : 0, reason: atSettle ? 'settle-mtm' : 'time-stop' };
}

// ── Time-based entry grid ───────────────────────────────────────────────────
// First entry at 10:00 ET (TRADESTART), then every intervalMin, while < 15:30.
function timeEntries(date: string, intervalMin: number): number[] {
  const sess = sessOpenTs(date);
  const start = sess + TRADESTART_SEC;
  const cutoff = sess + CUTOFF_HHMM;
  const out: number[] = [];
  for (let t = start; t < cutoff; t += intervalMin * 60) out.push(t);
  return out;
}

// ── Accumulator (schema mirrors iron-sweep so the spreads dashboard ingests it) ──
interface HourBucket { n: number; creditSum: number; riskSum: number; pnlSum: number; wins: number; }
interface Stat { pnl: number; pnl_gross: number; n: number; wins: number; creditSum: number; widthSum: number;
                 durationSumSec: number; peakConcurrent: number;
                 perHour: Map<number, HourBucket>; daily: Map<string, number>; }
const results = new Map<string, Stat>();
// key = `signal|spread|exit` — signal namespace "TIME {iv}m", spread "IB w{pts}" (native width filter).
function key(interval: number, w: number, ex: string) { return `TIME ${interval}m|IB w${w * SI}|${ex}`; }
function rec(k: string, pnlGross: number, date: string, credit: number, width: number, entryTs: number, durationSec: number) {
  let v = results.get(k);
  if (!v) { v = { pnl: 0, pnl_gross: 0, n: 0, wins: 0, creditSum: 0, widthSum: 0, durationSumSec: 0, peakConcurrent: 0, perHour: new Map(), daily: new Map() }; results.set(k, v); }
  const net = pnlGross - SLIPPAGE_PER_STRUCTURE;
  const maxRisk = (width - credit) * 100;
  v.pnl += net; v.pnl_gross += pnlGross; v.n++; if (net > 0) v.wins++; v.creditSum += credit; v.widthSum += width; v.durationSumSec += durationSec;
  v.daily.set(date, (v.daily.get(date) ?? 0) + net);
  const h = Math.max(9, Math.min(15, etHour(entryTs)));
  let hb = v.perHour.get(h); if (!hb) { hb = { n: 0, creditSum: 0, riskSum: 0, pnlSum: 0, wins: 0 }; v.perHour.set(h, hb); }
  hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += net; if (net > 0) hb.wins++;
}

function buildLegs(c1: any, center: number, wingWidth: number): Leg[] | null {
  const Ksp = center, Klp = center - wingWidth, Ksc = center, Klc = center + wingWidth;
  const sym_sp = findStrike(c1, 'P', Ksp), sym_lp = findStrike(c1, 'P', Klp);
  const sym_sc = findStrike(c1, 'C', Ksc), sym_lc = findStrike(c1, 'C', Klc);
  if (!sym_sp || !sym_lp || !sym_sc || !sym_lc) return null;
  if (new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) return null;
  return [
    { symbol: sym_sp, strike: Ksp, sign: +1, bars: c1.contractBars.get(sym_sp) as any[] },
    { symbol: sym_lp, strike: Klp, sign: -1, bars: c1.contractBars.get(sym_lp) as any[] },
    { symbol: sym_sc, strike: Ksc, sign: +1, bars: c1.contractBars.get(sym_sc) as any[] },
    { symbol: sym_lc, strike: Klc, sign: -1, bars: c1.contractBars.get(sym_lc) as any[] },
  ];
}

function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10); }

// ── Main ────────────────────────────────────────────────────────────────────
const ALL = listDatesFor(TARGET);
// Default to a 20-day viability window unless SWEEP_DAYS overrides.
const N = parseInt(process.env.SWEEP_DAYS || '20', 10);
const DATES = (Number.isFinite(N) && N > 0 && N < ALL.length) ? ALL.slice(-N) : ALL;

console.error(`[${TARGET.symbol}] TIME-iron study — dates: ${DATES.length} (of ${ALL.length}), intervals: ${INTERVALS_MIN.join('/')}m, widths: ${WIDTHS_S.map(w => w * SI).join('/')}, exits: ${EXITS.length} | exitGate=${EXIT_GATE} fill=${FILL_MODE}`);

for (let di = 0; di < DATES.length; di++) {
  const date = DATES[di];
  if (di % 5 === 0) console.error(`  ${di}/${DATES.length}  ${date}`);
  let c1: any;
  try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  if (!c1?.spxBars?.length) { console.error(`  skip ${date}: no spx bars`); continue; }
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  setEtHourSessOpen(sess);
  const spxAtSettle = optPx(s1, settle);
  const dayEvents = new Map<string, Array<{ e: number; x: number }>>();

  for (const intervalMin of INTERVALS_MIN) {
    for (const entryTs of timeEntries(date, intervalMin)) {
      const center = optPx(s1, entryTs - 1);
      if (center == null) continue;

      for (const wS of WIDTHS_S) {
        const wingWidth = wS * SI;
        const legs = buildLegs(c1, center, wingWidth);
        if (!legs) continue;

        const entriesPx = legs.map(lg => optPx(lg.bars, entryTs - 1));
        if (entriesPx.some(p => p == null)) continue;
        if (ENTRY_STALE_SEC > 0 && legs.some(lg => lg.sign === +1 && markAge(lg.bars, entryTs - 1) > ENTRY_STALE_SEC)) continue;

        const credit = legs.reduce((s, lg, i) => s + lg.sign * (entriesPx[i] as number), 0);
        if (credit <= 0.10) continue;
        if (credit >= wingWidth * 0.95) continue;

        const traj = buildTrajectory(legs, entryTs, settle);
        for (const ex of EXITS) {
          const closeTs = ex.maxHoldMin ? Math.min(settle, entryTs + ex.maxHoldMin * 60) : settle;
          const nat = applyExit(traj, closeTs, settle, legs, credit, ex.tpFrac, spxAtSettle, wingWidth, ex.slRiskFrac);
          const pnlGross = (credit - nat.exitV) * 100;
          const durationSec = Math.max(0, nat.exitTs - entryTs);
          const k = key(intervalMin, wS, ex.label);
          rec(k, pnlGross, date, credit, wingWidth, entryTs, durationSec);
          let evs = dayEvents.get(k); if (!evs) { evs = []; dayEvents.set(k, evs); }
          evs.push({ e: entryTs, x: nat.exitTs });
        }
      }
    }
  }
  // End-of-day peak concurrency per variant (events collected for this day only).
  for (const [k, evs] of dayEvents) {
    const pts: Array<{ ts: number; d: number }> = [];
    for (const e of evs) { pts.push({ ts: e.e, d: +1 }); pts.push({ ts: e.x, d: -1 }); }
    pts.sort((a, b) => a.ts - b.ts || a.d - b.d);   // close before open at a tie
    let cur = 0, peak = 0; for (const p of pts) { cur += p.d; if (cur > peak) peak = cur; }
    const v = results.get(k); if (v && peak > v.peakConcurrent) v.peakConcurrent = peak;
  }
}

// ── Report + studio output (iron-sweep schema → shared spreads dashboard) ─────
const SESSION_SEC = 20700; // 10:00 → 15:45 ET
const rows: any[] = [];
for (const [k, v] of results) {
  const [signal, spread, exit] = k.split('|');
  const dailyArr = [...v.daily.values()];
  let cum = 0, peak = 0, mdd = 0; for (const dp of dailyArr) { cum += dp; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  const pos = dailyArr.filter(x => x > 0.1).length;
  const wr = 100 * v.wins / Math.max(1, v.n);
  const ratio = mdd > 0 ? v.pnl / mdd : 0;
  const avgCredit = v.creditSum / Math.max(1, v.n);
  const avgWidth = v.widthSum / Math.max(1, v.n);
  const avgMaxRisk = (avgWidth - avgCredit) * 100;
  const avgDurMin = v.n > 0 ? v.durationSumSec / v.n / 60 : 0;
  const numActiveDays = v.daily.size;
  const avgConcurrent = numActiveDays > 0 ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2) : 0;
  rows.push({ signal, spread, exit, pnl: v.pnl, pnl_gross: v.pnl_gross, n: v.n, wr, dd: mdd, ratio, pos,
    avgCredit: +avgCredit.toFixed(3), avgMaxRisk: +avgMaxRisk.toFixed(0),
    avgPnlPerTrade: +(v.pnl / Math.max(1, v.n)).toFixed(2),
    peakConcurrent: v.peakConcurrent, evictions: 0,
    peakRiskCapacity: +(v.peakConcurrent * avgMaxRisk).toFixed(0),
    avgConcurrent, avgRiskCapacity: +(avgConcurrent * avgMaxRisk).toFixed(0), numActiveDays,
    avgDurMin: +avgDurMin.toFixed(1),
    fillModel: FILL_MODE, fillHalfSpread: CLOSE_HALFSPREAD_PER_LEG, exitGate: EXIT_GATE, entryStaleSec: ENTRY_STALE_SEC });
}
rows.sort((a, b) => b.pnl - a.pnl);

console.log(`\n${TARGET.symbol} time-based iron butterfly — ${DATES.length} days. Positive net: ${rows.filter(r => r.pnl > 0).length}/${rows.length}\n`);
console.log('variant'.padEnd(34), 'n'.padStart(5), 'WR%'.padStart(6), '$net'.padStart(11), '$/tr'.padStart(7), 'cr'.padStart(6), 'pkCon'.padStart(6), 'maxDD'.padStart(10));
console.log('-'.repeat(96));
for (const r of rows.slice(0, 40)) {
  console.log(`${r.signal}|${r.spread}|${r.exit}`.padEnd(34), String(r.n).padStart(5), r.wr.toFixed(1).padStart(6),
    Math.round(r.pnl).toLocaleString().padStart(11), Math.round(r.avgPnlPerTrade).toString().padStart(7),
    r.avgCredit.toFixed(2).padStart(6), String(r.peakConcurrent).padStart(6), Math.round(-r.dd).toLocaleString().padStart(10));
}

// ── Merge into the shared studio files (same as iron-sweep / credit-spread). ──
// De-dup is keyed on the "TIME " signal namespace so this is idempotent and never
// touches iron-sweep's signal-based IB/IC rows or credit-spread's 2-leg rows.
const isTime = (s: any) => String(s || '').startsWith('TIME ');
function writeSweep(base: string) {
  const f = outPath(base, TARGET);
  let existing: any[] = []; try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  existing = existing.filter((r: any) => !isTime(r.signal));
  fs.writeFileSync(f, JSON.stringify(existing.concat(rows)));
  return f;
}
function writeDaily(base: string) {
  const f = outPath(base, TARGET);
  let ex: any = { dates: [], series: {} }; try { ex = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for (const key of Object.keys(ex.series || {})) if (isTime(key.split('|')[0])) delete ex.series[key];
  const allDates = new Set<string>(ex.dates || []);
  for (const v of results.values()) for (const d of v.daily.keys()) allDates.add(d);
  const dates = [...allDates].sort(); const di = new Map<string, number>(); dates.forEach((d, i) => di.set(d, i));
  const series: Record<string, number[]> = {};
  for (const key of Object.keys(ex.series || {})) {           // re-index preserved series onto merged date axis
    const oldArr: number[] = ex.series[key], oldDates: string[] = ex.dates || [];
    const arr = new Array(dates.length).fill(0);
    for (let i = 0; i < oldDates.length; i++) { const idx = di.get(oldDates[i]); if (idx != null) arr[idx] = oldArr[i] || 0; }
    series[key] = arr;
  }
  for (const [k, v] of results) { const arr = new Array(dates.length).fill(0); for (const [d, p] of v.daily) arr[di.get(d)!] = +p.toFixed(2); series[k] = arr; }
  fs.writeFileSync(f, JSON.stringify({ dates, series }));
}
function writeHourly(base: string) {
  const f = outPath(base, TARGET);
  let existing: any[] = []; try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); existing = Array.isArray(raw) ? raw : Object.values(raw); } catch {}
  existing = existing.filter((r: any) => !isTime(r.signal));
  for (const [k, v] of results) {
    const [signal, structure, exit] = k.split('|');
    const byHour: Record<number, any> = {};
    for (const [h, hb] of v.perHour) { if (hb.n === 0) continue;
      byHour[h] = { n: hb.n, avgCredit: +(hb.creditSum / hb.n).toFixed(3), avgMaxRisk: +(hb.riskSum / hb.n).toFixed(0),
        avgPnl: +(hb.pnlSum / hb.n).toFixed(2), totalPnl: +hb.pnlSum.toFixed(0), wr: +(100 * hb.wins / hb.n).toFixed(1) }; }
    existing.push({ signal, structure, exit, hours: byHour });
  }
  fs.writeFileSync(f, JSON.stringify(existing));
}
const sweepF = writeSweep('/tmp/credit_spread_sweep.json');
writeSweep(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'));
writeDaily('/tmp/credit_spread_daily.json');
writeDaily(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'));
writeHourly('/tmp/iron_hourly.json');
writeHourly(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'));
console.log(`\nMerged ${rows.length} TIME variants into the spreads dashboard (sweep + daily + hourly). Filter signal "TIME 15m/30m/60m", width via spread "IB w…".`);
fs.writeFileSync('/tmp/time-iron-study.json', JSON.stringify({ symbol: TARGET.symbol, days: DATES.length, dateRange: [DATES[0], DATES[DATES.length - 1]], rows }, null, 2));
