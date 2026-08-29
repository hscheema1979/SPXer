/**
 * long-flip-poc.ts — proof-of-concept backtest for long-contract HMA configs
 * with two flip behaviors on stop-loss:
 *
 *   mode=none       baseline — SL just exits (matches long-config-single.ts)
 *   mode=flipOnSL   on SL: open OPPOSITE-side contract (re-picked from current
 *                   SPX with the same offset). Continues flipping until TP,
 *                   signal reversal, or EOD.
 *   mode=reenterSL  on SL: if SPX HMA direction at SL time is still the
 *                   ORIGINAL direction, re-enter SAME side (re-picked from
 *                   current SPX) on the next candle. Continues until TP,
 *                   signal reversal, HMA flip at SL time, or EOD.
 *
 * Position math (entry strike pick, HMA detection, MIN_ALIGN/CROSS_WIN/
 * MIN_PRICE/MIN_VOL filters, contract-HMA bull gate) is a byte-faithful port
 * of long-config-single.ts buildContexts() so baseline parity holds.
 *
 *   npx tsx scripts/diag/long-flip-poc.ts \
 *     --symbol SPX --tf 3 --fast 3 --slow 12 \
 *     --offset 0 --tp 25 --sl 20 \
 *     --gate-start 09:30 --gate-end 16:00 \
 *     --days 60
 *
 * Prints a side-by-side summary (trades, wr%, pnl, dd, ratio) for all three
 * modes — no JSON output, this is a quick POC for visual comparison.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay, SymbolTarget } from './sweep-symbol';

// ── CLI ─────────────────────────────────────────────────────────────────────
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const TARGET = resolveSymbolTarget(process.argv);
const TF = parseInt(argVal('--tf', '3'), 10);
const FAST = parseInt(argVal('--fast', '3'), 10);
const SLOW = parseInt(argVal('--slow', '12'), 10);
const OFFSET = parseInt(argVal('--offset', '0'), 10);
const TP_PCT = parseInt(argVal('--tp', '25'), 10);
const SL_PCT = parseInt(argVal('--sl', '20'), 10);
const GATE_START = argVal('--gate-start', '09:30');
const GATE_END = argVal('--gate-end', '16:00');
const DAYS = parseInt(argVal('--days', '60'), 10);

// ── Filters (verbatim from long-config-single) ──────────────────────────────
const MIN_ALIGN = 3, CROSS_WIN = 60, MIN_PRICE = 0.20, MIN_VOL = 100;
function hhmmToMin(s: string, def: number): number {
  const m = s.match(/^(\d{1,2}):(\d{2})$/); if (!m) return def;
  return Number(m[1]) * 60 + Number(m[2]);
}
const GATE_START_HHMM = hhmmToMin(GATE_START, 9 * 60 + 30);
const GATE_END_HHMM = hhmmToMin(GATE_END, 16 * 60);

// ── Helpers (verbatim) ──────────────────────────────────────────────────────
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

// ── Entry detection: returns initial bull/bear entry timestamps + SPX dir map
interface EntrySeed { dir: 'bull' | 'bear'; entryTs: number }
interface DayCtx {
  c1: any; s1: any[]; sess: number; eod: number;
  gateStartTs: number; gateEndTs: number;
  dirAt: Map<number, 'bull' | 'bear' | null>;
  entries: EntrySeed[];
}
function buildDayCtx(target: SymbolTarget, date: string, tf: number, fast: number, slow: number): DayCtx | null {
  const c1 = loadDay(target, date, '1m');
  if (!c1?.spxBars?.length) return null;
  const p1 = loadDay(target, prevDate(date), '1m');
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  const eod = sess + 6.5 * 3600;
  const gateStartTs = sess + (GATE_START_HHMM - (9 * 60 + 30)) * 60;
  const gateEndTs = sess + (GATE_END_HHMM - (9 * 60 + 30)) * 60;

  const st = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(st, b, tf);

  const prevDir: { v: 'bull' | 'bear' | null } = { v: null };
  let bullCross = 0, bearCross = 0;
  const dirAt = new Map<number, 'bull' | 'bear' | null>();
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
  const entries: EntrySeed[] = [];

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
  return { c1, s1, sess, eod, gateStartTs, gateEndTs, dirAt, entries };
}

function dirAtOrBefore(m: Map<number, 'bull' | 'bear' | null>, ts: number): 'bull' | 'bear' | null {
  let bestTs = -Infinity, bestVal: 'bull' | 'bear' | null = null;
  m.forEach((v, t) => { if (t <= ts && t > bestTs) { bestTs = t; bestVal = v; } });
  return bestVal;
}

// ── Leg simulator: open one position, return { exitPx, exitTs, reason } ─────
type ExitReason = 'tp' | 'sl' | 'reverse' | 'eod';
interface LegResult { entryPx: number; exitPx: number; entryTs: number; exitTs: number; reason: ExitReason; side: 'C' | 'P'; }

function openLeg(
  ctx: DayCtx, target: SymbolTarget, side: 'C' | 'P', origDir: 'bull' | 'bear',
  openTs: number,
): LegResult | null {
  if (openTs >= ctx.eod) return null;
  const spxRef = optPx(ctx.s1, openTs - 1);
  if (!spxRef) return null;
  const sym = findStrikeAtSpot(ctx.c1, side, spxRef, target.strikeInterval, OFFSET);
  if (!sym) return null;
  const bars = ctx.c1.contractBars.get(sym) as any[];
  if (!bars?.length) return null;
  const entryPx = optPx(bars, openTs - 1);
  if (!entryPx || entryPx < MIN_PRICE) return null;
  if (cumVol(bars, ctx.sess, openTs) < MIN_VOL) return null;

  const tp = entryPx * (1 + TP_PCT / 100);
  const sl = SL_PCT > 0 ? entryPx * (1 - SL_PCT / 100) : 0;

  // Walk forward minute-by-minute, checking SPX HMA reverse vs. origDir at each
  // minute and TP/SL on the contract bars covering that minute.
  let exitPx: number = entryPx, exitTs: number = ctx.eod, reason: ExitReason = 'eod';
  let bi = 0;
  // advance bi to first bar after openTs
  while (bi < bars.length && bars[bi].ts <= openTs) bi++;

  for (let t = openTs; t <= ctx.eod; t += 60) {
    const spxd = ctx.dirAt.get(t) ?? null;
    const reverse = (origDir === 'bull' && spxd === 'bear') || (origDir === 'bear' && spxd === 'bull');
    if (reverse) {
      // exit at end of this minute on the contract
      const px = optPx(bars, t + 60 - 1) ?? exitPx;
      exitPx = px; exitTs = t + 60; reason = 'reverse'; break;
    }
    // check tp/sl on bars whose ts falls in (openTs, t+60]
    while (bi < bars.length && bars[bi].ts <= t + 60 - 1) {
      const b = bars[bi];
      if (b.high >= tp) { exitPx = tp; exitTs = b.ts; reason = 'tp'; t = ctx.eod + 1; break; }
      if (sl > 0 && b.low <= sl) { exitPx = sl; exitTs = b.ts; reason = 'sl'; t = ctx.eod + 1; break; }
      bi++;
    }
    if (reason !== 'eod') break;
  }
  if (reason === 'eod') exitPx = optPx(bars, ctx.eod) ?? entryPx;
  return { entryPx, exitPx, entryTs: openTs, exitTs, reason, side };
}

// ── Mode runners ────────────────────────────────────────────────────────────
type Mode = 'none' | 'flipOnSL' | 'reenterSL';

function runEntryChain(ctx: DayCtx, target: SymbolTarget, seed: EntrySeed, mode: Mode): LegResult[] {
  const legs: LegResult[] = [];
  const origDir = seed.dir;
  let side: 'C' | 'P' = origDir === 'bull' ? 'C' : 'P';
  let openTs = seed.entryTs;
  // safety cap: at most 10 legs per seed
  for (let k = 0; k < 10; k++) {
    const leg = openLeg(ctx, target, side, origDir, openTs);
    if (!leg) break;
    legs.push(leg);
    if (leg.reason !== 'sl') break;
    if (mode === 'none') break;
    const nextTs = leg.exitTs + 60;
    if (nextTs >= ctx.eod) break;
    if (mode === 'flipOnSL') {
      side = side === 'C' ? 'P' : 'C';
      openTs = nextTs;
      continue;
    }
    if (mode === 'reenterSL') {
      const spxd = ctx.dirAt.get(Math.floor(leg.exitTs / 60) * 60) ?? dirAtOrBefore(ctx.dirAt, leg.exitTs);
      if (spxd !== origDir) break; // signal already flipped — let it go
      openTs = nextTs;
      continue;
    }
  }
  return legs;
}

// ── Aggregation ─────────────────────────────────────────────────────────────
interface Agg { trades: number; wins: number; pnl: number; dailyPnl: Map<string, number>; flips: number; }
function newAgg(): Agg { return { trades: 0, wins: 0, pnl: 0, dailyPnl: new Map(), flips: 0 }; }

function addLegs(agg: Agg, date: string, legs: LegResult[]) {
  if (legs.length > 1) agg.flips += legs.length - 1;
  let dayPnl = agg.dailyPnl.get(date) ?? 0;
  for (const l of legs) {
    const pnl = (l.exitPx - l.entryPx) * 100;
    agg.trades++;
    if (pnl > 0) agg.wins++;
    agg.pnl += pnl;
    dayPnl += pnl;
  }
  agg.dailyPnl.set(date, dayPnl);
}

function summarize(name: string, a: Agg) {
  const sortedDates = [...a.dailyPnl.keys()].sort();
  let cum = 0, peak = 0, dd = 0;
  for (const d of sortedDates) {
    cum += a.dailyPnl.get(d)!;
    if (cum > peak) peak = cum;
    const v = peak - cum;
    if (v > dd) dd = v;
  }
  const wr = a.trades > 0 ? (a.wins / a.trades) * 100 : 0;
  const ratio = dd > 0 ? a.pnl / dd : 0;
  const profitDays = sortedDates.filter(d => (a.dailyPnl.get(d) ?? 0) > 0).length;
  const tradeDays = sortedDates.filter(d => (a.dailyPnl.get(d) ?? 0) !== 0).length;
  return {
    name,
    trades: a.trades,
    flips: a.flips,
    wr: +wr.toFixed(2),
    pnl: +a.pnl.toFixed(2),
    dd: +dd.toFixed(2),
    ratio: +ratio.toFixed(2),
    profitDays,
    tradeDays,
    avgPnl: a.trades > 0 ? +(a.pnl / a.trades).toFixed(2) : 0,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const all = listDatesFor(TARGET);
  const dates = all.slice(-DAYS);
  process.stderr.write(`long-flip-poc — symbol=${TARGET.symbol} tf=${TF} ${FAST}x${SLOW} offset=${OFFSET} tp=${TP_PCT} sl=${SL_PCT} window=${GATE_START}-${GATE_END} dates=${dates.length} (last ${DAYS} of ${all.length})\n`);

  const aggs: Record<Mode, Agg> = { none: newAgg(), flipOnSL: newAgg(), reenterSL: newAgg() };

  let di = 0;
  for (const date of dates) {
    di++;
    let ctx: DayCtx | null = null;
    try { ctx = buildDayCtx(TARGET, date, TF, FAST, SLOW); }
    catch (e: any) { process.stderr.write(`  ${date}: ${e.message}\n`); continue; }
    if (!ctx || !ctx.entries.length) continue;
    // Filter entries to gate window + contract-HMA bull gate (mirrors original)
    for (const seed of ctx.entries) {
      if (seed.entryTs < ctx.gateStartTs || seed.entryTs >= ctx.gateEndTs) continue;
      // contract-HMA bull gate from original buildContexts
      const spxRef = optPx(ctx.s1, seed.entryTs - 1);
      if (!spxRef) continue;
      const type: 'C' | 'P' = seed.dir === 'bull' ? 'C' : 'P';
      const sym = findStrikeAtSpot(ctx.c1, type, spxRef, TARGET.strikeInterval, OFFSET);
      if (!sym) continue;
      const bars = ctx.c1.contractBars.get(sym) as any[];
      if (!bars?.length) continue;
      const cDir = new Map<number, 'bull' | 'bear' | null>();
      const cst = mkSt();
      for (const b of bars) { feed(cst, b, TF); cDir.set(b.ts, getDir(cst, FAST, SLOW)); }
      if (dirAtOrBefore(cDir, seed.entryTs - 1) !== 'bull') continue;

      for (const mode of ['none', 'flipOnSL', 'reenterSL'] as Mode[]) {
        const legs = runEntryChain(ctx, TARGET, seed, mode);
        addLegs(aggs[mode], date, legs);
      }
    }
    if (di % 10 === 0) process.stderr.write(`  ${di}/${dates.length} ${date}\n`);
  }

  const rows = [summarize('baseline (none)', aggs.none),
                summarize('flipOnSL',        aggs.flipOnSL),
                summarize('reenterSL',       aggs.reenterSL)];

  const pad = (s: any, n: number) => String(s).padStart(n);
  process.stdout.write(`\n${TARGET.symbol} HMA ${TF}m ${FAST}x${SLOW} offset=${OFFSET} TP${TP_PCT}/SL${SL_PCT} window=${GATE_START}-${GATE_END} — last ${dates.length} sessions\n`);
  process.stdout.write(`${'mode'.padEnd(18)} ${pad('trades',7)} ${pad('flips',6)} ${pad('wr%',7)} ${pad('pnl',10)} ${pad('dd',9)} ${pad('ratio',7)} ${pad('avg/tr',8)} ${pad('profitD',8)} ${pad('tradeD',7)}\n`);
  for (const r of rows) {
    process.stdout.write(
      `${r.name.padEnd(18)} ${pad(r.trades,7)} ${pad(r.flips,6)} ${pad(r.wr,7)} ${pad(r.pnl,10)} ${pad(r.dd,9)} ${pad(r.ratio,7)} ${pad(r.avgPnl,8)} ${pad(r.profitDays,8)} ${pad(r.tradeDays,7)}\n`,
    );
  }
  process.stdout.write(`\nNotes:\n  • baseline matches long-config-single.ts math (SL exits, no re-entry).\n  • flipOnSL: on SL, opens opposite-side contract re-picked from current SPX with same offset.\n  • reenterSL: on SL, re-enters same side from current SPX next candle if SPX HMA hasn't flipped.\n  • Both flip modes stop on TP, SPX HMA reversal, EOD, or after 10 legs (safety cap).\n`);
}

main();
