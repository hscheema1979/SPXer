/**
 * smc-credit-sweep.ts
 *
 * TJR / Smart-Money "liquidity sweep + break of structure" (V1) → LONG-ONLY
 * put credit spreads on SPX / NDX. Implements the strategy Revelio Trading
 * reverse-engineered and backtested across two videos:
 *   • https://youtu.be/4uqeKO6KcJk  — coding TJR's SMC strategy (V1 beats V2)
 *   • https://youtu.be/8FJbpSY0R3o  — the rebuild that beat the market
 *
 * Findings encoded here:
 *   • V1 (sweep + BOS, enter immediately) is the profitable core — we do NOT
 *     wait for FVG/order-block retracements (V2, which tested worse).
 *   • Indices are LONG ONLY (shorting an up-drifting index lost out-of-sample
 *     — the one thing the random forest confirmed). So only BULL setups fire,
 *     each expressed as a bull PUT credit spread (the user's nuance: defined-
 *     risk premium instead of shares).
 *   • Exits matter as much as entries. The video's edge came from a TRAILING
 *     stop on the underlying (1R steps), not fixed take-profits. We sweep BOTH
 *     exit families and let the dashboard compare:
 *       (a) the standard credit TP/SL/hold-to-settle menu (theta-decay edge,
 *           matches the house "credit = TP-only" rule), and
 *       (b) underlying-driven exits: trailing-stop (0.5R/1R/2R steps) and a
 *           fixed 1:1 / 1:2 R:R — the video's actual exit logic, applied to
 *           the index and cashing out the spread at its mark when hit.
 *   • No higher-timeframe (daily/weekly) bias filter — it hurt in both videos.
 *
 * Engine borrows the underlying-bar loader, option-chain loader, BS delta-
 * strike selector, spread trajectory + exit logic, and per-shard parallel
 * hooks from tlb-credit-sweep / multi-dte-credit-sweep (friction parity is
 * mandatory — see the cross-engine-friction-parity rule). Material differences:
 *   • Long-only put candidates (no call side loaded).
 *   • SMC sweep+BOS entry, swept across (timeframe × swing-param) signal rows.
 *   • Two exit families (spread-native + underlying-driven).
 *   • Spread label namespace "smcP0.30 w4c" so the dashboard merge regex never
 *     collides with multi-dte ("0.50d w4c") or tlb ("0.50dP w4c") rows.
 *
 * Run via the standard parallel runner:
 *   npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --dte 0 --engine smc-credit
 *   npx tsx scripts/diag/sweep-parallel.ts --symbol NDX --dte 1 --engine smc-credit
 *   …repeat for DTE 0 / 1 / 2 on each symbol.
 * Single-date debug: SWEEP_ALLOW_SERIAL=1 npx tsx scripts/diag/smc-credit-sweep.ts --symbol SPX --dte 0
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile, knownDates } from './sweep-shard';
import { CAP_POLICIES, capDayNet, capSummary, type CapEvent } from './side-cap';
import { geometryForDte } from './sweep-geometry';
import { readDiskCache, type Bar as FlatBar } from './flat-file-reader';
import { tradingDaysBetween, expiryForDate } from './sweep-dates';
import { deriveStrikeInterval } from './strike-grid';
import { selectStrikeByDelta, type DeltaCandidate } from './delta-grid';
import { aggregateIntraday } from './ohlc-aggregate';
import { smcSetupsOnSeries, type SmcParams } from './smc-signal';
import * as fs from 'fs';
import * as path from 'path';

// ── ⛔ RETIRED GUARD (2026-06-16) ────────────────────────────────────────────
// SMC is disabled: its TP results were fill artifacts and it overwrote the live
// dashboard. Refuse to run unless an operator deliberately sets SMC_FORCE_RUN=1.
if (process.env.SMC_FORCE_RUN !== '1') {
  console.error('⛔ smc-credit-sweep is RETIRED (TP-fill artifacts + dashboard overwrite). Set SMC_FORCE_RUN=1 to override deliberately. See memory: project_smc_credit_sweep.');
  process.exit(2);
}

// ── Serial-execution guard (mirrors tlb-credit-sweep) ───────────────────────
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: smc-credit-sweep.ts must NOT be invoked directly.
Use the parallel runner instead:

  npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --dte 0 --engine smc-credit

Override only for single-date debugging: SWEEP_ALLOW_SERIAL=1
`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

// ── DTE-aware geometry (slippage / close half-spread / exit gate defaults) ──
const GEO = geometryForDte(TARGET.dte);
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? GEO.closeHalfSpread);
const CLOSE_PENALTY_V = 2 * CLOSE_HALFSPREAD_PER_LEG;

// ── Structure-scaled ENTRY friction (NOT flat $25 — see the 0DTE-settle
//    feedback). Flat commission under-charges expensive near-ATM legs (we sell
//    0.50Δ ATM put spreads) and over-shrinks vs pricier NDX; scale the combo
//    half-spread by gross premium instead. SWEEP_SLIPPAGE forces a flat value.
//    Defaults are the 4-leg slot-study knobs halved for this 2-leg structure. ─
const FLAT_SLIPPAGE = process.env.SWEEP_SLIPPAGE ? Number(process.env.SWEEP_SLIPPAGE) : null;
const FRIC_COMM   = Number(process.env.SWEEP_COMM ?? 1.3);      // commission per 2-leg spread (entry)
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003); // combo half-spread as frac of gross premium
const FRIC_FLOOR  = Number(process.env.SWEEP_FRIC_FLOOR ?? 4);  // min $/spread (commission + token spread)
// grossPrem = Σ|leg mid|; friction in $/spread.
function entryFriction(grossPrem: number): number {
  if (FLAT_SLIPPAGE != null) return FLAT_SLIPPAGE;
  return Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
}
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? GEO.exitGateDefault) as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';
const RISK_FREE_RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;
const CUTOFF_HHMM = 6 * 3600;             // 15:30 ET — no new entries after this
// 0DTE index options (SPXW / NDXP) are PM-CASH-SETTLED on the 16:00 ET close.
// Settling early (15:45) truncates the last-15-min move and fabricates edge for
// near-ATM structures — see the 0DTE-settle feedback. Data extends to 16:00.
const SETTLE_HHMM = 6 * 3600 + 30 * 60;  // 16:00 ET — real 0DTE settlement
const TRADESTART_SEC = 1800;             // 10:00 ET — earliest setup that counts
const WARMUP_SESSIONS = 8;               // prior 1m sessions for higher-TF pivot lookback

// ── Spread spec: long-only puts, full ATM→OTM short-delta curve, 4 wide. ────
// 0.50 = ATM (max credit / most directional), 0.10 = deep OTM (tail premium).
const SHORT_DELTAS = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50];
const WIDTH_STRIKE_COUNTS = 4;

// ── Bar timeframes to sweep the SMC signal on (minutes). 15m is the video's
//    pick for indices; we bracket it both ways — down to 1m (more setups, more
//    noise) and up to 30m. ──────────────────────────────────────────────────
const TF_MINS = [1, 2, 3, 5, 15, 30] as const;
type TfMin = typeof TF_MINS[number];

// ── Swing-pivot parameter combos. The videos stress that the swing-point
//    lookback is the most consequential (and arbitrary) SMC knob, so we sweep
//    a few reasonable {left,right} pairs as separate signal rows. ────────────
const SWING_COMBOS: Array<{ left: number; right: number }> = [
  { left: 8,  right: 3 },
  { left: 12, right: 4 },
  { left: 20, right: 6 },
];
const MAX_WAIT = 12; // bars from sweep to BOS

// ── Spread-native exit menu (matches tlb / multi-dte so rows align). ────────
interface SpreadExit { kind: 'spread'; label: string; tpFrac: number; slMult: number; slRiskFrac?: number; }
// Underlying-driven exits — the video's actual exit logic on the index.
interface TrailExit  { kind: 'trail'; label: string; stepR: number; }
interface RrExit     { kind: 'rr';    label: string; rr: number; }
type ExitSpec = SpreadExit | TrailExit | RrExit;

// NO-STOP experiment: every stop removed (no spread SL, no underlying trailing
// stop, no fixed-R:R wick stop). Pure premium-collection — losers ride to the
// 16:00 settle and take their full intrinsic loss. This is the honest test of
// whether the high credit-spread win rate has positive expectancy once the
// occasional max-loss tail is paid in full. (Trail/RR exit fns are retained in
// the file for the prior comparison but are not swept here.)
const EXITS: ExitSpec[] = [
  { kind: 'spread', label: 'hold-to-settle', tpFrac: 0,    slMult: 0 },
  { kind: 'spread', label: 'TP10 only',      tpFrac: 0.10, slMult: 0 },
  { kind: 'spread', label: 'TP25 only',      tpFrac: 0.25, slMult: 0 },
  { kind: 'spread', label: 'TP50 only',      tpFrac: 0.50, slMult: 0 },
  { kind: 'spread', label: 'TP75 only',      tpFrac: 0.75, slMult: 0 },
];

// ── Signal matrix: one row per (timeframe × swing combo). ───────────────────
interface SignalSpec { label: string; mins: TfMin; swing: SmcParams; }
const SIGNALS: SignalSpec[] = [];
for (const m of TF_MINS) {
  for (const sw of SWING_COMBOS) {
    SIGNALS.push({ label: `SMC ${m}m ${sw.left}/${sw.right}`, mins: m, swing: { left: sw.left, right: sw.right, maxWait: MAX_WAIT } });
  }
}

// ── Date helpers ────────────────────────────────────────────────────────────
function prevDate(d: string): string {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}

// ── OCC helpers ─────────────────────────────────────────────────────────────
function occExpiryYYMMDD(sym: string): string { return sym.slice(sym.length - 15, sym.length - 9); }
function occStrike(sym: string): number { return parseInt(sym.slice(sym.length - 8), 10) / 1000; }
function expiryToYYMMDD(date: string): string { return date.slice(2).replace(/-/g, ''); }

function loadEntryChainFromDisk(entryDate: string, expiryDate: string, prefix: string):
  { contractBars: Map<string, FlatBar[]>; contractStrikes: Map<string, number> } | null {
  const day = readDiskCache(entryDate, prefix);
  if (!day) return null;
  const wantExp = expiryToYYMMDD(expiryDate);
  const contractBars = new Map<string, FlatBar[]>();
  const contractStrikes = new Map<string, number>();
  for (const [sym, bars] of day) {
    if (occExpiryYYMMDD(sym) !== wantExp) continue;
    contractBars.set(sym, bars);
    contractStrikes.set(sym, occStrike(sym));
  }
  return contractBars.size ? { contractBars, contractStrikes } : null;
}

function preloadCarrySessions(entryDate: string, expiryDate: string, prefix: string): Map<string, FlatBar[]>[] {
  const out: Map<string, FlatBar[]>[] = [];
  for (const d of tradingDaysBetween(entryDate, expiryDate)) {
    const day = readDiskCache(d, prefix);
    if (day) out.push(day);
  }
  return out;
}
function buildLegBars(symbol: string, sessions: Map<string, FlatBar[]>[]): FlatBar[] {
  const all: FlatBar[] = [];
  for (const sess of sessions) { const bars = sess.get(symbol); if (bars) all.push(...bars); }
  return all;
}

// ── Contract helpers ────────────────────────────────────────────────────────
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) {
    const sym = s as string;
    if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    const d = Math.abs(k - targetK);
    if (d < bestD) { bestD = d; best = sym; }
  }
  return best;
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function markAge(bars: any[], ts: number): number {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return ts - bars[i].ts;
  return Infinity;
}

// ── Spread-value trajectory (for the spread-native TP/SL exits) ─────────────
interface TrajPoint { ts: number; V: number; shortFresh: boolean; }
function buildSpreadTrajectory(shortBars: any[], longBars: any[], entryTs: number, endTs: number): TrajPoint[] {
  const tsSet = new Set<number>();
  for (const b of shortBars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  for (const b of longBars)  if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a, b) => a - b);
  const traj: TrajPoint[] = [];
  let si = 0, li = 0;
  let lastShort: number | null = null, lastLong: number | null = null;
  let lastShortTs = -1;
  for (const t of tsList) {
    while (si < shortBars.length && shortBars[si].ts <= t) { lastShort = shortBars[si].close; lastShortTs = shortBars[si].ts; si++; }
    while (li < longBars.length  && longBars[li].ts  <= t) { lastLong  = longBars[li].close; li++; }
    if (lastShort != null && lastLong != null) traj.push({ ts: t, V: lastShort - lastLong, shortFresh: lastShortTs === t });
  }
  return traj;
}

// Put-spread intrinsic at settle (0DTE) or MTM at an exit ts.
function spreadValueAt(reason: 'settle' | 'mtm', shortBars: any[], longBars: any[], ts: number,
                       shortStrike: number, longStrike: number, spxAtSettle: number | null): number {
  if (reason === 'settle' && spxAtSettle != null && TARGET.dte === 0) {
    const v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
    return Math.max(0, v);
  }
  const ps = optPx(shortBars, ts) ?? 0;
  const pl = optPx(longBars,  ts) ?? 0;
  return Math.max(0, (ps - pl) + CLOSE_PENALTY_V);
}

// ── Spread-native exit (TP / SL on the spread mark, else settle) ────────────
function applySpreadExit(traj: TrajPoint[], endTs: number, shortBars: any[], longBars: any[],
                         credit: number, tpFrac: number, slMult: number, slRiskFrac: number,
                         shortStrike: number, longStrike: number, spxAtSettle: number | null, width: number):
                         { exitTs: number, exitV: number, reason: string } {
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slRiskFrac > 0 && width > 0
    ? credit + slRiskFrac * (width - credit)
    : slMult > 0 ? (1 + slMult) * credit : Infinity;
  const slActive = slRiskFrac > 0 || slMult > 0;
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  for (const p of traj) {
    if (p.ts > endTs) break;
    const fillable = !GATE_SHORTS || p.shortFresh;
    if (tpFrac > 0 && p.V <= tpTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? tpV : p.V + CLOSE_PENALTY_V;
      return { exitTs: p.ts, exitV: Math.max(0, exitV), reason: 'TP' };
    }
    if (slActive && p.V >= slTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : p.V + CLOSE_PENALTY_V;
      return { exitTs: p.ts, exitV, reason: 'SL' };
    }
  }
  return { exitTs: endTs, exitV: spreadValueAt('settle', shortBars, longBars, endTs, shortStrike, longStrike, spxAtSettle), reason: 'settle' };
}

// ── Underlying trailing-stop exit (the video's edge), 1R-step grid. ─────────
// Walks the index 1m series from entry→settle. R = entryPx - stopLow. Stop
// starts at the sweep wick; each `stepR` of favourable travel ratchets it up
// (1R reached → breakeven, 2R → +1R, …). Conservative within-bar ordering:
// the stop is tested against this bar's LOW using the stop computed from the
// PRIOR peak, so we never assume an intrabar trail-up rescued a stop-out.
function applyTrailExit(under1m: any[], shortBars: any[], longBars: any[], entryTs: number, endTs: number,
                        entryPx: number, stopLow: number, stepR: number,
                        shortStrike: number, longStrike: number, spxAtSettle: number | null):
                        { exitTs: number, exitV: number, reason: string } {
  const R = entryPx - stopLow;
  if (R <= 0) return { exitTs: endTs, exitV: spreadValueAt('settle', shortBars, longBars, endTs, shortStrike, longStrike, spxAtSettle), reason: 'settle' };
  let stop = stopLow, peak = entryPx;
  for (const b of under1m) {
    if (b.ts <= entryTs) continue;
    if (b.ts > endTs) break;
    if (b.low <= stop) {
      return { exitTs: b.ts, exitV: spreadValueAt('mtm', shortBars, longBars, b.ts, shortStrike, longStrike, spxAtSettle), reason: 'trail' };
    }
    if (b.high > peak) peak = b.high;
    const steps = Math.floor((peak - entryPx) / (stepR * R));
    if (steps >= 1) {
      const newStop = entryPx + (steps - 1) * stepR * R;
      if (newStop > stop) stop = newStop;
    }
  }
  return { exitTs: endTs, exitV: spreadValueAt('settle', shortBars, longBars, endTs, shortStrike, longStrike, spxAtSettle), reason: 'settle' };
}

// ── Fixed R:R exit on the underlying (target = entry + rr·R, stop = wick). ───
function applyRrExit(under1m: any[], shortBars: any[], longBars: any[], entryTs: number, endTs: number,
                     entryPx: number, stopLow: number, rr: number,
                     shortStrike: number, longStrike: number, spxAtSettle: number | null):
                     { exitTs: number, exitV: number, reason: string } {
  const R = entryPx - stopLow;
  if (R <= 0) return { exitTs: endTs, exitV: spreadValueAt('settle', shortBars, longBars, endTs, shortStrike, longStrike, spxAtSettle), reason: 'settle' };
  const target = entryPx + rr * R;
  for (const b of under1m) {
    if (b.ts <= entryTs) continue;
    if (b.ts > endTs) break;
    if (b.low <= stopLow) // stop checked first (conservative)
      return { exitTs: b.ts, exitV: spreadValueAt('mtm', shortBars, longBars, b.ts, shortStrike, longStrike, spxAtSettle), reason: 'stop' };
    if (b.high >= target)
      return { exitTs: b.ts, exitV: spreadValueAt('mtm', shortBars, longBars, b.ts, shortStrike, longStrike, spxAtSettle), reason: 'target' };
  }
  return { exitTs: endTs, exitV: spreadValueAt('settle', shortBars, longBars, endTs, shortStrike, longStrike, spxAtSettle), reason: 'settle' };
}

// ── Aggregation ─────────────────────────────────────────────────────────────
interface HourBucket { n: number; creditSum: number; riskSum: number; pnlSum: number; wins: number; }
interface Stat {
  pnl: number; n: number; wins: number; daily: Map<string, number>; creditSum: number; widthSum: number;
  peakConcurrent: number; evictions: number; durationSumSec: number;
  perHour: Map<number, HourBucket>; capNets: number[];
}
const results = new Map<string, Stat>();
function recK(s: string, sp: string, ex: string) { return `${s}|${sp}|${ex}`; }

let _sessOpenForEtHour = 0;
function setEtHourSessOpen(t: number) { _sessOpenForEtHour = t; }
function etHour(ts: number): number {
  const minSinceOpen = (ts - _sessOpenForEtHour) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}

function rec(s: string, sp: string, ex: string, pnl: number, date: string, credit: number, width: number, durationSec = 0, entryTs = 0, maxRisk = 0) {
  const k = recK(s, sp, ex);
  let v = results.get(k);
  if (!v) {
    v = { pnl: 0, n: 0, wins: 0, daily: new Map(), creditSum: 0, widthSum: 0, peakConcurrent: 0, evictions: 0, durationSumSec: 0, perHour: new Map(), capNets: new Array(CAP_POLICIES.length).fill(0) };
    results.set(k, v);
  }
  v.pnl += pnl; v.n++; if (pnl > 0) v.wins++; v.daily.set(date, (v.daily.get(date) ?? 0) + pnl);
  v.creditSum += credit; v.widthSum += width; v.durationSumSec += durationSec;
  if (entryTs > 0) {
    const h = Math.max(9, Math.min(15, etHour(entryTs)));
    let hb = v.perHour.get(h);
    if (!hb) { hb = { n: 0, creditSum: 0, riskSum: 0, pnlSum: 0, wins: 0 }; v.perHour.set(h, hb); }
    hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl;
    if (pnl > 0) hb.wins++;
  }
}

// ── Date list ──────────────────────────────────────────────────────────────
// SWEEP_ONLY_DATES="2026-06-11,2026-06-10" → restrict to these dates (debug /
// single-date smoke). Empty = full history.
const ONLY = (process.env.SWEEP_ONLY_DATES || '').split(',').map(s => s.trim()).filter(Boolean);
const ALL_DATES_RAW = listDatesFor({ ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any);
const ALL_DATES = ONLY.length ? ALL_DATES_RAW.filter(d => ONLY.includes(d)) : ALL_DATES_RAW;
const SWEEP_DATES = process.env.SWEEP_MERGE ? [] : shardDates(ALL_DATES);
const STATE_FILE = process.env.SWEEP_STATE;
let RUN_DATES = SWEEP_DATES;
if (STATE_FILE && !process.env.SWEEP_MERGE && !process.env.SWEEP_SHARD) {
  const had = mergeStateFile(STATE_FILE, results);
  if (had) {
    const known = knownDates(results);
    RUN_DATES = SWEEP_DATES.filter(d => !known.has(d));
    console.error(`[incremental] state has ${known.size} dates; replaying ${RUN_DATES.length} NEW: ${RUN_DATES.join(',') || '(none)'}`);
  }
}
console.error(`[${TARGET.symbol} DTE${TARGET.dte}] SMC-CREDIT (long-only puts) | Dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD} → ${SWEEP_DATES.length})` : ''} | TFs=${TF_MINS.join('/')} | swings=${SWING_COMBOS.map(s => `${s.left}/${s.right}`).join(',')} | exitGate=${EXIT_GATE} fill=${FILL_MODE}`);

const UNDERLYING_TARGET = { ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` };
const OPTION_PREFIX = TARGET.optionPrefix;

const underlyingDayCache = new Map<string, any[] | null>();
function underlyingBars(d: string): any[] | null {
  if (underlyingDayCache.has(d)) return underlyingDayCache.get(d)!;
  let bars: any[] | null = null;
  try { const dd = loadDay(UNDERLYING_TARGET, d, '1m') as any; bars = dd?.spxBars?.length ? dd.spxBars : null; }
  catch { bars = null; }
  underlyingDayCache.set(d, bars);
  return bars;
}
// Underlying 1m series spanning entry→settle (multi-session for DTE≥1), used by
// the underlying-driven exits.
function buildUnderlyingSpan(entryDate: string, settleDate: string): any[] {
  if (TARGET.dte === 0) return underlyingBars(entryDate) ?? [];
  const all: any[] = [];
  for (const d of tradingDaysBetween(entryDate, settleDate)) { const b = underlyingBars(d); if (b) all.push(...b); }
  return all;
}

(async () => {
for (let di = 0; di < RUN_DATES.length; di++) {
  const date = RUN_DATES[di];
  if (di % 20 === 0) console.error(`  ${di}/${RUN_DATES.length}  ${date}`);
  let c1: any;
  try { c1 = loadDay(UNDERLYING_TARGET, date, '1m') as any; }
  catch { continue; }
  if (!c1?.spxBars?.length) continue;
  underlyingDayCache.set(date, c1.spxBars);

  const expiryDate = expiryForDate(date, TARGET.dte);
  const chain = loadEntryChainFromDisk(date, expiryDate, OPTION_PREFIX);
  if (!chain) continue;
  c1 = { ...c1, contractBars: chain.contractBars, contractStrikes: chain.contractStrikes };

  const carrySessions = TARGET.dte >= 2 ? preloadCarrySessions(date, expiryDate, OPTION_PREFIX) : [];

  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  setEtHourSessOpen(sess);
  const cutoff = sess + CUTOFF_HHMM;
  const settleDate = TARGET.dte >= 1 ? expiryForDate(date, TARGET.dte) : date;
  const settleTs = sessOpenTs(settleDate) + SETTLE_HHMM;
  const spxAtSettle = TARGET.dte === 0 ? optPx(s1, settleTs) : null;
  const underSpan = buildUnderlyingSpan(date, settleDate);

  const overlapMap = new Map<string, CapEvent[]>();

  // Warmup 1m series (prior WARMUP_SESSIONS days) so higher-TF pivots have
  // lookback before the first valid setup.
  const intradayWarmup1m: any[] = [];
  {
    let d = prevDate(date);
    const warmDays: string[] = [];
    for (let i = 0; i < WARMUP_SESSIONS; i++) { warmDays.unshift(d); d = prevDate(d); }
    for (const wd of warmDays) { const wb = underlyingBars(wd); if (wb) intradayWarmup1m.push(...wb); }
  }

  for (const sig of SIGNALS) {
    const allBars1m = [...intradayWarmup1m, ...s1];
    const tfBars = aggregateIntraday(allBars1m, sig.mins, sess)
      .map(b => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
    if (tfBars.length < sig.swing.left + sig.swing.right + 2) continue;
    const setups = smcSetupsOnSeries(tfBars, sig.swing);
    // First BULL setup ≥ 10:00 ET — long only, one entry per day per signal row.
    const firstBull = setups.find(e => e.dir === 'bull' && e.ts >= sess + TRADESTART_SEC && e.ts < cutoff);
    if (!firstBull) continue;

    // Aggregated bar.ts is the bucket OPEN; the BOS is only known at bucket
    // CLOSE = ts + tfSeconds. Enter there — never at the open (look-ahead).
    const entryTs = firstBull.ts + sig.mins * 60;
    if (entryTs >= cutoff) continue;

    const spxEntry = optPx(s1, entryTs - 1);
    if (spxEntry == null) continue;

    // Strike grid near spot from the listed put chain.
    const allStrikes: number[] = [];
    for (const [s] of c1.contractBars) {
      const sym = s as string;
      if (sym[sym.length - 9] !== 'P') continue;
      const k = c1.contractStrikes.get(sym);
      if (typeof k === 'number') allStrikes.push(k);
    }
    const grid = deriveStrikeInterval(allStrikes, spxEntry) ?? SI;
    const T = Math.max(TARGET.dte, 0.25) / 252;

    // Put candidates (strike, mark) at entry.
    const candidates: DeltaCandidate[] = [];
    const strikeToSym = new Map<number, string>();
    for (const [s] of c1.contractBars) {
      const sym = s as string;
      if (sym[sym.length - 9] !== 'P') continue;
      const k = c1.contractStrikes.get(sym) as number;
      const px = optPx(c1.contractBars.get(sym) as any[], entryTs - 1);
      if (px == null || px <= 0) continue;
      candidates.push({ strike: k, price: px });
      strikeToSym.set(k, sym);
    }
    if (candidates.length < 2) continue;

    for (const shortDelta of SHORT_DELTAS) {
      const shortSel = selectStrikeByDelta(candidates, shortDelta, spxEntry, T, RISK_FREE_RATE);
      if (!shortSel) continue;
      const shortStrike = shortSel.strike;
      const shortSym = strikeToSym.get(shortStrike)!;

      // Long leg: WIDTH_STRIKE_COUNTS further OTM (lower strike for a put).
      const longSym = findStrike(c1, 'P', shortStrike - WIDTH_STRIKE_COUNTS * grid);
      if (!longSym || longSym === shortSym) continue;
      const longStrike = c1.contractStrikes.get(longSym) as number;
      if (!(longStrike < shortStrike)) continue;
      const spreadWidth = shortStrike - longStrike;
      if (spreadWidth <= 0) continue;

      let shortBars: any[], longBars: any[];
      if (TARGET.dte >= 2) { shortBars = buildLegBars(shortSym, carrySessions); longBars = buildLegBars(longSym, carrySessions); }
      else { shortBars = c1.contractBars.get(shortSym) as any[]; longBars = c1.contractBars.get(longSym) as any[]; }

      const shortEntry = optPx(shortBars, entryTs - 1);
      const longEntry  = optPx(longBars,  entryTs - 1);
      if (shortEntry == null || longEntry == null) continue;
      if (ENTRY_STALE_SEC > 0 && markAge(shortBars, entryTs - 1) > ENTRY_STALE_SEC) continue;
      const credit = shortEntry - longEntry;
      if (credit <= 0.05) continue;
      if (credit > spreadWidth * 0.95) continue;

      const spreadLabel = `smcP${shortDelta.toFixed(2)} w${WIDTH_STRIKE_COUNTS}c`;
      const traj = buildSpreadTrajectory(shortBars, longBars, entryTs, settleTs);

      for (const ex of EXITS) {
        let nat: { exitTs: number, exitV: number, reason: string };
        if (ex.kind === 'spread') {
          nat = applySpreadExit(traj, settleTs, shortBars, longBars, credit, ex.tpFrac, ex.slMult, ex.slRiskFrac ?? 0, shortStrike, longStrike, spxAtSettle, spreadWidth);
        } else if (ex.kind === 'trail') {
          nat = applyTrailExit(underSpan, shortBars, longBars, entryTs, settleTs, spxEntry, firstBull.stopLow, ex.stepR, shortStrike, longStrike, spxAtSettle);
        } else {
          nat = applyRrExit(underSpan, shortBars, longBars, entryTs, settleTs, spxEntry, firstBull.stopLow, ex.rr, shortStrike, longStrike, spxAtSettle);
        }
        const grossPrem = Math.abs(shortEntry) + Math.abs(longEntry); // Σ|leg mid|
        const pnl = (credit - nat.exitV) * 100 - entryFriction(grossPrem);
        const durationSec = Math.max(0, nat.exitTs - entryTs);
        const maxRisk = (spreadWidth - credit) * 100;
        rec(sig.label, spreadLabel, ex.label, pnl, date, credit, spreadWidth, durationSec, entryTs, maxRisk);

        const k = `${sig.label}|${spreadLabel}|${ex.label}`;
        let evs = overlapMap.get(k); if (!evs) { evs = []; overlapMap.set(k, evs); }
        evs.push({ entry: entryTs, exit: nat.exitTs, side: 'put', pnl });
      }
    }
  }

  for (const [k, evs] of overlapMap) {
    if (evs.length === 0) continue;
    const stat = results.get(k); if (!stat) continue;
    const events: Array<{ ts: number, delta: number }> = [];
    for (const e of evs) { events.push({ ts: e.entry, delta: +1 }); events.push({ ts: e.exit, delta: -1 }); }
    events.sort((a, b) => a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts);
    let cur = 0, peak = 0;
    for (const e of events) { cur += e.delta; if (cur > peak) peak = cur; }
    if (peak > stat.peakConcurrent) stat.peakConcurrent = peak;
    for (let i = 0; i < CAP_POLICIES.length; i++) stat.capNets[i] += capDayNet(evs, CAP_POLICIES[i].pool, CAP_POLICIES[i].c, CAP_POLICIES[i].p);
  }
  overlapMap.clear();
}

finalize();

})().catch(err => { console.error('SMC-credit sweep error:', err); process.exit(1); });

// ── Finalize / dashboard merge ──────────────────────────────────────────────
// Dedup namespace: this engine owns every spread label matching /smcP\d/.
// Declared as hoisted functions so finalize() (called from the IIFE above) can
// reference them regardless of source order.
function isSmcSpread(s: string): boolean { return /smcP\d/.test(s); }
function isSmcKey(k: string): boolean { const parts = k.split('|'); return parts.length >= 2 && isSmcSpread(parts[1]); }

function finalize() {
  if (process.env.SWEEP_SHARD_OUT) { dumpResults(results, process.env.SWEEP_SHARD_OUT); return; }
  if (process.env.SWEEP_MERGE) { loadShardsInto(process.env.SWEEP_MERGE, results); }

  const rows = summary();

  const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
  let existing: any[] = [];
  try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON, 'utf8')); } catch {}
  existing = existing.filter((r: any) => !isSmcSpread(String(r.spread || '')));
  const merged = existing.concat(rows);
  fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged, null, 2));
  const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
  try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}
  console.log(`\nMerged: ${existing.length} prior + ${rows.length} new (SMC-credit) = ${merged.length}`);

  // Daily series.
  const allDates = new Set<string>();
  for (const v of results.values()) for (const d of v.daily.keys()) allDates.add(d);
  const dates = [...allDates].sort();
  const di = new Map<string, number>(); dates.forEach((d, i) => di.set(d, i));
  const series: Record<string, number[]> = {};
  for (const [k, v] of results) {
    const arr = new Array(dates.length).fill(0);
    for (const [d, p] of v.daily) arr[di.get(d)!] = +p.toFixed(2);
    series[k] = arr;
  }
  const DAILY_JSON = outPath('/tmp/credit_spread_daily.json', TARGET);
  let existingDaily: any = { dates: [], series: {} };
  try { existingDaily = JSON.parse(fs.readFileSync(DAILY_JSON, 'utf8')); } catch {}
  for (const k of Object.keys(existingDaily.series || {})) if (isSmcKey(k)) delete existingDaily.series[k];
  const allDatesSet = new Set<string>(existingDaily.dates || []);
  for (const d of dates) allDatesSet.add(d);
  const mergedDates = [...allDatesSet].sort();
  const mDi = new Map<string, number>(); mergedDates.forEach((d, i) => mDi.set(d, i));
  const mergedSeries: Record<string, number[]> = {};
  for (const k of Object.keys(existingDaily.series || {})) {
    const oldArr: number[] = existingDaily.series[k];
    const oldDates: string[] = existingDaily.dates || [];
    const newArr = new Array(mergedDates.length).fill(0);
    for (let i = 0; i < oldDates.length; i++) { const idx = mDi.get(oldDates[i]); if (idx != null) newArr[idx] = oldArr[i] || 0; }
    mergedSeries[k] = newArr;
  }
  for (const k of Object.keys(series)) {
    const oldArr = series[k];
    const newArr = new Array(mergedDates.length).fill(0);
    for (let i = 0; i < dates.length; i++) { const idx = mDi.get(dates[i]); if (idx != null) newArr[idx] = oldArr[i] || 0; }
    mergedSeries[k] = newArr;
  }
  fs.writeFileSync(DAILY_JSON, JSON.stringify({ dates: mergedDates, series: mergedSeries }));
  const STUDIO_DAILY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'), TARGET);
  try { fs.writeFileSync(STUDIO_DAILY, JSON.stringify({ dates: mergedDates, series: mergedSeries })); } catch {}
  console.log(`Daily merged: ${mergedDates.length} dates × ${Object.keys(mergedSeries).length} variants`);

  // Per-hour aggregates.
  const HOURLY_JSON   = outPath('/tmp/credit_spread_hourly.json', TARGET);
  const STUDIO_HOURLY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'), TARGET);
  const smcHourly: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    const byHour: any = {};
    for (const [h, hb] of v.perHour) {
      byHour[h] = {
        n: hb.n,
        avgCredit: +(hb.creditSum / Math.max(1, hb.n)).toFixed(3),
        avgRisk:   +(hb.riskSum   / Math.max(1, hb.n)).toFixed(0),
        avgPnl:    +(hb.pnlSum    / Math.max(1, hb.n)).toFixed(2),
        wr:        +(100 * hb.wins / Math.max(1, hb.n)).toFixed(1),
      };
    }
    smcHourly.push({ signal, spread, exit, hours: byHour });
  }
  let existingHourly: any[] = [];
  try { existingHourly = JSON.parse(fs.readFileSync(HOURLY_JSON, 'utf8')); } catch {}
  existingHourly = existingHourly.filter((e: any) => !isSmcSpread(String(e.spread || '')));
  const mergedHourly = existingHourly.concat(smcHourly);
  fs.writeFileSync(HOURLY_JSON, JSON.stringify(mergedHourly));
  try { fs.writeFileSync(STUDIO_HOURLY, JSON.stringify(mergedHourly)); } catch {}

  if (process.env.SWEEP_STATE) {
    dumpResults(results, process.env.SWEEP_STATE);
    console.error(`[incremental] state → ${process.env.SWEEP_STATE}`);
  }
}

function summary() {
  const rows: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    const dailyArr = [...v.daily.values()];
    let cum = 0, peak = 0, mdd = 0;
    for (const dp of dailyArr) { cum += dp; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
    const pos = dailyArr.filter(x => x > 0.1).length;
    const wr = 100 * v.wins / Math.max(1, v.n);
    const ratio = mdd >= 100 ? Math.min(100, v.pnl / mdd) : (v.pnl > 0 ? 100 : 0);
    const avgCredit = v.creditSum / Math.max(1, v.n);
    const avgWidth  = v.widthSum  / Math.max(1, v.n);
    const avgMaxRisk = (avgWidth - avgCredit) * 100;
    const avgDurMin = v.n > 0 ? (v.durationSumSec / v.n / 60) : 0;
    const SESSION_SEC = 20700;
    const numActiveDays = v.daily.size;
    const avgConcurrent = (numActiveDays > 0) ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2) : 0;
    const avgRiskCapacity = +(avgConcurrent * avgMaxRisk).toFixed(0);
    const cap = capSummary(v.capNets, 'call', 'put');
    rows.push({
      signal, spread, exit, pnl: v.pnl, n: v.n, wr, dd: mdd, ratio, pos,
      ...cap,
      avgCredit: +avgCredit.toFixed(3),
      avgMaxRisk: +avgMaxRisk.toFixed(0),
      avgPnlPerTrade: +(v.pnl / Math.max(1, v.n)).toFixed(2),
      peakConcurrent: v.peakConcurrent,
      evictions: v.evictions,
      peakRiskCapacity: +(v.peakConcurrent * avgMaxRisk).toFixed(0),
      avgConcurrent, avgRiskCapacity, numActiveDays,
      avgDurMin: +avgDurMin.toFixed(1),
      fillModel: FILL_MODE,
      fillHalfSpread: CLOSE_HALFSPREAD_PER_LEG,
      exitGate: EXIT_GATE,
      entryStaleSec: ENTRY_STALE_SEC,
    });
  }
  rows.sort((a, b) => b.pnl - a.pnl);
  const fricDesc = FLAT_SLIPPAGE != null ? `flat $${FLAT_SLIPPAGE}` : `scaled (comm $${FRIC_COMM} + ${FRIC_HSFRAC}·gross, floor $${FRIC_FLOOR})`;
  console.log(`\n=== SMC-CREDIT SWEEP (TJR sweep+BOS → long-only put spreads, entry friction ${fricDesc}) ===`);
  console.log(`Variants: ${rows.length}.  Positive net: ${rows.filter(r => r.pnl > 0).length}.\n`);
  console.log(`${'Signal'.padEnd(16)} ${'Spread'.padEnd(13)} ${'Exit'.padEnd(15)} ${'$Net'.padStart(11)} ${'N'.padStart(5)} ${'WR%'.padStart(5)} ${'$DD'.padStart(9)} ${'Ratio'.padStart(6)} ${'+days'.padStart(5)}`);
  console.log('-'.repeat(100));
  for (const r of rows.slice(0, 30)) {
    console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(13)} ${r.exit.padEnd(15)} $${(r.pnl >= 0 ? '+' : '') + Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  return rows;
}
