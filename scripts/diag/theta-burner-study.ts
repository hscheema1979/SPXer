/**
 * theta-burner-study.ts
 *
 * Backtest of the Option Alpha "Theta Burner | Laddered 0DTE ICs" strategy:
 * lay on multiple 0DTE iron CONDORS through the day and hold every one to
 * expiration (cash-settled SPX), capturing theta. Unlike time-iron-study.ts
 * (which sells an ATM iron BUTTERFLY at fixed intervals), Theta Burner sells
 * DELTA-TARGETED OTM shorts (~0.35Δ put + ~0.35Δ call) with fixed-width wings —
 * a much wider safe zone and a higher hold-to-expiry win rate.
 *
 * What is faithful to the bot's DEFAULT inputs:
 *   - 0DTE iron condor, short put/call selected by target delta (default 0.35Δ)
 *   - Long legs a fixed strike-distance further OTM (the wing)
 *   - Min Mid Price filter (default 0.35 net credit) + Min Short Strike OTM (0.50)
 *   - "Open Positions Anytime" → time-grid entries through the session
 *   - Hold to expiration, NO exits → 0DTE intrinsic cash-settle at 15:45 ET
 *   - Position Size: 1 contract
 *
 * What is NOT modelled yet (phase 2): the laddering trigger (open a fresh IC when
 * an existing short comes within Short Strike OTM Ladder Threshold of being
 * challenged). With "Open Anytime On" the bot mostly opens on the scan schedule
 * anyway, so the time-grid is a faithful first approximation. Max B/A spread and
 * VIX/price-range safeguards are also out of scope (defaults effectively ignore them).
 *
 * Valuation / friction / fill / 0DTE-settle logic is copied VERBATIM from
 * time-iron-study.ts (itself verbatim from the proven iron-sweep) so results land
 * on the same :3700 spreads dashboard and are apples-to-apples comparable.
 *
 * Dashboard namespace (chosen to coexist with every other study's merge de-dup):
 *   signal = "THETA {iv}m"   (NOT "TIME " → survives time-iron-study's de-dup)
 *   spread = "CND {d}d w{pts}" (NOT IB/IC and no ITM/ATM/OTM → survives
 *            iron-sweep's and credit-spread-sweep's de-dups)
 *
 * Matrix (override via env):
 *   short deltas : 0.30, 0.35, 0.40        (SWEEP_TB_DELTAS, csv of abs deltas)
 *   wing widths  : 5,10,20,30,50 pts       (SWEEP_TB_WINGS, csv of dollar widths)
 *   intervals    : 15,30,60 min            (SWEEP_TIME_INTERVALS, csv minutes)
 *   exits        : hold-to-settle + TP25/TP50 (theta burner is hold-to-settle)
 *
 * Run:
 *   npx tsx scripts/diag/theta-burner-study.ts --symbol SPX            # full history
 *   SWEEP_DAYS=20 npx tsx scripts/diag/theta-burner-study.ts --symbol SPX
 *
 * Output: /tmp/theta-burner-study.json + console table + merged spreads dashboard.
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import { selectStrikeByDelta, selectCallStrikeByDelta, type DeltaCandidate } from './delta-grid';
import * as fs from 'fs';
import * as path from 'path';

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

// ── Knobs (kept identical in spirit to iron-sweep / time-iron-study) ─────────
const SLIPPAGE_PER_STRUCTURE = 25;                                   // 4-leg entry-side friction + commissions
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? 0.10);
const CLOSE_PENALTY_V = 4 * CLOSE_HALFSPREAD_PER_LEG;                 // pay-through-ask on exit fills
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? 'shorts-fresh') as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;
const RISK_FREE_RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

// Theta Burner entry filters (defaults from the bot inputs).
const MIN_MID = Number(process.env.SWEEP_TB_MIN_MID ?? 0.35);        // Min Mid Price (net IC credit)
const MIN_OTM = Number(process.env.SWEEP_TB_MIN_OTM ?? 0.50);        // Min Short Strike OTM Amount ($)

const CUTOFF_HHMM = 6 * 3600;            // 15:30 ET — last allowable entry boundary
const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET — forced exit (0DTE expiry)
// First entry, as ET clock 'HH:MM' (SWEEP_TIME_START). Theta Burner default
// secondary-start is 09:35; we default to 10:00 to match the other studies for
// comparability. Override with SWEEP_TIME_START=09:35 for full faithfulness.
function startSecFromEnv(): number {
  const s = process.env.SWEEP_TIME_START;
  if (!s) return 1800; // 10:00 ET = 30 min after 09:30 open
  const [h, m] = s.split(':').map(Number);
  return (h * 60 + (m || 0) - 9 * 60 - 30) * 60;
}
const TRADESTART_SEC = startSecFromEnv();

// ── Matrix ───────────────────────────────────────────────────────────────────
const INTERVALS_MIN = (process.env.SWEEP_TIME_INTERVALS ?? '15,30,60')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
const SHORT_DELTAS = (process.env.SWEEP_TB_DELTAS ?? '0.30,0.35,0.40')
  .split(',').map(s => parseFloat(s.trim())).filter(n => Number.isFinite(n) && n > 0 && n < 1);
const WING_PTS = (process.env.SWEEP_TB_WINGS ?? '5,10,20,30,50')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);

interface ExitSpec { label: string; tpFrac: number; slRiskFrac: number; maxHoldMin?: number; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle', tpFrac: 0,    slRiskFrac: 0 },   // ← Theta Burner default (no exits)
  { label: 'TP25 only',      tpFrac: 0.25, slRiskFrac: 0 },   // comparison only
  { label: 'TP50 only',      tpFrac: 0.50, slRiskFrac: 0 },   // comparison only
];

// ── Session helpers (verbatim from time-iron-study / iron-sweep) ─────────────
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

// ── Strike + price helpers (verbatim) ────────────────────────────────────────
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

// buildTrajectory — verbatim from time-iron-study (incl. shorts-fresh flag).
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

// applyExit — verbatim from time-iron-study (no flip path; time-based IC).
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

// ── Time-based entry grid (verbatim) ─────────────────────────────────────────
function timeEntries(date: string, intervalMin: number): number[] {
  const sess = sessOpenTs(date);
  const start = sess + TRADESTART_SEC;
  const cutoff = sess + CUTOFF_HHMM;
  const out: number[] = [];
  for (let t = start; t < cutoff; t += intervalMin * 60) out.push(t);
  return out;
}

// ── Delta-targeted iron CONDOR builder ───────────────────────────────────────
// Short put ≈ -targetDelta, short call ≈ +targetDelta (selected from listed
// strikes via BS delta), wings `wingPts` further OTM. Returns legs + the chosen
// short strikes (for the Min-OTM gate). T = real time-to-expiry in YEARS.
function buildCondorLegs(
  c1: any, putCands: DeltaCandidate[], callCands: DeltaCandidate[],
  spot: number, T: number, targetDelta: number, wingPts: number,
): { legs: Leg[]; shortPutK: number; shortCallK: number } | null {
  const sp = selectStrikeByDelta(putCands, targetDelta, spot, T, RISK_FREE_RATE);
  const sc = selectCallStrikeByDelta(callCands, targetDelta, spot, T, RISK_FREE_RATE);
  if (!sp || !sc) return null;
  if (sp.strike >= spot || sc.strike <= spot) return null;       // shorts must straddle spot

  const sym_sp = findStrike(c1, 'P', sp.strike);
  const sym_lp = findStrike(c1, 'P', sp.strike - wingPts);
  const sym_sc = findStrike(c1, 'C', sc.strike);
  const sym_lc = findStrike(c1, 'C', sc.strike + wingPts);
  if (!sym_sp || !sym_lp || !sym_sc || !sym_lc) return null;
  if (new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) return null;

  const Klp = c1.contractStrikes.get(sym_lp) as number;
  const Klc = c1.contractStrikes.get(sym_lc) as number;
  if (Klp >= sp.strike || Klc <= sc.strike) return null;          // long legs must be further OTM

  return {
    legs: [
      { symbol: sym_sp, strike: sp.strike, sign: +1, bars: c1.contractBars.get(sym_sp) as any[] },
      { symbol: sym_lp, strike: Klp,       sign: -1, bars: c1.contractBars.get(sym_lp) as any[] },
      { symbol: sym_sc, strike: sc.strike, sign: +1, bars: c1.contractBars.get(sym_sc) as any[] },
      { symbol: sym_lc, strike: Klc,       sign: -1, bars: c1.contractBars.get(sym_lc) as any[] },
    ],
    shortPutK: sp.strike, shortCallK: sc.strike,
  };
}

// ── Accumulator (schema mirrors time-iron-study so the dashboard ingests it) ──
interface HourBucket { n: number; creditSum: number; riskSum: number; pnlSum: number; wins: number; }
interface Stat { pnl: number; pnl_gross: number; n: number; wins: number; creditSum: number; widthSum: number;
                 durationSumSec: number; peakConcurrent: number;
                 perHour: Map<number, HourBucket>; daily: Map<string, number>; }
const results = new Map<string, Stat>();
// key = `signal|spread|exit`. signal "THETA {iv}m"; spread "CND {d}d w{pts}".
function key(interval: number, delta: number, wingPts: number, ex: string) {
  return `THETA ${interval}m|CND ${Math.round(delta * 100)}d w${wingPts}|${ex}`;
}
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

// ── Main ──────────────────────────────────────────────────────────────────────
const ALL = listDatesFor(TARGET);
const N = parseInt(process.env.SWEEP_DAYS || '0', 10);
const DATES = (Number.isFinite(N) && N > 0 && N < ALL.length) ? ALL.slice(-N) : ALL;

console.error(`[${TARGET.symbol}] Theta-Burner study — dates: ${DATES.length} (of ${ALL.length}), intervals: ${INTERVALS_MIN.join('/')}m, deltas: ${SHORT_DELTAS.join('/')}, wings: ${WING_PTS.join('/')}pt, exits: ${EXITS.length} | minMid=${MIN_MID} minOTM=${MIN_OTM} exitGate=${EXIT_GATE} fill=${FILL_MODE} start=${process.env.SWEEP_TIME_START ?? '10:00'}`);

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
      const spot = optPx(s1, entryTs - 1);
      if (spot == null) continue;

      // Time to expiry in YEARS for the BS delta calc — real seconds to the
      // 15:45 settle, floored at 30 min to keep the IV inversion stable near
      // the close. Used uniformly for selection of both put and call shorts.
      const secsToExp = Math.max(settle - entryTs, 1800);
      const T = secsToExp / (365 * 24 * 3600);

      // Build put + call candidate lists (strike + entry mark) for delta selection.
      const putCands: DeltaCandidate[] = [];
      const callCands: DeltaCandidate[] = [];
      for (const [s] of c1.contractBars) {
        const sym = s as string;
        const k = c1.contractStrikes.get(sym) as number;
        const px = optPx(c1.contractBars.get(sym) as any[], entryTs - 1);
        if (px == null || px <= 0) continue;
        if (sym[sym.length - 9] === 'P') putCands.push({ strike: k, price: px });
        else callCands.push({ strike: k, price: px });
      }
      if (putCands.length < 2 || callCands.length < 2) continue;

      for (const targetDelta of SHORT_DELTAS) {
        for (const wingPts of WING_PTS) {
          const built = buildCondorLegs(c1, putCands, callCands, spot, T, targetDelta, wingPts);
          if (!built) continue;
          const { legs, shortPutK, shortCallK } = built;

          // Min Short Strike OTM gate (default $0.50).
          if (shortPutK > spot - MIN_OTM || shortCallK < spot + MIN_OTM) continue;

          const entriesPx = legs.map(lg => optPx(lg.bars, entryTs - 1));
          if (entriesPx.some(p => p == null)) continue;
          if (ENTRY_STALE_SEC > 0 && legs.some(lg => lg.sign === +1 && markAge(lg.bars, entryTs - 1) > ENTRY_STALE_SEC)) continue;

          const credit = legs.reduce((s, lg, i) => s + lg.sign * (entriesPx[i] as number), 0);
          if (credit < MIN_MID) continue;                          // Min Mid Price filter
          if (credit >= wingPts * 0.95) continue;                  // sanity: credit can't ≈ width

          const traj = buildTrajectory(legs, entryTs, settle);
          for (const ex of EXITS) {
            const closeTs = ex.maxHoldMin ? Math.min(settle, entryTs + ex.maxHoldMin * 60) : settle;
            const nat = applyExit(traj, closeTs, settle, legs, credit, ex.tpFrac, spxAtSettle, wingPts, ex.slRiskFrac);
            const pnlGross = (credit - nat.exitV) * 100;
            const durationSec = Math.max(0, nat.exitTs - entryTs);
            const k = key(intervalMin, targetDelta, wingPts, ex.label);
            rec(k, pnlGross, date, credit, wingPts, entryTs, durationSec);
            let evs = dayEvents.get(k); if (!evs) { evs = []; dayEvents.set(k, evs); }
            evs.push({ e: entryTs, x: nat.exitTs });
          }
        }
      }
    }
  }
  // End-of-day peak concurrency per variant.
  for (const [k, evs] of dayEvents) {
    const pts: Array<{ ts: number; d: number }> = [];
    for (const e of evs) { pts.push({ ts: e.e, d: +1 }); pts.push({ ts: e.x, d: -1 }); }
    pts.sort((a, b) => a.ts - b.ts || a.d - b.d);
    let cur = 0, peak = 0; for (const p of pts) { cur += p.d; if (cur > peak) peak = cur; }
    const v = results.get(k); if (v && peak > v.peakConcurrent) v.peakConcurrent = peak;
  }
}

// ── Report + studio output (mirrors time-iron-study schema) ───────────────────
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

console.log(`\n${TARGET.symbol} Theta-Burner delta condor — ${DATES.length} days. Positive net: ${rows.filter(r => r.pnl > 0).length}/${rows.length}\n`);
console.log('variant'.padEnd(34), 'n'.padStart(5), 'WR%'.padStart(6), '$net'.padStart(11), '$/tr'.padStart(7), 'cr'.padStart(6), 'pkCon'.padStart(6), 'maxDD'.padStart(10));
console.log('-'.repeat(96));
for (const r of rows.slice(0, 40)) {
  console.log(`${r.signal}|${r.spread}|${r.exit}`.padEnd(34), String(r.n).padStart(5), r.wr.toFixed(1).padStart(6),
    Math.round(r.pnl).toLocaleString().padStart(11), Math.round(r.avgPnlPerTrade).toString().padStart(7),
    r.avgCredit.toFixed(2).padStart(6), String(r.peakConcurrent).padStart(6), Math.round(-r.dd).toLocaleString().padStart(10));
}

// ── Merge into the shared studio files. De-dup keyed on the "THETA " signal
// namespace → idempotent, and never touches iron-sweep / time-iron / credit rows.
const isTb = (s: any) => String(s || '').startsWith('THETA ');
function writeSweep(base: string) {
  const f = outPath(base, TARGET);
  let existing: any[] = []; try { existing = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  existing = existing.filter((r: any) => !isTb(r.signal));
  fs.writeFileSync(f, JSON.stringify(existing.concat(rows)));
  return f;
}
function writeDaily(base: string) {
  const f = outPath(base, TARGET);
  let ex: any = { dates: [], series: {} }; try { ex = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  for (const key of Object.keys(ex.series || {})) if (isTb(key.split('|')[0])) delete ex.series[key];
  const allDates = new Set<string>(ex.dates || []);
  for (const v of results.values()) for (const d of v.daily.keys()) allDates.add(d);
  const dates = [...allDates].sort(); const di = new Map<string, number>(); dates.forEach((d, i) => di.set(d, i));
  const series: Record<string, number[]> = {};
  for (const key of Object.keys(ex.series || {})) {
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
  existing = existing.filter((r: any) => !isTb(r.signal));
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
writeSweep('/tmp/credit_spread_sweep.json');
writeSweep(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'));
writeDaily('/tmp/credit_spread_daily.json');
writeDaily(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'));
writeHourly('/tmp/iron_hourly.json');
writeHourly(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'));
console.log(`\nMerged ${rows.length} THETA variants into the spreads dashboard (sweep + daily + hourly). Filter signal "THETA 15m/30m/60m", structure via spread "CND {d}d w{pts}".`);
fs.writeFileSync('/tmp/theta-burner-study.json', JSON.stringify({ symbol: TARGET.symbol, days: DATES.length, dateRange: [DATES[0], DATES[DATES.length - 1]], rows }, null, 2));
