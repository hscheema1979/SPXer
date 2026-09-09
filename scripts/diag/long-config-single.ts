/**
 * long-config-single.ts — run ONE long-options config across the full date set
 * and append a single row to long-sweep-<ticker>.json in the same schema
 * hma3m-to-dashboard.ts emits. Triggered on-demand from the spxer-studio
 * Backtest page so users can test arbitrary (signal × offset × TP × SL × window)
 * tuples without regenerating the 18MB hma3m matrix.
 *
 * The trading math is a faithful port of hma3m-tpsl-study.ts::buildContexts()
 * + simulate(), kept byte-for-byte identical so parity verification against an
 * existing long-sweep-spxhma row produces matching pnl/wr/n on overlapping
 * dates (feedback_cross_engine_friction_parity).
 *
 *   npx tsx scripts/diag/long-config-single.ts \
 *     --symbol SPX --tf 3 --fast 3 --slow 12 \
 *     --offset -25 --tp 25 --sl 20 \
 *     --gate-start 09:30 --gate-end 16:00 \
 *     --ticker spxhma   [--dates 2025-01-02,2025-01-03,...]
 *
 * Without --dates, runs every parquet date listed by listDatesFor().
 * Appends/dedups by configId in scripts/autoresearch/output/long-sweep-<ticker>.json.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
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
const OFFSET = parseInt(argVal('--offset', '0'), 10);   // strikes, neg = ITM
const TP_PCT = parseInt(argVal('--tp', '25'), 10);
const SL_PCT = parseInt(argVal('--sl', '20'), 10);
const GATE_START = argVal('--gate-start', '09:30');
const GATE_END = argVal('--gate-end', '16:00');
const TICKER = argVal('--ticker', 'spxhma');
const DATES_OVR = argVal('--dates', '');
// Moving-average kind for the cross: 'hma' (default, preserves parity with the
// hma3m study) or 'dema'. Mirrors the optionx engine's signal.maType.
// MA kind for the cross. hma/dema were the original pair (parity with the
// hma3m study); ema/sma/wma were added so the Lab's indicator menu means the
// same thing for options as it does for shares — before that an option spec
// silently ran HMA no matter what the dialog said.
const MA_KINDS = ['hma', 'dema', 'ema', 'sma', 'wma'] as const;
type MaKind = typeof MA_KINDS[number];
const SIGNAL: MaKind = (() => {
  const raw = argVal('--signal', 'hma').toLowerCase();
  return (MA_KINDS as readonly string[]).includes(raw) ? (raw as MaKind) : 'hma';
})();

// ── Filters (verbatim from hma3m-tpsl-study) ────────────────────────────────
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
// DEMA = 2·EMA(p) − EMA(EMA(p)), SMA-seeded — verbatim port of long-config-sweep.ts
// (and algorithmically identical to the optionx engine's computeDEMA).
function demaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  function dema(p: number): number | null {
    if (closes.length < p) return null;
    const a = 2 / (p + 1);
    let e1 = 0;
    for (let i = 0; i < p; i++) e1 += closes[i];
    e1 /= p;
    const e1s: number[] = [e1];
    for (let i = p; i < closes.length; i++) { e1 = a * closes[i] + (1 - a) * e1; e1s.push(e1) }
    if (e1s.length < p) return null;
    let e2 = 0;
    for (let i = 0; i < p; i++) e2 += e1s[i];
    e2 /= p;
    for (let i = p; i < e1s.length; i++) { e2 = a * e1s[i] + (1 - a) * e2 }
    return 2 * e1s[e1s.length - 1] - e2;
  }
  const f = dema(fast), s = dema(slow);
  if (f == null || s == null) return null;
  return f > s ? 'bull' : 'bear';
}
/** Plain EMA, SMA-seeded — the same seeding demaDir uses for its first pass. */
function ema(closes: number[], p: number): number | null {
  if (closes.length < p) return null;
  const a = 2 / (p + 1);
  let e = 0;
  for (let i = 0; i < p; i++) e += closes[i];
  e /= p;
  for (let i = p; i < closes.length; i++) e = a * closes[i] + (1 - a) * e;
  return e;
}
function emaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const f = ema(closes, fast), s = ema(closes, slow);
  if (f == null || s == null) return null;
  return f > s ? 'bull' : 'bear';
}
function sma(closes: number[], p: number): number | null {
  if (closes.length < p) return null;
  let t = 0;
  for (let i = closes.length - p; i < closes.length; i++) t += closes[i];
  return t / p;
}
function smaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const f = sma(closes, fast), s = sma(closes, slow);
  if (f == null || s == null) return null;
  return f > s ? 'bull' : 'bear';
}
function wmaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const f = wma(closes, closes.length - 1, fast), s = wma(closes, closes.length - 1, slow);
  if (f == null || s == null) return null;
  return f > s ? 'bull' : 'bear';
}

