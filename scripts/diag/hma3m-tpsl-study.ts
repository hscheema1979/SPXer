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
    const m = part.trim().match(/^(3x9|3x12):(\d+)(ITM|OTM|ATM):(\d+):(\d+)$/i);
    if (!m) throw new Error(`bad --configs entry: ${part}`);
    const [, sigKey, offN, offDir, tp, sl] = m;
    const sigLabel = `HMA 3m ${sigKey.toLowerCase()}`;
    const off = offDir.toUpperCase() === 'ATM' ? 0 : (offDir.toUpperCase() === 'ITM' ? -Number(offN) : Number(offN));
    out.push({ sigLabel, offset: off, tp: Number(tp), sl: Number(sl) });
  }
  return out;
}
const FIXED_CONFIGS = parseFixedConfigs(argVal('--configs', ''));
const OUT_PATH = argVal('--out', '');
const EMIT_TRADES = process.argv.includes('--emit-trades');
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
const SIGNALS: SignalSpec[] = [
  { label: 'HMA 3m 3x9',  tfs: [{ tf: 3, fast: 3, slow: 9 }] },
  { label: 'HMA 3m 3x12', tfs: [{ tf: 3, fast: 3, slow: 12 }] },
];

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

  // Warm tier state from prev-day session bars so HMA can fire on the first
  // post-session 3m bar (≈ 9:33 ET).
  const st = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(st, b, tf);

  const prevDir: { v: 'bull' | 'bear' | null } = { v: null };
  let bullCross = 0, bearCross = 0;
  const dirAt = new Map<number, 'bull' | 'bear' | null>();
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
  const entries: { dir: 'bull' | 'bear'; entryTs: number }[] = [];

  for (const b of s1) {
    feed(st, b, tf);
    const d = getDir(st, fast, slow);
    dirAt.set(b.ts, d);
    if (prevDir.v !== null && d !== prevDir.v) {
      if (d === 'bull') bullCross = b.ts;
      if (d === 'bear') bearCross = b.ts;
    }
    prevDir.v = d;
    if (b.ts < gateStartTs) continue;
    if (d === 'bull') { bullStreak++; bearStreak = 0; bearFired = false; }
    else if (d === 'bear') { bearStreak++; bullStreak = 0; bullFired = false; }
    else { bullStreak = 0; bearStreak = 0; }
    if (d === 'bull' && bullStreak >= MIN_ALIGN && !bullFired && bullCross > 0) {
      if ((b.ts - bullCross) / 60 <= CROSS_WIN) { entries.push({ dir: 'bull', entryTs: b.ts + 60 }); bullFired = true; }
    }
    if (d === 'bear' && bearStreak >= MIN_ALIGN && !bearFired && bearCross > 0) {
      if ((b.ts - bearCross) / 60 <= CROSS_WIN) { entries.push({ dir: 'bear', entryTs: b.ts + 60 }); bearFired = true; }
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

    ctxs.push({ dir: e.dir, entryTs: e.entryTs, entryPx, bars, eod, reverseTs });
  }
  return ctxs;
}

// ── Exit simulator (cheap; sweeps TP/SL on cached contexts) ─────────────────
interface Stat { trades: number; wins: number; pnl: number; pnlPct: number; sumWinPct: number; sumLossPct: number; cntWins: number; cntLosses: number; }
function emptyStat(): Stat { return { trades: 0, wins: 0, pnl: 0, pnlPct: 0, sumWinPct: 0, sumLossPct: 0, cntWins: 0, cntLosses: 0 }; }
function simulate(ctxs: TradeCtx[], tpPct: number, slPct: number): Stat {
  const s = emptyStat();
  for (const ctx of ctxs) {
    const tp = ctx.entryPx * (1 + tpPct / 100);
    const sl = slPct > 0 ? ctx.entryPx * (1 - slPct / 100) : 0;
    const stopTs = Math.min(ctx.reverseTs, ctx.eod);
    let exitPx = optPx(ctx.bars, stopTs) ?? ctx.entryPx;
    for (const b of ctx.bars) {
      if (b.ts <= ctx.entryTs) continue;
      if (b.ts > stopTs) break;
      if (b.high >= tp) { exitPx = tp; break; }
      if (sl > 0 && b.low <= sl) { exitPx = sl; break; }
    }
    const retPct = ((exitPx - ctx.entryPx) / ctx.entryPx) * 100;
    s.trades++;
    s.pnl += (exitPx - ctx.entryPx) * 100;  // 1 contract × 100 multiplier
    s.pnlPct += retPct;
    if (retPct > 0) { s.wins++; s.cntWins++; s.sumWinPct += retPct; }
    else { s.cntLosses++; s.sumLossPct += retPct; }
  }
  return s;
}

