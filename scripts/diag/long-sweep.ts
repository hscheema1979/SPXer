/**
 * long-sweep.ts — profile-aware long-options backtest.
 *
 * A FAITHFUL port of backtest-server.ts::runDay() (the "Backtest Studio" long
 * engine) made per-ticker via sweep-symbol, so the existing SPX long configs
 * (scripts/autoresearch/output/strategies.json, 69 of them) can be run against
 * SPY/QQQ-1DTE — instead of SPX long bleeding into every ticker's dashboard.
 *
 *   npx tsx scripts/diag/long-sweep.ts --symbol SPY --dte 1   [SWEEP_DAYS=N]
 *
 * Three (and only three) things differ from the SPX-hardwired original:
 *   1. C/P parse  : sym[10]      → sym[len-9]   (prefix-agnostic OCC root)
 *   2. bar load   : readBarCache → loadDay(TARGET) (profile bars + 1DTE expiry)
 *   3. moneyness  : $5/$10/$20 fixed → % of spot (SPX $X@~6000 ≡ same % on
 *                   SPY/QQQ), so an ETF long isn't snapped absurdly far OTM.
 * Everything else (signal detection, tiers, TP/SL%, reversal/EOD exits,
 * circuit-breaker, singlePos, maxTrades) is copied byte-for-byte.
 *
 * Output: last-run{suffix}.json (outPath-namespaced) in the SAME shape
 * /api/longs + /api/last-run consume. SPX (suffix '') is NOT regenerated here
 * — its legacy last-run.json stays; this engine is for the ETF/other profiles.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';

const TARGET = resolveSymbolTarget(process.argv);

// ── tunables (verbatim from backtest-server) ────────────────────────────────
const TP_PCT = 250, SL_PCT = 45;
const MIN_ALIGN = 3, MAX_ENTRY = 25, MIN_PRICE = 0.20, MIN_VOL = 100;
const CROSS_WIN = 60, CB_TRIGGER = 3, CB_SKIP = 1;
const FAST0 = 3, SLOW0 = 15;
// Moneyness: original was OTM_MIN/MID/MAX = $5/$10/$20 on SPX. Calibrate to a
// reference SPX level so the SAME % moneyness is applied on any underlying.
const SPX_REF = 6000;
const OTM_MIN_PCT = 5 / SPX_REF, OTM_MID_PCT = 10 / SPX_REF, OTM_MAX_PCT = 20 / SPX_REF;

// ── helpers (verbatim) ──────────────────────────────────────────────────────
function prevDate(d: string) { const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1); if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2); if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); }
function optPx(bars: any[], ts: number): number | null { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; }
function cumVol(bars: any[], from: number, to: number) { return bars.filter((b: any) => b.ts >= from && b.ts <= to).reduce((s: number, b: any) => s + (b.volume ?? 0), 0); }
function fmtET(ts: number) { const e = ts - 14400; return `${Math.floor(e / 3600) % 24}:${String(Math.floor((e % 3600) / 60)).padStart(2, '0')}`; }
function etToTs(sess: number, hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); return sess + ((h - 9) * 60 + (m - 30)) * 60; }
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
interface TFState { closed: any[]; partial: any | null }
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
function getDir(st: TFState, fast: number, slow: number, signal?: string): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  const closes = bars.map((b: any) => b.close);
  return signal === 'dema' ? demaDir(closes, fast, slow) : hmaDir(closes, fast, slow);
}
// FIX #1: OCC type char is always 9 from the end (SPXW/SPY/QQQ/NDXP), not [10].
function findOtm(c1: any, type: 'C' | 'P', target: number): string | null {
  let sym: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const k = c1.contractStrikes.get(s as string); const d = Math.abs(k - target); if ((s as string)[(s as string).length - 9] !== type) continue; if (d < bestD) { bestD = d; sym = s as string; } }
  return sym;
}

function runDay(date: string, strat: any, c1: any, p1: any) {
  const TP = strat.tp ?? TP_PCT, SL = strat.sl ?? SL_PCT;
  const MAXE = strat.maxEntry ?? MAX_ENTRY, MINP = strat.minPrice ?? MIN_PRICE;
  const SINGLE_POS: boolean = strat.singlePos ?? false;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), eod = sess + 6.5 * 3600, tradeStart = sess + 1800;
  const gateStartTs = Math.max(etToTs(sess, strat.gateStart ?? '10:00'), tradeStart);
  const gateEndTs = Math.min(etToTs(sess, strat.gateEnd ?? '15:30'), eod - 300);
  const orBars = s1.filter((b: any) => b.ts >= sess && b.ts < sess + 1800);
  const orH = orBars.length ? Math.max(...orBars.map((b: any) => b.high)) : 0;
  const orL = orBars.length ? Math.min(...orBars.map((b: any) => b.low)) : 0;
  const or15Bars = s1.filter((b: any) => b.ts >= sess && b.ts < sess + 900);
  const or15H = or15Bars.length ? +Math.max(...or15Bars.map((b: any) => b.high)).toFixed(0) : 0;
  const or15L = or15Bars.length ? +Math.min(...or15Bars.map((b: any) => b.low)).toFixed(0) : 0;
  const tradeBars = s1.filter((b: any) => b.ts >= tradeStart);
  const dayHigh = tradeBars.length ? +Math.max(...tradeBars.map((b: any) => b.high)).toFixed(0) : 0;
  const dayLow = tradeBars.length ? +Math.min(...tradeBars.map((b: any) => b.low)).toFixed(0) : 0;
  const spxOpen = Math.round(optPx(s1, tradeStart) ?? 0);
  const spxClose = Math.round(s1[s1.length - 1]?.close ?? 0);

  const st0 = mkSt(); const sts = strat.tfs.map(() => mkSt());
  for (const b of (p1?.spxBars ?? [])) { feed(st0, b, 1); sts.forEach((st: any, i: number) => feed(st, b, strat.tfs[i].tf)); }

  const prevDirs = strat.tfs.map(() => null as any);
  const bullCross = strat.tfs.map(() => 0), bearCross = strat.tfs.map(() => 0);
  const dirLog = new Map<number, any[]>();
  const entries: any[] = [];
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false, bullAlignStart = 0, bearAlignStart = 0;

  for (const b of s1) {
    feed(st0, b, 1); sts.forEach((st: any, i: number) => feed(st, b, strat.tfs[i].tf));
    if (b.ts < tradeStart) continue;
    const d0 = getDir(st0, FAST0, SLOW0, strat.signal);
    const dirs = sts.map((st: any, i: number) => getDir(st, strat.tfs[i].fast, strat.tfs[i].slow, strat.signal));
    dirLog.set(b.ts, dirs);
    dirs.forEach((d: any, i: number) => { if (prevDirs[i] !== null && d !== prevDirs[i]) { if (d === 'bull') bullCross[i] = b.ts; if (d === 'bear') bearCross[i] = b.ts; } prevDirs[i] = d; });
    const allBull = dirs.every((d: any) => d === 'bull'), allBear = dirs.every((d: any) => d === 'bear');
    if (allBull) { if (bullStreak === 0) bullAlignStart = b.ts; bullStreak++; bearStreak = 0; bearFired = false; } else { bullStreak = 0; bullFired = false; bullAlignStart = 0; }
    if (allBear) { if (bearStreak === 0) bearAlignStart = b.ts; bearStreak++; bullStreak = 0; bullFired = false; } else { bearStreak = 0; bearFired = false; bearAlignStart = 0; }
    if (allBull && bullStreak >= MIN_ALIGN && !bullFired) { const ts = bullCross.filter((t: number) => t > 0); if (ts.length === strat.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ ts: b.ts, dir: 'bull', alignStart: bullAlignStart, d0 }); bullFired = true; } }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) { const ts = bearCross.filter((t: number) => t > 0); if (ts.length === strat.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) { entries.push({ ts: b.ts, dir: 'bear', alignStart: bearAlignStart, d0 }); bearFired = true; } }
  }

  const raw: any[] = [];
  let lastBullExit = 0, lastBearExit = 0;
  for (const align of entries) {
    const entryTs = align.ts + 60;
    if (entryTs < gateStartTs || entryTs >= gateEndTs) continue;
    if (SINGLE_POS) {
      if (align.dir === 'bull' && entryTs <= lastBullExit) continue;
      if (align.dir === 'bear' && entryTs <= lastBearExit) continue;
    }
    const spxEntry = optPx(s1, entryTs - 1); if (!spxEntry) continue;
    const spxAS = optPx(s1, align.alignStart);
    const rev = spxAS ? Math.abs(spxEntry - spxAS) : 0;
    const tier3 = align.d0 === align.dir;
    // FIX #3: % -of-spot moneyness. revPct lets a big reversal still widen the
    // strike (same behaviour as the original $ clamp, scaled to the underlying).
    const revPct = rev / spxEntry;
    const otmPct = Math.max(OTM_MIN_PCT, Math.min(tier3 ? OTM_MAX_PCT : OTM_MID_PCT, revPct));
    const otm = spxEntry * otmPct;
    const strikeTgt = align.dir === 'bull' ? spxEntry + otm : spxEntry - otm;
    const sym = findOtm(c1, align.dir === 'bull' ? 'C' : 'P', strikeTgt); if (!sym) continue;
    const strike = c1.contractStrikes.get(sym) as number;
    const bars = c1.contractBars.get(sym) as any[];
    const entryPx = optPx(bars, entryTs - 1);
    if (!entryPx || entryPx < MINP || entryPx > MAXE) continue;
    if (cumVol(bars, sess, entryTs) < MIN_VOL) continue;
    const tp = entryPx * (1 + TP / 100);
    const sl = SL > 0 ? entryPx * (1 - SL / 100) : 0;
    let divergeTs = eod, reason = 'EOD';
    for (const b2 of s1) { if (b2.ts < entryTs) continue; const logged = dirLog.get(b2.ts); if (!logged) continue; const flip = align.dir === 'bull' ? logged.every((d: any) => d === 'bear') : logged.every((d: any) => d === 'bull'); if (flip) { divergeTs = b2.ts; reason = 'reverse'; break; } }
    let exitTs = divergeTs + 60, exitPx = optPx(bars, exitTs - 1) ?? optPx(bars, divergeTs - 1) ?? entryPx;
    for (const b2 of bars) {
      if (b2.ts < entryTs) continue; if (b2.ts > divergeTs) break;
      if (b2.high >= tp) { exitTs = b2.ts; exitPx = tp; reason = 'TP'; break; }
      if (sl > 0 && b2.low <= sl) { exitTs = b2.ts; exitPx = (b2.open !== undefined && b2.open < sl) ? b2.open : sl; reason = 'SL'; break; }
    }
    if (reason === 'EOD') { exitTs = eod; exitPx = optPx(bars, eod) ?? optPx(bars, eod - 3600) ?? 0.05; }
    if (SINGLE_POS) { if (align.dir === 'bull') lastBullExit = exitTs; else lastBearExit = exitTs; }
    raw.push({ entryTime: fmtET(entryTs), exitTime: fmtET(exitTs), dir: align.dir, tier: tier3 ? 'T3' : 'T2', strike, entryPx: +entryPx.toFixed(2), exitPx: +exitPx.toFixed(2), retPct: +((exitPx - entryPx) / entryPx * 100).toFixed(1), dur: Math.round((exitTs - entryTs) / 60), reason });
  }

  const CB = strat.cbTrigger != null ? strat.cbTrigger : CB_TRIGGER;
  const CBSKIP = strat.cbSkip ?? CB_SKIP;
  const MAXT: number | null = strat.maxTrades ?? null;
  const taken: boolean[] = []; let consec = 0, skipsLeft = 0;
  for (const t of raw) { if (skipsLeft > 0) { skipsLeft--; taken.push(false); } else { taken.push(true); if (CB === 0) { /* disabled */ } else if (t.retPct > 0) consec = 0; else { consec++; if (consec >= CB) { skipsLeft = CBSKIP; consec = 0; } } } }
  if (MAXT != null) { let ct = 0; for (let i = 0; i < taken.length; i++) { if (taken[i]) { ct++; if (ct > MAXT) taken[i] = false; } } }
  const trades = raw.map((t, i) => ({ ...t, active: taken[i] }));
  const active = trades.filter(t => t.active);
  const dayPnl = +active.reduce((s: number, t: any) => s + t.retPct, 0).toFixed(1);
  const wins = active.filter((t: any) => t.retPct > 0).length;
  return { date, spxOpen, spxClose, orH: +orH.toFixed(0), orL: +orL.toFixed(0), orPts: +(orH - orL).toFixed(0), or15H, or15L, dayHigh, dayLow, dayPnl, trades, wins, total: active.length };
}

