/**
 * hma3m-tpsl-study.ts — focused TP/SL study for HMA 3m 3x9 and 3x12.
 *
 * Per user request (2026-05-30):
 *   - Last 3 months only (TODAY - 90d)
 *   - 3m timeframe, HMA only, 3x9 and 3x12
 *   - Trade window 9:30 – 12:00 ET (HMA warmed from prev-day session bars)
 *   - Long calls + puts (signal direction = call/put), ATM strike offset (offset=0)
 *   - Coarse TP/SL grid, then refine around best zone
 *
 * Signal source = 'contract' (the established study winner from the
 * 118k SPX sweep). SPX/NDX/SPY/QQQ underlying gives direction; the
 * target contract's own HMA times entry + reversal exit.
 *
 * Runs the same trade-context model as long-config-sweep.ts: build the
 * SPX-signal entries + contract trade contexts ONCE per (symbol, signal,
 * date), then sweep TP/SL cheaply on top.
 *
 * Output: scripts/autoresearch/output/hma3m-tpsl-study.json
 * Stdout: top-10 table per (symbol × signal × pass).
 *
 * Run:
 *   npx tsx scripts/diag/hma3m-tpsl-study.ts
 *     [--symbols SPX,NDX,SPY,QQQ] [--days 90] [--refine-top 5]
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fork } from 'child_process';
import { resolveSymbolTarget, listDatesFor, loadDay, SymbolTarget } from './sweep-symbol';

// ── CLI ─────────────────────────────────────────────────────────────────────
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const SYMBOLS = argVal('--symbols', 'SPX,NDX,SPY,QQQ').split(',').map(s => s.trim().toUpperCase());
const DAYS = parseInt(argVal('--days', '90'), 10);
const REFINE_TOP = parseInt(argVal('--refine-top', '3'), 10);

// Per-symbol strike offsets in STRIKES (negative = ITM). 0 = ATM (default).
// --offsets SPX:-5,-10,-15;SPY:-1,-2,-3;QQQ:-1,-2,-3
function parseOffsets(spec: string): { [sym: string]: number[] } {
  const out: { [sym: string]: number[] } = {};
  for (const part of spec.split(';')) {
    if (!part.trim()) continue;
    const [sym, vals] = part.split(':');
    if (!sym || !vals) continue;
    out[sym.trim().toUpperCase()] = vals.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n));
  }
  return out;
}
const OFFSETS_BY_SYM = parseOffsets(argVal('--offsets', ''));
function offsetsFor(sym: string): number[] {
  const v = OFFSETS_BY_SYM[sym];
  return v && v.length ? v : [0];
}

// --configs SIG:OFFSET:TP:SL,SIG:OFFSET:TP:SL,...
//   SIG    = 3x9 | 3x12 (maps to "HMA 3m 3x9"/"HMA 3m 3x12")
//   OFFSET = N[ITM|OTM]  (e.g. 15ITM, 25ITM, 5OTM)
//   TP, SL = integer %
// When set: SKIPS the coarse/refine grid search and evaluates ONLY these
// fixed (signal, offset, tp, sl) tuples per symbol. Output is the same shape
// but with `fixed[]` instead of coarse/refine. Used to test specific configs
// across longer date windows for out-of-sample validation.
interface FixedConfig { sigLabel: string; offset: number; tp: number; sl: number; }
function parseFixedConfigs(spec: string): FixedConfig[] {
  if (!spec.trim()) return [];
  const out: FixedConfig[] = [];
  for (const part of spec.split(',')) {
    // Optional TF prefix, e.g. "5m/3x21:0ATM:25:20" (defaults to 3m).
    const m = part.trim().match(/^(?:(\d+)m\/)?(\d+x\d+):(\d+)(ITM|OTM|ATM):(\d+):(\d+)$/i);
    if (!m) throw new Error(`bad --configs entry: ${part}`);
    const [, tfm, sigKey, offN, offDir, tp, sl] = m;
    const sigLabel = `HMA ${tfm || '3'}m ${sigKey.toLowerCase()}`;
    const off = offDir.toUpperCase() === 'ATM' ? 0 : (offDir.toUpperCase() === 'ITM' ? -Number(offN) : Number(offN));
    out.push({ sigLabel, offset: off, tp: Number(tp), sl: Number(sl) });
  }
  return out;
}
const FIXED_CONFIGS = parseFixedConfigs(argVal('--configs', ''));
const OUT_PATH = argVal('--out', '');
const EMIT_TRADES = process.argv.includes('--emit-trades');
// Optional execution friction. Default 0/0 → raw (exit-entry)*100, preserving
// the dashboard-feed behavior. --half-spread is option price points paid on
// EACH side (entry buys higher, exit sells lower); --commission is $/contract
// per side. Standard SPXer model: --half-spread 0.05 --commission 0.35.
const HALF_SPREAD = parseFloat(argVal('--half-spread', '0'));
const COMMISSION  = parseFloat(argVal('--commission', '0'));
// When a single bar's range straddles BOTH the TP and SL, the default
// (optimistic) path books the TP. --sl-first flips that to assume the stop
// triggered first — the conservative bound for path ambiguity.
const SL_FIRST = process.argv.includes('--sl-first');
const GATE_START_OVR = argVal('--gate-start', '');  // 'HH:MM' overrides 9:30
const GATE_END_OVR   = argVal('--gate-end', '');    // 'HH:MM' overrides 12:00
function hhmmToMin(s: string, def: number): number {
  if (!s) return def;
  const m = s.match(/^(\d{1,2}):(\d{2})$/); if (!m) return def;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ── Filters / gates ─────────────────────────────────────────────────────────
const MIN_ALIGN = 3, CROSS_WIN = 60, MIN_PRICE = 0.20, MIN_VOL = 100;
// MAX_ENTRY removed — volume filter (MIN_VOL=100) handles liquidity gating
// across the full offset/symbol grid. Deep ITM intrinsic floors made the old
// scaled cap a nuisance once we pushed past 15 strikes ITM on SPX/NDX.
const GATE_START_HHMM = hhmmToMin(GATE_START_OVR, 9 * 60 + 30);   // default 9:30 ET, override with --gate-start
const GATE_END_HHMM   = hhmmToMin(GATE_END_OVR,   12 * 60);        // default 12:00 ET, override with --gate-end
const SETTLE_SEC = 6 * 3600 + 15 * 60;  // 16:15 ET (hard exit cap from EOD)

interface SignalSpec { label: string; tfs: { tf: number; fast: number; slow: number }[] }

// Full HMA-only signal universe (DEMA dropped per user). 18 signals:
//   4 single-TF (1m, 2m, 3m, 5m) × 3 MA-pairs (3x9, 3x12, 3x21) = 12
//   2 multi-TF stacks (2+3, 2+3+5) × 3 MA-pairs                  =  6
// Use --signals to filter to a subset (e.g. one MA-pair × one TF for chunked
// runs). When --signals is empty, ALL 18 are included.
function buildAllSignals(): SignalSpec[] {
  const out: SignalSpec[] = [];
  const pairs: { fast: number; slow: number; tag: string }[] = [
    { fast: 3, slow: 9,  tag: '3x9'  },
    { fast: 3, slow: 12, tag: '3x12' },
    { fast: 3, slow: 21, tag: '3x21' },
    { fast: 3, slow: 50, tag: '3x50' },
  ];
  for (const tf of [1, 2, 3, 5]) {
    for (const p of pairs) {
      out.push({ label: `HMA ${tf}m ${p.tag}`, tfs: [{ tf, fast: p.fast, slow: p.slow }] });
    }
  }
  for (const p of pairs) {
    out.push({ label: `HMA 2+3 ${p.tag}`, tfs: [
      { tf: 2, fast: p.fast, slow: p.slow },
      { tf: 3, fast: p.fast, slow: p.slow },
    ]});
  }
  for (const p of pairs) {
    out.push({ label: `HMA 2+3+5 ${p.tag}`, tfs: [
      { tf: 2, fast: p.fast, slow: p.slow },
      { tf: 3, fast: p.fast, slow: p.slow },
      { tf: 5, fast: p.fast, slow: p.slow },
    ]});
  }
  return out;
}
const ALL_SIGNALS = buildAllSignals();
const SIGNALS_FILTER = argVal('--signals', '');
const SIGNALS: SignalSpec[] = SIGNALS_FILTER
  ? ALL_SIGNALS.filter(s => SIGNALS_FILTER.split(',').map(x => x.trim()).includes(s.label))
  : ALL_SIGNALS;
if (SIGNALS_FILTER && SIGNALS.length === 0) {
  console.error(`No signals matched --signals='${SIGNALS_FILTER}'. Available:`);
  for (const s of ALL_SIGNALS) console.error(`  ${s.label}`);
  process.exit(2);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
function prevDate(d: string) {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function cumVol(bars: any[], from: number, to: number) {
  return bars.filter((b: any) => b.ts >= from && b.ts <= to).reduce((s: number, b: any) => s + (b.volume ?? 0), 0);
}

interface TFState { closed: any[]; partial: any | null }
function mkSt(): TFState { return { closed: [], partial: null }; }
function feed(st: TFState, b: any, tf: number) {
  const bk = Math.floor(b.ts / (tf * 60)) * (tf * 60);
  if (!st.partial || st.partial.ts !== bk) {
    if (st.partial) st.closed.push(st.partial);
    st.partial = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close };
  } else {
    if (b.high > st.partial.high) st.partial.high = b.high;
    if (b.low < st.partial.low) st.partial.low = b.low;
    st.partial.close = b.close;
  }
}
function wma(arr: number[], end: number, p: number): number | null {
  if (end < p - 1) return null;
  let s = 0, w = 0;
  for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i); }
  return s / w;
}
function hmaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const hf = Math.floor(fast / 2), sf = Math.floor(Math.sqrt(fast));
  const hs = Math.floor(slow / 2), ss = Math.floor(Math.sqrt(slow));
  const rf: number[] = [], rs: number[] = [];
  let fa: number | null = null, sa: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    const a = wma(closes, i, hf), b = wma(closes, i, fast);
    if (a != null && b != null) { rf.push(2 * a - b); if (rf.length >= sf) fa = wma(rf, rf.length - 1, sf); }
    const c = wma(closes, i, hs), d = wma(closes, i, slow);
    if (c != null && d != null) { rs.push(2 * c - d); if (rs.length >= ss) sa = wma(rs, rs.length - 1, ss); }
  }
  if (fa == null || sa == null) return null;
  return fa > sa ? 'bull' : 'bear';
}
function getDir(st: TFState, fast: number, slow: number): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  return hmaDir(bars.map((b: any) => b.close), fast, slow);
}
// offsetStrikes in STRIKE-units. Convention: negative = ITM for the given type.
//   Call ITM = strike BELOW spot  →  target = base + offset*SI  (offset=-5 → −5*SI)
//   Put  ITM = strike ABOVE spot  →  target = base − offset*SI  (offset=-5 → +5*SI)
function findStrikeAtSpot(c1: any, type: 'C' | 'P', spx: number, si: number, offsetStrikes: number): string | null {
  const base = Math.round(spx / si) * si;
  const target = type === 'C' ? base + offsetStrikes * si : base - offsetStrikes * si;
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) {
    const sym = s as string;
    if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    const d = Math.abs(k - target);
    if (d < bestD) { bestD = d; best = sym; }
  }
  return best;
}
function dirAtOrBefore(m: Map<number, 'bull' | 'bear' | null>, ts: number): 'bull' | 'bear' | null {
  let bestTs = -Infinity, bestVal: 'bull' | 'bear' | null = null;
  m.forEach((v, t) => { if (t <= ts && t > bestTs) { bestTs = t; bestVal = v; } });
  return bestVal;
}

// ── Trade-context build (per symbol × signal × date) ────────────────────────
interface TradeCtx {
  dir: 'bull' | 'bear';
  entryTs: number;
  entryPx: number;
  bars: any[];
  eod: number;
  reverseTs: number;
  // Carried through for per-trade emission. None of these affect simulation;
  // they're forensic detail for downstream analysis.
  strike: number;
  alignStart: number;   // session ts when the streak that triggered entry began
  bullCross: number;    // most recent bull cross at entry (signal-spec scope)
  bearCross: number;    // most recent bear cross at entry
  tier: 2 | 3;          // 3 = SPX direction agreed with contract at entry
}

function buildContexts(target: SymbolTarget, date: string, sig: SignalSpec, offsetStrikes: number): TradeCtx[] {
  const c1 = loadDay(target, date, '1m');
  if (!c1?.spxBars?.length) return [];
  const p1 = loadDay(target, prevDate(date), '1m');

  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  const eod = sess + 6.5 * 3600;
  const gateStart = sess + GATE_START_HHMM * 60 - 9.5 * 3600;  // sess is 9:30 ET — so gate offsets are sec-from-sess
  // Above expression: sess corresponds to 9:30 ET (570 min). gate_start_hhmm = 570 → 0 sec.
  // Simplify directly:
  const gateStartTs = sess + (GATE_START_HHMM - (9 * 60 + 30)) * 60;
  const gateEndTs = sess + (GATE_END_HHMM - (9 * 60 + 30)) * 60;

  const tf = sig.tfs[0].tf, fast = sig.tfs[0].fast, slow = sig.tfs[0].slow;
  const TIER_FAST = 3, TIER_SLOW = 15;  // 1m HMA(3x15) on SPX — same as long-sweep.ts's FAST0/SLOW0

  // Warm signal-spec TF state from prev-day session bars so HMA can fire on
  // the first post-session bar (e.g. 9:33 ET on 3m TF).
  const st = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(st, b, tf);
  // Tier state: 1m HMA on SPX, used to label entries Tier 3 (1m direction
  // agrees with trade direction) vs Tier 2. Also warmed from prev-day.
  const tierSt = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(tierSt, b, 1);

  const prevDir: { v: 'bull' | 'bear' | null } = { v: null };
  let bullCross = 0, bearCross = 0;
  const dirAt = new Map<number, 'bull' | 'bear' | null>();
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
  let bullAlignStart = 0, bearAlignStart = 0;
  const entries: { dir: 'bull' | 'bear'; entryTs: number; alignStart: number; bullCross: number; bearCross: number; tier: 2 | 3 }[] = [];

  for (const b of s1) {
    feed(st, b, tf);
    feed(tierSt, b, 1);
    const d = getDir(st, fast, slow);
    dirAt.set(b.ts, d);
    if (prevDir.v !== null && d !== prevDir.v) {
      if (d === 'bull') bullCross = b.ts;
      if (d === 'bear') bearCross = b.ts;
    }
    prevDir.v = d;
    if (b.ts < gateStartTs) continue;
    if (d === 'bull') {
      if (bullStreak === 0) bullAlignStart = b.ts;
      bullStreak++; bearStreak = 0; bearFired = false;
    } else if (d === 'bear') {
      if (bearStreak === 0) bearAlignStart = b.ts;
      bearStreak++; bullStreak = 0; bullFired = false;
    } else {
      bullStreak = 0; bearStreak = 0; bullAlignStart = 0; bearAlignStart = 0;
    }
    if (d === 'bull' && bullStreak >= MIN_ALIGN && !bullFired && bullCross > 0) {
      if ((b.ts - bullCross) / 60 <= CROSS_WIN) {
        const tierDir = getDir(tierSt, TIER_FAST, TIER_SLOW);
        const tier: 2 | 3 = tierDir === 'bull' ? 3 : 2;
        entries.push({ dir: 'bull', entryTs: b.ts + 60, alignStart: bullAlignStart, bullCross, bearCross, tier });
        bullFired = true;
      }
    }
    if (d === 'bear' && bearStreak >= MIN_ALIGN && !bearFired && bearCross > 0) {
      if ((b.ts - bearCross) / 60 <= CROSS_WIN) {
        const tierDir = getDir(tierSt, TIER_FAST, TIER_SLOW);
        const tier: 2 | 3 = tierDir === 'bear' ? 3 : 2;
        entries.push({ dir: 'bear', entryTs: b.ts + 60, alignStart: bearAlignStart, bullCross, bearCross, tier });
        bearFired = true;
      }
    }
  }

  const ctxs: TradeCtx[] = [];
  for (const e of entries) {
    if (e.entryTs < gateStartTs || e.entryTs >= gateEndTs) continue;
    const spxEntry = optPx(s1, e.entryTs - 1);
    if (!spxEntry) continue;
    const type: 'C' | 'P' = e.dir === 'bull' ? 'C' : 'P';
    const sym = findStrikeAtSpot(c1, type, spxEntry, target.strikeInterval, offsetStrikes);
    if (!sym) continue;
    const bars = c1.contractBars.get(sym) as any[];
    if (!bars?.length) continue;
    const strike = (c1.contractStrikes?.get(sym) ?? 0) as number;

    // Contract's own HMA direction for entry gate + flip-on-reversal exit.
    const cDir = new Map<number, 'bull' | 'bear' | null>();
    const cst = mkSt();
    for (const b of bars) { feed(cst, b, tf); cDir.set(b.ts, getDir(cst, fast, slow)); }
    if (dirAtOrBefore(cDir, e.entryTs - 1) !== 'bull') continue;

    const entryPx = optPx(bars, e.entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE) continue;
    if (cumVol(bars, sess, e.entryTs) < MIN_VOL) continue;

    // Flip-on-reversal: SPX or contract turns against the position.
    const cArr = bars.map((b: any) => ({ ts: b.ts, d: cDir.get(b.ts) ?? null }));
    let cIdx = 0, lastCDir: 'bull' | 'bear' | null = null;
    let reverseTs = Infinity;
    for (let t = e.entryTs; t <= eod; t += 60) {
      const spxd = dirAt.has(t) ? dirAt.get(t)! : null;
      const flipSpx = e.dir === 'bull' ? spxd === 'bear' : spxd === 'bull';
      while (cIdx < cArr.length && cArr[cIdx].ts <= t) { lastCDir = cArr[cIdx].d; cIdx++; }
      const flipC = lastCDir === 'bear';
      if (flipSpx || flipC) { reverseTs = t + 60; break; }
    }

    ctxs.push({
      dir: e.dir, entryTs: e.entryTs, entryPx, bars, eod, reverseTs,
      strike, alignStart: e.alignStart, bullCross: e.bullCross, bearCross: e.bearCross, tier: e.tier,
    });
  }
  return ctxs;
}

// ── Exit simulator (cheap; sweeps TP/SL on cached contexts) ─────────────────
interface Stat {
  trades: number; wins: number; pnl: number; pnlPct: number;
  sumWinPct: number; sumLossPct: number; cntWins: number; cntLosses: number;
  hourly: { [hour: string]: HourBucket };   // per-entry-hour aggregates
  entryPxSum: number;                       // for avgEntryPx (post-merge)
}
function emptyStat(): Stat {
  return {
    trades: 0, wins: 0, pnl: 0, pnlPct: 0,
    sumWinPct: 0, sumLossPct: 0, cntWins: 0, cntLosses: 0,
    hourly: {}, entryPxSum: 0,
  };
}
// 30-min bucket label, ET. Buckets the session: 0930, 1000, 1030, ..., 1530.
// Trades entered in [HH:MM, HH:MM+30) land in the bucket labeled HH:MM.
function etBucketOf(ts: number): string {
  const d = new Date(ts * 1000);
  const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const m = parts.match(/(\d{2}):(\d{2})/);
  if (!m) return '0000';
  const hh = m[1].padStart(2, '0');
  const mm = +m[2] < 30 ? '00' : '30';
  return `${hh}${mm}`;
}
// Simulate exits for one TP/SL cell over the supplied contexts. Returns the
// aggregate stat AND per-trade Exit records keyed by the entry's index in the
// variant's shared entries[] array. baseIdx is the index into entries[] of the
// FIRST ctx in ctxs (subsequent ctxs are baseIdx+1, +2, ...).
function simulate(ctxs: TradeCtx[], tpPct: number, slPct: number, baseIdx: number): { stat: Stat; exits: Exit[] } {
  const s = emptyStat();
  const exits: Exit[] = [];
  for (let ci = 0; ci < ctxs.length; ci++) {
    const ctx = ctxs[ci];
    const tp = ctx.entryPx * (1 + tpPct / 100);
    const sl = slPct > 0 ? ctx.entryPx * (1 - slPct / 100) : 0;
    const stopTs = Math.min(ctx.reverseTs, ctx.eod);
    let exitPx = optPx(ctx.bars, stopTs) ?? ctx.entryPx;
    let exitTs = stopTs;
    let reason: 'T' | 'S' | 'R' | 'E' = ctx.reverseTs <= ctx.eod ? 'R' : 'E';
    for (const b of ctx.bars) {
      if (b.ts <= ctx.entryTs) continue;
      if (b.ts > stopTs) break;
      const hitTp = b.high >= tp;
      const hitSl = sl > 0 && b.low <= sl;
      // On a straddle bar (both hit), SL_FIRST books the stop, else the target.
      if (hitTp && hitSl && SL_FIRST) { exitPx = sl; exitTs = b.ts; reason = 'S'; break; }
      if (hitTp) { exitPx = tp; exitTs = b.ts; reason = 'T'; break; }
      if (hitSl) { exitPx = sl; exitTs = b.ts; reason = 'S'; break; }
    }
    // Round-trip friction: half-spread paid on both entry and exit, plus
    // commission per side. Zero by default (dashboard parity).
    const frictionCost = HALF_SPREAD * 2 * 100 + COMMISSION * 2;
    const retPct = ((exitPx - ctx.entryPx) / ctx.entryPx) * 100;
    const tradePnl = (exitPx - ctx.entryPx) * 100 - frictionCost;
    s.trades++;
    s.pnl += tradePnl;
    s.pnlPct += retPct;
    s.entryPxSum += ctx.entryPx;
    const hr = etBucketOf(ctx.entryTs);
    const hb = s.hourly[hr] || (s.hourly[hr] = { pnl: 0, n: 0, wins: 0 });
    hb.pnl += tradePnl; hb.n += 1;
    if (tradePnl > 0) { s.wins++; s.cntWins++; s.sumWinPct += retPct; hb.wins += 1; }
    else { s.cntLosses++; s.sumLossPct += retPct; }
    exits.push({
      i: baseIdx + ci,
      xs: exitTs,
      xp: +exitPx.toFixed(2),
      p: +tradePnl.toFixed(2),
      r: reason,
    });
  }
  return { stat: s, exits };
}

// Legacy alias kept so older fixed-configs JSON files still parse. The
// canonical trade row is now CellTrade (cell.tradeRows[]); simulateWithTrades
// was removed when simulate() began emitting tradeRows directly.
type TradeRow = CellTrade;

// Process a date slice for one symbol: build contexts AND run the grid.
// Returns per-signal aggregated stats keyed by `tp|sl`. Stats are additive
// across disjoint dates, so the parent can SUM shards. profitDays/daysWithTrade
// are also additive (each date belongs to exactly one shard).
// dailyPnl / hourlyPnl: powered the older "aggregate only" path. Now that we
// emit the full trade list per cell, the UI can recompute these on the fly,
// but we keep them so existing consumers (equity curve, daily heatmap, hourly
// heatmap) work without scanning trades.
// trades: full trade list for this cell. Drives concurrent-position cap and
// budget simulation in the UI. ~6,000 trades/cell × 96 TP/SL × 11 offsets per
// chunk → ~6 MB extra per cell when minified, ~600 MB total per 9-chunk run.
interface HourBucket { pnl: number; n: number; wins: number }

// Entry record — written ONCE per (label × offset × date). All TP/SL cells for
// that (signal × offset × date) share entries by index. Cuts JSON ~75% vs
// duplicating entry fields in every cell.
//   d   date "YYYY-MM-DD"
//   es  entryTs (Unix seconds, UTC)
//   px  entryPx ($ per option)
//   dr  direction 'B' (bull/call) or 'S' (bear/put)
//   k   strike (option strike price)
//   t   tier 2 or 3 — entry-quality tier (3 = SPX direction agrees with contract)
//   as  alignStart — when the streak that fired this trade began
//   bc  bullCross — latest bull-cross at entry (0 if n/a)
//   sc  bearCross — latest bear-cross at entry
interface Entry {
  d: string;
  es: number;
  px: number;
  dr: 'B' | 'S';
  k: number;
  t: 2 | 3;
  as: number;
  bc: number;
  sc: number;
}
// Exit record — per cell, parallel-indexed to the variant's entries array.
//   i  entry index in variant's entries[]
//   xs exitTs
//   xp exitPx
//   p  pnl $ (1 contract × $100 multiplier)
//   r  exit reason 'T' (TP), 'S' (SL), 'R' (reverse), 'E' (EOD)
interface Exit {
  i: number;
  xs: number;
  xp: number;
  p: number;
  r: 'T' | 'S' | 'R' | 'E';
}
// CellTrade is a recomposed view of (entry + exit) used by downstream consumers
// that don't want to merge the two streams themselves. Not stored on disk.
type CellTrade = Entry & Omit<Exit, 'i'>;

interface CellAgg {
  trades: number; wins: number; pnl: number;
  daysWithTrade: number; profitDays: number;
  dailyPnl: { [date: string]: number };
  hourlyPnl: { [hour: string]: HourBucket };
  entryPxSum: number; entryPxN: number;
  exits: Exit[];   // parallel-indexed to the variant's entries[]
}
interface ShardResult {
  symbol: string;
  dates: string[];
  perSignal: { [label: string]: { contextCount: number; cells: { [tpSlKey: string]: CellAgg }; entries: Entry[]; trades?: TradeRow[] } };
}

// Composite label = `${sigLabel} @ ${offsetTag}`; offset is in STRIKES (neg=ITM).
// offsetTag examples: 'ATM', '5ITM', '10ITM' (always ITM-only in this study).
function offsetTag(off: number): string {
  if (off === 0) return 'ATM';
  return off < 0 ? `${Math.abs(off)}ITM` : `${off}OTM`;
}

interface Variant { label: string; sig: SignalSpec; offset: number; }

function newCell(): CellAgg {
  return { trades: 0, wins: 0, pnl: 0, daysWithTrade: 0, profitDays: 0, dailyPnl: {}, hourlyPnl: {}, entryPxSum: 0, entryPxN: 0, exits: [] };
}

function foldStat(cell: CellAgg, s: Stat, date: string) {
  if (s.trades === 0) return;
  cell.trades += s.trades; cell.wins += s.wins; cell.pnl += s.pnl;
  cell.daysWithTrade += 1; if (s.pnl > 0) cell.profitDays += 1;
  cell.dailyPnl[date] = +s.pnl.toFixed(2);
  cell.entryPxSum += s.entryPxSum;
  cell.entryPxN += s.trades;
  for (const [hr, hb] of Object.entries(s.hourly)) {
    const acc = cell.hourlyPnl[hr] || (cell.hourlyPnl[hr] = { pnl: 0, n: 0, wins: 0 });
    acc.pnl += hb.pnl; acc.n += hb.n; acc.wins += hb.wins;
  }
}

function runShard(target: SymbolTarget, dates: string[], grids: { [label: string]: { tp: number; sl: number }[] }, variants: Variant[], _emitTrades: boolean): ShardResult {
  // Streaming-sidecar design: trade-level data (entries + exits) is written
  // DIRECTLY to per-(variant, cell) sidecar files during the sweep, never
  // accumulated in memory. The slot.cells[] / slot.entries[] in-memory state
  // holds only aggregates, so this scales to arbitrary date counts.
  const out: ShardResult = { symbol: target.symbol, dates, perSignal: {} };
  for (const v of variants) out.perSignal[v.label] = { contextCount: 0, cells: {}, entries: [], trades: undefined };

  // Sidecar setup. Parent passes STUDY_SIDECAR_DIR via env; we write
  // NDJSON shard files into it. Each line is one JSON value.
  const sidecarDir = process.env.STUDY_SIDECAR_DIR;
  const shardIdx = process.env.STUDY_SHARD ?? '0';
  let entryFds: { [variantLabel: string]: number } = {};
  let exitFds: { [cellKey: string]: number } = {};  // cellKey = `${label}::TP${tp}_SL${sl}`
  function slugify(s: string): string {
    return s.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/g, '');
  }
  function entryFileFor(label: string): number | null {
    if (!sidecarDir) return null;
    if (entryFds[label] !== undefined) return entryFds[label];
    const fname = `${slugify(target.symbol)}__${slugify(label)}__entries__shard${shardIdx}.ndjson`;
    const fd = fs.openSync(path.join(sidecarDir, fname), 'a');
    entryFds[label] = fd;
    return fd;
  }
  function exitFileFor(label: string, tp: number, sl: number): number | null {
    if (!sidecarDir) return null;
    const k = `${label}::${tp}|${sl}`;
    if (exitFds[k] !== undefined) return exitFds[k];
    const fname = `${slugify(target.symbol)}__${slugify(label)}__TP${tp}_SL${sl}__shard${shardIdx}.ndjson`;
    const fd = fs.openSync(path.join(sidecarDir, fname), 'a');
    exitFds[k] = fd;
    return fd;
  }
  function appendLine(fd: number, obj: any): void {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
  }
  function closeAllFds(): void {
    for (const fd of Object.values(entryFds)) { try { fs.closeSync(fd); } catch {} }
    for (const fd of Object.values(exitFds))  { try { fs.closeSync(fd); } catch {} }
    entryFds = {};
    exitFds = {};
  }

  let di = 0;
  for (const date of dates) {
    for (const v of variants) {
      let ctxs: TradeCtx[] = [];
      try { ctxs = buildContexts(target, date, v.sig, v.offset); }
      catch (e: any) { process.stderr.write(`  [${target.symbol}] ${date} ${v.label}: ${e.message}\n`); continue; }
      const slot = out.perSignal[v.label];
      slot.contextCount += ctxs.length;
      if (!ctxs.length) continue;

      // Track entry indices so this shard's exits reference the same indices
      // that the post-merge entries array will use. baseIdx counts THIS WORKER's
      // entry tally so far; mergeShards offsets across shards.
      const baseIdx = slot.entries.length;
      const entryFd = entryFileFor(v.label);
      for (const ctx of ctxs) {
        const entry: Entry = {
          d: date,
          es: ctx.entryTs,
          px: +ctx.entryPx.toFixed(2),
          dr: ctx.dir === 'bull' ? 'B' : 'S',
          k: ctx.strike,
          t: ctx.tier,
          as: ctx.alignStart,
          bc: ctx.bullCross,
          sc: ctx.bearCross,
        };
        // In-memory entries: count-only stub (we just need length for baseIdx).
        // The actual entry object lives in the sidecar file.
        slot.entries.push(null as any);
        if (entryFd !== null) appendLine(entryFd, entry);
      }

      const grid = grids[v.label] || [];
      for (const g of grid) {
        const key = `${g.tp}|${g.sl}`;
        const { stat: s, exits } = simulate(ctxs, g.tp, g.sl, baseIdx);
        const cell = slot.cells[key] || (slot.cells[key] = newCell());
        foldStat(cell, s, date);
        if (exits.length) {
          const fd = exitFileFor(v.label, g.tp, g.sl);
          if (fd !== null) for (const ex of exits) appendLine(fd, ex);
        }
        // cell.exits stays empty in memory — written to sidecar instead.
      }
    }
    if (++di % 10 === 0) process.stderr.write(`  [shard ${shardIdx} ${target.symbol}] ${di}/${dates.length}\n`);
  }
  closeAllFds();
  return out;
}

interface Row {
  tp: number; sl: number; trades: number; wins: number; winRate: number;
  pnl: number; avgPnl: number; daysWithTrade: number; profitDays: number;
  maxDrawdown: number;
  dailyPnl: { [date: string]: number };
  hourlyPnl: { [hour: string]: HourBucket };
  avgEntryPx: number;
  // Row.exits references the variant's shared entries[] array. Cells alone
  // are not self-contained; downstream consumers must join with entries.
  exits: Exit[];
}
// Max drawdown = largest peak-to-trough drop on the cumulative equity curve
// (in dollars). Walks dailyPnl in date order, tracks running peak, returns
// max(peak - cum). Returns positive number — the "depth" of the deepest valley.
function maxDrawdownFromDaily(dailyPnl: { [date: string]: number }): number {
  const dates = Object.keys(dailyPnl).sort();
  let cum = 0, peak = 0, maxDd = 0;
  for (const d of dates) {
    cum += dailyPnl[d];
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  return +maxDd.toFixed(2);
}
function cellToRow(tp: number, sl: number, c: CellAgg): Row {
  return {
    tp, sl,
    trades: c.trades, wins: c.wins,
    winRate: c.trades > 0 ? c.wins / c.trades : 0,
    pnl: +c.pnl.toFixed(2),
    avgPnl: c.trades > 0 ? +(c.pnl / c.trades).toFixed(2) : 0,
    daysWithTrade: c.daysWithTrade, profitDays: c.profitDays,
    maxDrawdown: maxDrawdownFromDaily(c.dailyPnl || {}),
    dailyPnl: c.dailyPnl || {},
    hourlyPnl: c.hourlyPnl || {},
    avgEntryPx: c.entryPxN > 0 ? +(c.entryPxSum / c.entryPxN).toFixed(2) : 0,
    exits: c.exits || [],
  };
}
function mergeShards(shards: ShardResult[]): { perSignal: { [label: string]: { contextCount: number; cells: { [k: string]: CellAgg }; entries: Entry[]; trades?: TradeRow[] } }, dates: string[] } {
  const perSignal: { [label: string]: { contextCount: number; cells: { [k: string]: CellAgg }; entries: Entry[]; trades?: TradeRow[] } } = {};
  const dates: string[] = [];
  for (const sh of shards) {
    for (const d of sh.dates) dates.push(d);
    for (const label of Object.keys(sh.perSignal)) {
      const slot = perSignal[label] || (perSignal[label] = { contextCount: 0, cells: {}, entries: [] });
      slot.contextCount += sh.perSignal[label].contextCount;

      // Each shard has its own entries[] indexed from 0. Capture the merged
      // entries array's length BEFORE concat — that's the offset to add to
      // every exit.i emitted by this shard.
      const entryOffset = slot.entries.length;
      const shardEntries = sh.perSignal[label].entries || [];
      slot.entries.push(...shardEntries);

      for (const [k, cell] of Object.entries(sh.perSignal[label].cells)) {
        const acc = slot.cells[k] || (slot.cells[k] = newCell());
        acc.trades += cell.trades;
        acc.wins += cell.wins;
        acc.pnl += cell.pnl;
        acc.daysWithTrade += cell.daysWithTrade;
        acc.profitDays += cell.profitDays;
        acc.entryPxSum += cell.entryPxSum || 0;
        acc.entryPxN   += cell.entryPxN   || 0;
        // dailyPnl shards are disjoint by date — union.
        if (cell.dailyPnl) for (const [d, v] of Object.entries(cell.dailyPnl)) acc.dailyPnl[d] = v as number;
        // hourlyPnl: accumulate (same hour can occur across shards).
        if (cell.hourlyPnl) for (const [hr, hb] of Object.entries(cell.hourlyPnl)) {
          const a = acc.hourlyPnl[hr] || (acc.hourlyPnl[hr] = { pnl: 0, n: 0, wins: 0 });
          const b = hb as HourBucket;
          a.pnl += b.pnl; a.n += b.n; a.wins += b.wins;
        }
        // Exits: rewrite their .i to point into the merged entries[] array.
        if (cell.exits && cell.exits.length) {
          for (const ex of cell.exits) acc.exits.push({ ...ex, i: ex.i + entryOffset });
        }
      }
      if (sh.perSignal[label].trades && sh.perSignal[label].trades!.length) {
        slot.trades = slot.trades || [];
        slot.trades.push(...sh.perSignal[label].trades!);
      }
    }
  }
  return { perSignal, dates: [...new Set(dates)].sort() };
}
function cellsToRows(cells: { [k: string]: CellAgg }): Row[] {
  return Object.entries(cells).map(([k, c]) => {
    const [tp, sl] = k.split('|').map(Number);
    return cellToRow(tp, sl, c);
  });
}

// ── Pass runners ────────────────────────────────────────────────────────────
function buildGrid(tpStart: number, tpEnd: number, tpStep: number, slStart: number, slEnd: number, slStep: number) {
  const grid: { tp: number; sl: number }[] = [];
  for (let tp = tpStart; tp <= tpEnd; tp += tpStep) {
    for (let sl = slStart; sl <= slEnd; sl += slStep) grid.push({ tp, sl });
  }
  return grid;
}

function topByPnl(rows: Row[], n: number) { return [...rows].sort((a, b) => b.pnl - a.pnl).slice(0, n); }
function fmtRow(r: Row): string {
  return `  TP${String(r.tp).padStart(3)}% SL${String(r.sl).padStart(2)}% │ trades ${String(r.trades).padStart(4)}  WR ${(r.winRate * 100).toFixed(1).padStart(5)}%  pnl $${r.pnl.toFixed(0).padStart(7)}  avg $${r.avgPnl.toFixed(2).padStart(6)}  ${r.profitDays}/${r.daysWithTrade} green`;
}

// ── Worker mode ─────────────────────────────────────────────────────────────
// Forked from main with STUDY_SHARD_MODE=1. Receives one IPC message with the
// shard task, runs runShard(), sends ShardResult back, exits.
if (process.env.STUDY_SHARD_MODE === '1') {
  process.on('message', (msg: any) => {
    try {
      const target: SymbolTarget = msg.target;
      const dates: string[] = msg.dates;
      const grids: { [label: string]: { tp: number; sl: number }[] } = msg.grids;
      // Re-hydrate variants by looking sigLabel up in SIGNALS (sig itself isn't
      // structurally clone-friendly through IPC — only its label is needed).
      const variants: Variant[] = (msg.variants as { label: string; sigLabel: string; offset: number }[]).map(v => {
        const sig = SIGNALS.find(s => s.label === v.sigLabel);
        if (!sig) throw new Error(`unknown sigLabel: ${v.sigLabel}`);
        return { label: v.label, sig, offset: v.offset };
      });
      const emitTrades: boolean = !!msg.emitTrades;
      const result = runShard(target, dates, grids, variants, emitTrades);
      // CRITICAL: wait for IPC send to flush before exiting. Without the
      // callback, large messages may be silently dropped — observed as
      // "shard N exited code 0 without result" on pass2 of 16+ variants.
      process.send!({ ok: true, result }, undefined, undefined, () => process.exit(0));
    } catch (e: any) {
      process.send!({ ok: false, error: e.message, stack: e.stack }, undefined, undefined, () => process.exit(1));
    }
  });
} else {
  main().catch(e => { console.error(e); process.exit(1); });
}

function dispatchShards(target: SymbolTarget, dates: string[], grids: { [label: string]: { tp: number; sl: number }[] }, variants: Variant[], workers: number, emitTrades: boolean = false, sidecarDir: string | null = null): Promise<ShardResult[]> {
  if (!dates.length) return Promise.resolve([]);
  const W = Math.max(1, Math.min(workers, dates.length));
  // Round-robin shard so each worker gets a similar mix of high/low-volume days.
  const shards: string[][] = Array.from({ length: W }, () => []);
  dates.forEach((d, i) => shards[i % W].push(d));

  // sig is not IPC-serializable cleanly; ship sigLabel + offset and re-hydrate.
  const wireVariants = variants.map(v => ({ label: v.label, sigLabel: v.sig.label, offset: v.offset }));

  return Promise.all(shards.map((shardDates, idx) => new Promise<ShardResult>((resolve, reject) => {
    if (!shardDates.length) {
      resolve({ symbol: target.symbol, dates: [], perSignal: Object.fromEntries(variants.map(v => [v.label, { contextCount: 0, cells: {}, entries: [] }])) });
      return;
    }
    // Forward gate overrides to the child so its module-level constants match
    // the parent's. Without this, workers default to 9:30-12:00 and silently
    // truncate any --gate-end past noon (bit me in smoke testing).
    const childArgs: string[] = [];
    if (GATE_START_OVR) childArgs.push('--gate-start', GATE_START_OVR);
    if (GATE_END_OVR)   childArgs.push('--gate-end',   GATE_END_OVR);
    if (HALF_SPREAD)    childArgs.push('--half-spread', String(HALF_SPREAD));
    if (COMMISSION)     childArgs.push('--commission',  String(COMMISSION));
    if (SL_FIRST)       childArgs.push('--sl-first');
    const childEnv: NodeJS.ProcessEnv = { ...process.env, STUDY_SHARD_MODE: '1', STUDY_SHARD: String(idx) };
    if (sidecarDir) childEnv.STUDY_SIDECAR_DIR = sidecarDir;
    const child = fork(__filename, childArgs, { env: childEnv, silent: false });
    let settled = false;
    child.on('message', (msg: any) => {
      if (settled) return;
      settled = true;
      if (msg.ok) resolve(msg.result);
      else reject(new Error(`shard ${idx}: ${msg.error}\n${msg.stack ?? ''}`));
    });
    child.on('exit', (code) => { if (!settled) { settled = true; reject(new Error(`shard ${idx} exited code ${code} without result`)); } });
    child.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
    child.send({ target, dates: shardDates, grids, variants: wireVariants, emitTrades });
  })));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const WORKERS = Math.max(1, parseInt(argVal('--workers', String(Math.max(2, Math.min(8, os.cpus().length - 1)))), 10));
  console.log(`hma3m-tpsl-study — symbols=${SYMBOLS.join(',')}  days=${DAYS}  refine-top=${REFINE_TOP}  workers=${WORKERS}`);

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setUTCDate(cutoff.getUTCDate() - DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  // Coarse grid: TP 25..300 step 25 × SL 20..90 step 10  →  12 × 8 = 96 combos
  const coarseGrid = buildGrid(25, 300, 25, 20, 90, 10);
  console.log(`Coarse grid: ${coarseGrid.length} TP/SL combos per (signal × offset)`);

  // Sidecar dir (computed early, passed to workers). Workers stream per-cell
  // entries + exits to NDJSON files here. Parent's chunk JSON stays small,
  // referencing sidecars by relative path.
  const outFile = OUT_PATH
    ? (path.isAbsolute(OUT_PATH) ? OUT_PATH : path.join(process.cwd(), OUT_PATH))
    : path.join(process.cwd(), 'scripts/autoresearch/output/hma3m-tpsl-study.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const sidecarDir = outFile + '.exits';
  fs.mkdirSync(sidecarDir, { recursive: true });
  // Wipe any pre-existing sidecar files (stale from a previous run on the same
  // outFile name). Otherwise NDJSON appends would compound results.
  for (const f of fs.readdirSync(sidecarDir)) {
    try { fs.unlinkSync(path.join(sidecarDir, f)); } catch {}
  }

  const output: any = { generatedAt: new Date().toISOString(), days: DAYS, cutoff: cutoffStr, workers: WORKERS, offsetsBySym: OFFSETS_BY_SYM, symbols: {} };

  for (const symbol of SYMBOLS) {
    try {
    const fakeArgv = ['node', 'study', '--symbol', symbol];
    const target = resolveSymbolTarget(fakeArgv as any);
    const allDates = listDatesFor(target).filter(d => d >= cutoffStr);
    if (!allDates.length) {
      console.log(`\n[${symbol}] no parquet in last ${DAYS}d`);
      continue;
    }

    // ── Fixed-configs path: evaluate ONLY the picked (sig × offset × tp × sl)
    // tuples. Skips coarse + refine grid search. Used to test specific configs
    // out-of-sample on extended date ranges.
    if (FIXED_CONFIGS.length > 0) {
      const variantByLabel = new Map<string, Variant>();
      const cellsByLabel: { [k: string]: { tp: number; sl: number }[] } = {};
      for (const fc of FIXED_CONFIGS) {
        const sig = SIGNALS.find(s => s.label === fc.sigLabel);
        if (!sig) throw new Error(`unknown sigLabel in --configs: ${fc.sigLabel}`);
        const label = `${sig.label} @ ${offsetTag(fc.offset)} TP${fc.tp}/SL${fc.sl}`;
        variantByLabel.set(label, { label, sig, offset: fc.offset });
        (cellsByLabel[label] = cellsByLabel[label] || []).push({ tp: fc.tp, sl: fc.sl });
      }
      const variants = [...variantByLabel.values()];
      console.log(`\n[${symbol}] ${allDates.length} dates ${allDates[0]} … ${allDates[allDates.length - 1]} — ${variants.length} fixed configs${EMIT_TRADES ? ' (with trade-level emission)' : ''}`);
      const t0 = Date.now();
      const shards = await dispatchShards(target, allDates, cellsByLabel, variants, WORKERS, EMIT_TRADES, sidecarDir);
      const merged = mergeShards(shards);
      console.log(`[${symbol}] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

      const symOut: any = { dates: allDates, fixedConfigs: FIXED_CONFIGS, signals: {} };
      for (const v of variants) {
        const slot = merged.perSignal[v.label];
        const ctxCount = slot?.contextCount ?? 0;
        const rows = slot ? cellsToRows(slot.cells) : [];
        console.log(`\n[${symbol}] ${v.label} — ${ctxCount} trade contexts`);
        rows.forEach(r => console.log(fmtRow(r)));
        symOut.signals[v.label] = { contextCount: ctxCount, fixed: rows };
        if (EMIT_TRADES && slot?.trades) symOut.signals[v.label].trades = slot.trades;
      }
      output.symbols[symbol] = symOut;
      continue;
    }

    const offsets = offsetsFor(symbol);
    const variants: Variant[] = [];
    for (const sig of SIGNALS) for (const off of offsets) variants.push({ label: `${sig.label} @ ${offsetTag(off)}`, sig, offset: off });
    const coarseGrids: { [k: string]: { tp: number; sl: number }[] } = {};
    for (const v of variants) coarseGrids[v.label] = coarseGrid;

    console.log(`\n[${symbol}] ${allDates.length} dates ${allDates[0]} … ${allDates[allDates.length - 1]} — ${variants.length} variants (${SIGNALS.length} sig × ${offsets.length} offset) — pass1 (coarse)`);
    const t0 = Date.now();

    const shards1 = await dispatchShards(target, allDates, coarseGrids, variants, WORKERS, false, sidecarDir);
    const merged1 = mergeShards(shards1);
    console.log(`[${symbol}] pass1 done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const symOut: any = { dates: allDates, offsets, signals: {} };
    const refineGrids: { [k: string]: { tp: number; sl: number }[] } = {};

    for (const v of variants) {
      const slot = merged1.perSignal[v.label];
      const ctxCount = slot?.contextCount ?? 0;
      console.log(`\n[${symbol}] ${v.label} — ${ctxCount} trade contexts`);
      if (ctxCount === 0 || !slot || Object.keys(slot.cells).length === 0) {
        symOut.signals[v.label] = { contextCount: ctxCount, coarse: [], refine: [], topCoarse: [], topRefine: [] };
        refineGrids[v.label] = [];
        continue;
      }
      const coarseRows = cellsToRows(slot.cells);
      const topC = topByPnl(coarseRows, 10);
      console.log(`Top 10 coarse for ${symbol} ${v.label}:`);
      topC.forEach(r => console.log(fmtRow(r)));

      const seeds = topByPnl(coarseRows, REFINE_TOP);
      const tpSet = new Set<number>(), slSet = new Set<number>();
      for (const s of seeds) {
        for (let dt = -20; dt <= 20; dt += 5) { const t = s.tp + dt; if (t >= 10 && t <= 500) tpSet.add(t); }
        for (let ds = -8; ds <= 8; ds += 2) { const w = s.sl + ds; if (w >= 10 && w <= 95) slSet.add(w); }
      }
      const rg: { tp: number; sl: number }[] = [];
      for (const tp of [...tpSet].sort((a, b) => a - b)) for (const sl of [...slSet].sort((a, b) => a - b)) rg.push({ tp, sl });
      refineGrids[v.label] = rg;
      // Emit the variant's shared entries[] alongside cells. Each row's
      // exits[].i is an index into this entries array.
      symOut.signals[v.label] = {
        contextCount: ctxCount,
        entries: slot.entries || [],
        coarse: coarseRows,
        topCoarse: topC,
        refine: [],
        topRefine: [],
      };
    }

    const hasRefine = Object.values(refineGrids).some(g => g.length > 0);
    if (hasRefine) {
      const refineCombos = Object.values(refineGrids).reduce((s, g) => s + g.length, 0);
      console.log(`\n[${symbol}] pass2 (refine) — ${refineCombos} total TP/SL combos across ${variants.length} variants`);
      const t1 = Date.now();
      const shards2 = await dispatchShards(target, allDates, refineGrids, variants, WORKERS, false, sidecarDir);
      const merged2 = mergeShards(shards2);
      console.log(`[${symbol}] pass2 done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

      for (const v of variants) {
        const slot = merged2.perSignal[v.label];
        if (!slot || Object.keys(slot.cells).length === 0) continue;
        const refineRows = cellsToRows(slot.cells);
        const topR = topByPnl(refineRows, 10);
        console.log(`\nTop 10 refined for ${symbol} ${v.label} (${refineRows.length} combos):`);
        topR.forEach(r => console.log(fmtRow(r)));
        symOut.signals[v.label].refine = refineRows;
        symOut.signals[v.label].topRefine = topR;
      }
    }
    output.symbols[symbol] = symOut;
    } catch (e: any) {
      console.error(`\n[${symbol}] FAILED: ${e.message}\n${e.stack ?? ''}`);
      output.symbols[symbol] = { error: e.message };
    }
  }

  // outFile + sidecarDir were created at the top of main(). Workers have been
  // streaming entries + exits to sidecarDir during the sweep, so here we only
  // need to write the small chunk file: aggregates + meta. Each row gets an
  // exitsCount derived from the merged cell stats; the actual exit rows live
  // in sidecar NDJSON files written by the workers.
  const exitsBasename = path.basename(sidecarDir);
  function slug(s: string): string {
    return s.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/g, '');
  }
  // Annotate each row with the sidecar filename pattern (one per shard).
  // Reader has to load all 4 shard NDJSON files for a given cell and concat.
  function decorateRows(sym: string, sigLabel: string, rows: any[]): any[] {
    return rows.map((row: any) => {
      const fnamePrefix = `${slug(sym)}__${slug(sigLabel)}__TP${row.tp}_SL${row.sl}__shard`;
      return { ...row, exitsFilePrefix: `${exitsBasename}/${fnamePrefix}`, exitsCount: row.trades };
    });
  }
  // Walk the output and decorate coarse/refine rows. Modifies in place.
  for (const sym of Object.keys(output.symbols || {})) {
    const symVal = output.symbols[sym];
    for (const sigLabel of Object.keys(symVal.signals || {})) {
      const sig = symVal.signals[sigLabel];
      if (Array.isArray(sig.coarse)) sig.coarse = decorateRows(sym, sigLabel, sig.coarse);
      if (Array.isArray(sig.refine)) sig.refine = decorateRows(sym, sigLabel, sig.refine);
    }
  }
  // Annotate the variant slot with its entries-sidecar filename pattern so
  // downstream tooling can find the per-shard NDJSON entries files.
  for (const sym of Object.keys(output.symbols || {})) {
    const symVal = output.symbols[sym];
    for (const sigLabel of Object.keys(symVal.signals || {})) {
      const sig = symVal.signals[sigLabel];
      sig.entriesFilePrefix = `${exitsBasename}/${slug(sym)}__${slug(sigLabel)}__entries__shard`;
      // The in-memory entries[] holds null stubs (one per entry seen) just so
      // mergeShards' baseIdx math works. Drop them before write — readers
      // should load entries from the sidecar NDJSON files instead.
      delete sig.entries;
    }
  }
  function streamOutput(filePath: string, root: any): void {
    const fd = fs.openSync(filePath, 'w');
    const write = (s: string) => fs.writeSync(fd, s);
    try {
      write('{');
      let firstTop = true;
      for (const [topKey, topVal] of Object.entries(root)) {
        if (!firstTop) write(',');
        firstTop = false;
        write(JSON.stringify(topKey) + ':');
        if (topKey !== 'symbols') { write(JSON.stringify(topVal)); continue; }
        write('{');
        let firstSym = true;
        for (const [sym, symVal] of Object.entries(topVal as any)) {
          if (!firstSym) write(',');
          firstSym = false;
          write(JSON.stringify(sym) + ':{');
          let firstSymKey = true;
          for (const [symKey, symKeyVal] of Object.entries(symVal as any)) {
            if (!firstSymKey) write(',');
            firstSymKey = false;
            write(JSON.stringify(symKey) + ':');
            if (symKey !== 'signals') { write(JSON.stringify(symKeyVal)); continue; }
            write('{');
            let firstSig = true;
            for (const [sigLabel, sigVal] of Object.entries(symKeyVal as any)) {
              if (!firstSig) write(',');
              firstSig = false;
              write(JSON.stringify(sigLabel) + ':{');
              let firstField = true;
              for (const [fk, fv] of Object.entries(sigVal as any)) {
                if (!firstField) write(',');
                firstField = false;
                write(JSON.stringify(fk) + ':');
                if (Array.isArray(fv) && fv.length > 500) {
                  write('[');
                  for (let i = 0; i < fv.length; i++) {
                    if (i > 0) write(',');
                    write(JSON.stringify(fv[i]));
                  }
                  write(']');
                } else {
                  write(JSON.stringify(fv));
                }
              }
              write('}');
            }
            write('}');
          }
          write('}');
        }
        write('}');
      }
      write('}');
    } finally { fs.closeSync(fd); }
  }
  streamOutput(outFile, output);
  console.log(`\n✓ wrote ${outFile}`);
}