// Trade-level variant used by the fixed-configs path. Emits one row per trade
// with entry/exit time-of-day so a post-processor can bucket by hour. Kept
// separate from simulate() because the grid sweep doesn't need this overhead.
interface TradeRow {
  date: string;
  dir: 'bull' | 'bear';
  entryTs: number;
  exitTs: number;
  entryPx: number;
  exitPx: number;
  pnl: number;
  reason: 'TP' | 'SL' | 'reverse' | 'EOD';
}
function simulateWithTrades(ctxs: TradeCtx[], tpPct: number, slPct: number, date: string): { stat: Stat; trades: TradeRow[] } {
  const s = emptyStat();
  const rows: TradeRow[] = [];
  for (const ctx of ctxs) {
    const tp = ctx.entryPx * (1 + tpPct / 100);
    const sl = slPct > 0 ? ctx.entryPx * (1 - slPct / 100) : 0;
    const stopTs = Math.min(ctx.reverseTs, ctx.eod);
    let exitPx = optPx(ctx.bars, stopTs) ?? ctx.entryPx;
    let exitTs = stopTs;
    let reason: TradeRow['reason'] = ctx.reverseTs <= ctx.eod ? 'reverse' : 'EOD';
    for (const b of ctx.bars) {
      if (b.ts <= ctx.entryTs) continue;
      if (b.ts > stopTs) break;
      if (b.high >= tp) { exitPx = tp; exitTs = b.ts; reason = 'TP'; break; }
      if (sl > 0 && b.low <= sl) { exitPx = sl; exitTs = b.ts; reason = 'SL'; break; }
    }
    const retPct = ((exitPx - ctx.entryPx) / ctx.entryPx) * 100;
    s.trades++;
    s.pnl += (exitPx - ctx.entryPx) * 100;
    s.pnlPct += retPct;
    if (retPct > 0) { s.wins++; s.cntWins++; s.sumWinPct += retPct; }
    else { s.cntLosses++; s.sumLossPct += retPct; }
    rows.push({ date, dir: ctx.dir, entryTs: ctx.entryTs, exitTs, entryPx: ctx.entryPx, exitPx, pnl: (exitPx - ctx.entryPx) * 100, reason });
  }
  return { stat: s, trades: rows };
}

// Process a date slice for one symbol: build contexts AND run the grid.
// Returns per-signal aggregated stats keyed by `tp|sl`. Stats are additive
// across disjoint dates, so the parent can SUM shards. profitDays/daysWithTrade
// are also additive (each date belongs to exactly one shard).
interface CellAgg { trades: number; wins: number; pnl: number; daysWithTrade: number; profitDays: number; }
interface ShardResult {
  symbol: string;
  dates: string[];
  perSignal: { [label: string]: { contextCount: number; cells: { [tpSlKey: string]: CellAgg }; trades?: TradeRow[] } };
}

// Composite label = `${sigLabel} @ ${offsetTag}`; offset is in STRIKES (neg=ITM).
// offsetTag examples: 'ATM', '5ITM', '10ITM' (always ITM-only in this study).
function offsetTag(off: number): string {
  if (off === 0) return 'ATM';
  return off < 0 ? `${Math.abs(off)}ITM` : `${off}OTM`;
}

interface Variant { label: string; sig: SignalSpec; offset: number; }

function runShard(target: SymbolTarget, dates: string[], grids: { [label: string]: { tp: number; sl: number }[] }, variants: Variant[], emitTrades: boolean): ShardResult {
  const out: ShardResult = { symbol: target.symbol, dates, perSignal: {} };
  for (const v of variants) out.perSignal[v.label] = { contextCount: 0, cells: {}, trades: emitTrades ? [] : undefined };

  let di = 0;
  for (const date of dates) {
    for (const v of variants) {
      let ctxs: TradeCtx[] = [];
      try { ctxs = buildContexts(target, date, v.sig, v.offset); }
      catch (e: any) { process.stderr.write(`  [${target.symbol}] ${date} ${v.label}: ${e.message}\n`); continue; }
      const slot = out.perSignal[v.label];
      slot.contextCount += ctxs.length;
      if (!ctxs.length) continue;
      const grid = grids[v.label] || [];
      for (const g of grid) {
        const key = `${g.tp}|${g.sl}`;
        if (emitTrades) {
          const { stat: s, trades } = simulateWithTrades(ctxs, g.tp, g.sl, date);
          const cell = slot.cells[key] || (slot.cells[key] = { trades: 0, wins: 0, pnl: 0, daysWithTrade: 0, profitDays: 0 });
          if (s.trades > 0) {
            cell.trades += s.trades; cell.wins += s.wins; cell.pnl += s.pnl;
            cell.daysWithTrade += 1; if (s.pnl > 0) cell.profitDays += 1;
          }
          // Only one (tp,sl) per variant is meaningful when emitTrades=true
          // (the fixed-configs path). Stitch trades onto the variant slot.
          slot.trades!.push(...trades);
        } else {
          const s = simulate(ctxs, g.tp, g.sl);
          const cell = slot.cells[key] || (slot.cells[key] = { trades: 0, wins: 0, pnl: 0, daysWithTrade: 0, profitDays: 0 });
          if (s.trades > 0) {
            cell.trades += s.trades; cell.wins += s.wins; cell.pnl += s.pnl;
            cell.daysWithTrade += 1; if (s.pnl > 0) cell.profitDays += 1;
          }
        }
      }
    }
    if (++di % 10 === 0) process.stderr.write(`  [shard ${process.env.STUDY_SHARD ?? '?'} ${target.symbol}] ${di}/${dates.length}\n`);
  }
  return out;
}