// ── main ────────────────────────────────────────────────────────────────────
if (TARGET.outSuffix === '') {
  console.error('long-sweep: refusing to regenerate SPX (protected). Its legacy last-run.json stays. Run for an ETF/other profile.');
  process.exit(2);
}
const STRAT_FILE = path.join(process.cwd(), 'scripts/autoresearch/output/strategies.json');
const DEFAULT_STRATEGIES = [
  { name: '10+15 HMA10×12', tfs: [{ tf: 10, fast: 10, slow: 12 }, { tf: 15, fast: 10, slow: 12 }] },
  { name: '5+10 HMA10×12', tfs: [{ tf: 5, fast: 10, slow: 12 }, { tf: 10, fast: 10, slow: 12 }] },
  { name: '3+5+10 HMA10×12', tfs: [{ tf: 3, fast: 10, slow: 12 }, { tf: 5, fast: 10, slow: 12 }, { tf: 10, fast: 10, slow: 12 }] },
];
const strategies: any[] = fs.existsSync(STRAT_FILE)
  ? (() => { const j = JSON.parse(fs.readFileSync(STRAT_FILE, 'utf8')); return Array.isArray(j) ? j : (j.strategies || DEFAULT_STRATEGIES); })()
  : DEFAULT_STRATEGIES;

