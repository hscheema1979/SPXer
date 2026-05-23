/**
 * ndx-validate-fills.ts  —  FOCUSED, REVERTABLE validation of NDX credit-spread sweeps.
 *
 * Why this exists
 * ───────────────
 * spread-sweep-ndx.json shows physically-implausible results (e.g. the top
 * 2-leg variant nets ~45% of max-risk per trade at >75% WR, 250/280 up days).
 * Scrutiny traced this to two fill-model assumptions that hold for liquid SPXW
 * but break on thin NDXP 0DTE:
 *   1. optPx() carries the LAST TRADE forward forever and treats it as fillable.
 *      Measured: ATM±6 NDX legs are >2min stale 40% of the time (p90 ≈ 41min).
 *      Mixing two stale, asynchronous last-prints fabricates a "credit" you
 *      could never actually get filled at; TP exits fire off stale/noisy prints.
 *   2. Slippage is a flat $15/round-trip for the whole 2-leg spread — an order
 *      of magnitude too small for NDX 0DTE bid/ask.
 *
 * What this does
 * ──────────────
 * Re-runs a FOCUSED set of 2-leg credit-spread variants over all NDX dates,
 * computing TWO P&Ls per trade in one pass:
 *   • baseline  — original sweep assumptions (no staleness gate, flat slippage)
 *   • honest    — reject any entry/exit where a leg's last print is older than
 *                 STALE_MAX_SEC, and charge SLIP_PER_LEG per leg per round-trip.
 *
 * The baseline column doubles as a FAITHFULNESS CHECK: it should reproduce the
 * numbers in spread-sweep-ndx.json. If it does, the honest column is trustworthy.
 *
 * Revertable by design
 * ────────────────────
 *   • Standalone — touches NO existing script and NO output/*.json (writes /tmp only).
 *     To revert entirely: delete this file.
 *   • Every correction is a knob. To collapse "honest" back to "baseline":
 *       STALE_MAX_SEC=0 SLIP_PER_LEG=7.5 npx tsx scripts/diag/ndx-validate-fills.ts
 *     (0 disables the staleness gate; 7.5×2 legs = the original $15 flat.)
 *   • If the gate overcorrects (rejects too much), raise STALE_MAX_SEC; the
 *     headline staleness-sensitivity table shows the full gradient so you can
 *     pick a defensible threshold instead of guessing.
 *
 * Knobs (env)
 *   STALE_MAX_SEC  default 120   0 = disable gate
 *   SLIP_PER_LEG   default 12    $ per leg per round-trip (2-leg spread → 2×)
 *   GATE_EXIT      default 1     also gate TP/SL exit fills on staleness (1/0)
 *   DATES_LIMIT    default 0     0 = all dates; N = first N (fast smoke test)
 *
 * Run:  npx tsx scripts/diag/ndx-validate-fills.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import * as fs from 'fs';

const TARGET = resolveSymbolTarget(['', '', '--symbol', 'NDX']);
const SI = TARGET.strikeInterval; // NDX = 10

// ── Knobs ────────────────────────────────────────────────────────────────────
const STALE_MAX_SEC = process.env.STALE_MAX_SEC != null ? +process.env.STALE_MAX_SEC : 120;
const SLIP_PER_LEG  = process.env.SLIP_PER_LEG  != null ? +process.env.SLIP_PER_LEG  : 12;
const GATE_EXIT     = process.env.GATE_EXIT !== '0';
const DATES_LIMIT   = process.env.DATES_LIMIT != null ? +process.env.DATES_LIMIT : 0;
const N_LEGS = 2;
const BASELINE_SLIP = 15;   // original flat $/RT for 2-leg credit spread

// ── Engine constants (copied verbatim from credit-spread-sweep.ts) ─────────────
const MIN_ALIGN = 3, CROSS_WIN = 60;
const CUTOFF_HHMM = 6 * 3600;            // 15:30 ET
const SETTLE_HHMM = 6 * 3600 + 15 * 60;  // 15:45 ET
const TRADESTART_SEC = 1800;             // 10:00 ET

// ── Focused variant set (the suspicious top 2-leg rows + contrast) ─────────────
type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: { tf: number; fast: number; slow: number }[]; }
const SIGNALS: SignalSpec[] = [
  { label: 'HMA  1m 3x9',  signal: 'hma', tfs: [{ tf: 1, fast: 3, slow: 9 }] },
  { label: 'HMA  1m 3x12', signal: 'hma', tfs: [{ tf: 1, fast: 3, slow: 12 }] },
  { label: 'HMA  3m 3x12', signal: 'hma', tfs: [{ tf: 3, fast: 3, slow: 12 }] },
];
// Spread geometry in strike-counts (× SI). Matches credit-spread-sweep labels.
const SPREAD_DEFS: Array<{ soS: number; wS: number }> = [
  { soS: -2, wS: 4 },  // "20ITM w40" on NDX — the headline 2-leg row
  { soS: -1, wS: 2 },  // "10ITM w20"
  { soS:  0, wS: 1 },  // "ATM w10"
  { soS:  1, wS: 1 },  // "10OTM w10"
];
interface SpreadSpec { label: string; shortOffset: number; width: number; }
const SPREADS: SpreadSpec[] = SPREAD_DEFS.map(({ soS, wS }) => {
  const so = soS * SI, w = wS * SI;
  const moneyness = so < 0 ? `${Math.abs(so)}ITM` : so > 0 ? `${so}OTM` : 'ATM';
  return { label: `${moneyness} w${w}`, shortOffset: so, width: w };
});
interface ExitSpec { label: string; tpFrac: number; slMult: number; useFlip: boolean; }
const EXITS: ExitSpec[] = [
  { label: 'TP75 only', tpFrac: 0.75, slMult: 0, useFlip: false },
  { label: 'TP50 only', tpFrac: 0.50, slMult: 0, useFlip: false },
  { label: 'TP25 only', tpFrac: 0.25, slMult: 0, useFlip: false },
  { label: 'hold-to-settle', tpFrac: 0, slMult: 0, useFlip: false },
];

// ── Signal engine (copied verbatim from credit-spread-sweep.ts) ────────────────
function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }
function sessOpenTs(date: string): number { const [y, mo, d] = date.split('-').map(Number); const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0)); const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })); const offsetH = 12 - etHour; return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000); }
interface TFState { closed: any[]; partial: any | null; }
function mkSt(): TFState { return { closed: [], partial: null }; }
function feed(st: TFState, b: any, tf: number) { const bk = Math.floor(b.ts / (tf * 60)) * (tf * 60); if (!st.partial || st.partial.ts !== bk) { if (st.partial) st.closed.push(st.partial); st.partial = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close }; } else { if (b.high > st.partial.high) st.partial.high = b.high; if (b.low < st.partial.low) st.partial.low = b.low; st.partial.close = b.close; } }
function wma(arr: number[], end: number, p: number): number | null { if (end < p - 1) return null; let s = 0, w = 0; for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i); } return s / w; }
function hmaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null { const hf = Math.floor(fast / 2), sf = Math.floor(Math.sqrt(fast)); const hs = Math.floor(slow / 2), ss = Math.floor(Math.sqrt(slow)); const rf: number[] = [], rs: number[] = []; let fa: number | null = null, sa: number | null = null; for (let i = 0; i < closes.length; i++) { const a = wma(closes, i, hf), b = wma(closes, i, fast); if (a != null && b != null) { rf.push(2 * a - b); if (rf.length >= sf) fa = wma(rf, rf.length - 1, sf); } const c = wma(closes, i, hs), d = wma(closes, i, slow); if (c != null && d != null) { rs.push(2 * c - d); if (rs.length >= ss) sa = wma(rs, rs.length - 1, ss); } } if (fa == null || sa == null) return null; return fa > sa ? 'bull' : 'bear'; }
function demaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null { function dema(p: number): number | null { if (closes.length < p) return null; const a = 2 / (p + 1); let e1 = 0; for (let i = 0; i < p; i++) e1 += closes[i]; e1 /= p; const e1s: number[] = [e1]; for (let i = p; i < closes.length; i++) { e1 = a * closes[i] + (1 - a) * e1; e1s.push(e1); } if (e1s.length < p) return null; let e2 = 0; for (let i = 0; i < p; i++) e2 += e1s[i]; e2 /= p; for (let i = p; i < e1s.length; i++) { e2 = a * e1s[i] + (1 - a) * e2; } return 2 * e1s[e1s.length - 1] - e2; } const f = dema(fast), s = dema(slow); if (f == null || s == null) return null; return f > s ? 'bull' : 'bear'; }
function getDir(st: TFState, fast: number, slow: number, signal: Signal): 'bull' | 'bear' | null { const bars = st.partial ? [...st.closed, st.partial] : st.closed; if (!bars.length) return null; const closes = bars.map((b: any) => b.close); return signal === 'dema' ? demaDir(closes, fast, slow) : hmaDir(closes, fast, slow); }
interface SignalEvent { alignTs: number; dir: 'bull' | 'bear'; entryTs: number; }
function detectSignals(date: string, spec: SignalSpec, c1: any, p1: any): { entries: SignalEvent[]; dirLog: Map<number, ('bull' | 'bear' | null)[]> } {
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
    if (allBull && bullStreak >= MIN_ALIGN && !bullFired) { const ts = bullCross.filter(t => t > 0); if (ts.length === spec.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ alignTs: b.ts, dir: 'bull', entryTs: b.ts + 60 }); bullFired = true; } }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) { const ts = bearCross.filter(t => t > 0); if (ts.length === spec.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ alignTs: b.ts, dir: 'bear', entryTs: b.ts + 60 }); bearFired = true; } }
  }
  return { entries, dirLog };
}
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null { let best: string | null = null, bestD = Infinity; for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue; const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } } return best; }
function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }

// ── NEW: staleness helper ──────────────────────────────────────────────────
// Age (sec) of the last printed bar at-or-before ts. Infinity if none. Since the
// NDX cache has no synthetic bars, every bar is a real print → age = ts - lastTs.
function markAge(bars: any[], ts: number): number {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return ts - bars[i].ts;
  return Infinity;
}

// Build the spread-value trajectory, recording per-point the staleness of each
// leg so the exit gate can reject TP/SL triggers that rest on a stale carry.
interface TrajPt { ts: number; V: number; ageShort: number; ageLong: number; }
function buildTraj(shortBars: any[], longBars: any[], entryTs: number, endTs: number): TrajPt[] {
  const tsSet = new Set<number>();
  for (const b of shortBars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  for (const b of longBars) if (b.ts > entryTs && b.ts <= endTs) tsSet.add(b.ts);
  const tsList = [...tsSet].sort((a, b) => a - b);
  const traj: TrajPt[] = [];
  let si = 0, li = 0, lastShort: number | null = null, lastLong: number | null = null, lastShortTs = -1, lastLongTs = -1;
  for (const t of tsList) {
    while (si < shortBars.length && shortBars[si].ts <= t) { lastShort = shortBars[si].close; lastShortTs = shortBars[si].ts; si++; }
    while (li < longBars.length && longBars[li].ts <= t) { lastLong = longBars[li].close; lastLongTs = longBars[li].ts; li++; }
    if (lastShort != null && lastLong != null) traj.push({ ts: t, V: lastShort - lastLong, ageShort: t - lastShortTs, ageLong: t - lastLongTs });
  }
  return traj;
}

// Exit policy. `gateExit` true → ignore TP/SL trigger points where either leg is
// staler than STALE_MAX_SEC (you couldn't observe/fill that level live).
function applyExit(traj: TrajPt[], endTs: number, shortBars: any[], longBars: any[],
                   credit: number, tpFrac: number, slMult: number, flipTs: number,
                   isCallSpread: boolean, shortStrike: number, longStrike: number,
                   spxAtSettle: number | null, gateExit: boolean): { exitTs: number; exitV: number; reason: string } {
  const effEnd = Math.min(endTs, flipTs);
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slMult > 0 ? (1 + slMult) * credit : Infinity;
  for (const p of traj) {
    if (p.ts > effEnd) break;
    if (gateExit && STALE_MAX_SEC > 0 && (p.ageShort > STALE_MAX_SEC || p.ageLong > STALE_MAX_SEC)) continue;
    if (tpFrac > 0 && p.V <= tpV) return { exitTs: p.ts, exitV: Math.max(0, p.V), reason: 'TP' };
    if (slMult > 0 && p.V >= slV) return { exitTs: p.ts, exitV: p.V, reason: 'SL' };
  }
  // 0DTE intrinsic settle (legitimate — settlement needs no print).
  if (effEnd === endTs && spxAtSettle != null && TARGET.dte === 0) {
    let v: number;
    if (isCallSpread) v = Math.max(0, spxAtSettle - shortStrike) - Math.max(0, spxAtSettle - longStrike);
    else v = Math.max(0, shortStrike - spxAtSettle) - Math.max(0, longStrike - spxAtSettle);
    return { exitTs: effEnd, exitV: Math.max(0, v), reason: 'expiry' };
  }
  const ps = optPx(shortBars, effEnd) ?? 0;
  const pl = optPx(longBars, effEnd) ?? 0;
  return { exitTs: effEnd, exitV: Math.max(0, ps - pl), reason: effEnd === endTs ? 'settle-mtm' : 'flip' };
}

// ── Accumulators ───────────────────────────────────────────────────────────
interface Stat { base: number; honest: number; n: number; nHonest: number; winsB: number; winsH: number; rejStale: number; creditSum: number; widthSum: number; }
function mk(): Stat { return { base: 0, honest: 0, n: 0, nHonest: 0, winsB: 0, winsH: 0, rejStale: 0, creditSum: 0, widthSum: 0 }; }
const results = new Map<string, Stat>();
// Staleness-sensitivity probe for ONE headline variant across thresholds.
const PROBE_KEY = 'HMA  1m 3x9|20ITM w40|TP75 only';
const PROBE_THRESHOLDS = [0, 600, 300, 120, 60];
const probe = new Map<number, { pnl: number; n: number; wins: number }>();
for (const th of PROBE_THRESHOLDS) probe.set(th, { pnl: 0, n: 0, wins: 0 });

// ── Main ─────────────────────────────────────────────────────────────────────
let ALL = listDatesFor(TARGET);
if (DATES_LIMIT > 0) ALL = ALL.slice(0, DATES_LIMIT);
console.error(`[ndx-validate] dates=${ALL.length} STALE_MAX_SEC=${STALE_MAX_SEC} SLIP_PER_LEG=$${SLIP_PER_LEG} (honest RT=$${SLIP_PER_LEG * N_LEGS}) GATE_EXIT=${GATE_EXIT}`);

for (let di = 0; di < ALL.length; di++) {
  const date = ALL[di];
  if (di % 40 === 0) console.error(`  ${di}/${ALL.length} ${date}`);
  let c1: any, p1: any;
  try { c1 = loadDay(TARGET, date, '1m'); p1 = loadDay(TARGET, prevDate(date), '1m'); } catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  const cutoff = sess + CUTOFF_HHMM, settle = sess + SETTLE_HHMM;
  const spxAtSettle = optPx(s1, settle);

  for (const sig of SIGNALS) {
    const { entries, dirLog } = detectSignals(date, sig, c1, p1);
    entries.sort((a, b) => a.entryTs - b.entryTs);
    for (const ev of entries) {
      if (ev.entryTs >= cutoff) continue;
      const spxEntry = optPx(s1, ev.entryTs - 1);
      if (spxEntry == null) continue;
      for (const sp of SPREADS) {
        const isCallSpread = ev.dir === 'bear';
        const letter: 'C' | 'P' = isCallSpread ? 'C' : 'P';
        const shortK = isCallSpread ? spxEntry + sp.shortOffset : spxEntry - sp.shortOffset;
        const longK = isCallSpread ? shortK + sp.width : shortK - sp.width;
        const shortSym = findStrike(c1, letter, shortK);
        const longSym = findStrike(c1, letter, longK);
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

        // staleness of the ENTRY marks
        const ageShortEntry = markAge(shortBars, ev.entryTs - 1);
        const ageLongEntry = markAge(longBars, ev.entryTs - 1);
        const entryStale = STALE_MAX_SEC > 0 && (ageShortEntry > STALE_MAX_SEC || ageLongEntry > STALE_MAX_SEC);

        let flipTs = Infinity;
        for (const [t, dirs] of dirLog) { if (t <= ev.entryTs) continue; if (!dirs) continue; const flip = ev.dir === 'bull' ? dirs.every((d: any) => d === 'bear') : dirs.every((d: any) => d === 'bull'); if (flip) { flipTs = t + 60; break; } }

        const traj = buildTraj(shortBars, longBars, ev.entryTs, settle);

        for (const ex of EXITS) {
          const flipUse = ex.useFlip ? flipTs : Infinity;
          const k = `${sig.label}|${sp.label}|${ex.label}`;

          // BASELINE — original assumptions: no gate, flat $15 RT.
          const natB = applyExit(traj, settle, shortBars, longBars, credit, ex.tpFrac, ex.slMult, flipUse, isCallSpread, shortStrike, longStrike, spxAtSettle, false);
          const pnlB = (credit - natB.exitV) * 100 - BASELINE_SLIP;

          // HONEST — gated entry/exit + per-leg slippage.
          const natH = applyExit(traj, settle, shortBars, longBars, credit, ex.tpFrac, ex.slMult, flipUse, isCallSpread, shortStrike, longStrike, spxAtSettle, GATE_EXIT);
          const pnlH = (credit - natH.exitV) * 100 - SLIP_PER_LEG * N_LEGS;

          let st = results.get(k); if (!st) { st = mk(); results.set(k, st); }
          st.n++; st.base += pnlB; if (pnlB > 0) st.winsB++; st.creditSum += credit; st.widthSum += sp.width;
          if (entryStale) { st.rejStale++; }   // honest model never opens this trade
          else { st.nHonest++; st.honest += pnlH; if (pnlH > 0) st.winsH++; }

          // staleness-sensitivity probe (entry gate only, baseline slippage, to isolate the gate's effect)
          if (k === PROBE_KEY) {
            for (const th of PROBE_THRESHOLDS) {
              const stale = th > 0 && (ageShortEntry > th || ageLongEntry > th);
              if (stale) continue;
              const pr = probe.get(th)!;
              pr.pnl += pnlB; pr.n++; if (pnlB > 0) pr.wins++;
            }
          }
        }
      }
    }
  }
}

// ── Cross-check against the published sweep file ───────────────────────────────
let published: any[] = [];
try { published = JSON.parse(fs.readFileSync('scripts/autoresearch/output/spread-sweep-ndx.json', 'utf8')); } catch {}
const pubMap = new Map<string, any>();
for (const r of published) pubMap.set(`${r.signal}|${r.spread}|${r.exit}`, r);

console.log('\n================ NDX FILL VALIDATION ================');
console.log(`gate: reject fills with a leg-mark older than ${STALE_MAX_SEC || '∞ (disabled)'}s | honest slippage: $${SLIP_PER_LEG}/leg → $${SLIP_PER_LEG * N_LEGS}/RT (baseline $${BASELINE_SLIP})\n`);
const rows = [...results.entries()].map(([k, v]) => {
  const pub = pubMap.get(k);
  return {
    k,
    baseP: v.base, baseN: v.n, baseWR: 100 * v.winsB / Math.max(1, v.n),
    honP: v.honest, honN: v.nHonest, honWR: 100 * v.winsH / Math.max(1, v.nHonest),
    rejPct: 100 * v.rejStale / Math.max(1, v.n),
    survive: v.base !== 0 ? 100 * v.honest / v.base : 0,
    pubP: pub?.pnl, pubN: pub?.n,
  };
}).sort((a, b) => b.baseP - a.baseP);

console.log('variant'.padEnd(30) + ' | ' + 'BASELINE (pnl / n / wr)'.padEnd(28) + ' | published(pnl/n)'.padEnd(20) + ' | HONEST (pnl / n / wr)'.padEnd(26) + ' | staleRej% survive%');
console.log('-'.repeat(140));
for (const r of rows) {
  const base = `$${fmt(r.baseP)} / ${r.baseN} / ${r.baseWR.toFixed(0)}%`.padEnd(28);
  const pub = (r.pubP != null ? `$${fmt(r.pubP)} / ${r.pubN}` : 'n/a').padEnd(18);
  const hon = `$${fmt(r.honP)} / ${r.honN} / ${r.honWR.toFixed(0)}%`.padEnd(26);
  console.log(r.k.padEnd(30) + ' | ' + base + ' | ' + pub + ' | ' + hon + ' | ' + `${r.rejPct.toFixed(0)}%  ${r.survive.toFixed(0)}%`);
}

console.log('\n--- Faithfulness check: BASELINE here should ≈ published spread-sweep-ndx.json ---');
// Relative error is only meaningful where P&L is materially non-zero; near-zero
// variants blow up % error on a few-$K absolute difference. Judge on |pub|>$1M
// and report trade-count agreement separately.
let maxErr = 0, worst = '';
for (const r of rows) {
  if (r.pubP == null || Math.abs(r.pubP) < 1e6) continue;
  const e = Math.abs(r.baseP - r.pubP) / Math.abs(r.pubP);
  if (e > maxErr) { maxErr = e; worst = r.k; }
}
let maxNErr = 0;
for (const r of rows) if (r.pubN) maxNErr = Math.max(maxNErr, Math.abs(r.baseN - r.pubN) / r.pubN);
console.log(`max P&L error (|published|>$1M variants): ${(maxErr * 100).toFixed(2)}%  (worst: ${worst})`);
console.log(`max trade-count error vs published: ${(maxNErr * 100).toFixed(2)}%`);
console.log(maxErr < 0.02 && maxNErr < 0.02 ? '✓ faithful — baseline reproduces the published sweep; honest column is trustworthy' : '⚠ DIVERGENT — investigate before trusting honest column');

console.log(`\n--- Staleness sensitivity for "${PROBE_KEY}" (entry-gate only, baseline slippage) ---`);
console.log('threshold     pnl            n      wr%');
const probe0 = probe.get(0)!;
for (const th of PROBE_THRESHOLDS) {
  const p = probe.get(th)!;
  const label = th === 0 ? 'disabled' : `${th}s`;
  const surv = probe0.pnl !== 0 ? `  (${(100 * p.pnl / probe0.pnl).toFixed(0)}% of ungated)` : '';
  console.log(label.padEnd(13) + `$${fmt(p.pnl)}`.padEnd(15) + String(p.n).padEnd(7) + (100 * p.wins / Math.max(1, p.n)).toFixed(0) + '%' + surv);
}
console.log('\n(To revert to baseline: STALE_MAX_SEC=0 SLIP_PER_LEG=7.5 npx tsx scripts/diag/ndx-validate-fills.ts)');

function fmt(n: number | undefined): string { if (n == null) return 'n/a'; const a = Math.abs(n); if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return (n / 1e3).toFixed(0) + 'K'; return n.toFixed(0); }