interface Row { tp: number; sl: number; trades: number; wins: number; winRate: number; pnl: number; avgPnl: number; daysWithTrade: number; profitDays: number; }
function cellToRow(tp: number, sl: number, c: CellAgg): Row {
  return {
    tp, sl,
    trades: c.trades, wins: c.wins,
    winRate: c.trades > 0 ? c.wins / c.trades : 0,
    pnl: +c.pnl.toFixed(2),
    avgPnl: c.trades > 0 ? +(c.pnl / c.trades).toFixed(2) : 0,
    daysWithTrade: c.daysWithTrade, profitDays: c.profitDays,
  };
}
function mergeShards(shards: ShardResult[]): { perSignal: { [label: string]: { contextCount: number; cells: { [k: string]: CellAgg }; trades?: TradeRow[] } }, dates: string[] } {
  const perSignal: { [label: string]: { contextCount: number; cells: { [k: string]: CellAgg }; trades?: TradeRow[] } } = {};
  const dates: string[] = [];
  for (const sh of shards) {
    for (const d of sh.dates) dates.push(d);
    for (const label of Object.keys(sh.perSignal)) {
      const slot = perSignal[label] || (perSignal[label] = { contextCount: 0, cells: {} });
      slot.contextCount += sh.perSignal[label].contextCount;
      for (const [k, cell] of Object.entries(sh.perSignal[label].cells)) {
        const acc = slot.cells[k] || (slot.cells[k] = { trades: 0, wins: 0, pnl: 0, daysWithTrade: 0, profitDays: 0 });
        acc.trades += cell.trades;
        acc.wins += cell.wins;
        acc.pnl += cell.pnl;
        acc.daysWithTrade += cell.daysWithTrade;
        acc.profitDays += cell.profitDays;
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

function dispatchShards(target: SymbolTarget, dates: string[], grids: { [label: string]: { tp: number; sl: number }[] }, variants: Variant[], workers: number, emitTrades: boolean = false): Promise<ShardResult[]> {
  if (!dates.length) return Promise.resolve([]);
  const W = Math.max(1, Math.min(workers, dates.length));
  // Round-robin shard so each worker gets a similar mix of high/low-volume days.
  const shards: string[][] = Array.from({ length: W }, () => []);
  dates.forEach((d, i) => shards[i % W].push(d));

  // sig is not IPC-serializable cleanly; ship sigLabel + offset and re-hydrate.
  const wireVariants = variants.map(v => ({ label: v.label, sigLabel: v.sig.label, offset: v.offset }));

  return Promise.all(shards.map((shardDates, idx) => new Promise<ShardResult>((resolve, reject) => {
    if (!shardDates.length) {
      resolve({ symbol: target.symbol, dates: [], perSignal: Object.fromEntries(variants.map(v => [v.label, { contextCount: 0, cells: {} }])) });
      return;
    }
    // Forward gate overrides to the child so its module-level constants match
    // the parent's. Without this, workers default to 9:30-12:00 and silently
    // truncate any --gate-end past noon (bit me in smoke testing).
    const childArgs: string[] = [];
    if (GATE_START_OVR) childArgs.push('--gate-start', GATE_START_OVR);
    if (GATE_END_OVR)   childArgs.push('--gate-end',   GATE_END_OVR);
    const child = fork(__filename, childArgs, { env: { ...process.env, STUDY_SHARD_MODE: '1', STUDY_SHARD: String(idx) }, silent: false });
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
      const shards = await dispatchShards(target, allDates, cellsByLabel, variants, WORKERS, EMIT_TRADES);
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

    const shards1 = await dispatchShards(target, allDates, coarseGrids, variants, WORKERS);
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
      symOut.signals[v.label] = { contextCount: ctxCount, coarse: coarseRows, topCoarse: topC, refine: [], topRefine: [] };
    }

    const hasRefine = Object.values(refineGrids).some(g => g.length > 0);
    if (hasRefine) {
      const refineCombos = Object.values(refineGrids).reduce((s, g) => s + g.length, 0);
      console.log(`\n[${symbol}] pass2 (refine) — ${refineCombos} total TP/SL combos across ${variants.length} variants`);
      const t1 = Date.now();
      const shards2 = await dispatchShards(target, allDates, refineGrids, variants, WORKERS);
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

  const outFile = OUT_PATH
    ? (path.isAbsolute(OUT_PATH) ? OUT_PATH : path.join(process.cwd(), OUT_PATH))
    : path.join(process.cwd(), 'scripts/autoresearch/output/hma3m-tpsl-study.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n✓ wrote ${outFile}`);
}
