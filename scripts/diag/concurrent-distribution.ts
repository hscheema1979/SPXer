/**
 * concurrent-distribution.ts
 *
 * Targeted exact compute: replay signals for a SPECIFIC set of variants and
 * produce:
 *   1. Per-minute concurrent-position distribution (p50, p80, p90, p95, p99, peak)
 *      sampled across every minute of every active day.
 *   2. Correlation: on days bucketed by their peak concurrency, what's the
 *      average daily P&L? (Tests the hypothesis "high-overlap days = losing
 *      days".)
 *
 * Why it's fast vs the full iron-sweep: we run only the variants we care
 * about (~2-10) instead of the full 16,000-variant grid. ~10-20s vs 45-60min.
 *
 * Run: cd ~/SPXer && npx tsx scripts/diag/concurrent-distribution.ts
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';

// Profile resolution: --symbol SPX|SPY|QQQ|NDX [--dte 0|1].
// SI = strike interval ($ between adjacent strikes: SPX 5, SPY/QQQ 1, NDX 10)
// — used for strike rounding so ETF geometry isn't snapped to the SPX $5 grid.
const TARGET = resolveSymbolTarget(process.argv);
const SI = TARGET.strikeInterval;

const TRADESTART_SEC = 1800;
const CUTOFF_HHMM = 6 * 3600;            // 15:30 ET — no NEW entries after this
const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET — forced exit
const SESSION_MIN = 345;  // 10:00 → 15:45 = 345 min
// Round-trip slippage — MUST match the sweep engines exactly
// (iron-sweep SLIPPAGE_PER_STRUCTURE=25, credit-spread SLIPPAGE_PER_SPREAD=15).
const SLIP_IRON = 25, SLIP_SPREAD = 15;

const MIN_ALIGN = 3, CROSS_WIN = 60;

interface TargetVariant {
  label: string;
  hmaFast: number;
  hmaSlow: number;
  timeframes: number[];
  kind?: 'iron' | 'spread';  // default 'iron' for back-compat
  centerOffset?: number;      // iron only
  shortOffset?: number;       // both (iron=condor offset, spread=short strike offset)
  wingWidth?: number;         // iron
  width?: number;             // 2-leg spread
  tpFrac: number;
  slMult: number;
}

// Targets source (priority order):
//   1. RISK_TARGETS_INLINE env var (JSON array) — used by on-demand API endpoint
//   2. /tmp/risk_targets.json — written by the bulk curator script
//   3. Hand-picked default list below — fallback for ad-hoc runs
let TARGETS: TargetVariant[] = [];
const inline = process.env.RISK_TARGETS_INLINE;
if (inline) {
  try { TARGETS = JSON.parse(inline); console.log(`Loaded ${TARGETS.length} targets from RISK_TARGETS_INLINE env`); }
  catch (e:any) { console.error(`Bad RISK_TARGETS_INLINE: ${e.message}`); }
} else {
  const RISK_TARGETS_FILE = '/tmp/risk_targets.json';
  if (fs.existsSync(RISK_TARGETS_FILE)) {
    try {
      TARGETS = JSON.parse(fs.readFileSync(RISK_TARGETS_FILE, 'utf8'));
      console.log(`Loaded ${TARGETS.length} targets from ${RISK_TARGETS_FILE}`);
    } catch (e:any) { console.error(`Failed to load ${RISK_TARGETS_FILE}: ${e.message}`); }
  }
}
if (TARGETS.length === 0) TARGETS = [
  // Currently live
  { label: 'HMA  1m 3x9|IB±25 w10|TP10 only',     hmaFast: 3, hmaSlow: 9,  timeframes: [1],     centerOffset: 25, wingWidth: 10, tpFrac: 0.10, slMult: 0 },
  { label: 'HMA  2+3+5 3x9|IB±25 w10|TP10 only', hmaFast: 3, hmaSlow: 9,  timeframes: [2,3,5], centerOffset: 25, wingWidth: 10, tpFrac: 0.10, slMult: 0 },
  // Comparison candidates
  { label: 'HMA  1m 3x9|IB±20 w10|TP10 only',     hmaFast: 3, hmaSlow: 9,  timeframes: [1],     centerOffset: 20, wingWidth: 10, tpFrac: 0.10, slMult: 0 },
  { label: 'HMA  1m 3x9|IB±25 w15|TP10 only',     hmaFast: 3, hmaSlow: 9,  timeframes: [1],     centerOffset: 25, wingWidth: 15, tpFrac: 0.10, slMult: 0 },
  { label: 'HMA  1m 3x12|IB±25 w10|TP10 only',    hmaFast: 3, hmaSlow: 12, timeframes: [1],     centerOffset: 25, wingWidth: 10, tpFrac: 0.10, slMult: 0 },
  { label: 'HMA  1m 3x21|IB±25 w10|TP15 only',    hmaFast: 3, hmaSlow: 21, timeframes: [1],     centerOffset: 25, wingWidth: 10, tpFrac: 0.15, slMult: 0 },
  { label: 'HMA  1m 3x9|IB±25 w10|TP15 only',     hmaFast: 3, hmaSlow: 9,  timeframes: [1],     centerOffset: 25, wingWidth: 10, tpFrac: 0.15, slMult: 0 },
  { label: 'HMA  1m 3x9|IB±25 w10|TP25 only',     hmaFast: 3, hmaSlow: 9,  timeframes: [1],     centerOffset: 25, wingWidth: 10, tpFrac: 0.25, slMult: 0 },
];

// ─ Helpers from iron-sweep ────────────────────────────────────────────────────
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
function listDates(): string[] { return listDatesFor(TARGET); }
function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }

interface TFState { closed: any[]; partial: any | null; }
function mkSt(): TFState { return { closed: [], partial: null }; }
function feed(st: TFState, b: any, tf: number) {
  const bk = Math.floor(b.ts / (tf * 60)) * (tf * 60);
  if (!st.partial || st.partial.ts !== bk) { if (st.partial) st.closed.push(st.partial); st.partial = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close }; }
  else { if (b.high > st.partial.high) st.partial.high = b.high; if (b.low < st.partial.low) st.partial.low = b.low; st.partial.close = b.close; }
}
function wma(arr: number[], end: number, p: number): number | null { if (end < p - 1) return null; let s = 0, w = 0; for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i); } return s / w; }
function hmaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const hf = Math.floor(fast / 2), sf = Math.floor(Math.sqrt(fast));
  const hs = Math.floor(slow / 2), ss = Math.floor(Math.sqrt(slow));
  const rf: number[] = [], rs: number[] = []; let fa: number | null = null, sa: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    const a = wma(closes, i, hf), b = wma(closes, i, fast); if (a != null && b != null) { rf.push(2 * a - b); if (rf.length >= sf) fa = wma(rf, rf.length - 1, sf); }
    const c = wma(closes, i, hs), d = wma(closes, i, slow); if (c != null && d != null) { rs.push(2 * c - d); if (rs.length >= ss) sa = wma(rs, rs.length - 1, ss); }
  }
  if (fa == null || sa == null) return null; return fa > sa ? 'bull' : 'bear';
}
function getDir(st: TFState, fast: number, slow: number): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  return hmaDir(bars.map((b: any) => b.close), fast, slow);
}

function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue; const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } }
  return best;
}
function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }

interface Leg { bars: any[]; sign: number; strike: number; symbol: string; }
function buildTrajectory(legs: Leg[], entryTs: number, endTs: number): Array<{ ts: number, V: number }> {
  const tsSet = new Set<number>();
  for (const lg of legs) for (const b of lg.bars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a, b) => a - b);
  const ptr = new Array(legs.length).fill(0);
  const last = new Array<number | null>(legs.length).fill(null);
  const traj: Array<{ ts: number, V: number }> = [];
  for (const t of tsList) {
    for (let i = 0; i < legs.length; i++) {
      while (ptr[i] < legs[i].bars.length && legs[i].bars[ptr[i]].ts <= t) { last[i] = legs[i].bars[ptr[i]].close; ptr[i]++; }
    }
    if (last.every(v => v != null)) { let V = 0; for (let i = 0; i < legs.length; i++) V += legs[i].sign * (last[i] as number); traj.push({ ts: t, V }); }
  }
  return traj;
}

function applyExit(traj: Array<{ ts: number, V: number }>, endTs: number, legs: Leg[], credit: number, tpFrac: number, slMult: number, spxAtSettle: number | null) {
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slMult > 0 ? (1 + slMult) * credit : Infinity;
  for (const p of traj) {
    if (p.ts > endTs) break;
    if (tpFrac > 0 && p.V <= tpV) return { exitTs: p.ts, exitV: Math.max(0, p.V), reason: 'TP' };
    if (slMult > 0 && p.V >= slV) return { exitTs: p.ts, exitV: p.V, reason: 'SL' };
  }
  // dte-aware settle. 0DTE: at 15:45 extrinsic ≈ 0 → intrinsic value is a
  // valid mark. 1DTE: the option still has ~1 trading day of life, so
  // intrinsic massively understates leg value (inflates short-premium P&L) —
  // mark each leg at its real option bar instead.
  if (TARGET.dte === 0 && spxAtSettle != null) {
    let V = 0;
    for (const lg of legs) {
      const isPut = (lg.symbol[lg.symbol.length - 9] === 'P');
      const intrinsic = isPut ? Math.max(0, lg.strike - spxAtSettle) : Math.max(0, spxAtSettle - lg.strike);
      V += lg.sign * intrinsic;
    }
    return { exitTs: endTs, exitV: Math.max(0, V), reason: 'expiry' };
  }
  {
    let V = 0, ok = true;
    for (const lg of legs) { const px = optPx(lg.bars, endTs); if (px == null) { ok = false; break; } V += lg.sign * px; }
    if (ok) return { exitTs: endTs, exitV: Math.max(0, V), reason: 'settle-mtm' };
  }
  return { exitTs: endTs, exitV: 0, reason: 'expiry' };
}

// ─ Main ────────────────────────────────────────────────────────────────────────
const dates = listDates();
console.log(`Processing ${dates.length} dates for ${TARGETS.length} variants...\n`);

interface VariantStat {
  // Per-day arrays of (concurrent count per minute) and per-day net P&L
  perDayConcurrents: Map<string, number[]>;   // date → array of 345 minute samples
  perDayPnl: Map<string, number>;
}
const stats = new Map<string, VariantStat>();
for (const v of TARGETS) stats.set(v.label, { perDayConcurrents: new Map(), perDayPnl: new Map() });

let processed = 0;
const t0 = Date.now();
for (const date of dates) {
  let c1: any, p1: any;
  try { c1 = loadDay(TARGET, date, '1m') as any; p1 = loadDay(TARGET, prevDate(date), '1m') as any; } catch { continue; }
  if (!c1) continue;
  if (!c1?.spxBars?.length) continue;
  const sess = sessOpenTs(date);
  const tradeStart = sess + TRADESTART_SEC;
  const cutoff = sess + CUTOFF_HHMM;     // entries at/after 15:30 ET are dropped
  const settle = sess + SETTLE_HHMM;
  const s1: any[] = c1.spxBars;

  // Find SPX at settle (for expiry intrinsic)
  let spxAtSettle: number | null = null;
  for (let i = s1.length - 1; i >= 0; i--) if (s1[i].ts <= settle) { spxAtSettle = s1[i].close; break; }

  for (const variant of TARGETS) {
    // Build TF states from prev day + current day
    const sts = variant.timeframes.map(() => mkSt());
    for (const b of (p1?.spxBars ?? [])) sts.forEach((st, i) => feed(st, b, variant.timeframes[i]));

    // Walk bars detecting signals
    const prevDirs: any[] = variant.timeframes.map(() => null);
    const bullCross = variant.timeframes.map(() => 0), bearCross = variant.timeframes.map(() => 0);
    let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
    const entries: Array<{ entryTs: number; dir: 'bull' | 'bear' }> = [];
    for (const b of s1) {
      sts.forEach((st, i) => feed(st, b, variant.timeframes[i]));
      if (b.ts < tradeStart) continue;
      const dirs = sts.map((st, i) => getDir(st, variant.hmaFast, variant.hmaSlow));
      dirs.forEach((d, i) => { if (prevDirs[i] !== null && d !== prevDirs[i]) { if (d === 'bull') bullCross[i] = b.ts; if (d === 'bear') bearCross[i] = b.ts; } prevDirs[i] = d; });
      const allBull = dirs.every(d => d === 'bull'), allBear = dirs.every(d => d === 'bear');
      if (allBull) { bullStreak++; bearStreak = 0; bearFired = false; } else { bullStreak = 0; bullFired = false; }
      if (allBear) { bearStreak++; bullStreak = 0; bullFired = false; } else { bearStreak = 0; bearFired = false; }
      if (allBull && bullStreak >= MIN_ALIGN && !bullFired) {
        const ts = bullCross.filter(t => t > 0);
        if (ts.length === variant.timeframes.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ entryTs: b.ts + 60, dir: 'bull' }); bullFired = true; }
      }
      if (allBear && bearStreak >= MIN_ALIGN && !bearFired) {
        const ts = bearCross.filter(t => t > 0);
        if (ts.length === variant.timeframes.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ entryTs: b.ts + 60, dir: 'bear' }); bearFired = true; }
      }
    }

    // For each entry, find legs + compute exit
    const tradeSpans: Array<{ entryTs: number; exitTs: number; pnl: number }> = [];
    const kind = variant.kind || 'iron';
    for (const ev of entries) {
      // Mirror the sweep engines EXACTLY (iron-sweep.ts / credit-spread-sweep.ts):
      //  • drop entries at/after the 15:30 ET cutoff
      //  • NO Math.round(/SI) snap — pass the raw target to findStrike, which
      //    already picks the nearest listed strike (double-rounding shifts legs)
      //  • iron: require 4 DISTINCT contract symbols; credit ≤0.10 reject,
      //    credit ≥ width*0.95 reject; slippage $25
      //  • spread: credit ≤0.05 reject (no width cap); slippage $15
      if (ev.entryTs >= cutoff) continue;
      const spot = optPx(s1, ev.entryTs - 1); if (spot == null) continue;
      let legs: Leg[] | null = null;
      let widthVal = 0;
      let slip = SLIP_IRON;
      if (kind === 'iron') {
        const co = variant.centerOffset ?? 0;
        const center = co ? spot + (ev.dir === 'bull' ? co : -co) : spot;
        const sOff = variant.shortOffset ?? 0;
        const w = variant.wingWidth ?? 10;
        const Kshort_p = center - sOff;
        const Klong_p  = Kshort_p - w;
        const Kshort_c = center + sOff;
        const Klong_c  = Kshort_c + w;
        const sym_sp = findStrike(c1, 'P', Kshort_p);
        const sym_lp = findStrike(c1, 'P', Klong_p);
        const sym_sc = findStrike(c1, 'C', Kshort_c);
        const sym_lc = findStrike(c1, 'C', Klong_c);
        if (!sym_sp || !sym_lp || !sym_sc || !sym_lc) continue;
        if (new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) continue;
        legs = [
          { symbol: sym_sp, strike: Kshort_p, sign: +1, bars: c1.contractBars.get(sym_sp) },
          { symbol: sym_lp, strike: Klong_p,  sign: -1, bars: c1.contractBars.get(sym_lp) },
          { symbol: sym_sc, strike: Kshort_c, sign: +1, bars: c1.contractBars.get(sym_sc) },
          { symbol: sym_lc, strike: Klong_c,  sign: -1, bars: c1.contractBars.get(sym_lc) },
        ];
        widthVal = w; slip = SLIP_IRON;
      } else {
        // 2-leg credit spread (credit-spread-sweep.ts geometry, verbatim):
        //   bear → call spread: shortK = spot + shortOffset; longK = shortK + width
        //   bull → put  spread: shortK = spot − shortOffset; longK = shortK − width
        // shortOffset is signed (ITM negative) — same convention as parseRowSpec.
        const w = variant.width ?? 10;
        const off = variant.shortOffset ?? 0;
        const isCall = ev.dir === 'bear';
        const letter: 'C' | 'P' = isCall ? 'C' : 'P';
        const k_s = isCall ? spot + off : spot - off;
        const k_l = isCall ? k_s + w : k_s - w;
        const sym_s = findStrike(c1, letter, k_s);
        const sym_l = findStrike(c1, letter, k_l);
        if (!sym_s || !sym_l) continue;
        if (sym_s === sym_l) continue;
        legs = [
          { symbol: sym_s, strike: k_s, sign: +1, bars: c1.contractBars.get(sym_s) },
          { symbol: sym_l, strike: k_l, sign: -1, bars: c1.contractBars.get(sym_l) },
        ];
        widthVal = w; slip = SLIP_SPREAD;
      }
      if (!legs) continue;
      const entryPx = legs.map(lg => optPx(lg.bars, ev.entryTs - 1));
      if (entryPx.some(p => p == null)) continue;
      const credit = legs.reduce((s, lg, i) => s + lg.sign * (entryPx[i] as number), 0);
      if (kind === 'iron') {
        if (credit <= 0.10) continue;
        if (credit >= widthVal * 0.95) continue;
      } else {
        if (credit <= 0.05) continue;
      }
      const traj = buildTrajectory(legs, ev.entryTs, settle);
      const ex = applyExit(traj, settle, legs, credit, variant.tpFrac, variant.slMult, spxAtSettle);
      const pnl = (credit - ex.exitV) * 100 - slip;
      tradeSpans.push({ entryTs: ev.entryTs, exitTs: ex.exitTs, pnl });
    }

    // Bucket per-minute concurrent counts
    const minuteCounts = new Array(SESSION_MIN).fill(0);
    for (const span of tradeSpans) {
      const startMin = Math.max(0, Math.floor((span.entryTs - tradeStart) / 60));
      const endMin = Math.min(SESSION_MIN - 1, Math.floor((span.exitTs - tradeStart) / 60));
      for (let m = startMin; m <= endMin; m++) minuteCounts[m]++;
    }
    const dayPnl = tradeSpans.reduce((s, t) => s + t.pnl, 0);
    const st = stats.get(variant.label)!;
    st.perDayConcurrents.set(date, minuteCounts);
    st.perDayPnl.set(date, dayPnl);
    // Stash per-day trade list on the variant object for the cap simulation
    // below (avoids re-replaying signals).
    const vAny = variant as any;
    if (!vAny._tradeMap) vAny._tradeMap = new Map();
    vAny._tradeMap.set(date, tradeSpans);
  }

  processed++;
  if (processed % 50 === 0) console.log(`  ${processed}/${dates.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
console.log(`\nFinished ${processed} dates in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * (sorted.length - 1));
  return sorted[idx];
}

// Aggregate per-variant for JSON output + console summary
const output: Record<string, any> = {};

for (const variant of TARGETS) {
  const st = stats.get(variant.label)!;
  // Flatten all minute counts across all days
  const allMinutes: number[] = [];
  for (const arr of st.perDayConcurrents.values()) allMinutes.push(...arr);
  const totalDays = st.perDayConcurrents.size;
  const totalMinutes = allMinutes.length;
  const mean = allMinutes.reduce((a, b) => a + b, 0) / totalMinutes;
  // Distribution histogram
  const hist: Map<number, number> = new Map();
  for (const v of allMinutes) hist.set(v, (hist.get(v) || 0) + 1);
  const maxObserved = Math.max(...allMinutes);

  console.log(`═══ ${variant.label} ═══`);
  console.log(`  Total days: ${totalDays}, total minute-samples: ${totalMinutes}`);
  console.log(`  Mean concurrent: ${mean.toFixed(3)}`);
  console.log(`  Percentiles:`);
  for (const p of [50, 75, 80, 85, 90, 95, 98, 99, 99.5, 100]) {
    const v = percentile(allMinutes, p);
    const pct = ((hist.get(v) || 0) / totalMinutes * 100).toFixed(2);
    console.log(`    p${String(p).padStart(4)}: ${v.toString().padStart(2)} concurrent  (${pct}% of minutes at this exact value)`);
  }
  console.log(`  Max observed: ${maxObserved}`);

  // Histogram of "max concurrent per day" — this is the "peak" you'd see daily
  const dailyPeaks: number[] = [];
  const dailyPeakWithPnl: Array<{ date: string; peak: number; pnl: number }> = [];
  for (const [date, arr] of st.perDayConcurrents) {
    const peak = Math.max(...arr);
    dailyPeaks.push(peak);
    dailyPeakWithPnl.push({ date, peak, pnl: st.perDayPnl.get(date) || 0 });
  }
  console.log(`\n  DAILY peak distribution (max concurrent on each day):`);
  for (const p of [50, 75, 80, 85, 90, 95, 99, 100]) {
    console.log(`    p${String(p).padStart(3)}: ${percentile(dailyPeaks, p)}`);
  }

  // Correlation: bucket days by peak, show avg P&L
  console.log(`\n  Daily P&L by peak-concurrent bucket:`);
  const buckets: Map<number, { count: number; pnlSum: number; pnlMin: number; pnlMax: number; wins: number }> = new Map();
  for (const r of dailyPeakWithPnl) {
    const bucket = r.peak;
    let b = buckets.get(bucket);
    if (!b) { b = { count: 0, pnlSum: 0, pnlMin: Infinity, pnlMax: -Infinity, wins: 0 }; buckets.set(bucket, b); }
    b.count++;
    b.pnlSum += r.pnl;
    if (r.pnl < b.pnlMin) b.pnlMin = r.pnl;
    if (r.pnl > b.pnlMax) b.pnlMax = r.pnl;
    if (r.pnl > 0) b.wins++;
  }
  console.log(`    ${'peak'.padStart(5)} ${'days'.padStart(5)} ${'avgPnl'.padStart(9)} ${'WR%'.padStart(6)} ${'min'.padStart(9)} ${'max'.padStart(9)}`);
  const sortedBuckets = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
  const bucketArr: any[] = [];
  for (const [peak, b] of sortedBuckets) {
    bucketArr.push({ peak, days: b.count, avgPnl: +(b.pnlSum / b.count).toFixed(0), wr: +(100 * b.wins / b.count).toFixed(0), pnlMin: +b.pnlMin.toFixed(0), pnlMax: +b.pnlMax.toFixed(0) });
    console.log(`    ${String(peak).padStart(5)} ${String(b.count).padStart(5)} $${(b.pnlSum / b.count).toFixed(0).padStart(7)} ${(100 * b.wins / b.count).toFixed(0).padStart(5)}% $${b.pnlMin.toFixed(0).padStart(7)} $${b.pnlMax.toFixed(0).padStart(7)}`);
  }
  console.log();

  // ── maxPositions cap simulation ────────────────────────────────────────
  // For each cap level, replay the day's trades chronologically: drop new
  // entries that would push concurrent open count above the cap. Sum
  // surviving trades' P&L → per-day series → cum, WR, DD.
  // We need per-trade data — recompute by re-walking the variant's signals.
  // Already done above in tradeSpans variable, but tradeSpans is per-day
  // local; need to persist. Re-derive from perDayConcurrents + the daily
  // P&L map by re-running the replay quickly… actually simpler: re-walk
  // trades using the same logic as the earlier loop. To keep this script
  // efficient, we accumulate per-day {entryTs, exitTs, pnl} into a new map
  // alongside the existing perDayConcurrents.
  // (Done by tracking tradeSpansAll above — added below.)
  const capResults: Record<string, any> = {};
  const CAPS = [1, 2, 3, 5, 8, 10, 12, 15, 9999];
  const tradeMap = (variant as any)._tradeMap as Map<string, Array<{entryTs:number;exitTs:number;pnl:number}>>;
  if (tradeMap) {
    for (const cap of CAPS) {
      const dailyPnls: number[] = [];
      let totalKept = 0, totalSkipped = 0, tradeWins = 0;
      for (const [, trades] of tradeMap) {
        const sorted = [...trades].sort((a,b) => a.entryTs - b.entryTs);
        const open: typeof trades = [];
        let dayKept = 0, dayPnl = 0;
        for (const t of sorted) {
          for (let i = open.length - 1; i >= 0; i--) if (open[i].exitTs <= t.entryTs) open.splice(i, 1);
          if (open.length >= cap) { totalSkipped++; continue; }
          open.push(t); dayKept++; dayPnl += t.pnl;
          if (t.pnl > 0) tradeWins++;   // match sweep's `pnl_net > 0` win def
        }
        totalKept += dayKept;
        dailyPnls.push(dayPnl);
      }
      const cum = dailyPnls.reduce((s,v)=>s+v,0);
      const dayWins = dailyPnls.filter(v => v > 0.01).length;
      const dayWr = 100 * dayWins / dailyPnls.length;
      const tradeWr = totalKept > 0 ? 100 * tradeWins / totalKept : 0;
      let peak = 0, cumc = 0, mdd = 0;
      for (const v of dailyPnls) { cumc += v; if (cumc > peak) peak = cumc; if (peak - cumc > mdd) mdd = peak - cumc; }
      const worst = Math.min(...dailyPnls);
      capResults[cap === 9999 ? 'uncap' : `cap${cap}`] = {
        n: totalKept, skipped: totalSkipped,
        cumPnl: +cum.toFixed(0), avgPnl: +(cum / dailyPnls.length).toFixed(0),
        wr: +dayWr.toFixed(1),         // legacy field — per-DAY positive WR
        tradeWr: +tradeWr.toFixed(1),   // per-TRADE win rate of kept trades only
        dayWr: +dayWr.toFixed(1),
        maxDD: +mdd.toFixed(0), worstDay: +worst.toFixed(0),
      };
    }
  }

  output[variant.label] = {
    totalDays, totalMinutes,
    meanConcurrent: +mean.toFixed(3),
    minutePercentiles: {
      p50: percentile(allMinutes, 50), p75: percentile(allMinutes, 75),
      p80: percentile(allMinutes, 80), p85: percentile(allMinutes, 85),
      p90: percentile(allMinutes, 90), p95: percentile(allMinutes, 95),
      p98: percentile(allMinutes, 98), p99: percentile(allMinutes, 99),
      p995: percentile(allMinutes, 99.5), p100: maxObserved,
    },
    dailyPeakPercentiles: {
      p50: percentile(dailyPeaks, 50), p75: percentile(dailyPeaks, 75),
      p80: percentile(dailyPeaks, 80), p85: percentile(dailyPeaks, 85),
      p90: percentile(dailyPeaks, 90), p95: percentile(dailyPeaks, 95),
      p99: percentile(dailyPeaks, 99), p100: percentile(dailyPeaks, 100),
    },
    pnlByPeakBucket: bucketArr,
    capResults,
  };
}

// MERGE with existing risk-analysis.json so on-demand single-variant runs
// don't wipe the pre-computed batch. Existing keys with the same name get
// overwritten (= refresh). Per-symbol namespaced (outPath): SPX-0dte keeps
// the legacy unsuffixed name; SPY/QQQ-1dte → risk-analysis-{sym}-1dte.json
// (mirrors spread-sweep{suffix}.json so the Studio cap filter resolves it).
const OUT_PATH = outPath(path.join(__dirname, '..', 'autoresearch', 'output', 'risk-analysis.json'), TARGET);
let existing: Record<string, any> = {};
if (fs.existsSync(OUT_PATH)) {
  try { existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch {}
}
const merged = { ...existing, ...output };
fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));
console.log(`\nWrote ${OUT_PATH} (${Object.keys(output).length} new/updated, ${Object.keys(merged).length} total)`);
