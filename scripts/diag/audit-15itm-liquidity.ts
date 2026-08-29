/**
 * audit-15itm-liquidity.ts — per-trade liquidity audit for the 15ITM long-call
 * variant. Re-runs the buildContexts() pass from long-config-single.ts but
 * captures the entry bar's volume, prior-minute volume, cumulative session
 * volume, time-of-day, and entry price for every trade. Reports distributions
 * so we can judge whether the row's $310k-style pnls are realistic when you
 * actually try to fill a contract.
 *
 *   npx tsx scripts/diag/audit-15itm-liquidity.ts \
 *     --symbol SPX --tf 3 --fast 3 --slow 12 --offset -15 \
 *     --gate-start 09:30 --gate-end 16:00
 *
 * Writes per-trade NDJSON to scripts/autoresearch/output/audit-15itm.ndjson
 * and prints a summary table to stderr.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, listDatesFor, loadDay, SymbolTarget } from './sweep-symbol';

function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const TARGET = resolveSymbolTarget(process.argv);
const TF = parseInt(argVal('--tf', '3'), 10);
const FAST = parseInt(argVal('--fast', '3'), 10);
const SLOW = parseInt(argVal('--slow', '12'), 10);
const OFFSET = parseInt(argVal('--offset', '-15'), 10);
const GATE_START = argVal('--gate-start', '09:30');
const GATE_END = argVal('--gate-end', '16:00');
const DATES_OVR = argVal('--dates', '');

const MIN_ALIGN = 3, CROSS_WIN = 60, MIN_PRICE = 0.20, MIN_VOL = 100;
function hhmmToMin(s: string, def: number): number {
  const m = s.match(/^(\d{1,2}):(\d{2})$/); if (!m) return def;
  return Number(m[1]) * 60 + Number(m[2]);
}
const GATE_START_HHMM = hhmmToMin(GATE_START, 9 * 60 + 30);
const GATE_END_HHMM = hhmmToMin(GATE_END, 16 * 60);

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
function barAtOrBefore(bars: any[], ts: number): any | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i];
  return null;
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
function dirAtOrBefore(m: Map<number, 'bull' | 'bear' | null>, ts: number): 'bull' | 'bear' | null {
  let bestTs = -Infinity, bestVal: 'bull' | 'bear' | null = null;
  m.forEach((v, t) => { if (t <= ts && t > bestTs) { bestTs = t; bestVal = v; } });
  return bestVal;
}
function etHourMin(ts: number): { hour: number; min: number; bucket: string } {
  const d = new Date(ts * 1000);
  const parts = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const m = parts.match(/(\d{2}):(\d{2})/);
  if (!m) return { hour: 0, min: 0, bucket: '0000' };
  const hh = +m[1], mm = +m[2];
  return { hour: hh, min: mm, bucket: `${String(hh).padStart(2, '0')}${mm < 30 ? '00' : '30'}` };
}

interface TradeAudit {
  date: string;
  entryTs: number;
  bucket: string;
  hour: number;
  min: number;
  dir: 'bull' | 'bear';
  type: 'C' | 'P';
  spxEntry: number;
  strike: number;
  entryPx: number;
  entryBarVol: number;      // volume on the bar containing the entry timestamp
  prevBarVol: number;       // volume on the 1m bar immediately before entry
  cumVolAtEntry: number;    // cumulative session volume up to entry
  cumVolFullDay: number;    // cumulative session volume for the whole day on this strike
  barCountTotal: number;    // total 1m bars present for this contract
  barCountWithVol: number;  // bars with volume > 0
}

function auditDay(target: SymbolTarget, date: string): TradeAudit[] {
  const c1 = loadDay(target, date, '1m');
  if (!c1?.spxBars?.length) return [];
  const p1 = loadDay(target, prevDate(date), '1m');
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date);
  const eod = sess + 6.5 * 3600;
  const gateStartTs = sess + (GATE_START_HHMM - (9 * 60 + 30)) * 60;
  const gateEndTs = sess + (GATE_END_HHMM - (9 * 60 + 30)) * 60;

  const st = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(st, b, TF);
  const prevDir: { v: 'bull' | 'bear' | null } = { v: null };
  let bullCross = 0, bearCross = 0;
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;
  const entries: { dir: 'bull' | 'bear'; entryTs: number }[] = [];

  for (const b of s1) {
    feed(st, b, TF);
    const d = getDir(st, FAST, SLOW);
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

  const audits: TradeAudit[] = [];
  for (const e of entries) {
    if (e.entryTs < gateStartTs || e.entryTs >= gateEndTs) continue;
    const spxEntry = optPx(s1, e.entryTs - 1); if (!spxEntry) continue;
    const type: 'C' | 'P' = e.dir === 'bull' ? 'C' : 'P';
    const sym = findStrikeAtSpot(c1, type, spxEntry, target.strikeInterval, OFFSET); if (!sym) continue;
    const bars = c1.contractBars.get(sym) as any[]; if (!bars?.length) continue;
    const strike = (c1.contractStrikes?.get(sym) ?? 0) as number;
    // Same contract-HMA bull gate as the engine. Required for the trade to count.
    const cDir = new Map<number, 'bull' | 'bear' | null>();
    const cst = mkSt();
    for (const b of bars) { feed(cst, b, TF); cDir.set(b.ts, getDir(cst, FAST, SLOW)); }
    if (dirAtOrBefore(cDir, e.entryTs - 1) !== 'bull') continue;
    const entryPx = optPx(bars, e.entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE) continue;
    const cv = cumVol(bars, sess, e.entryTs);
    if (cv < MIN_VOL) continue;

    const entryBar = barAtOrBefore(bars, e.entryTs);
    const prevBar = barAtOrBefore(bars, e.entryTs - 60);
    const fullDayVol = cumVol(bars, sess, eod);
    const barsWithVol = bars.filter(b => (b.volume ?? 0) > 0).length;
    const { hour, min, bucket } = etHourMin(e.entryTs);
    audits.push({
      date, entryTs: e.entryTs, bucket, hour, min,
      dir: e.dir, type, spxEntry, strike, entryPx,
      entryBarVol: entryBar?.volume ?? 0,
      prevBarVol: prevBar?.volume ?? 0,
      cumVolAtEntry: cv,
      cumVolFullDay: fullDayVol,
      barCountTotal: bars.length,
      barCountWithVol: barsWithVol,
    });
  }
  return audits;
}

function main() {
  const dates = DATES_OVR ? DATES_OVR.split(',').map(s => s.trim()).filter(Boolean) : listDatesFor(TARGET);
  process.stderr.write(`audit-15itm-liquidity — ${TARGET.symbol} ${TF}m ${FAST}x${SLOW} offset=${OFFSET} ${GATE_START}-${GATE_END} dates=${dates.length}\n`);

  const OUT = path.join(process.cwd(), 'scripts/autoresearch/output/audit-15itm.ndjson');
  fs.writeFileSync(OUT, '');
  const fd = fs.openSync(OUT, 'a');
  const all: TradeAudit[] = [];
  let di = 0;
  for (const date of dates) {
    let auds: TradeAudit[] = [];
    try { auds = auditDay(TARGET, date); } catch (e: any) { process.stderr.write(`  ${date}: ${e.message}\n`); continue; }
    for (const a of auds) fs.writeSync(fd, JSON.stringify(a) + '\n');
    all.push(...auds);
    if (++di % 25 === 0) process.stderr.write(`  ${di}/${dates.length} ${date}  (${all.length} trades so far)\n`);
  }
  fs.closeSync(fd);

  // ── Summary ────────────────────────────────────────────────────────────────
  const n = all.length;
  if (n === 0) { process.stderr.write('no trades\n'); return; }
  const pct = (x: number) => +(100 * x / n).toFixed(1);
  const numericPctiles = (vals: number[], ps: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    return ps.map(p => s[Math.min(s.length - 1, Math.floor(s.length * p))]);
  };

  const entryBarVols = all.map(a => a.entryBarVol);
  const prevBarVols = all.map(a => a.prevBarVol);
  const cumVols = all.map(a => a.cumVolAtEntry);
  const fullDayVols = all.map(a => a.cumVolFullDay);
  const entryPxs = all.map(a => a.entryPx);

  process.stderr.write('\n────────── 15ITM LIQUIDITY AUDIT ──────────\n');
  process.stderr.write(`total trades: ${n}\n`);
  process.stderr.write(`unique dates : ${new Set(all.map(a => a.date)).size}\n\n`);

  const showPct = (label: string, vals: number[]) => {
    const [p10, p25, p50, p75, p90, p95, p99] = numericPctiles(vals, [0.10, 0.25, 0.50, 0.75, 0.90, 0.95, 0.99]);
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    process.stderr.write(`${label.padEnd(28)} mean=${mean.toFixed(1).padStart(8)}  p10=${p10}  p25=${p25}  p50=${p50}  p75=${p75}  p90=${p90}  p95=${p95}  p99=${p99}\n`);
  };
  showPct('entry-BAR volume:', entryBarVols);
  showPct('prev-BAR volume:', prevBarVols);
  showPct('cumVol AT entry:', cumVols);
  showPct('cumVol FULL day:', fullDayVols);
  showPct('entry price ($):', entryPxs);

  process.stderr.write('\nthresholds — entry-bar volume:\n');
  const ranges = [
    ['= 0           (dead bar)', (v: number) => v === 0],
    ['1-9           (tiny)', (v: number) => v >= 1 && v <= 9],
    ['10-49         (light)', (v: number) => v >= 10 && v <= 49],
    ['50-99         (modest)', (v: number) => v >= 50 && v <= 99],
    ['100-499       (decent)', (v: number) => v >= 100 && v <= 499],
    ['500+          (good)', (v: number) => v >= 500],
  ] as const;
  for (const [lab, pred] of ranges) {
    const c = entryBarVols.filter(pred).length;
    process.stderr.write(`  ${lab.padEnd(28)} ${String(c).padStart(5)}  (${pct(c).toString().padStart(5)}%)\n`);
  }

  process.stderr.write('\ntime-of-day distribution:\n');
  const byBucket = new Map<string, number>();
  for (const a of all) byBucket.set(a.bucket, (byBucket.get(a.bucket) ?? 0) + 1);
  for (const k of [...byBucket.keys()].sort()) {
    const c = byBucket.get(k)!;
    process.stderr.write(`  ${k}  ${String(c).padStart(5)}  (${pct(c).toString().padStart(5)}%)\n`);
  }

  process.stderr.write(`\nNDJSON written to ${OUT}\n`);
}

main();
