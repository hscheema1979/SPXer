/**
 * tlb-credit-sweep.ts
 *
 * Bidirectional short credit-spread study driven by LuxAlgo's "Trendlines
 * with Breaks" indicator (see tlb-signal.ts for the detector). Sells premium
 * on the OPPOSITE side of the break:
 *   Upper break (bullish "B")  → short PUT credit spread
 *   Lower break (bearish "B")  → short CALL credit spread
 *
 * Test matrix (locked at user request):
 *   DTE          = 0, 1, 2
 *   short delta  = 0.50 (≈ ATM)
 *   width        = 4 strike-counts
 *   TLB params   = length 14, mult 1.0, ATR slope  (LuxAlgo defaults)
 *   timeframes   = 3m, 5m, 15m, 30m, 60m  (each a separate signal row)
 *   exits        = full TP/SL menu (mirrors multi-dte-credit-sweep)
 *   entry window = first break ≥ 10:00 ET, one entry per direction per day
 *
 * Engine borrows the underlying-bar loader, option-chain loader, delta-strike
 * selector, trajectory builder, and exit logic from multi-dte-credit-sweep
 * (and shares the same per-shard parallel hooks via sweep-shard.ts). The
 * only material differences:
 *   • Bidirectional candidate pools (puts AND calls loaded per date)
 *   • TLB-driven entry events, evaluated on multiple bar timeframes
 *   • Spread label includes a side tag ("0.50dC w4c" / "0.50dP w4c") so the
 *     dashboard merge regex doesn't collide with the multi-dte put-only rows.
 *
 * Run via the standard parallel runner:
 *   npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --dte 0 --engine tlb-credit
 *   npx tsx scripts/diag/sweep-parallel.ts --symbol NDX --dte 1 --engine tlb-credit
 *   …repeat for DTE 0 / 1 / 2 on each symbol.
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
import { tlbBreaksOnSeries, TLB_DEFAULTS, type TlbBreak } from './tlb-signal';
import * as fs from 'fs';
import * as path from 'path';

// ── Serial-execution guard (mirrors multi-dte-credit-sweep) ─────────────────
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: tlb-credit-sweep.ts must NOT be invoked directly.
Use the parallel runner instead:

  npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --dte 0 --engine tlb-credit

Override only for single-date debugging: SWEEP_ALLOW_SERIAL=1
`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

// ── DTE-aware geometry (slippage / close half-spread / exit gate defaults) ──
const GEO = geometryForDte(TARGET.dte);

const SLIPPAGE_PER_SPREAD = Number(process.env.SWEEP_SLIPPAGE ?? GEO.entrySlippage2leg);
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? GEO.closeHalfSpread);
const CLOSE_PENALTY_V = 2 * CLOSE_HALFSPREAD_PER_LEG;
const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';

const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? GEO.exitGateDefault) as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';

const RISK_FREE_RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;
const CUTOFF_HHMM = 6 * 3600;            // 15:30 ET — no new entries after this
const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET — force-exit window
const TRADESTART_SEC = 1800;             // 10:00 ET — earliest TLB break that counts
const WARMUP_SESSIONS = 8;               // prior 1m sessions loaded so the higher-TF TLB has lookback

// ── Locked spread spec: 0.50Δ short, 4 strikes wide, one variant per side. ──
const SHORT_DELTA = 0.50;
const WIDTH_STRIKE_COUNTS = 4;

// ── Bar timeframes to sweep TLB on (minutes). ───────────────────────────────
const TF_MINS = [3, 5, 15, 30, 60] as const;
type TfMin = typeof TF_MINS[number];

// ── Exit menu (matches multi-dte-credit-sweep so rows align in the UI). ─────
interface ExitSpec { label: string; tpFrac: number; slMult: number; slRiskFrac?: number; useFlip: boolean; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle',  tpFrac: 0,    slMult: 0,   useFlip: false },
  { label: 'TP5 only',        tpFrac: 0.05, slMult: 0,   useFlip: false },
  { label: 'TP10 only',       tpFrac: 0.10, slMult: 0,   useFlip: false },
  { label: 'TP15 only',       tpFrac: 0.15, slMult: 0,   useFlip: false },
  { label: 'TP25 only',       tpFrac: 0.25, slMult: 0,   useFlip: false },
  { label: 'TP35 only',       tpFrac: 0.35, slMult: 0,   useFlip: false },
  { label: 'TP50 only',       tpFrac: 0.50, slMult: 0,   useFlip: false },
  { label: 'TP75 only',       tpFrac: 0.75, slMult: 0,   useFlip: false },
  { label: 'TP15 SL50%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP15 SL70%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP25 SL50%',      tpFrac: 0.25, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP25 SL70%',      tpFrac: 0.25, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
];

// ── Signal matrix: one signal row per timeframe. ────────────────────────────
// Label encodes the indicator + TF, e.g. "TLB 5m". The dashboard sorts by
// label so this groups cleanly next to existing HMA/DEMA rows.
interface SignalSpec { label: string; mins: TfMin; }
const SIGNALS: SignalSpec[] = TF_MINS.map(m => ({ label: `TLB ${m}m`, mins: m }));

// ── Date list ───────────────────────────────────────────────────────────────
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
function occType(sym: string): 'C' | 'P' { return sym[sym.length - 9] as 'C' | 'P'; }
function occStrike(sym: string): number { return parseInt(sym.slice(sym.length - 8), 10) / 1000; }
function expiryToYYMMDD(date: string): string { return date.slice(2).replace(/-/g, ''); }

// Build the entry-day option CHAIN for BOTH puts and calls of the target
// expiry from the local disk cache.
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
  const sessionDates = tradingDaysBetween(entryDate, expiryDate);
  const out: Map<string, FlatBar[]>[] = [];
  for (const d of sessionDates) {
    const day = readDiskCache(d, prefix);
    if (day) out.push(day);
  }
  return out;
}

function buildLegBars(symbol: string, sessions: Map<string, FlatBar[]>[]): FlatBar[] {
  const all: FlatBar[] = [];
  for (const sess of sessions) {
    const bars = sess.get(symbol);
    if (bars) all.push(...bars);
  }
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
function listStrikes(c1: any, type: 'C' | 'P'): number[] {
  const out: number[] = [];
  for (const [s] of c1.contractBars) {
    const sym = s as string;
    if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    if (typeof k === 'number') out.push(k);
  }
  return out;
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function markAge(bars: any[], ts: number): number {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return ts - bars[i].ts;
  return Infinity;
}

// ── Spread-value trajectory ─────────────────────────────────────────────────
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

function applyExit(traj: TrajPoint[], endTs: number,
                   shortBars: any[], longBars: any[],
                   credit: number, tpFrac: number, slMult: number, flipTs: number,
                   isCallSpread: boolean, shortStrike: number, longStrike: number,
                   spxAtSettle: number | null, width: number = 0, slRiskFrac: number = 0):
                   { exitTs: number, exitV: number, reason: string } {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slRiskFrac > 0 && width > 0
    ? credit + slRiskFrac * (width - credit)
    : slMult > 0 ? (1 + slMult) * credit : Infinity;
  const slActive = slRiskFrac > 0 || slMult > 0;
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  for (const p of traj) {
    if (p.ts > effEnd) break;
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
  // 0DTE expiry: intrinsic settle. Higher DTE: real MTM at settle ts.
  if (effEnd === endTs && spxAtSettle != null && TARGET.dte === 0) {
    let v: number;
    if (isCallSpread) {
      v = Math.max(0, spxAtSettle - shortStrike) - Math.max(0, spxAtSettle - longStrike);
    } else {
      v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
    }
    return { exitTs: effEnd, exitV: Math.max(0, v), reason: 'expiry' };
  }
  const ps = optPx(shortBars, effEnd) ?? 0;
  const pl = optPx(longBars,  effEnd) ?? 0;
  return { exitTs: effEnd, exitV: Math.max(0, (ps - pl) + CLOSE_PENALTY_V), reason: effEnd === endTs ? 'settle-mtm' : 'flip' };
}

// ── Aggregation ─────────────────────────────────────────────────────────────
interface HourBucket { n: number; creditSum: number; riskSum: number; pnlSum: number; wins: number; }
interface Stat {
  pnl: number; n: number; wins: number; daily: Map<string, number>; creditSum: number; widthSum: number;
  peakConcurrent: number; evictions: number;
  durationSumSec: number;
  perHour: Map<number, HourBucket>;
  capNets: number[];
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
  v.creditSum += credit; v.widthSum += width;
  v.durationSumSec += durationSec;
  if (entryTs > 0) {
    const h = Math.max(9, Math.min(15, etHour(entryTs)));
    let hb = v.perHour.get(h);
    if (!hb) { hb = { n: 0, creditSum: 0, riskSum: 0, pnlSum: 0, wins: 0 }; v.perHour.set(h, hb); }
    hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl;
    if (pnl > 0) hb.wins++;
  }
}

// ── Date list ──────────────────────────────────────────────────────────────
const ALL_DATES = listDatesFor({ ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any);
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
console.error(`[${TARGET.symbol} DTE${TARGET.dte}] TLB-CREDIT | Dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD} → ${SWEEP_DATES.length})` : ''} | TFs=${TF_MINS.join('/')} | spread=${SHORT_DELTA}d w${WIDTH_STRIKE_COUNTS}c | exitGate=${EXIT_GATE} fill=${FILL_MODE}`);

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

  const overlapMap = new Map<string, CapEvent[]>();

  // Build the warmup 1m series (prior WARMUP_SESSIONS days + current day up to
  // session start) once per date — TLB on 30m/60m needs a few days of bars to
  // form a confirmed pivot before the first valid break.
  const intradayWarmup1m: any[] = [];
  {
    let d = prevDate(date);
    const warmDays: string[] = [];
    for (let i = 0; i < WARMUP_SESSIONS; i++) { warmDays.unshift(d); d = prevDate(d); }
    for (const wd of warmDays) {
      const wb = underlyingBars(wd);
      if (wb) intradayWarmup1m.push(...wb);
    }
  }

  for (const sig of SIGNALS) {
    // Aggregate 1m → sig.mins for the warmup span + current day, anchored to
    // 09:30 ET. We feed TLB the FULL bar series; a break event "fires" at the
    // bar's close ts. The earliest event with bar.ts ≥ sess+TRADESTART_SEC
    // (10:00 ET) is the trade entry for that direction.
    const allBars1m = [...intradayWarmup1m, ...s1];
    const tfBars = aggregateIntraday(allBars1m, sig.mins, sess)
      .map(b => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
    if (tfBars.length < 3 * TLB_DEFAULTS.length) continue;
    const breaks = tlbBreaksOnSeries(tfBars, TLB_DEFAULTS);
    // First break ≥ 10:00 ET per direction (one entry per side per day).
    const firstBull = breaks.find(b => b.ts >= sess + TRADESTART_SEC && b.ts < cutoff && b.dir === 'bull');
    const firstBear = breaks.find(b => b.ts >= sess + TRADESTART_SEC && b.ts < cutoff && b.dir === 'bear');

    for (const event of [firstBull, firstBear]) {
      if (!event) continue;
      // Entry ts is the close of the TLB bar where the break occurred. TLB
      // bars are aggregated, so bar.ts is the bucket OPEN; the break is only
      // known at bucket CLOSE = bar.ts + sig.mins*60. Trade at the close.
      const entryTs = event.ts + sig.mins * 60;
      if (entryTs >= cutoff) continue;

      const spxEntry = optPx(s1, entryTs - 1);
      if (spxEntry == null) continue;

      // Direction → side. Bull break sells PUTs; bear break sells CALLs.
      const isCallSpread = event.dir === 'bear';
      const shortLetter: 'C' | 'P' = isCallSpread ? 'C' : 'P';

      // Real local strike interval near spot from the listed chain.
      const allStrikes = listStrikes(c1, shortLetter);
      const grid = deriveStrikeInterval(allStrikes, spxEntry) ?? SI;

      const T = Math.max(TARGET.dte, 0.25) / 252;

      // Build candidate (strike, mark) list for the active side at entry.
      const candidates: DeltaCandidate[] = [];
      const strikeToSym = new Map<number, string>();
      for (const [s] of c1.contractBars) {
        const sym = s as string;
        if (sym[sym.length - 9] !== shortLetter) continue;
        const k = c1.contractStrikes.get(sym) as number;
        const bars = c1.contractBars.get(sym) as any[];
        const px = optPx(bars, entryTs - 1);
        if (px == null || px <= 0) continue;
        candidates.push({ strike: k, price: px });
        strikeToSym.set(k, sym);
      }
      if (candidates.length < 2) continue;

      // selectStrikeByDelta returns the strike whose BS |delta| is nearest the
      // target. Bull (put) and bear (call) both target 0.50Δ ≈ ATM.
      const shortSel = selectStrikeByDelta(candidates, SHORT_DELTA, spxEntry, T, RISK_FREE_RATE);
      if (!shortSel) continue;
      const shortStrike = shortSel.strike;
      const shortSym = strikeToSym.get(shortStrike)!;

      // Long leg: 4 strike-counts further OTM (lower strike for put, higher
      // for call), snapped to a listed contract distinct from the short.
      const longK_target = isCallSpread
        ? shortStrike + WIDTH_STRIKE_COUNTS * grid
        : shortStrike - WIDTH_STRIKE_COUNTS * grid;
      const longSym = findStrike(c1, shortLetter, longK_target);
      if (!longSym || longSym === shortSym) continue;
      const longStrike = c1.contractStrikes.get(longSym) as number;
      const longIsFurtherOtm = isCallSpread ? longStrike > shortStrike : longStrike < shortStrike;
      if (!longIsFurtherOtm) continue;
      const spreadWidth = Math.abs(shortStrike - longStrike);
      if (spreadWidth <= 0) continue;

      let shortBars: any[], longBars: any[];
      if (TARGET.dte >= 2) {
        shortBars = buildLegBars(shortSym, carrySessions);
        longBars  = buildLegBars(longSym,  carrySessions);
      } else {
        shortBars = c1.contractBars.get(shortSym) as any[];
        longBars  = c1.contractBars.get(longSym)  as any[];
      }

      const shortEntry = optPx(shortBars, entryTs - 1);
      const longEntry  = optPx(longBars,  entryTs - 1);
      if (shortEntry == null || longEntry == null) continue;
      if (ENTRY_STALE_SEC > 0 && markAge(shortBars, entryTs - 1) > ENTRY_STALE_SEC) continue;
      const credit = shortEntry - longEntry;
      if (credit <= 0.05) continue;
      if (credit > spreadWidth * 0.95) continue;

      // Spread label: "0.50dC w4c" (call-credit) or "0.50dP w4c" (put-credit).
      // The side tag protects against label collision with multi-dte-credit's
      // "0.50d w4c" rows in the merged dashboard JSON.
      const spreadLabel = `${SHORT_DELTA.toFixed(2)}d${isCallSpread ? 'C' : 'P'} w${WIDTH_STRIKE_COUNTS}c`;

      const traj = buildSpreadTrajectory(shortBars, longBars, entryTs, settleTs);

      for (const ex of EXITS) {
        const nat = applyExit(traj, settleTs, shortBars, longBars, credit,
                              ex.tpFrac, ex.slMult, Infinity,
                              isCallSpread, shortStrike, longStrike, spxAtSettle,
                              spreadWidth, ex.slRiskFrac ?? 0);
        const pnl = (credit - nat.exitV) * 100 - SLIPPAGE_PER_SPREAD;
        const durationSec = Math.max(0, nat.exitTs - entryTs);
        const maxRisk = (spreadWidth - credit) * 100;
        rec(sig.label, spreadLabel, ex.label, pnl, date, credit, spreadWidth, durationSec, entryTs, maxRisk);

        const k = `${sig.label}|${spreadLabel}|${ex.label}`;
        let evs = overlapMap.get(k); if (!evs) { evs = []; overlapMap.set(k, evs); }
        evs.push({ entry: entryTs, exit: nat.exitTs, side: isCallSpread ? 'call' : 'put', pnl });
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

})().catch(err => {
  console.error('TLB-credit sweep error:', err);
  process.exit(1);
});

// ── Finalize / dashboard merge ──────────────────────────────────────────────
function finalize() {
  // Shard-out path: dump partial accumulator, no dashboard write.
  if (process.env.SWEEP_SHARD_OUT) {
    dumpResults(results, process.env.SWEEP_SHARD_OUT);
    return;
  }
  // Merge path: fold all shard dumps into `results`, then write dashboard.
  if (process.env.SWEEP_MERGE) {
    loadShardsInto(process.env.SWEEP_MERGE, results);
  }

  const rows = summary();

  // Merge into the shared spread-sweep file. Match THIS engine's own prior
  // rows by the side-tagged spread label so a re-run replaces (never appends).
  const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
  let existing: any[] = [];
  try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON, 'utf8')); } catch {}
  const isTlbCredit = (s: string) => /\d\.\d\dd[CP]\s*w\d+c/.test(s);
  existing = existing.filter((r: any) => !isTlbCredit(r.spread));
  const merged = existing.concat(rows);
  fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged, null, 2));
  const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
  try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}
  console.log(`\nMerged: ${existing.length} prior + ${rows.length} new (TLB-credit) = ${merged.length}`);

  // Daily-series (per-date P&L array per variant).
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
  const isTlbKey = (k: string) => {
    const parts = k.split('|');
    return parts.length >= 2 && /\d\.\d\dd[CP]\s*w\d+c/.test(parts[1]);
  };
  for (const k of Object.keys(existingDaily.series || {})) if (isTlbKey(k)) delete existingDaily.series[k];
  const allDatesSet = new Set<string>(existingDaily.dates || []);
  for (const d of dates) allDatesSet.add(d);
  const mergedDates = [...allDatesSet].sort();
  const mDi = new Map<string, number>(); mergedDates.forEach((d, i) => mDi.set(d, i));
  const mergedSeries: Record<string, number[]> = {};
  for (const k of Object.keys(existingDaily.series || {})) {
    const oldArr: number[] = existingDaily.series[k];
    const oldDates: string[] = existingDaily.dates || [];
    const newArr = new Array(mergedDates.length).fill(0);
    for (let i = 0; i < oldDates.length; i++) {
      const idx = mDi.get(oldDates[i]);
      if (idx != null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  for (const k of Object.keys(series)) {
    const oldArr = series[k];
    const newArr = new Array(mergedDates.length).fill(0);
    for (let i = 0; i < dates.length; i++) {
      const idx = mDi.get(dates[i]);
      if (idx != null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  fs.writeFileSync(DAILY_JSON, JSON.stringify({ dates: mergedDates, series: mergedSeries }));
  const STUDIO_DAILY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'), TARGET);
  try { fs.writeFileSync(STUDIO_DAILY, JSON.stringify({ dates: mergedDates, series: mergedSeries })); } catch {}
  console.log(`Daily merged: ${mergedDates.length} dates × ${Object.keys(mergedSeries).length} variants`);

  // Per-hour aggregates: append TLB-credit entries to the shared spread-hourly
  // file, dropping any prior TLB-credit rows on re-run.
  const HOURLY_JSON   = outPath('/tmp/credit_spread_hourly.json', TARGET);
  const STUDIO_HOURLY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'), TARGET);
  const tlbHourlyEntries: any[] = [];
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
    tlbHourlyEntries.push({ signal, spread, exit, hours: byHour });
  }
  let existingHourly: any[] = [];
  try { existingHourly = JSON.parse(fs.readFileSync(HOURLY_JSON, 'utf8')); } catch {}
  existingHourly = existingHourly.filter((e: any) => !isTlbCredit(String(e.spread || '')));
  const mergedHourly = existingHourly.concat(tlbHourlyEntries);
  fs.writeFileSync(HOURLY_JSON, JSON.stringify(mergedHourly));
  try { fs.writeFileSync(STUDIO_HOURLY, JSON.stringify(mergedHourly)); } catch {}

  // Persist incremental state if requested.
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
    const avgConcurrent = (numActiveDays > 0)
      ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2)
      : 0;
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
  console.log(`\n=== TLB-CREDIT SWEEP (Trendlines-with-Breaks, $${SLIPPAGE_PER_SPREAD}/RT slippage) ===`);
  console.log(`Variants: ${rows.length}.  Positive net: ${rows.filter(r => r.pnl > 0).length}.\n`);
  console.log(`${'Signal'.padEnd(10)} ${'Spread'.padEnd(12)} ${'Exit'.padEnd(16)} ${'$Net'.padStart(11)} ${'N'.padStart(5)} ${'WR%'.padStart(5)} ${'$DD'.padStart(9)} ${'Ratio'.padStart(6)} ${'+days'.padStart(5)}`);
  console.log('-'.repeat(96));
  for (const r of rows.slice(0, 30)) {
    console.log(`${r.signal.padEnd(10)} ${r.spread.padEnd(12)} ${r.exit.padEnd(16)} $${(r.pnl >= 0 ? '+' : '') + Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  return rows;
}
