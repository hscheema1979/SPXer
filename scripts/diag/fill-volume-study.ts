/**
 * fill-volume-study.ts — STANDALONE DIAGNOSTIC (does NOT touch production sweeps)
 *
 * Question: how much of the apparent edge in the iron / 2-leg credit sweeps is
 * an artifact of the "false mid" — a TP that fires off a STALE leg close that
 * wasn't actually tradeable that minute?
 *
 * The production exit (`applyExit`) checks only the price level of the
 * carry-forward trajectory V = Σ sign_i × close_i(t). A leg with no bar at ts=t
 * keeps contributing its last close. This study re-evaluates the SAME entries /
 * trajectories under a set of VOLUME / FRESHNESS exit gates and compares
 * fill-rate, WR, hold, $/trade, $Net.
 *
 * Signal detection + structure building are copied VERBATIM from
 *   scripts/diag/iron-sweep.ts  (iron condor / butterfly)
 *   scripts/diag/credit-spread-sweep.ts  (2-leg credit spread)
 * so entries / trajectories / credit match production exactly. Only the EXIT
 * evaluation varies.
 *
 * Data facts (established, used not re-investigated):
 *  - historical option bars carry OHLC-mid + volume only (bid/ask 0% populated)
 *  - ~0% zero-volume bars; "staleness" = a leg has NO bar at minute t (a gap),
 *    not a zero-volume bar. A leg is FRESH at trajectory ts t iff it has a bar
 *    with ts === t; otherwise its contribution is a carried-forward stale close.
 *
 * Outputs: stdout tables + /tmp/fill-volume-study.json + /tmp/fill-volume-study.md
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import * as fs from 'fs';

const TARGET = resolveSymbolTarget(['--symbol', 'SPX']);
const SI = TARGET.strikeInterval;

// Slippage as the engines use it.
const SLIPPAGE_PER_STRUCTURE = 25;   // iron (4-leg)
const SLIPPAGE_PER_SPREAD = 15;      // 2-leg

// Engine constants — VERBATIM from both sweeps.
const MIN_ALIGN = 3, CROSS_WIN = 60;
const CUTOFF_HHMM = 6 * 3600;          // 15:30 ET
const SETTLE_HHMM = 6 * 3600 + 15 * 60; // 15:45 ET
const TRADESTART_SEC = 1800;            // 10:00 ET

// ── Signal engine (VERBATIM from iron-sweep.ts / credit-spread-sweep.ts) ─────
type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: { tf: number; fast: number; slow: number }[]; }

function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}

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
function demaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  function dema(p: number): number | null {
    if (closes.length < p) return null;
    const a = 2 / (p + 1);
    let e1 = 0; for (let i = 0; i < p; i++) e1 += closes[i]; e1 /= p;
    const e1s: number[] = [e1];
    for (let i = p; i < closes.length; i++) { e1 = a * closes[i] + (1 - a) * e1; e1s.push(e1); }
    if (e1s.length < p) return null;
    let e2 = 0; for (let i = 0; i < p; i++) e2 += e1s[i]; e2 /= p;
    for (let i = p; i < e1s.length; i++) { e2 = a * e1s[i] + (1 - a) * e2; }
    return 2 * e1s[e1s.length - 1] - e2;
  }
  const f = dema(fast), s = dema(slow);
  if (f == null || s == null) return null; return f > s ? 'bull' : 'bear';
}
function getDir(st: TFState, fast: number, slow: number, signal: Signal): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  const closes = bars.map((b: any) => b.close);
  return signal === 'dema' ? demaDir(closes, fast, slow) : hmaDir(closes, fast, slow);
}

interface SignalEvent { alignTs: number; dir: 'bull' | 'bear'; entryTs: number; }
function detectSignals(date: string, spec: SignalSpec, c1: any, p1: any): { entries: SignalEvent[], dirLog: Map<number, ('bull' | 'bear' | null)[]> } {
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), tradeStart = sess + TRADESTART_SEC;
  const sts = spec.tfs.map(() => mkSt());
  for (const b of (p1?.spxBars ?? [])) { sts.forEach((st, i) => feed(st, b, spec.tfs[i].tf)); }
  const prevDirs = spec.tfs.map(() => null as any);
  const bullCross = spec.tfs.map(() => 0), bearCross = spec.tfs.map(() => 0);
  const dirLog = new Map<number, any[]>();
  const entries: SignalEvent[] = [];
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
  for (const b of s1) {
    sts.forEach((st, i) => feed(st, b, spec.tfs[i].tf));
    if (b.ts < tradeStart) continue;
    const dirs = sts.map((st, i) => getDir(st, spec.tfs[i].fast, spec.tfs[i].slow, spec.signal));
    dirLog.set(b.ts, dirs);
    dirs.forEach((d, i) => { if (prevDirs[i] !== null && d !== prevDirs[i]) { if (d === 'bull') bullCross[i] = b.ts; if (d === 'bear') bearCross[i] = b.ts; } prevDirs[i] = d; });
    const allBull = dirs.every(d => d === 'bull'), allBear = dirs.every(d => d === 'bear');
    if (allBull) { bullStreak++; bearStreak = 0; bearFired = false; } else { bullStreak = 0; bullFired = false; }
    if (allBear) { bearStreak++; bullStreak = 0; bullFired = false; } else { bearStreak = 0; bearFired = false; }
    if (allBull && bullStreak >= MIN_ALIGN && !bullFired) {
      const ts = bullCross.filter(t => t > 0);
      if (ts.length === spec.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ alignTs: b.ts, dir: 'bull', entryTs: b.ts + 60 }); bullFired = true; }
    }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) {
      const ts = bearCross.filter(t => t > 0);
      if (ts.length === spec.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ alignTs: b.ts, dir: 'bear', entryTs: b.ts + 60 }); bearFired = true; }
    }
  }
  return { entries, dirLog };
}

function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue; const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } }
  return best;
}
function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }

// ── Trajectory builders (VERBATIM, but we also record per-leg freshness) ─────
interface Leg { bars: any[]; sign: number; strike: number; symbol: string; }

// Iron: V = Σ sign_i × close_i(t). Carry-forward last close per leg.
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
    if (last.every(v => v != null)) {
      let V = 0;
      for (let i = 0; i < legs.length; i++) V += legs[i].sign * (last[i] as number);
      traj.push({ ts: t, V });
    }
  }
  return traj;
}

// 2-leg: V = short.close − long.close. Carry-forward last close per leg.
function buildSpreadTrajectory(shortBars: any[], longBars: any[], entryTs: number, endTs: number): Array<{ ts: number, V: number }> {
  const tsSet = new Set<number>();
  for (const b of shortBars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  for (const b of longBars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a, b) => a - b);
  const traj: Array<{ ts: number, V: number }> = [];
  let si = 0, li = 0;
  let lastShort: number | null = null, lastLong: number | null = null;
  for (const t of tsList) {
    while (si < shortBars.length && shortBars[si].ts <= t) { lastShort = shortBars[si].close; si++; }
    while (li < longBars.length && longBars[li].ts <= t) { lastLong = longBars[li].close; li++; }
    if (lastShort != null && lastLong != null) traj.push({ ts: t, V: lastShort - lastLong });
  }
  return traj;
}

// ── Freshness / volume index per leg ─────────────────────────────────────────
// For O(1) lookup: ts → bar for each leg, plus the leg's average per-bar volume
// over the trade window [entryTs, endTs]. "Window" = bars with entryTs<ts<=endTs
// (same set that feeds the trajectory).
interface LegIndex {
  sign: number;
  isShort: boolean;          // short leg (we transact) vs wing/long
  byTs: Map<number, any>;    // ts → bar (presence == fresh that minute)
  avgVol: number;            // mean volume over window bars (for %vol gates)
}
function buildLegIndex(leg: Leg, entryTs: number, endTs: number, isShort: boolean): LegIndex {
  const byTs = new Map<number, any>();
  let volSum = 0, n = 0;
  for (const b of leg.bars) {
    if (b.ts > entryTs && b.ts <= endTs) {
      byTs.set(b.ts, b);
      volSum += (b.volume ?? 0); n++;
    }
  }
  return { sign: leg.sign, isShort, byTs, avgVol: n > 0 ? volSum / n : 0 };
}

// ── Exit-fill gates ──────────────────────────────────────────────────────────
// Each gate is a predicate on (ts, legIdxs) → boolean: is the TP fillable here?
type Gate = (ts: number, idxs: LegIndex[]) => boolean;

function gateBaseline(): Gate { return () => true; }
function gateAllFresh(): Gate { return (ts, idxs) => idxs.every(li => li.byTs.has(ts)); }
function gateShortsFresh(): Gate { return (ts, idxs) => idxs.filter(li => li.isShort).every(li => li.byTs.has(ts)); }
function gateKofN(k: number): Gate { return (ts, idxs) => idxs.filter(li => li.byTs.has(ts)).length >= k; }
function gatePerLegVol(xPct: number): Gate {
  const frac = xPct / 100;
  return (ts, idxs) => idxs.every(li => { const b = li.byTs.get(ts); if (!b) return false; return (b.volume ?? 0) >= frac * li.avgVol; });
}
function gateShortsVol(xPct: number): Gate {
  const frac = xPct / 100;
  return (ts, idxs) => idxs.filter(li => li.isShort).every(li => { const b = li.byTs.get(ts); if (!b) return false; return (b.volume ?? 0) >= frac * li.avgVol; });
}
function gateCombinedVol(xPct: number): Gate {
  const frac = xPct / 100;
  // Combined fresh volume that minute vs avg combined per-bar volume over window.
  // avgCombined = Σ_legs avgVol (each leg's mean per-bar vol). Trigger-bar combined
  // = Σ over FRESH legs of that bar's volume (absent legs contribute 0).
  return (ts, idxs) => {
    const avgCombined = idxs.reduce((s, li) => s + li.avgVol, 0);
    if (avgCombined <= 0) return false;
    let cur = 0;
    for (const li of idxs) { const b = li.byTs.get(ts); if (b) cur += (b.volume ?? 0); }
    return cur >= frac * avgCombined;
  };
}

interface GateSpec { label: string; gate: Gate; }
function gateSpecs(nLegs: number): GateSpec[] {
  const specs: GateSpec[] = [
    { label: 'baseline', gate: gateBaseline() },
    { label: 'all-legs-fresh', gate: gateAllFresh() },
    { label: 'shorts-fresh', gate: gateShortsFresh() },
  ];
  // k-of-n: iron k=2,3 ; 2-leg k=1,2
  if (nLegs === 4) { specs.push({ label: 'k2-of-n-fresh', gate: gateKofN(2) }); specs.push({ label: 'k3-of-n-fresh', gate: gateKofN(3) }); }
  else { specs.push({ label: 'k1-of-n-fresh', gate: gateKofN(1) }); specs.push({ label: 'k2-of-n-fresh', gate: gateKofN(2) }); }
  for (const x of [10, 20, 30]) specs.push({ label: `perleg-vol${x}%`, gate: gatePerLegVol(x) });
  for (const x of [10, 20, 30]) specs.push({ label: `shorts-vol${x}%`, gate: gateShortsVol(x) });
  for (const x of [10, 20, 30]) specs.push({ label: `combined-vol${x}%`, gate: gateCombinedVol(x) });
  return specs;
}

// ── Settle valuation (VERBATIM logic from each engine) ───────────────────────
// Iron intrinsic-at-0DTE settle.
function ironSettleV(legs: Leg[], spxAtSettle: number): number {
  let V = 0;
  for (const lg of legs) {
    const isPut = (lg.symbol[lg.symbol.length - 9] === 'P');
    const intrinsic = isPut ? Math.max(0, lg.strike - spxAtSettle) : Math.max(0, spxAtSettle - lg.strike);
    V += lg.sign * intrinsic;
  }
  return Math.max(0, V);
}
// 2-leg intrinsic-at-0DTE settle.
function spreadSettleV(isCallSpread: boolean, shortStrike: number, longStrike: number, spxAtSettle: number): number {
  let v: number;
  if (isCallSpread) v = Math.max(0, spxAtSettle - shortStrike) - Math.max(0, spxAtSettle - longStrike);
  else v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
  return Math.max(0, v);
}

// ── Gated exit evaluation ────────────────────────────────────────────────────
// Walk the trajectory; the first ts where V <= tpV AND the gate passes is the
// honored TP. If the gate never passes before settle, ride to settle (intrinsic
// at 0DTE). Returns {exitTs, exitV, reason}. We study TP-only variants here, so
// no SL / flip path is needed (slMult=0, useFlip=false).
function gatedExit(
  traj: Array<{ ts: number, V: number }>, settle: number, idxs: LegIndex[], gate: Gate,
  credit: number, tpFrac: number, settleV: number,
): { exitTs: number, exitV: number, reason: 'TP' | 'expiry' } {
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  for (const p of traj) {
    if (p.ts > settle) break;
    if (tpFrac > 0 && p.V <= tpV && gate(p.ts, idxs)) return { exitTs: p.ts, exitV: Math.max(0, p.V), reason: 'TP' };
  }
  return { exitTs: settle, exitV: settleV, reason: 'expiry' };
}

// ── Stat accumulation ────────────────────────────────────────────────────────
interface Stat { n: number; tpFills: number; wins: number; pnlNetSum: number; pnlGrossSum: number; durationSumSec: number; }
function mkStat(): Stat { return { n: 0, tpFills: 0, wins: 0, pnlNetSum: 0, pnlGrossSum: 0, durationSumSec: 0 }; }

// Volume diagnostics, computed once per variant at BASELINE TP-trigger bars.
interface VolDiag {
  nTriggers: number;
  freshCount: number[];          // for each trigger, how many legs fresh
  combinedPctOfAvg: number[];    // trigger combined fresh vol as % of window-avg combined
  shortFreshHits: number; shortFreshTot: number;   // short-leg freshness rate at trigger
  wingFreshHits: number; wingFreshTot: number;     // wing/long-leg freshness rate at trigger
}
function mkVolDiag(): VolDiag { return { nTriggers: 0, freshCount: [], combinedPctOfAvg: [], shortFreshHits: 0, shortFreshTot: 0, wingFreshHits: 0, wingFreshTot: 0 }; }

// ── Variants ─────────────────────────────────────────────────────────────────
type Path = 'iron' | 'twoleg';
interface Variant {
  key: string;
  path: Path;
  signal: SignalSpec;
  // iron structure
  iron?: { label: string; kind: 'butterfly' | 'condor'; shortOffset: number; wingWidth: number; centerOffset?: number };
  // 2-leg structure (offset/width in dollars)
  twoleg?: { label: string; shortOffset: number; width: number };
  tpFrac: number;
  exitLabel: string;
}

const SIG_3x12: SignalSpec = { label: 'HMA  1m 3x12', signal: 'hma', tfs: [{ tf: 1, fast: 3, slow: 12 }] };
const SIG_3x9: SignalSpec = { label: 'HMA  1m 3x9', signal: 'hma', tfs: [{ tf: 1, fast: 3, slow: 9 }] };

const VARIANTS: Variant[] = [
  // Iron: IB±25 w10 = directional butterfly, centerOffset 25, wingWidth 10, shortOffset 0.
  { key: 'HMA  1m 3x12|IB±25 w10|TP10 only', path: 'iron', signal: SIG_3x12, iron: { label: 'IB±25 w10', kind: 'butterfly', shortOffset: 0, wingWidth: 10, centerOffset: 25 }, tpFrac: 0.10, exitLabel: 'TP10 only' },
  { key: 'HMA  1m 3x9|IB±25 w10|TP10 only', path: 'iron', signal: SIG_3x9, iron: { label: 'IB±25 w10', kind: 'butterfly', shortOffset: 0, wingWidth: 10, centerOffset: 25 }, tpFrac: 0.10, exitLabel: 'TP10 only' },
  // 2-leg: 15ITM w10 = shortOffset -15 (3 strikes ITM × SI 5), width 10 (2 strikes).
  { key: 'HMA  1m 3x12|15ITM w10|TP10 only', path: 'twoleg', signal: SIG_3x12, twoleg: { label: '15ITM w10', shortOffset: -15, width: 10 }, tpFrac: 0.10, exitLabel: 'TP10 only' },
];

// Sanity: confirm label↔geometry mapping matches the production sweep label gen.
// Iron directional IB: label `IB±${co} w${w}` (co=centerOffset, w=wingWidth). [iron-sweep.ts:118]
// 2-leg: soS strikes, wS strikes → label `${moneyness} w${w}`; 15ITM w10 = soS -3, wS 2 (×SI 5). [credit-spread-sweep.ts:92-96]

// ── Date selection: ~20 evenly spaced across full history ────────────────────
const ALL_DATES = listDatesFor(TARGET);
const N_DATES = 20;
function pickEven(dates: string[], n: number): string[] {
  if (dates.length <= n) return dates.slice();
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * (dates.length - 1) / (n - 1));
    out.push(dates[idx]);
  }
  return [...new Set(out)];
}
const STUDY_DATES = pickEven(ALL_DATES, N_DATES);

// ── Main loop ────────────────────────────────────────────────────────────────
// results[variantKey][gateLabel] = Stat ; volDiag[variantKey] = VolDiag
const results = new Map<string, Map<string, Stat>>();
const volDiag = new Map<string, VolDiag>();
for (const v of VARIANTS) {
  const m = new Map<string, Stat>();
  const nLegs = v.path === 'iron' ? 4 : 2;
  for (const g of gateSpecs(nLegs)) m.set(g.label, mkStat());
  results.set(v.key, m);
  volDiag.set(v.key, mkVolDiag());
}

console.error(`[fill-volume-study] ${TARGET.symbol} | ${STUDY_DATES.length} dates | ${VARIANTS.length} variants`);
console.error(`Dates: ${STUDY_DATES.join(', ')}`);

for (let di = 0; di < STUDY_DATES.length; di++) {
  const date = STUDY_DATES[di];
  console.error(`  ${di + 1}/${STUDY_DATES.length}  ${date}`);
  let c1: any, p1: any;
  try { c1 = loadDay(TARGET, date, '1m') as any; p1 = loadDay(TARGET, prevDate(date), '1m') as any; }
  catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), cutoff = sess + CUTOFF_HHMM, settle = sess + SETTLE_HHMM;
  const spxAtSettle = optPx(s1, settle);

  for (const v of VARIANTS) {
    const { entries } = detectSignals(date, v.signal, c1, p1);
    entries.sort((a, b) => a.entryTs - b.entryTs);
    const statMap = results.get(v.key)!;
    const vd = volDiag.get(v.key)!;
    const gates = gateSpecs(v.path === 'iron' ? 4 : 2);

    for (const ev of entries) {
      if (ev.entryTs >= cutoff) continue;
      const spxEntry = optPx(s1, ev.entryTs - 1);
      if (spxEntry == null) continue;

      if (v.path === 'iron') {
        const st = v.iron!;
        const center = st.centerOffset
          ? spxEntry + (ev.dir === 'bull' ? st.centerOffset : -st.centerOffset)
          : spxEntry;
        const Kshort_put = center - st.shortOffset;
        const Klong_put = Kshort_put - st.wingWidth;
        const Kshort_call = center + st.shortOffset;
        const Klong_call = Kshort_call + st.wingWidth;
        const sym_sp = findStrike(c1, 'P', Kshort_put);
        const sym_lp = findStrike(c1, 'P', Klong_put);
        const sym_sc = findStrike(c1, 'C', Kshort_call);
        const sym_lc = findStrike(c1, 'C', Klong_call);
        if (!sym_sp || !sym_lp || !sym_sc || !sym_lc) continue;
        if (new Set([sym_sp, sym_lp, sym_sc, sym_lc]).size !== 4) continue;
        const legs: Leg[] = [
          { symbol: sym_sp, strike: Kshort_put, sign: +1, bars: c1.contractBars.get(sym_sp) as any[] },
          { symbol: sym_lp, strike: Klong_put, sign: -1, bars: c1.contractBars.get(sym_lp) as any[] },
          { symbol: sym_sc, strike: Kshort_call, sign: +1, bars: c1.contractBars.get(sym_sc) as any[] },
          { symbol: sym_lc, strike: Klong_call, sign: -1, bars: c1.contractBars.get(sym_lc) as any[] },
        ];
        const entries_px = legs.map(lg => optPx(lg.bars, ev.entryTs - 1));
        if (entries_px.some(p => p == null)) continue;
        const credit = legs.reduce((s, lg, i) => s + lg.sign * (entries_px[i] as number), 0);
        if (credit <= 0.10) continue;
        if (credit >= st.wingWidth * 0.95) continue;

        const traj = buildTrajectory(legs, ev.entryTs, settle);
        // Short legs are signs +1 (sp, sc); long wings are signs -1 (lp, lc).
        const idxs = legs.map(lg => buildLegIndex(lg, ev.entryTs, settle, lg.sign === +1));
        const settleV = (spxAtSettle != null && TARGET.dte === 0)
          ? ironSettleV(legs, spxAtSettle)
          : (() => { let V = 0; let ok = true; for (const lg of legs) { const cc = optPx(lg.bars, settle); if (cc == null) { ok = false; break; } V += lg.sign * cc; } return ok ? Math.max(0, V) : 0; })();

        evalAllGates(v, traj, settle, idxs, gates, credit, settleV, ev.entryTs, statMap, vd, SLIPPAGE_PER_STRUCTURE);
      } else {
        const sp = v.twoleg!;
        const isCallSpread = ev.dir === 'bear';
        const shortLetter: 'C' | 'P' = isCallSpread ? 'C' : 'P';
        const shortK_target = isCallSpread ? spxEntry + sp.shortOffset : spxEntry - sp.shortOffset;
        const longK_target = isCallSpread ? shortK_target + sp.width : shortK_target - sp.width;
        const shortSym = findStrike(c1, shortLetter, shortK_target);
        const longSym = findStrike(c1, shortLetter, longK_target);
        if (!shortSym || !longSym || shortSym === longSym) continue;
        const shortStrike = c1.contractStrikes.get(shortSym) as number;
        const longStrike = c1.contractStrikes.get(longSym) as number;
        const shortBars = c1.contractBars.get(shortSym) as any[];
        const longBars = c1.contractBars.get(longSym) as any[];
        const shortEntry = optPx(shortBars, ev.entryTs - 1);
        const longEntry = optPx(longBars, ev.entryTs - 1);
        if (shortEntry == null || longEntry == null) continue;
        const credit = shortEntry - longEntry;
        if (credit <= 0.05) continue;
        if (credit > sp.width * 0.95) continue;

        const traj = buildSpreadTrajectory(shortBars, longBars, ev.entryTs, settle);
        const legShort: Leg = { symbol: shortSym, strike: shortStrike, sign: +1, bars: shortBars };
        const legLong: Leg = { symbol: longSym, strike: longStrike, sign: -1, bars: longBars };
        const idxs = [buildLegIndex(legShort, ev.entryTs, settle, true), buildLegIndex(legLong, ev.entryTs, settle, false)];
        const settleV = (spxAtSettle != null && TARGET.dte === 0)
          ? spreadSettleV(isCallSpread, shortStrike, longStrike, spxAtSettle)
          : Math.max(0, (optPx(shortBars, settle) ?? 0) - (optPx(longBars, settle) ?? 0));

        evalAllGates(v, traj, settle, idxs, gates, credit, settleV, ev.entryTs, statMap, vd, SLIPPAGE_PER_SPREAD);
      }
    }
  }
}

function evalAllGates(
  v: Variant, traj: Array<{ ts: number, V: number }>, settle: number, idxs: LegIndex[], gates: GateSpec[],
  credit: number, settleV: number, entryTs: number, statMap: Map<string, Stat>, vd: VolDiag, slippage: number,
) {
  // Per-gate exit + stat.
  for (const g of gates) {
    const ex = gatedExit(traj, settle, idxs, g.gate, credit, v.tpFrac, settleV);
    const pnlGross = (credit - ex.exitV) * 100;
    const pnlNet = pnlGross - slippage;
    const durationSec = Math.max(0, ex.exitTs - entryTs);
    const s = statMap.get(g.label)!;
    s.n++; if (ex.reason === 'TP') s.tpFills++; if (pnlNet > 0) s.wins++;
    s.pnlNetSum += pnlNet; s.pnlGrossSum += pnlGross; s.durationSumSec += durationSec;
  }
  // Volume diagnostics at the BASELINE TP-trigger bar (first ts where V<=tpV).
  const tpV = v.tpFrac > 0 ? (1 - v.tpFrac) * credit : -Infinity;
  let trigTs: number | null = null;
  for (const p of traj) { if (p.ts > settle) break; if (v.tpFrac > 0 && p.V <= tpV) { trigTs = p.ts; break; } }
  if (trigTs != null) {
    vd.nTriggers++;
    const freshN = idxs.filter(li => li.byTs.has(trigTs!)).length;
    vd.freshCount.push(freshN);
    const avgCombined = idxs.reduce((s, li) => s + li.avgVol, 0);
    let cur = 0; for (const li of idxs) { const b = li.byTs.get(trigTs!); if (b) cur += (b.volume ?? 0); }
    vd.combinedPctOfAvg.push(avgCombined > 0 ? 100 * cur / avgCombined : 0);
    for (const li of idxs) {
      if (li.isShort) { vd.shortFreshTot++; if (li.byTs.has(trigTs!)) vd.shortFreshHits++; }
      else { vd.wingFreshTot++; if (li.byTs.has(trigTs!)) vd.wingFreshHits++; }
    }
  }
}

// ── Reporting ────────────────────────────────────────────────────────────────
function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const GATE_ORDER = (nLegs: number) => gateSpecs(nLegs).map(g => g.label);

interface OutRow { gate: string; n: number; tpFills: number; tpRate: number; wr: number; avgHoldMin: number; perTrade: number; net: number; }
const jsonOut: any = { meta: { symbol: TARGET.symbol, dates: STUDY_DATES, nDates: STUDY_DATES.length, generated: new Date().toISOString() }, variants: [] };

let stdoutBlocks: string[] = [];
let mdBlocks: string[] = [];

for (const v of VARIANTS) {
  const nLegs = v.path === 'iron' ? 4 : 2;
  const statMap = results.get(v.key)!;
  const vd = volDiag.get(v.key)!;
  const rows: OutRow[] = [];
  for (const gl of GATE_ORDER(nLegs)) {
    const s = statMap.get(gl)!;
    rows.push({
      gate: gl, n: s.n, tpFills: s.tpFills,
      tpRate: s.n > 0 ? 100 * s.tpFills / s.n : 0,
      wr: s.n > 0 ? 100 * s.wins / s.n : 0,
      avgHoldMin: s.n > 0 ? s.durationSumSec / s.n / 60 : 0,
      perTrade: s.n > 0 ? s.pnlNetSum / s.n : 0,
      net: s.pnlNetSum,
    });
  }
  // Volume diagnostics summary
  const fcDist: Record<number, number> = {};
  for (const fc of vd.freshCount) fcDist[fc] = (fcDist[fc] ?? 0) + 1;
  const fcPct: Record<number, number> = {};
  for (const k of Object.keys(fcDist)) fcPct[+k] = 100 * fcDist[+k] / Math.max(1, vd.nTriggers);
  const diag = {
    nTriggers: vd.nTriggers,
    freshLegDistPct: fcPct,
    combinedPctMedian: +quantile(vd.combinedPctOfAvg, 0.5).toFixed(1),
    combinedPctQ1: +quantile(vd.combinedPctOfAvg, 0.25).toFixed(1),
    combinedPctQ3: +quantile(vd.combinedPctOfAvg, 0.75).toFixed(1),
    shortFreshRatePct: vd.shortFreshTot > 0 ? +(100 * vd.shortFreshHits / vd.shortFreshTot).toFixed(1) : 0,
    wingFreshRatePct: vd.wingFreshTot > 0 ? +(100 * vd.wingFreshHits / vd.wingFreshTot).toFixed(1) : 0,
  };

  jsonOut.variants.push({ key: v.key, path: v.path, nLegs, rows, volDiag: diag });

  // ── stdout block ──
  const L: string[] = [];
  L.push('');
  L.push('='.repeat(100));
  L.push(`VARIANT: ${v.key}   (${nLegs}-leg ${v.path})`);
  L.push('='.repeat(100));
  L.push(`${'Approach'.padEnd(18)} ${'N'.padStart(5)} ${'TPfill'.padStart(7)} ${'TP%'.padStart(6)} ${'WR%'.padStart(6)} ${'hold(m)'.padStart(8)} ${'$/trade'.padStart(9)} ${'$Net'.padStart(11)}`);
  L.push('-'.repeat(100));
  for (const r of rows) {
    L.push(`${r.gate.padEnd(18)} ${String(r.n).padStart(5)} ${String(r.tpFills).padStart(7)} ${r.tpRate.toFixed(1).padStart(6)} ${r.wr.toFixed(1).padStart(6)} ${r.avgHoldMin.toFixed(1).padStart(8)} ${(r.perTrade >= 0 ? '+' : '') + r.perTrade.toFixed(1).padStart(8)} ${(r.net >= 0 ? '+' : '') + Math.round(r.net).toString().padStart(10)}`);
  }
  L.push('');
  L.push(`VOLUME DIAGNOSTICS (at ${diag.nTriggers} baseline TP-trigger bars):`);
  const fcStr = Object.keys(fcPct).sort((a, b) => +b - +a).map(k => `${k} legs: ${fcPct[+k].toFixed(0)}%`).join(', ');
  L.push(`  fresh-leg count at trigger: ${fcStr}`);
  L.push(`  combined fresh vol as % of window-avg combined: median ${diag.combinedPctMedian}%  (Q1 ${diag.combinedPctQ1}%, Q3 ${diag.combinedPctQ3}%)`);
  L.push(`  short-leg freshness at trigger: ${diag.shortFreshRatePct}%   wing/long-leg freshness: ${diag.wingFreshRatePct}%`);
  stdoutBlocks.push(L.join('\n'));

  // ── md block ──
  const M: string[] = [];
  M.push(`### \`${v.key}\` — ${nLegs}-leg ${v.path}`);
  M.push('');
  M.push('| Approach | N | TPfill | TP% | WR% | hold(m) | $/trade | $Net |');
  M.push('|---|--:|--:|--:|--:|--:|--:|--:|');
  for (const r of rows) {
    M.push(`| ${r.gate} | ${r.n} | ${r.tpFills} | ${r.tpRate.toFixed(1)} | ${r.wr.toFixed(1)} | ${r.avgHoldMin.toFixed(1)} | ${r.perTrade.toFixed(1)} | ${Math.round(r.net)} |`);
  }
  M.push('');
  M.push(`**Volume diagnostics** (at ${diag.nTriggers} baseline TP-trigger bars):`);
  M.push('');
  M.push(`- fresh-leg count at trigger: ${fcStr}`);
  M.push(`- combined fresh vol as % of window-avg combined: median **${diag.combinedPctMedian}%** (Q1 ${diag.combinedPctQ1}%, Q3 ${diag.combinedPctQ3}%)`);
  M.push(`- short-leg freshness at trigger: **${diag.shortFreshRatePct}%**; wing/long-leg freshness: **${diag.wingFreshRatePct}%**`);
  M.push('');
  mdBlocks.push(M.join('\n'));
}

console.log(stdoutBlocks.join('\n'));

fs.writeFileSync('/tmp/fill-volume-study.json', JSON.stringify(jsonOut, null, 2));

const md: string[] = [];
md.push('# Fill / Volume Gate Study');
md.push('');
md.push(`Symbol: **${TARGET.symbol}** | Dates: **${STUDY_DATES.length}** evenly spaced across ${ALL_DATES.length} available trading days.`);
md.push('');
md.push(`Dates used: ${STUDY_DATES.join(', ')}`);
md.push('');
md.push('Each variant re-evaluates the SAME entries / trajectory under different exit-fill gates. A TP is only honored at a trajectory point where its gate passes; if the gate never passes before 15:45 ET settle, the trade rides to settle (intrinsic at 0DTE). Slippage: iron $25/structure, 2-leg $15/spread.');
md.push('');
md.push(...mdBlocks);
fs.writeFileSync('/tmp/fill-volume-study.md', md.join('\n'));

console.log(`\nWrote /tmp/fill-volume-study.json + /tmp/fill-volume-study.md`);