function getDir(st: TFState, fast: number, slow: number): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  const closes = bars.map((b: any) => b.close);
  switch (SIGNAL) {
    case 'dema': return demaDir(closes, fast, slow);
    case 'ema': return emaDir(closes, fast, slow);
    case 'sma': return smaDir(closes, fast, slow);
    case 'wma': return wmaDir(closes, fast, slow);
    default: return hmaDir(closes, fast, slow);
  }
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
function dirAtOrBefore(m: Map<number, 'bull' | 'bear' | null>, ts: number): 'bull' | 'bear' | null {
  let bestTs = -Infinity, bestVal: 'bull' | 'bear' | null = null;
  m.forEach((v, t) => { if (t <= ts && t > bestTs) { bestTs = t; bestVal = v; } });
  return bestVal;
}
/** Exact HH:MM ET for a trade-log row (etBucketOf rounds to the half hour). */
function etOf(ts: number): string {
  return new Date(ts * 1000).toLocaleString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function etBucketOf(ts: number): string {
  const d = new Date(ts * 1000);
  const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const m = parts.match(/(\d{2}):(\d{2})/);
  if (!m) return '0000';
  const hh = m[1].padStart(2, '0');
  const mm = +m[2] < 30 ? '00' : '30';
  return `${hh}${mm}`;
}

// ── Trade context build (verbatim port) ─────────────────────────────────────
interface TradeCtx {
  dir: 'bull' | 'bear';
  entryTs: number;
  entryPx: number;
  bars: any[];
  eod: number;
  reverseTs: number;
  strike: number;
  symbol: string;   // OCC contract actually traded — the log has to name it
}
function buildContexts(target: SymbolTarget, date: string, tf: number, fast: number, slow: number, offsetStrikes: number): TradeCtx[] {
  const c1 = loadDay(target, date, '1m');
  if (!c1?.spxBars?.length) return [];
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
      if ((b.ts - bullCross) / 60 <= CROSS_WIN) {
        entries.push({ dir: 'bull', entryTs: b.ts + 60 });
        bullFired = true;
      }
    }
    if (d === 'bear' && bearStreak >= MIN_ALIGN && !bearFired && bearCross > 0) {
      if ((b.ts - bearCross) / 60 <= CROSS_WIN) {
        entries.push({ dir: 'bear', entryTs: b.ts + 60 });
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

    const cDir = new Map<number, 'bull' | 'bear' | null>();
    const cst = mkSt();
    for (const b of bars) { feed(cst, b, tf); cDir.set(b.ts, getDir(cst, fast, slow)); }
    if (dirAtOrBefore(cDir, e.entryTs - 1) !== 'bull') continue;

    const entryPx = optPx(bars, e.entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE) continue;
    if (cumVol(bars, sess, e.entryTs) < MIN_VOL) continue;

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

    ctxs.push({ dir: e.dir, entryTs: e.entryTs, entryPx, bars, eod, reverseTs, strike, symbol: sym });
  }
  return ctxs;
}

// ── Simulate one TP/SL cell ─────────────────────────────────────────────────
interface HourBucket { pnl: number; n: number; wins: number }
/** One row per fill — what the run actually did, so a result can be checked. */
export interface TradeLogRow {
  date: string;
  dir: 'bull' | 'bear';
  side: 'C' | 'P';
  symbol: string;      // OCC contract traded
  strike: number;
  entryET: string;
  exitET: string;
  holdMin: number;
  entryPx: number;
  exitPx: number;
  pnl: number;         // dollars, 1 contract (x100)
  retPct: number;
  reason: 'TP' | 'SL' | 'reverse' | 'EOD';
}
interface DayStat { pnl: number; wins: number; trades: number; entryPxSum: number; hourly: { [hr: string]: HourBucket }; log: TradeLogRow[] }
function simulateDay(ctxs: TradeCtx[], tpPct: number, slPct: number, date = ''): DayStat {
  const s: DayStat = { pnl: 0, wins: 0, trades: 0, entryPxSum: 0, hourly: {}, log: [] };
  for (const ctx of ctxs) {
    const tp = ctx.entryPx * (1 + tpPct / 100);
    const sl = slPct > 0 ? ctx.entryPx * (1 - slPct / 100) : 0;
    const stopTs = Math.min(ctx.reverseTs, ctx.eod);
    let exitPx = optPx(ctx.bars, stopTs) ?? ctx.entryPx;
    let exitTs = stopTs;
    let reason: TradeLogRow['reason'] = stopTs < ctx.eod ? 'reverse' : 'EOD';
    for (const b of ctx.bars) {
      if (b.ts <= ctx.entryTs) continue;
      if (b.ts > stopTs) break;
      if (b.high >= tp) { exitPx = tp; exitTs = b.ts; reason = 'TP'; break; }
      if (sl > 0 && b.low <= sl) { exitPx = sl; exitTs = b.ts; reason = 'SL'; break; }
    }
    const retPct = ((exitPx - ctx.entryPx) / ctx.entryPx) * 100;
    const tradePnl = (exitPx - ctx.entryPx) * 100;
    s.log.push({
      date,
      dir: ctx.dir,
      side: ctx.symbol[10] === 'P' ? 'P' : 'C',
      symbol: ctx.symbol,
      strike: ctx.strike,
      entryET: etOf(ctx.entryTs),
      exitET: etOf(exitTs),
      holdMin: Math.max(0, Math.round((exitTs - ctx.entryTs) / 60)),
      entryPx: +ctx.entryPx.toFixed(2),
      exitPx: +exitPx.toFixed(2),
      pnl: +tradePnl.toFixed(2),
      retPct: +retPct.toFixed(1),
      reason,
    });
    s.trades++;
    s.pnl += tradePnl;
    s.entryPxSum += ctx.entryPx;
    const hr = etBucketOf(ctx.entryTs);
    const hb = s.hourly[hr] || (s.hourly[hr] = { pnl: 0, n: 0, wins: 0 });
    hb.pnl += tradePnl; hb.n += 1;
    if (retPct > 0) { s.wins++; hb.wins += 1; }
  }
  return s;
}

// ── ConfigId formatter (mirrors hma3m-to-dashboard) ─────────────────────────
function offsetTag(off: number): string {
  if (off === 0) return 'ATM';
  return off < 0 ? `${Math.abs(off)}ITM` : `${off}OTM`;
}
function tfClassFromTf(tf: number, isMulti: boolean): string {
  return isMulti ? `${tf}m+` : `${tf}m`;
}
function windowTag(): string {
  return `${GATE_START.replace(':', '')}${GATE_END.replace(':', '')}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
function main() {
  const dates = DATES_OVR
    ? DATES_OVR.split(',').map(s => s.trim()).filter(Boolean)
    : listDatesFor(TARGET);
  process.stderr.write(`long-config-single — symbol=${TARGET.symbol} tf=${TF} ${FAST}x${SLOW} offset=${OFFSET} tp=${TP_PCT} sl=${SL_PCT} window=${GATE_START}-${GATE_END} dates=${dates.length}\n`);

  let totalTrades = 0, totalWins = 0, totalPnl = 0, daysWithTrade = 0, profitDays = 0;
  const tradeLog: TradeLogRow[] = [];
  let entryPxSum = 0;
  const dailyPnl: { [date: string]: number } = {};
  const hourly: { [hr: string]: HourBucket } = {};

  let di = 0;
  for (const date of dates) {
    let ctxs: TradeCtx[] = [];
    try { ctxs = buildContexts(TARGET, date, TF, FAST, SLOW, OFFSET); }
    catch (e: any) { process.stderr.write(`  ${date}: ${e.message}\n`); continue; }
    if (!ctxs.length) { di++; continue; }
    const s = simulateDay(ctxs, TP_PCT, SL_PCT, date);
    tradeLog.push(...s.log);
    if (s.trades === 0) { di++; continue; }
    totalTrades += s.trades;
    totalWins += s.wins;
    totalPnl += s.pnl;
    entryPxSum += s.entryPxSum;
    daysWithTrade++;
    if (s.pnl > 0) profitDays++;
    dailyPnl[date] = +s.pnl.toFixed(2);
    for (const [hr, hb] of Object.entries(s.hourly)) {
      const acc = hourly[hr] || (hourly[hr] = { pnl: 0, n: 0, wins: 0 });
      acc.pnl += hb.pnl; acc.n += hb.n; acc.wins += hb.wins;
    }
    if (++di % 25 === 0) process.stderr.write(`  ${di}/${dates.length} ${date}\n`);
  }

  // Drawdown over the per-date equity curve.
  const sortedDates = Object.keys(dailyPnl).sort();
  let cum = 0, peak = 0, dd = 0;
  for (const d of sortedDates) {
    cum += dailyPnl[d];
    if (cum > peak) peak = cum;
    const v = peak - cum;
    if (v > dd) dd = v;
  }

  const losses = totalTrades - totalWins;
  const wr = totalTrades > 0 ? +((totalWins / totalTrades) * 100).toFixed(2) : 0;
  const avgPnl = totalTrades > 0 ? +(totalPnl / totalTrades).toFixed(2) : 0;
  const negDays = daysWithTrade - profitDays;
  const ddPos = +dd.toFixed(2);
  const ratio = ddPos > 0 ? +(totalPnl / ddPos).toFixed(2) : 0;
  const profitFactor = losses > 0 ? +(totalWins / losses).toFixed(3) : 0;
  const avgEntryPx = totalTrades > 0 ? +(entryPxSum / totalTrades).toFixed(2) : 0;

  // Signal label includes the window (matches hma3m-to-dashboard convention so
  // morning vs full-day rows are distinguishable in the dashboard table).
  const sigBase = `${SIGNAL.toUpperCase()} ${TF}m ${FAST}x${SLOW}`;
  const dashSignal = `${sigBase} ${GATE_START}-${GATE_END}`;
  const money = offsetTag(OFFSET);
  // Match the configId convention emitted by hma3m-to-dashboard.ts so re-running
  // an existing row dedups by id instead of appending a duplicate. The MA kind
  // prefixes the id so DEMA rows never collide with HMA rows of the same shape.
  // Shape: {ma}{tf}m-{sym}-{fast}x{slow}-{money}-tp{T}-sl{S}-w{HHMMHHMM}
  const configId = `${SIGNAL}${TF}m-${TARGET.symbol.toLowerCase()}-${FAST}x${SLOW}-${money.toLowerCase()}-tp${TP_PCT}-sl${SL_PCT}-w${windowTag()}`;

  const row = {
    source: 'long',
    configId,
    symbol: TARGET.symbol,
    signal: dashSignal,
    spread: `long ${money}`,
    exit: `TP${TP_PCT}/SL${SL_PCT}`,
    tp: TP_PCT,
    sl: SL_PCT,
    offset: OFFSET,
    moneyness: money,
    maType: SIGNAL.toUpperCase(),
    tfClass: tfClassFromTf(TF, false),
    pnl: +totalPnl.toFixed(2),
    pnlPct: 0,
    n: totalTrades,
    wins: totalWins,
    losses,
    wr,
    dd: ddPos,
    ratio,
    sharpe: 0,
    profitFactor,
    expectancy: +avgPnl.toFixed(3),
    posDays: profitDays,
    negDays,
    pos: profitDays,
    worstDay: 0,
    bestDay: 0,
    avgCredit: 0,
    avgMaxRisk: 0,
    avgPnlPerTrade: avgPnl,
    avgDurMin: 0,
    numActiveDays: daysWithTrade,
    hourlyPnl: hourly,
    avgEntryPx,
  };

  // Append/dedup-by-configId to long-sweep-<ticker>.json.
  const OUT_DIR = path.join(process.cwd(), 'scripts/autoresearch/output');
  const outFile = path.join(OUT_DIR, `long-sweep-${TICKER}.json`);
  let existing: any[] = [];
  if (fs.existsSync(outFile)) {
    try { existing = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
    if (!Array.isArray(existing)) existing = [];
  }
  const filtered = existing.filter(r => r?.configId !== configId);
  filtered.push(row);
  fs.writeFileSync(outFile, JSON.stringify(filtered, null, 2));
  process.stderr.write(`✓ wrote row to ${outFile} (configId=${configId})\n`);

  // --json-out <path>: the full artifact — summary row PLUS every fill, so a
  // run can be checked line by line (which contract, in at what, out at what,
  // why). The shares engine already emits one; long-option had none, which is
  // why a Lab option run had no trade log to inspect.
  const jsonOut = argVal('--json-out', '');
  if (jsonOut) {
    try {
      fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
      fs.writeFileSync(jsonOut, JSON.stringify({
        configId,
        symbol: TARGET.symbol,
        profileId: TARGET.profileId,
        params: {
          tf: TF, fast: FAST, slow: SLOW, offset: OFFSET, signal: SIGNAL,
          tpPct: TP_PCT, slPct: SL_PCT, gateStart: GATE_START, gateEnd: GATE_END,
          dates: dates.length, firstDate: dates[0], lastDate: dates[dates.length - 1],
        },
        row,
        trades: tradeLog,
      }, null, 2));
      process.stderr.write(`✓ wrote artifact ${jsonOut} (${tradeLog.length} trades)\n`);
    } catch (e: any) {
      process.stderr.write(`! json-out failed: ${e.message}\n`);
    }
  }
  process.stderr.write(`  trades=${totalTrades} wr=${wr}% pnl=$${totalPnl.toFixed(0)} dd=$${ddPos.toFixed(0)} ratio=${ratio}\n`);

  // ── long-daily-<ticker>.json: per-variant per-date P&L series ───────────────
  // Powers the Equity, Daily Heatmap, Coverage, Regime, Correlation tabs. The
  // file's `dates` array is the union across all existing variants; each
  // series is aligned to it. We INTERSECT the new variant with the existing
  // `dates` array — date-range mismatches drop silently rather than mutate the
  // shared dates list (keeps other variants' series stable, avoids the
  // "purge before regen" pitfall noted in memory).
  // Key shape mirrors hma3m-to-dashboard.ts:354 — `long::${signal}::${money}::TP${tp}/SL${sl}`
  // (also matches variantKey() in spxer-studio components/spreads/utils.ts).
  const variantKey = `long::${dashSignal}::${money}::TP${TP_PCT}/SL${SL_PCT}`;
  const dailyFile = path.join(OUT_DIR, `long-daily-${TICKER}.json`);
  let dailyBlob: { dates: string[]; series: { [k: string]: number[] } } = { dates: [], series: {} };
  if (fs.existsSync(dailyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
      if (parsed && Array.isArray(parsed.dates) && parsed.series && typeof parsed.series === 'object') {
        dailyBlob = parsed;
      }
    } catch {}
  }
  if (!dailyBlob.dates.length) {
    // No existing file (or empty): seed with this variant's dates.
    dailyBlob.dates = Object.keys(dailyPnl).sort();
    dailyBlob.series[variantKey] = dailyBlob.dates.map(d => +(dailyPnl[d] ?? 0).toFixed(2));
  } else {
    // Intersect: only write values for dates already in the file. Dates this
    // variant has but the file doesn't are dropped (logged for visibility).
    const fileDateSet = new Set(dailyBlob.dates);
    const variantDates = Object.keys(dailyPnl);
    const matched = variantDates.filter(d => fileDateSet.has(d));
    const dropped = variantDates.length - matched.length;
    dailyBlob.series[variantKey] = dailyBlob.dates.map(d => +(dailyPnl[d] ?? 0).toFixed(2));
    if (dropped > 0) {
      process.stderr.write(`  ⚠ long-daily intersect: dropped ${dropped} variant dates not present in ${path.basename(dailyFile)}\n`);
    }
  }
  fs.writeFileSync(dailyFile, JSON.stringify(dailyBlob));
  process.stderr.write(`✓ wrote daily series to ${dailyFile} (variantKey=${variantKey})\n`);

  // Print configId to stdout so the API can echo it back to the UI.
  process.stdout.write(JSON.stringify({ configId, row }) + '\n');
}

main();
