/**
 * multi-dte-credit-sweep.ts
 *
 * Sweep short PUT SPREADS ONLY across multiple DTEs (1, 2, 3, 5, 10, 15, 20, 30, 40, 60).
 * Uses the SAME look-ahead-protected signal engine as backtest-server.ts with
 * HMA/DEMA cross detection, but restricts to bull signals (short put spreads).
 *
 * Multi-DTE support: Positions held across multiple trading sessions until TP/SL fires
 * or expiry. For DTE≥2, fetches bars from Polygon S3 flat files (flat-file-reader.ts)
 * covering all sessions from entry to expiry. DTE-specific geometry (spread offsets,
 * widths, friction) via sweep-geometry.ts.
 *
 * Outputs to: /tmp/credit_spread_sweep.json + /tmp/credit_spread_daily.json
 * (merged with iron results if both run).
 *
 * Run: npx tsx scripts/diag/sweep-parallel.ts --symbol NDX --dte 5 --engine credit
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { readBarCacheFile } from '../../src/replay/bar-cache-file';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile, knownDates } from './sweep-shard';
import { CAP_POLICIES, capDayNet, capSummary, type CapEvent } from './side-cap';
import { geometryForDte } from './sweep-geometry';
import { getOptionsForDay } from './flat-file-reader';
import { tradingDaysBetween, expiryForDate } from './sweep-dates';
import { deriveStrikeInterval } from './strike-grid';
import { selectStrikeByDelta, type DeltaCandidate } from './delta-grid';
import { aggregateIntraday } from './ohlc-aggregate';
import { freshBullCross, direction, type Signal as SwingSignal } from './swing-signal';
import type { DailyBar } from './backfill-ndx-daily';
import * as fs from 'fs';
import * as path from 'path';

// ── Serial-execution guard ──────────────────────────────────────────────────
// Direct invocation takes 40+ minutes on a 280-date SPX run. ALWAYS go through
// sweep-parallel.ts (8× faster). The serial path is dead.
// SWEEP_ALLOW_SERIAL=1 escape hatch for single-date debug; almost never useful.
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: multi-dte-credit-sweep.ts must NOT be invoked directly.
Use the parallel runner instead:

  npx tsx scripts/diag/sweep-parallel.ts --symbol NDX --dte 5 --engine credit --shards 8

Pass-through env vars (SWEEP_FILL_MODE, SWEEP_CLOSE_HALFSPREAD, etc.) inherit
through to all workers automatically.

Override only for single-date debugging: SWEEP_ALLOW_SERIAL=1
`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval; // $ per strike: SPX 5, SPY/QQQ 1, NDX 25

// ── DTE-aware geometry ────────────────────────────────────────────────────────
const GEO = geometryForDte(TARGET.dte);

// Overrideable via env; defaults from geometry module
const SLIPPAGE_PER_SPREAD = Number(process.env.SWEEP_SLIPPAGE ?? GEO.entrySlippage2leg);

// Pay-through-ask close model — 2-leg structure → penalty on close.
// Defaults from geometry module; override via SWEEP_CLOSE_HALFSPREAD.
const CLOSE_HALFSPREAD_PER_LEG = Number(process.env.SWEEP_CLOSE_HALFSPREAD ?? GEO.closeHalfSpread);
const CLOSE_PENALTY_V = 2 * CLOSE_HALFSPREAD_PER_LEG;

const FILL_MODE = (process.env.SWEEP_FILL_MODE ?? 'hard') as 'soft' | 'hard';

// ── Exit liquidity gate (shorts-fresh) ──────────────────────────────────────
// Default from geometry; override via SWEEP_EXIT_GATE.
const EXIT_GATE = (process.env.SWEEP_EXIT_GATE ?? GEO.exitGateDefault) as 'shorts-fresh' | 'none';
const GATE_SHORTS = EXIT_GATE === 'shorts-fresh';

// ── PUT_ONLY mode (short put spreads only — this engine focuses on puts) ────────
const PUT_ONLY = true;  // Multi-DTE study focuses on short puts by design

// Flat risk-free rate for the BS delta calc (delta-grid). Approximate; delta is
// only used to PICK strikes, so small rate error is immaterial to selection.
const RISK_FREE_RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

// ── Entry liquidity gate (shorts-fresh AT ENTRY) ────────────────────────────
// The exit gate above protects TP/SL fills, but the ENTRY credit is still built
// from optPx() last-prints which carry a stale close forward. On thin chains
// (NDX 0DTE short legs are >2min stale ~40% of minutes) this fabricates a credit
// you could never fill — the dominant source of phantom edge in the NDX audit.
// SWEEP_ENTRY_STALE_SEC=N rejects entries where the SHORT leg's mark is older
// than N sec at entryTs-1.  Default 0 = DISABLED (reproduces historical numbers).
const ENTRY_STALE_SEC = process.env.SWEEP_ENTRY_STALE_SEC ? parseInt(process.env.SWEEP_ENTRY_STALE_SEC) : 0;
const CUTOFF_HHMM = 6 * 3600; // 15:30 ET (sec from sess open)
const SETTLE_HHMM = 6 * 3600 + 15 * 60; // 15:45 ET — force-exit window has liquid quotes — close before final 5 min
const TRADESTART_SEC = 1800; // 10:00 ET (30 min after 9:30)

// ── Swing signals to sweep (higher TF for multi-DTE) ─────────────────────────
// Multi-DTE holds are swing trades; we detect HMA/DEMA bull crosses on
// DAILY and WEEKLY bars (warmed from the NDX daily-history cache), plus 2h/4h
// built from the entry-day + recent 1m sessions. Each spec fires at most once
// per date when its higher-TF state shows a fresh bull cross. (Short PUT
// spreads only → bull bias.)
type Signal = SwingSignal;
type SwingTf = 'daily' | 'weekly' | '2h' | '4h';
// mode 'cross' = enter on a fresh bull cross; 'state' = enter while bull;
// 'always' = unconditional daily entry (the swing fields are ignored). Each spec
// enters at entrySec from the session open (default 10:00 ET = 1800s); the
// always-daily spec enters at 1pm (12600s). One entry per (spec,date).
interface SignalSpec { label: string; signal: Signal; tf: SwingTf; fast: number; slow: number; mode: 'cross' | 'state' | 'always'; entrySec?: number; }
const ET_1PM_SEC = 3 * 3600 + 1800; // 13:00 ET = 3.5h after 09:30
const SIGNALS: SignalSpec[] = [
  // Unconditional daily 1pm entry — a baseline "signal" to compare the HMA
  // variants against (always-on daily put-credit spread).
  { label: '1pm daily',    signal: 'hma',  tf: 'daily',  fast: 3, slow: 9,  mode: 'always', entrySec: ET_1PM_SEC },
  // Daily HMA/DEMA crosses
  { label: 'HMA  D 3x9',   signal: 'hma',  tf: 'daily',  fast: 3, slow: 9,  mode: 'cross' },
  { label: 'HMA  D 5x20',  signal: 'hma',  tf: 'daily',  fast: 5, slow: 20, mode: 'cross' },
  { label: 'DEMA D 3x9',   signal: 'dema', tf: 'daily',  fast: 3, slow: 9,  mode: 'cross' },
  { label: 'DEMA D 5x20',  signal: 'dema', tf: 'daily',  fast: 5, slow: 20, mode: 'cross' },
  // Weekly HMA/DEMA crosses (slower swing)
  { label: 'HMA  W 3x9',   signal: 'hma',  tf: 'weekly', fast: 3, slow: 9,  mode: 'cross' },
  { label: 'DEMA W 3x9',   signal: 'dema', tf: 'weekly', fast: 3, slow: 9,  mode: 'cross' },
  // Daily STATE (already-bull) variants — enter while trend is up, not just on the flip
  { label: 'HMA  D 3x9 st', signal: 'hma', tf: 'daily',  fast: 3, slow: 9,  mode: 'state' },
  { label: 'HMA  D 5x20 st',signal: 'hma', tf: 'daily',  fast: 5, slow: 20, mode: 'state' },
];

// ── NDX daily-history warmup cache (for daily/weekly indicators) ─────────────
// Loaded once. Absent file → daily/weekly signals are skipped (run the backfill:
// npx tsx scripts/diag/backfill-ndx-daily.ts). 2h/4h would use intraday bars.
const DAILY_HISTORY_PATH = path.resolve(__dirname, '../../data/ndx-daily-history.json');
let DAILY_HISTORY: DailyBar[] = [];
try {
  DAILY_HISTORY = JSON.parse(fs.readFileSync(DAILY_HISTORY_PATH, 'utf8'));
} catch {
  console.error(`[warn] ${DAILY_HISTORY_PATH} missing — daily/weekly signals disabled. Run scripts/diag/backfill-ndx-daily.ts`);
}
// Daily closes strictly BEFORE a given date (no look-ahead).
function dailyClosesBefore(date: string): number[] {
  const out: number[] = [];
  for (const b of DAILY_HISTORY) { if (b.date < date) out.push(b.c); else break; }
  return out;
}
// Weekly closes (last daily close of each ISO week) strictly before date.
function weeklyClosesBefore(date: string): number[] {
  const weekly: number[] = [];
  let curWeek = ''; let lastClose = NaN;
  for (const b of DAILY_HISTORY) {
    if (b.date >= date) break;
    const dt = new Date(b.date + 'T12:00:00Z');
    const onejan = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
    const wk = `${dt.getUTCFullYear()}-${Math.ceil((((dt.getTime() - onejan.getTime()) / 86400000) + onejan.getUTCDay() + 1) / 7)}`;
    if (wk !== curWeek && curWeek !== '') weekly.push(lastClose);
    curWeek = wk; lastClose = b.c;
  }
  if (!Number.isNaN(lastClose)) weekly.push(lastClose);
  return weekly;
}

// ── Spreads: CROSS-PRODUCT of shortDeltas × widths ────────────────────────────
// Short leg selected by target |delta| (BS-computed from price; delta-grid.ts),
// long leg `wS` strike-counts further OTM (× per-expiry derived interval). The
// matrix sweeps every width at every short delta, isolating the width effect at
// each delta. Label is delta×count based (e.g. "0.30d w3c") — a stable
// aggregation key independent of the per-day strikes; strikes snap to real
// listed contracts.
interface SpreadSpec { label: string; shortDelta: number; wS: number; }
const SPREADS: SpreadSpec[] = [];
for (const d of GEO.shortDeltas) {
  for (const wS of GEO.widths) {
    SPREADS.push({ label: `${d.toFixed(2)}d w${wS}c`, shortDelta: d, wS });
  }
}

// ── Exit policies (TP/SL as fraction of credit). TP=0 means hold to settle. ──
// slRiskFrac (0-1): SL fires when V reaches credit + slRiskFrac × (width − credit).
// Properly bounded for credit structures (V capped at width). Use INSTEAD of slMult.
interface ExitSpec { label: string; tpFrac: number; slMult: number; slRiskFrac?: number; useFlip: boolean; }
const EXITS: ExitSpec[] = [
  { label: 'hold-to-settle',  tpFrac: 0,    slMult: 0,   useFlip: false },
  { label: 'TP5 only',        tpFrac: 0.05, slMult: 0,   useFlip: false },
  { label: 'TP6 only',        tpFrac: 0.06, slMult: 0,   useFlip: false },
  { label: 'TP7 only',        tpFrac: 0.07, slMult: 0,   useFlip: false },
  { label: 'TP8 only',        tpFrac: 0.08, slMult: 0,   useFlip: false },
  { label: 'TP10 only',       tpFrac: 0.10, slMult: 0,   useFlip: false },
  { label: 'TP15 only',       tpFrac: 0.15, slMult: 0,   useFlip: false },
  { label: 'TP20 only',       tpFrac: 0.20, slMult: 0,   useFlip: false },
  { label: 'TP25 only',       tpFrac: 0.25, slMult: 0,   useFlip: false },
  { label: 'TP35 only',       tpFrac: 0.35, slMult: 0,   useFlip: false },
  { label: 'TP50 only',       tpFrac: 0.50, slMult: 0,   useFlip: false },
  { label: 'TP75 only',       tpFrac: 0.75, slMult: 0,   useFlip: false },
  // Risk-based SL variants for TP5/10/15
  { label: 'TP5 SL50%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP5 SL60%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP5 SL70%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP5 SL80%',       tpFrac: 0.05, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  { label: 'TP10 SL50%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP10 SL60%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP10 SL70%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP10 SL80%',      tpFrac: 0.10, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  { label: 'TP15 SL50%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.50, useFlip: false },
  { label: 'TP15 SL60%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.60, useFlip: false },
  { label: 'TP15 SL70%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.70, useFlip: false },
  { label: 'TP15 SL80%',      tpFrac: 0.15, slMult: 0,   slRiskFrac: 0.80, useFlip: false },
  // Flip-exit variants: close on signal reversal (first opposite alignment after entry)
  { label: 'TP10 +flip',      tpFrac: 0.10, slMult: 0,   useFlip: true  },
  { label: 'TP15 +flip',      tpFrac: 0.15, slMult: 0,   useFlip: true  },
  { label: 'TP25 +flip',      tpFrac: 0.25, slMult: 0,   useFlip: true  },
  { label: 'TP50 +flip',      tpFrac: 0.50, slMult: 0,   useFlip: true  },
  { label: 'flip only',       tpFrac: 0,    slMult: 0,   useFlip: true  },
];

// Effectively-uncapped budget so the sweep records every signal. Per-variant
// peakConcurrent + avgMaxRisk are output so the dashboard can budget-scale
// without re-running. To run a true-capped sweep, lower this to the tier.
const MAX_OPEN_RISK = 100_000;

// ── Date list ──────────────────────────────────────────────────────────────
// (dates resolved via sweep-symbol.ts listDatesFor — profile-id aware)
function prevDate(d:string){const dt=new Date(d+'T12:00:00Z');dt.setUTCDate(dt.getUTCDate()-1);if(dt.getUTCDay()===0)dt.setUTCDate(dt.getUTCDate()-2);if(dt.getUTCDay()===6)dt.setUTCDate(dt.getUTCDate()-1);return dt.toISOString().slice(0,10);}
function sessOpenTs(date:string):number{
  const[y,mo,d]=date.split('-').map(Number);
  const utcNoon=new Date(Date.UTC(y,mo-1,d,12,0,0));
  const etHour=parseInt(utcNoon.toLocaleString('en-US',{timeZone:'America/New_York',hour:'numeric',hour12:false}));
  const offsetH=12-etHour;
  return Math.floor(Date.UTC(y,mo-1,d,9+offsetH,30,0)/1000);
}

// ── Signal engine ──────────────────────────────────────────────────────────
// Swing signals (daily/weekly/2h/4h HMA-DEMA crosses) are detected by
// swing-signal.ts off higher-TF closes; the intraday detector was removed when
// this engine moved to multi-DTE swing entries.

// Trading-day helpers (holiday-aware) live in sweep-dates.ts — imported above.

// ── Multi-day bar loading (S3 flat files for DTE≥2) ───────────────────────────
async function getMultiDayBars(symbol: string, entryDate: string, expiryDate: string): Promise<any[]> {
  const sessionDates = tradingDaysBetween(entryDate, expiryDate);
  const all: any[] = [];

  for (const d of sessionDates) {
    try {
      const dayMap = await getOptionsForDay(d, [symbol]);
      const dayBars = dayMap.get(symbol) ?? [];
      all.push(...dayBars);
    } catch (e) {
      console.error(`[multi-day-bars] failed for ${symbol} on ${d}: ${(e as any).message}`);
    }
  }

  return all;
}

// ── Contract helpers ───────────────────────────────────────────────────────
function findStrike(c1:any, type:'C'|'P', targetK:number): string|null {
  let best:string|null=null, bestD=Infinity;
  // OCC type char is always 9 chars from the end (8 strike digits + C/P),
  // so this works for SPXW(4), SPY/QQQ(3), NDXP(4) roots alike.
  for(const [s] of c1.contractBars){const sym=s as string;if(sym[sym.length-9]!==type)continue;const k=c1.contractStrikes.get(sym);const d=Math.abs(k-targetK);if(d<bestD){bestD=d;best=sym;}}
  return best;
}
// All listed strikes of a given type (C/P) in the entry-day chain — the raw
// material for deriveStrikeInterval (real local grid near spot).
function listStrikes(c1:any, type:'C'|'P'): number[] {
  const out:number[] = [];
  for(const [s] of c1.contractBars){
    const sym = s as string;
    if(sym[sym.length-9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    if(typeof k === 'number') out.push(k);
  }
  return out;
}
function optPx(bars:any[],ts:number):number|null{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return bars[i].close;return null;}
// Age (sec) of the last printed bar at-or-before ts (Infinity if none). Bar cache
// holds only real prints (no synthetic fill), so age = ts − lastBar.ts. Used by
// the entry-staleness gate (ENTRY_STALE_SEC).
function markAge(bars:any[],ts:number):number{for(let i=bars.length-1;i>=0;i--)if(bars[i].ts<=ts)return ts-bars[i].ts;return Infinity;}

// Build the spread-value trajectory from entryTs+1 to endTs as a list of {ts, V}.
// Linear walk through both bar arrays (O(N+M)), instead of per-timestamp re-scan.
interface TrajPoint { ts:number; V:number; shortFresh:boolean; }
// Each point flags whether the SHORT leg printed AT that exact minute (vs a
// carried-forward stale close), so applyExit can reject false-mid TP/SL fills
// on an un-tradeable short (see GATE_SHORTS).
function buildSpreadTrajectory(shortBars:any[], longBars:any[], entryTs:number, endTs:number): TrajPoint[] {
  const tsSet = new Set<number>();
  for(const b of shortBars) if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  for(const b of longBars)  if(b.ts>entryTs && b.ts<=endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a,b)=>a-b);
  const traj: TrajPoint[] = [];
  let si = 0, li = 0;
  let lastShort:number|null = null, lastLong:number|null = null;
  let lastShortTs = -1;
  for(const t of tsList){
    while(si < shortBars.length && shortBars[si].ts <= t){ lastShort = shortBars[si].close; lastShortTs = shortBars[si].ts; si++; }
    while(li < longBars.length  && longBars[li].ts  <= t){ lastLong  = longBars[li].close;  li++; }
    if(lastShort != null && lastLong != null) traj.push({ts: t, V: lastShort - lastLong, shortFresh: lastShortTs === t});
  }
  return traj;
}

// Find V at a given ts (latest V where ts ≤ target) — used for rotation eviction.
function currentV(traj: Array<{ts:number,V:number}>, targetTs: number): number | null {
  let v: number | null = null;
  for(const p of traj){
    if(p.ts > targetTs) break;
    v = p.V;
  }
  return v;
}

// Apply one exit policy to a precomputed trajectory.
// At true session settle (effEnd === endTs), V is computed as INTRINSIC from SPX close + strikes
// to avoid stale-leg-bar bias on deep ITM credit spreads (which can stop printing late in the day).
// At flip exits (effEnd < endTs), uses last available close on each leg.
function applyExit(traj:TrajPoint[], endTs:number,
                   shortBars:any[], longBars:any[],
                   credit:number, tpFrac:number, slMult:number, flipTs:number,
                   isCallSpread:boolean, shortStrike:number, longStrike:number,
                   spxAtSettle:number|null, width:number = 0, slRiskFrac:number = 0): {exitTs:number, exitV:number, reason:string} {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac>0 ? (1 - tpFrac) * credit : -Infinity;
  // Prefer slRiskFrac (fraction of max risk) when > 0; slMult is broken for
  // credit structures (V bounded by width). Kept for backward-compat.
  const slV = slRiskFrac > 0 && width > 0
    ? credit + slRiskFrac * (width - credit)
    : slMult > 0 ? (1 + slMult) * credit : Infinity;
  const slActive = slRiskFrac > 0 || slMult > 0;
  // Hard mode: limit must be crossed (mid penetrates by penalty) for TP, stop
  // must be cleared (mid clears stop by penalty) for SL. Fills at order level.
  const tpTrigger = FILL_MODE === 'hard' ? tpV - CLOSE_PENALTY_V : tpV;
  const slTrigger = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : slV;
  // Liquidity gate: honor a TP/SL only at a bar where the SHORT leg actually
  // printed (p.shortFresh). Rejects exits priced off a stale carried-forward
  // SHORT close (the "false mid"). GATE_SHORTS=false reproduces legacy behavior.
  for(const p of traj){
    if(p.ts > effEnd) break;
    const fillable = !GATE_SHORTS || p.shortFresh;
    if(tpFrac>0 && p.V <= tpTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? tpV : p.V + CLOSE_PENALTY_V;
      return {exitTs: p.ts, exitV: Math.max(0, exitV), reason:'TP'};
    }
    if(slActive && p.V >= slTrigger && fillable) {
      const exitV = FILL_MODE === 'hard' ? slV + CLOSE_PENALTY_V : p.V + CLOSE_PENALTY_V;
      return {exitTs: p.ts, exitV, reason:'SL'};
    }
  }
  // INTRINSIC settle only valid at true same-day expiry (0DTE @ 15:45,
  // extrinsic ≈ 0). For 1DTE+ the contract still has ≥1 session of life at the
  // 15:45 day-D forced exit → use the real option-bar mark instead (below),
  // else short-premium P&L is grossly inflated.
  if(effEnd === endTs && spxAtSettle != null && TARGET.dte === 0){
    // Intrinsic settle. For call spread: V = max(0, spx-K_short) - max(0, spx-K_long).
    // For put spread:  V = max(0, K_short-spx) - max(0, K_long-spx).
    let v: number;
    if(isCallSpread){
      v = Math.max(0, spxAtSettle - shortStrike) - Math.max(0, spxAtSettle - longStrike);
    } else {
      v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
    }
    return {exitTs: effEnd, exitV: Math.max(0, v), reason: 'expiry'};
  }
  // Real mark-to-market at exit ts (last printed leg closes). Covers flip
  // exits (effEnd<endTs) AND 1DTE+ settle (effEnd==endTs, dte≥1).
  const ps = optPx(shortBars, effEnd) ?? 0;
  const pl = optPx(longBars,  effEnd) ?? 0;
  // Flip + 1DTE+ settle-MTM both require crossing the spread on both legs —
  // apply pay-through-ask penalty. Cash-settled 0DTE expiry above is unpenalized.
  return {exitTs: effEnd, exitV: Math.max(0, (ps - pl) + CLOSE_PENALTY_V), reason: effEnd === endTs ? 'settle-mtm' : 'flip'};
}

// ── Aggregation ────────────────────────────────────────────────────────────
interface AggKey { signal:string; spread:string; exit:string; }
interface HourBucket { n:number; creditSum:number; riskSum:number; pnlSum:number; wins:number; }
interface Stat {
  pnl:number; n:number; wins:number; daily:Map<string,number>; creditSum:number; widthSum:number;
  peakConcurrent:number; evictions:number;
  durationSumSec:number;
  perHour: Map<number, HourBucket>;        // ET hour (9..15) → bucket
  capNets:number[];                        // cumulative net under each CAP_POLICIES entry (per-side cap scan)
}
const results = new Map<string, Stat>();
function recK(s:string,sp:string,ex:string){return `${s}|${sp}|${ex}`;}

// Fast ET hour from unix ts (no Date/toLocaleString in the hot loop). Mirror
// of iron-sweep's helper: 09:30 ET = minute 570 of the day, so
// etHour = floor((570 + (ts−sessOpen)/60) / 60).
let _sessOpenForEtHour = 0;
function setEtHourSessOpen(sessOpenTs: number){ _sessOpenForEtHour = sessOpenTs; }
function etHour(ts: number): number {
  const minSinceOpen = (ts - _sessOpenForEtHour) / 60;
  return Math.floor((570 + minSinceOpen) / 60);
}

function rec(s:string,sp:string,ex:string, pnl:number, date:string, credit:number, width:number, durationSec:number = 0, entryTs:number = 0, maxRisk:number = 0){
  const k=recK(s,sp,ex);
  let v=results.get(k); if(!v){v={pnl:0,n:0,wins:0,daily:new Map(),creditSum:0,widthSum:0,peakConcurrent:0,evictions:0,durationSumSec:0,perHour:new Map(),capNets:new Array(CAP_POLICIES.length).fill(0)}; results.set(k,v);}
  v.pnl+=pnl; v.n++; if(pnl>0)v.wins++; v.daily.set(date,(v.daily.get(date)??0)+pnl);
  v.creditSum+=credit; v.widthSum+=width;
  v.durationSumSec += durationSec;
  // Per-hour bucket (clamped to 9..15 — anything outside is noise/wrong-day).
  // entryTs=0 is a back-compat default (no-op) for any caller that doesn't pass it.
  if (entryTs > 0) {
    const h = Math.max(9, Math.min(15, etHour(entryTs)));
    let hb = v.perHour.get(h); if(!hb){hb={n:0,creditSum:0,riskSum:0,pnlSum:0,wins:0}; v.perHour.set(h,hb);}
    hb.n++; hb.creditSum += credit; hb.riskSum += maxRisk; hb.pnlSum += pnl;
    if (pnl > 0) hb.wins++;
  }
}

// ── Per-trade emission (additive, env-gated) ───────────────────────────────
// Enable by setting SWEEP_EMIT_TRADES_KEYS to a newline-separated list of
// "signal|spread|exit" keys (passed via env). Trades for ONLY those variants
// are emitted; everything else is a no-op (zero overhead). Output files:
//   $SWEEP_EMIT_TRADES_DIR/{slug}/{date}.json
// where slug = signal|spread|exit with spaces/pipes → underscores.
// Each file holds one CreditSpreadDay record (header + trades[] + spxBars +
// contractBars-for-legs). UI loads exactly one per inspection.
interface TradeRecord {
  entryTs:number; exitTs:number; durationSec:number;
  dir:'bull'|'bear'; side:'put-credit'|'call-credit';
  spxAtEntry:number; spxAtExit:number;
  shortSymbol:string; shortStrike:number; shortEntryMark:number; shortExitMark:number;
  longSymbol:string;  longStrike:number;  longEntryMark:number;  longExitMark:number;
  netCredit:number; netExitDebit:number; width:number; maxRisk:number;
  tpFrac:number; slMult:number;
  pnlGross:number; pnlNet:number;
  exitReason:string;
}
interface DayEmit {
  date:string; signal:string; spread:string; exit:string;
  spxOpen:number; spxClose:number; spxSettle:number|null;
  trades: TradeRecord[];
  spxBars: any[];                        // 1m OHLCV [ts,o,h,l,c,v]
  contractBars: Record<string, any[]>;   // symbol → 1m bars (deduped: legs from all trades)
}
const EMIT_KEYS = (() => {
  const raw = process.env.SWEEP_EMIT_TRADES_KEYS;
  if (!raw) return null;
  return new Set(raw.split(/[\n,]/).map(s=>s.trim()).filter(Boolean));
})();
// EMIT-ONLY: narrow the matrix to the emit keys and skip dashboard writes — fast
// per-config trade re-emission under current code (without clobbering the sweep JSON).
const EMIT_ONLY = !!process.env.SWEEP_EMIT_ONLY && !!EMIT_KEYS;
const EMIT_SIGNALS = new Set<string>(), EMIT_SPREADS = new Set<string>(), EMIT_EXITS = new Set<string>();
if (EMIT_KEYS) for (const k of EMIT_KEYS) { const [s, sp, e] = k.split('|'); EMIT_SIGNALS.add(s); EMIT_SPREADS.add(sp); EMIT_EXITS.add(e); }
const EMIT_DIR = process.env.SWEEP_EMIT_TRADES_DIR
  || path.join(process.cwd(), 'scripts/autoresearch/output/spread-trades');
const EMIT_BUFFER = new Map<string, Map<string, DayEmit>>();   // key → date → DayEmit
function slugify(k:string){ return k.replace(/[|]/g,'__').replace(/\s+/g,'_'); }
function emitTrade(k:string, date:string, hdr:{spxOpen:number; spxClose:number; spxSettle:number|null}, tr:TradeRecord, spxBars:any[], shortSym:string, shortBars:any[], longSym:string, longBars:any[]){
  if (!EMIT_KEYS || !EMIT_KEYS.has(k)) return;
  let byDate = EMIT_BUFFER.get(k); if(!byDate){byDate=new Map(); EMIT_BUFFER.set(k,byDate);}
  let d = byDate.get(date);
  if(!d){
    const [signal,spread,exit] = k.split('|');
    d = { date, signal, spread, exit,
          spxOpen: hdr.spxOpen, spxClose: hdr.spxClose, spxSettle: hdr.spxSettle,
          trades: [], spxBars, contractBars: {} };
    byDate.set(date,d);
  }
  d.trades.push(tr);
  if (!d.contractBars[shortSym]) d.contractBars[shortSym] = shortBars;
  if (!d.contractBars[longSym])  d.contractBars[longSym]  = longBars;
}
// Serialize a Bar[] (object-shape with full indicators) as compact tuples
// [ts, o, h, l, c, v] — what the lightweight-charts UI actually needs. Drops
// the indicators blob which adds ~10× size.
function compactBars(bars:any[]): number[][] {
  const out:number[][] = new Array(bars.length);
  for (let i=0;i<bars.length;i++) {
    const b = bars[i];
    out[i] = [b.ts, b.open, b.high, b.low, b.close, b.volume ?? 0];
  }
  return out;
}
function flushTrades(){
  if (!EMIT_KEYS || EMIT_BUFFER.size === 0) return;
  fs.mkdirSync(EMIT_DIR, { recursive: true });
  let nFiles = 0, nTrades = 0;
  for (const [k, byDate] of EMIT_BUFFER) {
    const sub = path.join(EMIT_DIR, slugify(k));
    fs.mkdirSync(sub, { recursive: true });
    for (const [date, day] of byDate) {
      day.trades.sort((a,b)=>a.entryTs-b.entryTs);
      const compact = {
        ...day,
        spxBars: compactBars(day.spxBars),
        contractBars: Object.fromEntries(
          Object.entries(day.contractBars).map(([sym, b]) => [sym, compactBars(b as any[])])
        ),
      };
      fs.writeFileSync(path.join(sub, `${date}.json`), JSON.stringify(compact));
      nFiles++; nTrades += day.trades.length;
    }
  }
  console.error(`[trades] emitted ${nTrades} trades across ${nFiles} files under ${EMIT_DIR}`);
}

// ── Main ───────────────────────────────────────────────────────────────────
const ALL_DATES = listDatesFor(TARGET);
// Parallel-shard hook: SWEEP_MERGE skips the loop (results come from shard
// dumps); SWEEP_SHARD="i/n" runs only this worker's date subset. No env =
// serial, identical behaviour. Each shard keeps every date's FULL bar
// history, so this cannot introduce look-ahead.
const SWEEP_DATES = process.env.SWEEP_MERGE ? [] : shardDates(ALL_DATES);
// ── Incremental hook: SWEEP_STATE=<file> persists the per-variant
// accumulator. On a nightly run we load it, then replay ONLY dates not
// already in the accumulator's per-date `daily` maps (idempotent — a re-run
// or --force re-backfill of an already-counted day is skipped). After the
// normal finalize (which still writes the FULL-history dashboard JSON from
// the merged accumulator) we persist the updated state. Additive/env-gated;
// no SWEEP_STATE, or with SWEEP_SHARD/SWEEP_MERGE, = unchanged behaviour.
const STATE_FILE = process.env.SWEEP_STATE;
let RUN_DATES = SWEEP_DATES;
if (STATE_FILE && !process.env.SWEEP_MERGE && !process.env.SWEEP_SHARD) {
  const had = mergeStateFile(STATE_FILE, results);
  if (had) {
    const known = knownDates(results);
    RUN_DATES = SWEEP_DATES.filter(d => !known.has(d));
    console.error(`[incremental] state has ${known.size} dates; replaying ${RUN_DATES.length} NEW: ${RUN_DATES.join(',') || '(none)'}`);
  } else {
    console.error(`[incremental] no state file — bootstrap full ${SWEEP_DATES.length} dates`);
  }
}
console.error(`[${TARGET.symbol} DTE${TARGET.dte}] Dates: ${ALL_DATES.length}${process.env.SWEEP_SHARD ? ` (shard ${process.env.SWEEP_SHARD} → ${SWEEP_DATES.length})` : ''} | exitGate=${EXIT_GATE} entryStaleSec=${ENTRY_STALE_SEC || 'off'} fill=${FILL_MODE} putOnly=true`);

(async () => {
for(let di=0; di<RUN_DATES.length; di++){
  const date = RUN_DATES[di];
  if(di%20===0) console.error(`  ${di}/${RUN_DATES.length}  ${date}`);
  let c1:any, p1:any;
  try { c1 = loadDay(TARGET,date,'1m') as any; p1 = loadDay(TARGET,prevDate(date),'1m') as any; }
  catch { continue; }
  if(!c1?.spxBars?.length) continue;
  const s1:any[]=c1.spxBars;
  const sess = sessOpenTs(date);
  setEtHourSessOpen(sess);   // arm fast etHour() for the per-hour bucket below
  const cutoff = sess + CUTOFF_HHMM;
  const settleDate = TARGET.dte >= 1 ? expiryForDate(date, TARGET.dte) : date;
  const settleTs = sessOpenTs(settleDate) + SETTLE_HHMM;
  // SPX close at settle ts — for intrinsic-value settle in applyExit (0DTE only)
  const spxAtSettle = TARGET.dte === 0 ? optPx(s1, settleTs) : null;

  // Per-variant overlap event tracking (entry/exit timestamps) for peak-concurrent calc
  const overlapMap = new Map<string, CapEvent[]>();

  // Higher-TF closes strictly before this date (no look-ahead).
  const dailyCloses = dailyClosesBefore(date);
  const weeklyCloses = weeklyClosesBefore(date);
  const prior1m: any[] = (p1?.spxBars ?? []);

  for(const sig of SIGNALS){
    if (EMIT_ONLY && !EMIT_SIGNALS.has(sig.label)) continue;

    // Per-signal entry timestamp (default 10:00 ET; 1pm-daily enters at 13:00).
    const entryTs = sess + (sig.entrySec ?? TRADESTART_SEC);

    // mode 'always' enters unconditionally; cross/state evaluate the higher TF.
    if (sig.mode !== 'always') {
      let closes: number[];
      if (sig.tf === 'daily')       closes = dailyCloses;
      else if (sig.tf === 'weekly') closes = weeklyCloses;
      else {
        const mins = sig.tf === '2h' ? 120 : 240;
        const intraday1m = [...prior1m, ...s1.filter(b => b.ts <= entryTs)];
        closes = aggregateIntraday(intraday1m, mins, sess).map(b => b.close);
      }
      if (closes.length < sig.slow + 2) continue; // not enough history to warm up

      const bull = sig.mode === 'cross'
        ? freshBullCross(closes, sig.signal, sig.fast, sig.slow)
        : direction(closes, sig.signal, sig.fast, sig.slow) === 'bull';
      if (process.env.SWEEP_DEBUG && bull) console.error(`[dbg] ${date} ${sig.label}: BULL (closes=${closes.length})`);
      if (!bull) continue;
    }

    // Single entry at this signal's entry window.
    {
      if(entryTs >= cutoff) continue;
      const spxEntry = optPx(s1, entryTs - 1);
      if(spxEntry==null) continue;

      // PUT_ONLY engine: short PUT spreads only. shortLetter is P.
      const isCallSpread = false;
      const shortLetter:'C'|'P' = 'P';

      // Real local strike interval near spot from the listed chain (NDXP spacing
      // varies by DTE/moneyness); used to convert width strike-COUNTS to dollars.
      const allPutStrikes = listStrikes(c1, 'P');
      const grid = deriveStrikeInterval(allPutStrikes, spxEntry) ?? SI;

      // Time to expiry in YEARS for the BS delta calc. Use trading-day count /
      // 252 (the option lives over TARGET.dte trading sessions).
      const T = Math.max(TARGET.dte, 0.25) / 252;

      // Put-strike candidates (strike + entry mark) for delta selection. The
      // entry mark must come from the leg's own bars at entry; build a quick
      // strike→symbol map and price each put at entryTs-1.
      const putCandidates: DeltaCandidate[] = [];
      const strikeToSym = new Map<number, string>();
      for (const [s] of c1.contractBars) {
        const sym = s as string;
        if (sym[sym.length - 9] !== 'P') continue;
        const k = c1.contractStrikes.get(sym) as number;
        const bars = c1.contractBars.get(sym) as any[];
        const px = optPx(bars, entryTs - 1);
        if (px == null || px <= 0) continue;
        putCandidates.push({ strike: k, price: px });
        strikeToSym.set(k, sym);
      }
      if (putCandidates.length < 2) continue;

      for(const sp of SPREADS){
        if (EMIT_ONLY && !EMIT_SPREADS.has(sp.label)) continue;
        // Short leg: listed put whose BS delta is nearest the target |delta|.
        const shortSel = selectStrikeByDelta(putCandidates, sp.shortDelta, spxEntry, T, RISK_FREE_RATE);
        if (!shortSel) continue;
        const shortStrike = shortSel.strike;
        const shortSym = strikeToSym.get(shortStrike)!;
        // Long leg: wS strike-counts further OTM (lower strike for a put), snapped
        // to the nearest listed put strike, excluding the short strike.
        const longK_target = shortStrike - sp.wS * grid;
        const longSym = findStrike(c1, 'P', longK_target);
        if(!longSym || longSym === shortSym) continue;
        const longStrike = c1.contractStrikes.get(longSym) as number;
        if(longStrike >= shortStrike) continue;
        // Realized width = actual distance between snapped strikes — the true risk.
        const spreadWidth = Math.abs(shortStrike - longStrike);
        if(spreadWidth <= 0) continue;

        // Fetch bars: for DTE≥2 use multi-day S3 flat files; otherwise entry-day parquet
        let shortBars: any[], longBars: any[];
        if (TARGET.dte >= 2) {
          const expiryDate = expiryForDate(date, TARGET.dte);
          try {
            const [shortMulti, longMulti] = await Promise.all([
              getMultiDayBars(shortSym, date, expiryDate),
              getMultiDayBars(longSym, date, expiryDate),
            ]);
            shortBars = shortMulti;
            longBars = longMulti;
          } catch {
            continue;
          }
        } else {
          shortBars = c1.contractBars.get(shortSym) as any[];
          longBars  = c1.contractBars.get(longSym)  as any[];
        }

        const shortEntry = optPx(shortBars, entryTs-1);
        const longEntry  = optPx(longBars,  entryTs-1);
        if(shortEntry==null||longEntry==null) continue;
        // Entry staleness gate (default off). Credit realism depends on the SHORT
        // leg being freshly printed; reject if its mark is too stale at entry.
        if(ENTRY_STALE_SEC > 0 && markAge(shortBars, entryTs-1) > ENTRY_STALE_SEC) continue;
        const credit = shortEntry - longEntry;
        if(credit <= 0.05) continue;
        if(credit > spreadWidth * 0.95) continue;

        // Credit strategies are TP/SL/settle only — never flip on signal
        // reversal (it destroys the theta-decay edge). Swing signals have no
        // intraday reversal log anyway, so flip is permanently disabled here.
        const flipTs = Infinity;

        const traj = buildSpreadTrajectory(shortBars, longBars, entryTs, settleTs);

        for(const ex of EXITS){
          if (EMIT_ONLY && !EMIT_EXITS.has(ex.label)) continue;
          // Compute natural exit, record P&L immediately, push overlap event.
          const flipTsToUse = ex.useFlip ? flipTs : Infinity;
          const nat = applyExit(traj, settleTs, shortBars, longBars, credit, ex.tpFrac, ex.slMult, flipTsToUse,
                                isCallSpread, shortStrike, longStrike, spxAtSettle, spreadWidth, ex.slRiskFrac ?? 0);
          const pnl = (credit - nat.exitV) * 100 - SLIPPAGE_PER_SPREAD;
          const pnlGross = (credit - nat.exitV) * 100;
          const durationSec = Math.max(0, nat.exitTs - entryTs);
          const maxRisk = (spreadWidth - credit) * 100;   // per contract — defined-risk credit spread
          rec(sig.label, sp.label, ex.label, pnl, date, credit, spreadWidth, durationSec, entryTs, maxRisk);

          const k = `${sig.label}|${sp.label}|${ex.label}`;
          let evs = overlapMap.get(k); if(!evs){evs=[]; overlapMap.set(k, evs);}
          evs.push({entry: entryTs, exit: nat.exitTs, side: isCallSpread ? 'call' : 'put', pnl});

          // Per-trade emission (no-op unless this variant key is in EMIT_KEYS).
          if (EMIT_KEYS && EMIT_KEYS.has(k)) {
            const spxAtExit = optPx(s1, nat.exitTs) ?? spxEntry;
            // Reconstruct per-leg exit marks. For intrinsic-settle (0DTE expiry),
            // derive marks from SPX vs strikes; otherwise use leg-bar close.
            let shortExitMark:number, longExitMark:number;
            if (nat.reason === 'expiry' && spxAtSettle != null) {
              if (isCallSpread) {
                shortExitMark = Math.max(0, spxAtSettle - shortStrike);
                longExitMark  = Math.max(0, spxAtSettle - longStrike);
              } else {
                shortExitMark = Math.max(0, shortStrike - spxAtSettle);
                longExitMark  = Math.max(0, longStrike  - spxAtSettle);
              }
            } else {
              shortExitMark = optPx(shortBars, nat.exitTs) ?? 0;
              longExitMark  = optPx(longBars,  nat.exitTs) ?? 0;
            }
            const tr: TradeRecord = {
              entryTs: entryTs, exitTs: nat.exitTs, durationSec,
              dir: "bull", side: isCallSpread ? 'call-credit' : 'put-credit',
              spxAtEntry: spxEntry, spxAtExit,
              shortSymbol: shortSym, shortStrike, shortEntryMark: shortEntry, shortExitMark,
              longSymbol:  longSym,  longStrike,  longEntryMark: longEntry,  longExitMark,
              netCredit: credit, netExitDebit: nat.exitV, width: spreadWidth, maxRisk,
              tpFrac: ex.tpFrac, slMult: ex.slMult,
              pnlGross, pnlNet: pnl,
              exitReason: nat.reason,
            };
            const spxOpen = s1[0]?.close ?? spxEntry;
            const spxClose = s1[s1.length-1]?.close ?? spxEntry;
            emitTrade(k, date,
              { spxOpen, spxClose, spxSettle: spxAtSettle },
              tr, s1, shortSym, shortBars, longSym, longBars);
          }
        }
      }
    }
  }

  // End of day: compute per-variant peak concurrent open via sweep-line on entry/exit events.
  for(const [k, evs] of overlapMap){
    if(evs.length === 0) continue;
    const stat = results.get(k); if(!stat) continue;
    const events: Array<{ts:number, delta:number}> = [];
    for(const e of evs){ events.push({ts:e.entry, delta:+1}); events.push({ts:e.exit, delta:-1}); }
    events.sort((a,b) => a.ts === b.ts ? a.delta - b.delta : a.ts - b.ts);
    let cur = 0, peak = 0;
    for(const e of events){ cur += e.delta; if(cur > peak) peak = cur; }
    if(peak > stat.peakConcurrent) stat.peakConcurrent = peak;
    // Per-side cap scan: accumulate today's capped net for each policy (drop-and-wait).
    for(let i=0;i<CAP_POLICIES.length;i++) stat.capNets[i] += capDayNet(evs, CAP_POLICIES[i].pool, CAP_POLICIES[i].c, CAP_POLICIES[i].p);
  }
  overlapMap.clear();
}

// ── Finalize (INSIDE the async IIFE so it runs AFTER the await-driven loop) ──
finalize();

})().catch(err => {
  console.error('Sweep error:', err);
  process.exit(1);
});

// ── Report ─────────────────────────────────────────────────────────────────
function summary(){
  const rows:any[] = [];
  for(const [k,v] of results){
    const [signal,spread,exit] = k.split('|');
    const dailyArr = [...v.daily.values()];
    let cum=0,peak=0,mdd=0; for(const dp of dailyArr){cum+=dp; peak=Math.max(peak,cum); mdd=Math.max(mdd,peak-cum);}
    const pos = dailyArr.filter(x=>x>0.1).length;
    const wr = 100*v.wins/Math.max(1,v.n);
    const ratio = mdd>0 ? v.pnl/mdd : 0;
    const avgCredit = v.creditSum / Math.max(1,v.n);
    const avgWidth  = v.widthSum  / Math.max(1,v.n);
    const avgMaxRisk = (avgWidth - avgCredit) * 100; // dollars at risk per spread (1 contract)
    const avgDurMin = v.n > 0 ? (v.durationSumSec / v.n / 60) : 0;
    // avgConcurrent: time-weighted average open positions during the entry
    // window (10:00 → 15:45 ET = 20700s). When trades are short-held, this
    // is a more realistic ongoing capital-at-work estimate than peak.
    const SESSION_SEC = 20700;
    const numActiveDays = v.daily.size;
    const avgConcurrent = (numActiveDays > 0)
      ? +(v.durationSumSec / (numActiveDays * SESSION_SEC)).toFixed(2)
      : 0;
    const avgRiskCapacity = +(avgConcurrent * avgMaxRisk).toFixed(0);
    // Shared-pool cap scan (pool + per-side sub-cap): current baseline, best sub-cap at pool 11, best overall.
    const cap = capSummary(v.capNets, 'call', 'put');
    rows.push({signal,spread,exit,pnl:v.pnl,n:v.n,wr,dd:mdd,ratio,pos,
      ...cap,
      avgCredit:+avgCredit.toFixed(3),avgMaxRisk:+avgMaxRisk.toFixed(0),
      avgPnlPerTrade:+(v.pnl/Math.max(1,v.n)).toFixed(2),
      peakConcurrent:v.peakConcurrent, evictions:v.evictions,
      peakRiskCapacity:+(v.peakConcurrent * avgMaxRisk).toFixed(0),
      avgConcurrent, avgRiskCapacity, numActiveDays,
      avgDurMin:+avgDurMin.toFixed(1),
      // Fill-model provenance — see iron-sweep.ts for context.
      fillModel: FILL_MODE,
      fillHalfSpread: CLOSE_HALFSPREAD_PER_LEG,
      exitGate: EXIT_GATE,
      entryStaleSec: ENTRY_STALE_SEC});
  }
  rows.sort((a,b)=>b.pnl-a.pnl);
  console.log(`\n=== CREDIT-SPREAD SWEEP (look-ahead protected, $${SLIPPAGE_PER_SPREAD}/RT slippage) ===`);
  console.log(`Variants: ${rows.length}.  Positive net: ${rows.filter(r=>r.pnl>0).length}.\n`);
  console.log(`${'Signal'.padEnd(16)} ${'Spread'.padEnd(11)} ${'Exit'.padEnd(18)} ${'$Net'.padStart(11)} ${'N'.padStart(5)} ${'WR%'.padStart(5)} ${'$DD'.padStart(9)} ${'Ratio'.padStart(6)} ${'+days'.padStart(5)}`);
  console.log('-'.repeat(96));
  // Print top 30
  for(const r of rows.slice(0,30)){
    console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(11)} ${r.exit.padEnd(18)} $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  console.log('\n--- Bottom 10 ---');
  for(const r of rows.slice(-10)){
    console.log(`${r.signal.padEnd(16)} ${r.spread.padEnd(11)} ${r.exit.padEnd(18)} $${(r.pnl>=0?'+':'')+Math.round(r.pnl).toString().padStart(8)} ${String(r.n).padStart(5)} ${r.wr.toFixed(1).padStart(4)} $${Math.round(r.dd).toString().padStart(7)} ${r.ratio.toFixed(2).padStart(6)} ${String(r.pos).padStart(5)}`);
  }
  // MERGE with existing file so we don't wipe iron rows added by iron-sweep.
  // Strategy: keep all rows EXCEPT prior 2-leg credit-spread rows (matching this script's spread labels).
  const SWEEP_JSON = outPath('/tmp/credit_spread_sweep.json', TARGET);
  let existing:any[] = [];
  try { existing = JSON.parse(fs.readFileSync(SWEEP_JSON,'utf8')); } catch {}
  // Identify 2-leg credit-spread spread labels we generate (e.g. "ATM w5", "15ITM w10")
  const isCreditSpread = (s:string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);
  existing = existing.filter((r:any) => !isCreditSpread(r.spread));
  const merged = existing.concat(rows);
  fs.writeFileSync(SWEEP_JSON, JSON.stringify(merged,null,2));
  // Also write to viewer's expected location so dashboard sees fresh data
  // immediately without a manual copy step.
  const STUDIO_SWEEP = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-sweep.json'), TARGET);
  try { fs.writeFileSync(STUDIO_SWEEP, JSON.stringify(merged)); } catch {}
  console.log(`\nMerged: ${existing.length} prior (iron) + ${rows.length} new (credit-spread) = ${merged.length}`);
  // Daily-series emission: shared `dates` array + per-variant pnl-by-date arrays.
  const allDates = new Set<string>();
  for(const v of results.values()) for(const d of v.daily.keys()) allDates.add(d);
  const dates = [...allDates].sort();
  const di = new Map<string,number>(); dates.forEach((d,i)=>di.set(d,i));
  const series: Record<string, number[]> = {};
  for(const [k,v] of results){
    const arr = new Array(dates.length).fill(0);
    for(const [d,p] of v.daily) arr[di.get(d)!] = +p.toFixed(2);
    series[k] = arr;
  }
  // Merge daily-series with existing file so iron series stay
  const DAILY_JSON = outPath('/tmp/credit_spread_daily.json', TARGET);
  let existingDaily:any = {dates:[], series:{}};
  try { existingDaily = JSON.parse(fs.readFileSync(DAILY_JSON,'utf8')); } catch {}
  // Drop prior 2-leg credit-spread keys (matched by spread label pattern in key)
  const isCsKey = (k:string) => {
    const parts = k.split('|');
    return parts.length>=2 && /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(parts[1]);
  };
  for(const k of Object.keys(existingDaily.series||{})) if(isCsKey(k)) delete existingDaily.series[k];
  // Build unified date list
  const allDatesSet = new Set<string>(existingDaily.dates || []);
  for(const d of dates) allDatesSet.add(d);
  const mergedDates = [...allDatesSet].sort();
  const mDi = new Map<string,number>(); mergedDates.forEach((d,i)=>mDi.set(d,i));
  const mergedSeries: Record<string, number[]> = {};
  // Re-index existing (iron) series onto merged dates
  for(const k of Object.keys(existingDaily.series||{})){
    const oldArr: number[] = existingDaily.series[k];
    const oldDates: string[] = existingDaily.dates || [];
    const newArr = new Array(mergedDates.length).fill(0);
    for(let i=0;i<oldDates.length;i++){
      const idx = mDi.get(oldDates[i]);
      if(idx!=null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  // Add new credit-spread series
  for(const k of Object.keys(series)){
    const oldArr = series[k];
    const newArr = new Array(mergedDates.length).fill(0);
    for(let i=0;i<dates.length;i++){
      const idx = mDi.get(dates[i]);
      if(idx!=null) newArr[idx] = oldArr[i] || 0;
    }
    mergedSeries[k] = newArr;
  }
  fs.writeFileSync(DAILY_JSON, JSON.stringify({dates: mergedDates, series: mergedSeries}));
  const STUDIO_DAILY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-daily.json'), TARGET);
  try { fs.writeFileSync(STUDIO_DAILY, JSON.stringify({dates: mergedDates, series: mergedSeries})); } catch {}
  console.log(`Daily merged: ${mergedDates.length} dates × ${Object.keys(mergedSeries).length} variants`);
  console.log('Saved to /tmp/credit_spread_*.json + scripts/autoresearch/output/spread-*.json');

  // ── Per-hour aggregates — mirror iron-sweep, MERGE with existing iron rows.
  // Studio's Hourly Heatmap reads scripts/autoresearch/output/spread-hourly*.json;
  // iron writes its entries (with `structure`) — we APPEND credit-spread entries
  // (with `spread`) and drop any prior credit entries on re-run.
  const HOURLY_JSON   = outPath('/tmp/credit_spread_hourly.json', TARGET);
  const STUDIO_HOURLY = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/spread-hourly.json'), TARGET);
  const creditHourlyEntries: any[] = [];
  for (const [k, v] of results) {
    const [signal, spread, exit] = k.split('|');
    if (v.perHour.size === 0) continue;
    const byHour: Record<number, any> = {};
    for (const [h, hb] of v.perHour) {
      if (hb.n === 0) continue;
      byHour[h] = {
        n: hb.n,
        avgCredit:  +(hb.creditSum / hb.n).toFixed(3),
        avgMaxRisk: +(hb.riskSum   / hb.n).toFixed(0),
        avgPnl:     +(hb.pnlSum    / hb.n).toFixed(2),
        totalPnl:   +hb.pnlSum.toFixed(0),
        wr:         +(100 * hb.wins / hb.n).toFixed(1),
      };
    }
    creditHourlyEntries.push({ signal, spread, exit, hours: byHour });
  }
  const isCsHourly = (s: string) => /\d*\s*(ITM|ATM|OTM)\s*w\d+/.test(s);
  let mergedHourly: any[] = [];
  try {
    const existingRaw = JSON.parse(fs.readFileSync(STUDIO_HOURLY, 'utf8'));
    if (Array.isArray(existingRaw)) {
      mergedHourly = existingRaw.filter((e: any) => !isCsHourly(e?.spread || e?.structure || ''));
    } else if (existingRaw && typeof existingRaw === 'object') {
      mergedHourly = Object.values(existingRaw).filter((e: any) => !isCsHourly(e?.spread || e?.structure || ''));
    }
  } catch { /* missing/parse-fail → start fresh from iron's entries via this run if any */ }
  mergedHourly = mergedHourly.concat(creditHourlyEntries);
  fs.writeFileSync(HOURLY_JSON, JSON.stringify(mergedHourly));
  try { fs.writeFileSync(STUDIO_HOURLY, JSON.stringify(mergedHourly)); } catch {}
  console.log(`Hourly merged: ${mergedHourly.length} variants (${creditHourlyEntries.length} credit-spread + ${mergedHourly.length - creditHourlyEntries.length} prior)`);
}

// Per-trade emission + summary/finalize. Called from INSIDE the async IIFE
// (after the await-driven date loop completes) so results is fully populated.
function finalize(){
  flushTrades();

  if (EMIT_ONLY) process.exit(0);   // emit-only: skip summary + dashboard writes

  if (process.env.SWEEP_SHARD_OUT) {
    // Worker: dump this shard's partial accumulator; do NOT run the
    // dashboard-merge finalize (the merge run owns the final JSON).
    dumpResults(results, process.env.SWEEP_SHARD_OUT);
  } else {
    if (process.env.SWEEP_MERGE) loadShardsInto(process.env.SWEEP_MERGE, results);
    summary();
    // Incremental: persist the merged (prior + new dates) accumulator so the
    // next nightly run only replays the following day.
    if (STATE_FILE) { dumpResults(results, STATE_FILE); console.error(`[incremental] state saved → ${STATE_FILE}`); }
  }
}
