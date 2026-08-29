/**
 * flat-fly-study.ts
 *
 * Option Alpha "FLAT FLY" strategy backtest.
 *
 * Opens ONE 0-wide iron butterfly per day at 10:00 ET, centered on the
 * PREVIOUS DAY's close price, and holds it to expiration (0DTE intrinsic
 * settle). Sweeps the wing width. That's the whole strategy — no signal, no
 * direction, no intraday management. The edge claim is that SPX tends to
 * revert toward yesterday's close, so a fly pinned there expires near max
 * profit more often than the wing-cost implies.
 *
 * This is the time-iron-study engine with ONE change: the body is anchored at
 * the prior session's close instead of the current price at entry. Valuation,
 * the shorts-fresh exit gate, pay-through-ask penalty, $25/RT slippage, and
 * 0DTE intrinsic settle are copied VERBATIM from iron-sweep.ts / time-iron-
 * study.ts so the numbers are directly comparable on the spreads dashboard
 * (cross-engine friction parity — see feedback_cross_engine_friction_parity).
 *
 * Matrix:
 *   entry   : 10:00 ET, one fly/day        (SWEEP_TIME_START 'HH:MM' to override)
 *   widths  : w5..w50 (strike counts × SI)  (SWEEP_TIME_WIDTHS csv of strike counts)
 *   exits   : hold-to-settle (headline) + a few TP / TP+SL variants for contrast
 *
 * Run:
 *   npx tsx scripts/diag/flat-fly-study.ts --symbol SPX            # full history
 *   SWEEP_DAYS=60 npx tsx scripts/diag/flat-fly-study.ts --symbol SPX
 *
 * Output: shared spreads dashboard (signal namespace "FLATFLY 10:00",
 * spread "IB w{pts}") + /tmp/flat-fly-study.json summary.
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import * as fs from 'fs';
import * as path from 'path';

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

// ── Knobs (identical to iron-sweep / time-iron-study) ───────────────────────
const SLIPPAGE_PER_STRUCTURE = 25;                                   // 4-leg entry-side friction + commissions
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? 0.10);
const CLOSE_PENALTY_V = 4 * CLOSE_HALFSPREAD_PER_LEG;                 // pay-through-ask on exit fills
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? 'shorts-fresh') as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;

const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET — forced exit (0DTE intrinsic)
// Entry, as ET clock 'HH:MM' (SWEEP_TIME_START). Default 10:00 — OA's fixed open.
function startSecFromEnv(): number {
  const s = process.env.SWEEP_TIME_START;
  if (!s) return 1800; // 10:00 ET = 30 min after 09:30 open
  const [h, m] = s.split(':').map(Number);
  return (h * 60 + (m || 0) - 9 * 60 - 30) * 60;
}
const TRADESTART_SEC = startSecFromEnv();

// Wing widths in STRIKE COUNTS (× SI → dollars). Default brackets OA's 10-wide.
const WIDTHS_S = (process.env.SWEEP_TIME_WIDTHS ?? '1,2,3,4,5,6,8,10')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);

export interface ExitSpec { label: string; tpFrac: number; slRiskFrac: number; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle', tpFrac: 0,    slRiskFrac: 0    },  // OA's headline: hold to expiration
  { label: 'TP25 only',      tpFrac: 0.25, slRiskFrac: 0    },
  { label: 'TP50 only',      tpFrac: 0.50, slRiskFrac: 0    },
  { label: 'TP25 SL70%',     tpFrac: 0.25, slRiskFrac: 0.70 },
  { label: 'TP50 SL70%',     tpFrac: 0.50, slRiskFrac: 0.70 },
];

// ── Session helpers (verbatim from iron-sweep / time-iron-study) ────────────
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

// ── Strike + price helpers (verbatim) ───────────────────────────────────────
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } }
  return best;
}
export function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }
function markAge(bars: any[], ts: number): number { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return ts - bars[i].ts; return Infinity; }

export interface Leg { bars: any[]; sign: number; strike: number; symbol: string; }
export interface TrajPoint { ts: number; V: number; shortsFresh: boolean; }

// buildTrajectory — verbatim from time-iron-study (incl. shorts-fresh flag).
export function buildTrajectory(legs: Leg[], entryTs: number, endTs: number): TrajPoint[] {
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

// applyExit — verbatim from time-iron-study (TP/SL/hold-to-settle, no flip,
// 0DTE intrinsic settle). closeTs = forced close, settleTs = 15:45 expiry.
export function applyExit(traj: TrajPoint[], closeTs: number, settleTs: number, legs: Leg[], credit: number, tpFrac: number,
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

// prevClose — the ONLY new ingredient vs time-iron-study: the fly's anchor is
// the previous session's closing price = last 1m SPX bar of the prior day.
export function prevClose(prevDaySpxBars: any[] | undefined | null): number | null {
  if (!prevDaySpxBars || !prevDaySpxBars.length) return null;
  return prevDaySpxBars[prevDaySpxBars.length - 1].close ?? null;
}

// shortOffset = 0 → ATM iron butterfly (both shorts at center). shortOffset > 0
// → iron condor: shorts displaced symmetrically OTM (put below, call above),
// each with its own long wing beyond. Default 0 preserves the fly behaviour.
export function buildLegs(c1: any, center: number, wingWidth: number, shortOffset = 0): Leg[] | null {
  const Ksp = center - shortOffset, Klp = center - shortOffset - wingWidth;
  const Ksc = center + shortOffset, Klc = center + shortOffset + wingWidth;
  const sym_sp = findStrike(c1, 'P', Ksp), sym_lp = findStrike(c1, 'P', Klp);
  const sym_sc = findStrike(c1, 'C', Ksc), sym_lc = findStrike(c1, 'C', Klc);
  if (!sym_sp || !sym_lp || !sym_sc || !sym_lc) return null;
  if (new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) return null;
  // Pin strikes to the actually-listed strike of each chosen contract so the
  // intrinsic settle uses the real strike (findStrike snaps to nearest).
  const ks = (sym: string) => c1.contractStrikes.get(sym) as number;
  return [
    { symbol: sym_sp, strike: ks(sym_sp), sign: +1, bars: c1.contractBars.get(sym_sp) as any[] },
    { symbol: sym_lp, strike: ks(sym_lp), sign: -1, bars: c1.contractBars.get(sym_lp) as any[] },
    { symbol: sym_sc, strike: ks(sym_sc), sign: +1, bars: c1.contractBars.get(sym_sc) as any[] },
    { symbol: sym_lc, strike: ks(sym_lc), sign: -1, bars: c1.contractBars.get(sym_lc) as any[] },
  ];
}

function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10); }

// ── Accumulator (schema mirrors iron-sweep so the dashboard ingests it) ──────
interface HourBucket { n: number; creditSum: number; riskSum: number; pnlSum: number; wins: number; }
interface Stat { pnl: number; pnl_gross: number; n: number; wins: number; creditSum: number; widthSum: number;
                 durationSumSec: number; peakConcurrent: number;
                 perHour: Map<number, HourBucket>; daily: Map<string, number>; }
// signal namespace "FLATFLY {HH:MM}" — distinct from iron-sweep's signal rows
// and time-iron-study's "TIME …" rows, so each engine de-dups only its own.
const FLATFLY_NS = `FLATFLY ${process.env.SWEEP_TIME_START ?? '10:00'}`;
function key(w: number, ex: string) { return `${FLATFLY_NS}|IB w${w * SI}|${ex}`; }

// Reversion diagnostic: per wing-width, how often SPX settled within the wing
// of the prior close (i.e. inside the profitable zone of a 0-wide fly).
const within = new Map<number, { in: number; tot: number }>();

function main() {
  const results = new Map<string, Stat>();
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

  const ALL = listDatesFor(TARGET);
  const N = parseInt(process.env.SWEEP_DAYS || '0', 10);
  const DATES = (Number.isFinite(N) && N > 0 && N < ALL.length) ? ALL.slice(-N) : ALL;

  console.error(`[${TARGET.symbol}] FLAT-FLY study — anchor=PREV-CLOSE entry=${process.env.SWEEP_TIME_START ?? '10:00'} ET, dates: ${DATES.length} (of ${ALL.length}), widths: ${WIDTHS_S.map(w => w * SI).join('/')}, exits: ${EXITS.length} | exitGate=${EXIT_GATE} fill=${FILL_MODE}`);

  let skipNoPrev = 0, skipNoData = 0, traded = 0;
  for (let di = 0; di < DATES.length; di++) {
    const date = DATES[di];
    if (di % 20 === 0) console.error(`  ${di}/${DATES.length}  ${date}`);
    let c1: any, p1: any;
    try { c1 = loadDay(TARGET, date, '1m') as any; } catch { skipNoData++; continue; }
    if (!c1?.spxBars?.length) { skipNoData++; continue; }
    try { p1 = loadDay(TARGET, prevDate(date), '1m') as any; } catch { p1 = null; }

    const anchor = prevClose(p1?.spxBars);
    if (anchor == null) { skipNoPrev++; continue; }   // no prior-close → can't anchor the fly

    const s1: any[] = c1.spxBars;
    const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
    setEtHourSessOpen(sess);
    const spxAtSettle = optPx(s1, settle);
    const entryTs = sess + TRADESTART_SEC;
    const dayEvents = new Map<string, Array<{ e: number; x: number }>>();
    traded++;

    for (const wS of WIDTHS_S) {
      const wingWidth = wS * SI;
      // Reversion diagnostic (price-only, independent of fill): did SPX settle
      // within the wing of the prior close?
      if (spxAtSettle != null) {
        let wd = within.get(wingWidth); if (!wd) { wd = { in: 0, tot: 0 }; within.set(wingWidth, wd); }
        wd.tot++; if (Math.abs(spxAtSettle - anchor) <= wingWidth) wd.in++;
      }

      const legs = buildLegs(c1, anchor, wingWidth);
      if (!legs) continue;

      const entriesPx = legs.map(lg => optPx(lg.bars, entryTs - 1));
      if (entriesPx.some(p => p == null)) continue;
      if (ENTRY_STALE_SEC > 0 && legs.some(lg => lg.sign === +1 && markAge(lg.bars, entryTs - 1) > ENTRY_STALE_SEC)) continue;

      const credit = legs.reduce((s, lg, i) => s + lg.sign * (entriesPx[i] as number), 0);
      if (credit <= 0.10) continue;
      if (credit >= wingWidth * 0.95) continue;

      const traj = buildTrajectory(legs, entryTs, settle);
      for (const ex of EXITS) {
        const nat = applyExit(traj, settle, settle, legs, credit, ex.tpFrac, spxAtSettle, wingWidth, ex.slRiskFrac);
        const pnlGross = (credit - nat.exitV) * 100;
        const durationSec = Math.max(0, nat.exitTs - entryTs);
        const k = key(wS, ex.label);
        rec(k, pnlGross, date, credit, wingWidth, entryTs, durationSec);
        let evs = dayEvents.get(k); if (!evs) { evs = []; dayEvents.set(k, evs); }
        evs.push({ e: entryTs, x: nat.exitTs });
      }
    }
    // One fly/day → peak concurrency is 1 (kept for dashboard-schema parity).
    for (const [k, evs] of dayEvents) {
      const pts: Array<{ ts: number; d: number }> = [];
      for (const e of evs) { pts.push({ ts: e.e, d: +1 }); pts.push({ ts: e.x, d: -1 }); }
      pts.sort((a, b) => a.ts - b.ts || a.d - b.d);
      let cur = 0, peak = 0; for (const p of pts) { cur += p.d; if (cur > peak) peak = cur; }
      const v = results.get(k); if (v && peak > v.peakConcurrent) v.peakConcurrent = peak;
    }
  }
  console.error(`  traded ${traded} days; skipped ${skipNoData} (no data) + ${skipNoPrev} (no prior close)`);

  finalizeAndWrite(results, DATES);
}

// ── Report + studio output (iron-sweep schema → shared spreads dashboard) ─────
function finalizeAndWrite(results: Map<string, Stat>, DATES: string[]) {
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

  console.log(`\n${TARGET.symbol} FLAT FLY (prev-close anchored) — ${DATES.length} days. Positive net: ${rows.filter(r => r.pnl > 0).length}/${rows.length}\n`);
  console.log('variant'.padEnd(40), 'n'.padStart(5), 'WR%'.padStart(6), '$net'.padStart(11), '$/tr'.padStart(7), 'cr'.padStart(6), 'ret/DD'.padStart(7), 'maxDD'.padStart(10));
  console.log('-'.repeat(100));
  for (const r of rows.slice(0, 40)) {
    console.log(`${r.signal}|${r.spread}|${r.exit}`.padEnd(40), String(r.n).padStart(5), r.wr.toFixed(1).padStart(6),
      Math.round(r.pnl).toLocaleString().padStart(11), Math.round(r.avgPnlPerTrade).toString().padStart(7),
      r.avgCredit.toFixed(2).padStart(6), r.ratio.toFixed(2).padStart(7), Math.round(-r.dd).toLocaleString().padStart(10));
  }

  // Reversion diagnostic — OA's "1 out of 4 days" claim, by wing width.
  console.log(`\n=== REVERSION: SPX settled within wing of prior close ===`);
  for (const wd of [...within.keys()].sort((a, b) => a - b)) {
    const w = within.get(wd)!;
    console.log(`  within $${String(wd).padStart(3)}:  ${w.in}/${w.tot}  (${(100 * w.in / Math.max(1, w.tot)).toFixed(1)}%)`);
  }

  // ── Merge into the shared studio files. De-dup keyed on THIS run's exact
  // FLATFLY namespace (signal = `FLATFLY {HH:MM}`) so different entry times
  // (e.g. "FLATFLY 10:00" vs "FLATFLY 14:20") COEXIST and each run only
  // replaces its own rows. Never touches iron-sweep's IB/IC rows, time-iron's
  // "TIME …" rows, or credit-spread's 2-leg rows.
  const isFlatFly = (s: any) => String(s || '') === FLATFLY_NS;
  function writeSweep(base: string) {
    const f = outPath(base, TARGET);
    let existing: any[] = []; try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    existing = existing.filter((r: any) => !isFlatFly(r.signal));
    fs.writeFileSync(f, JSON.stringify(existing.concat(rows)));
    return f;
  }
  function writeDaily(base: string) {
    const f = outPath(base, TARGET);
    let ex: any = { dates: [], series: {} }; try { ex = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    for (const kk of Object.keys(ex.series || {})) if (isFlatFly(kk.split('|')[0])) delete ex.series[kk];
    const allDates = new Set<string>(ex.dates || []);
    for (const v of results.values()) for (const d of v.daily.keys()) allDates.add(d);
    const dates = [...allDates].sort(); const di = new Map<string, number>(); dates.forEach((d, i) => di.set(d, i));
    const series: Record<string, number[]> = {};
    for (const kk of Object.keys(ex.series || {})) {
      const oldArr: number[] = ex.series[kk], oldDates: string[] = ex.dates || [];
      const arr = new Array(dates.length).fill(0);
      for (let i = 0; i < oldDates.length; i++) { const idx = di.get(oldDates[i]); if (idx != null) arr[idx] = oldArr[i] || 0; }
      series[kk] = arr;
    }
    for (const [k, v] of results) { const arr = new Array(dates.length).fill(0); for (const [d, p] of v.daily) arr[di.get(d)!] = +p.toFixed(2); series[k] = arr; }
    fs.writeFileSync(f, JSON.stringify({ dates, series }));
  }
  function writeHourly(base: string) {
    const f = outPath(base, TARGET);
    let existing: any[] = []; try { const raw = JSON.parse(fs.readFileSync(f, 'utf8')); existing = Array.isArray(raw) ? raw : Object.values(raw); } catch {}
    existing = existing.filter((r: any) => !isFlatFly(r.signal));
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
  console.log(`\nMerged ${rows.length} FLATFLY variants into the spreads dashboard (sweep + daily + hourly). Filter signal "${FLATFLY_NS}", width via spread "IB w…".`);
  const reversion = [...within.entries()].sort((a, b) => a[0] - b[0]).map(([w, d]) => ({ wing: w, in: d.in, tot: d.tot, pct: +(100 * d.in / Math.max(1, d.tot)).toFixed(1) }));
  fs.writeFileSync('/tmp/flat-fly-study.json', JSON.stringify({ symbol: TARGET.symbol, anchor: 'prev-close', entry: process.env.SWEEP_TIME_START ?? '10:00', days: DATES.length, dateRange: [DATES[0], DATES[DATES.length - 1]], reversion, rows }, null, 2));
}

// Importable-safe: only run the sweep when invoked directly, so tests can
// import the pure helpers (prevClose, applyExit, buildTrajectory) cleanly.
if (process.argv[1] && /flat-fly-study\.ts$/.test(process.argv[1])) main();