const dates = listDatesFor(TARGET);
console.error(`[${TARGET.symbol}-${TARGET.dte}dte] long-sweep — ${strategies.length} configs × ${dates.length} dates`);
const results: { [date: string]: any[] } = {};
let di = 0;
for (const date of dates) {
  const c1 = loadDay(TARGET, date, '1m') as any;
  if (!c1?.spxBars?.length) { di++; continue; }
  const p1 = loadDay(TARGET, prevDate(date), '1m') as any;
  const rows: any[] = [];
  for (const strat of strategies) {
    try { rows.push({ strategy: strat.name, ...runDay(date, strat, c1, p1) }); }
    catch (e: any) { rows.push({ strategy: strat.name, date, error: e.message, dayPnl: 0, trades: [], wins: 0, total: 0 }); }
  }
  results[date] = rows;
  if (++di % 20 === 0) console.error(`  ${di}/${dates.length} ${date}`);
}

// Same shape /api/longs + /api/last-run consume; trades stripped from snapshot.
const slim: { [d: string]: any[] } = {};
for (const [d, rows] of Object.entries(results)) slim[d] = rows.map(({ trades: _t, ...r }) => r);
const OUT = outPath(path.join(process.cwd(), 'scripts/autoresearch/output/last-run.json'), TARGET);
fs.writeFileSync(OUT, JSON.stringify({ strategies, dates, results: slim, ts: Date.now(), symbol: TARGET.symbol, dte: TARGET.dte }));
console.error(`✓ wrote ${OUT} (${strategies.length} configs, ${dates.length} dates)`);
