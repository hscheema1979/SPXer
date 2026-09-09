/**
 * HMA period comparison worker — replicates backtest-server runDay() entry + strike
 * selection VERBATIM, but applies a TRAILING-STOP exit (with activation threshold) and
 * a catastrophic hard stop. Reads v2 .po.brc caches via the engine loader.
 *
 * Usage: npx tsx scripts/tmp_hma/worker.ts <outfile.json> <date1,date2,...>
 * Strategies (fast/slow on 1m) are fixed below: 3x9, 3x12, 3x21.
 *
 * Exit model (NEW — implemented here, NOT in engine source):
 *   - catastrophic hard stop: exit if option <= entry*(1-CATA)         (CATA=0.15)
 *   - trailing stop: once price has been >= entry*(1+ACT) (ACT=0.15),
 *     exit when price <= highWater*(1-TRAIL)                            (TRAIL=0.10)
 *   - reversal flip (engine's): all-TF HMA flip against position -> exit next bar
 *   - EOD
 * Entry/strike/gates/sizing IDENTICAL across the three HMA configs; only fast/slow differ.
 */
import { readBarCacheFile } from '../../src/replay/bar-cache-file';

// ---- engine constants (verbatim from backtest-server.ts) ----
const OTM_MIN = 5, OTM_MAX = 20, OTM_MID = 10;
const MIN_ALIGN = 3, CROSS_WIN = 60, MIN_VOL = 100;
const MAX_ENTRY = 40, MIN_PRICE = 0.2;
const FAST0 = 3, SLOW0 = 15;
// ---- corrections to match our validated approach ----
const MAXPOS = 5;       // max concurrent positions (engine risk.maxPositions)
const ITM_OFFSET = 5;   // ITM by ~1 strike (5pt SPXW) instead of OTM

// ---- exit model params (this worker) ----
const CATA = 0.15;   // catastrophic hard stop -15%
const ACT  = 0.15;   // trailing activates only after +15%
const TRAIL = 0.10;  // 10% trail from high-water once active
// no-flip FIXED bracket mode (no trail): set TP_PCT / SL_PCT env to enable
const TP_PCT = process.env.TP_PCT ? +process.env.TP_PCT : 0;
const SL_PCT = process.env.SL_PCT ? +process.env.SL_PCT : 0;
const USE_FIXED = TP_PCT > 0 || SL_PCT > 0;

type Bar = { ts: number; open: number; high: number; low: number; close: number; volume?: number };

function mkSt(): any { return { closed: [], partial: null }; }
function feed(st: any, b: Bar, tf: number) {
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
  for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += p - i; }
  return s / w;
}
function hmaDir(closes: number[], fast: number, slow: number): string | null {
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
function getDir(st: any, fast: number, slow: number): string | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  const closes = bars.map((b: Bar) => b.close);
  return hmaDir(closes, fast, slow);
}
function optPx(bars: Bar[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1e3);
}
function etToTs(sess: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return sess + ((h - 9) * 60 + (m - 30)) * 60;
}
function cumVol(bars: Bar[], from: number, to: number): number {
  return bars.filter(b => b.ts >= from && b.ts <= to).reduce((s, b) => s + (b.volume ?? 0), 0);
}
function findOtm(c1: any, type: string, target: number): string | null {
  let sym: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) {
    if (s[10] !== type) continue;
    const k = c1.contractStrikes.get(s);
    const d = Math.abs(k - target);
    if (d < bestD) { bestD = d; sym = s; }
  }
  return sym;
}
function prevDate(d: string): string {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

interface Strat { name: string; fast: number; slow: number; }
const STRATS: Strat[] = [
  { name: '3x9_1m',  fast: 3, slow: 9 },
  { name: '3x12_1m', fast: 3, slow: 12 },
  { name: '3x21_1m', fast: 3, slow: 21 },
];

interface Trade { dir: string; entryPx: number; exitPx: number; retPct: number; pnl: number; reason: string; dur: number; }

function runDay(date: string, strat: Strat, c1: any, p1: any) {
  const tfs = [{ tf: 1, fast: strat.fast, slow: strat.slow }];
  const s1: Bar[] = c1.spxBars;
  const sess = sessOpenTs(date), eod = sess + 6.5 * 3600, tradeStart = sess + 1800;
  const gateStartTs = Math.max(etToTs(sess, '10:00'), tradeStart);
  const gateEndTs = Math.min(etToTs(sess, '15:30'), eod - 300);

  const st0 = mkSt();
  const sts = tfs.map(() => mkSt());
  for (const b of (p1?.spxBars ?? [])) { feed(st0, b, 1); sts.forEach((st, i) => feed(st, b, tfs[i].tf)); }

  const prevDirs: (string | null)[] = tfs.map(() => null);
  const bullCross = tfs.map(() => 0), bearCross = tfs.map(() => 0);
  const dirLog = new Map<number, (string | null)[]>();
  const entries: any[] = [];
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false, bullAlignStart = 0, bearAlignStart = 0;

  for (const b of s1) {
    feed(st0, b, 1); sts.forEach((st, i) => feed(st, b, tfs[i].tf));
    if (b.ts < tradeStart) continue;
    const d0 = getDir(st0, FAST0, SLOW0);
    const dirs = sts.map((st, i) => getDir(st, tfs[i].fast, tfs[i].slow));
    dirLog.set(b.ts, dirs);
    dirs.forEach((d, i) => {
      if (prevDirs[i] !== null && d !== prevDirs[i]) {
        if (d === 'bull') bullCross[i] = b.ts;
        if (d === 'bear') bearCross[i] = b.ts;
      }
      prevDirs[i] = d;
    });
    const allBull = dirs.every(d => d === 'bull'), allBear = dirs.every(d => d === 'bear');
    if (allBull) { if (bullStreak === 0) bullAlignStart = b.ts; bullStreak++; bearStreak = 0; bearFired = false; }
    else { bullStreak = 0; bullFired = false; bullAlignStart = 0; }
    if (allBear) { if (bearStreak === 0) bearAlignStart = b.ts; bearStreak++; bullStreak = 0; bullFired = false; }
    else { bearStreak = 0; bearFired = false; bearAlignStart = 0; }
    if (allBull && bullStreak >= MIN_ALIGN && !bullFired) {
      const ts = bullCross.filter(t => t > 0);
      if (ts.length === tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ ts: b.ts, dir: 'bull', alignStart: bullAlignStart, d0 }); bullFired = true;
      }
    }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) {
      const ts = bearCross.filter(t => t > 0);
      if (ts.length === tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ ts: b.ts, dir: 'bear', alignStart: bearAlignStart, d0 }); bearFired = true;
      }
    }
  }

  const trades: Trade[] = [];
  const open: { dir: string; exitTs: number }[] = [];
  for (const align of entries) {
    const entryTs = align.ts + 60;
    if (entryTs < gateStartTs || entryTs >= gateEndTs) continue;
    // expire closed positions, then apply same-side dedup + max-positions (our approach)
    for (let i = open.length - 1; i >= 0; i--) if (open[i].exitTs <= entryTs) open.splice(i, 1);
    if (open.some(o => o.dir === align.dir)) continue;   // same-side dedup
    if (open.length >= MAXPOS) continue;                 // max concurrent positions
    const spxEntry = optPx(s1, entryTs - 1);
    if (!spxEntry) continue;
    // ITM strike (mirrors today's strikeOffset -1 ITM1): call strike BELOW spot, put ABOVE
    const strikeTgt = align.dir === 'bull' ? spxEntry - ITM_OFFSET : spxEntry + ITM_OFFSET;
    const sym = findOtm(c1, align.dir === 'bull' ? 'C' : 'P', strikeTgt);
    if (!sym) continue;
    const bars: Bar[] = c1.contractBars.get(sym);
    const entryPx = optPx(bars, entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE || entryPx > MAX_ENTRY) continue;
    if (cumVol(bars, sess, entryTs) < MIN_VOL) continue;

    // reversal flip (engine logic) — DISABLED for the trailing-stop framework so that
    // winners can run to the trail/CATA/EOD instead of being cut on an immediate HMA flip.
    // Set USE_REVERSAL=1 to re-enable the engine's reversal exit.
    const USE_REVERSAL = process.env.USE_REVERSAL === '1';
    let divergeTs = eod, reason = 'EOD';
    if (USE_REVERSAL) {
      for (const b2 of s1) {
        if (b2.ts < entryTs) continue;
        const logged = dirLog.get(b2.ts);
        if (!logged) continue;
        const flip = align.dir === 'bull' ? logged.every(d => d === 'bear') : logged.every(d => d === 'bull');
        if (flip) { divergeTs = b2.ts; reason = 'reverse'; break; }
      }
    }

    // ----- TRAILING-STOP EXIT (walk contract bars up to divergeTs) -----
    const cata = entryPx * (1 - CATA);
    const actLevel = entryPx * (1 + ACT);
    let highWater = entryPx, trailActive = false;
    let exitTs = divergeTs + 60;
    let exitPx = optPx(bars, exitTs - 1) ?? optPx(bars, divergeTs - 1) ?? entryPx;
    let exitReason = reason;
    for (const b2 of bars) {
      if (b2.ts < entryTs) continue;
      if (b2.ts > divergeTs) break;
      if (USE_FIXED) {  // no-flip fixed bracket: SL first (conservative), then TP
        const slL = entryPx * (1 - SL_PCT), tpL = entryPx * (1 + TP_PCT);
        if (SL_PCT > 0 && b2.low <= slL) { exitTs = b2.ts; exitPx = slL; exitReason = 'SL'; break; }
        if (TP_PCT > 0 && b2.high >= tpL) { exitTs = b2.ts; exitPx = tpL; exitReason = 'TP'; break; }
        continue;
      }
      // catastrophic stop first (conservative — use bar low)
      if (b2.low <= cata) { exitTs = b2.ts; exitPx = Math.min(cata, b2.open ?? cata); exitReason = 'CATA'; break; }
      // update high-water from bar high
      if (b2.high > highWater) highWater = b2.high;
      if (!trailActive && highWater >= actLevel) trailActive = true;
      if (trailActive) {
        const trailStop = highWater * (1 - TRAIL);
        if (b2.low <= trailStop) { exitTs = b2.ts; exitPx = trailStop; exitReason = 'TRAIL'; break; }
      }
    }
    if (exitReason === 'EOD' || exitReason === 'reverse') {
      // no stop hit before divergence/eod -> exit at reversal/eod price (already set)
      if (exitReason === 'EOD') { exitTs = eod; exitPx = optPx(bars, eod) ?? optPx(bars, eod - 3600) ?? 0.05; }
    }

    open.push({ dir: align.dir, exitTs });  // track for dedup / max-positions
    const pnl = (exitPx - entryPx) * 100; // 1 contract, $100 multiplier
    trades.push({
      dir: align.dir, entryPx: +entryPx.toFixed(2), exitPx: +exitPx.toFixed(2),
      retPct: +((exitPx - entryPx) / entryPx * 100).toFixed(1),
      pnl: +pnl.toFixed(2), reason: exitReason, dur: Math.round((exitTs - entryTs) / 60),
    });
  }

  // Circuit-breaker (engine default CB_TRIGGER=3, CB_SKIP=1): after 3 consecutive
  // losers, skip the next entry. Applied identically across all three HMA configs.
  const CB = 3, CBSKIP = 1;
  const taken: Trade[] = [];
  let consec = 0, skipsLeft = 0;
  for (const t of trades) {
    if (skipsLeft > 0) { skipsLeft--; continue; }
    taken.push(t);
    if (t.retPct > 0) consec = 0;
    else { consec++; if (consec >= CB) { skipsLeft = CBSKIP; consec = 0; } }
  }

  const wins = taken.filter(t => t.pnl > 0).length;
  const dayPnl = taken.reduce((s, t) => s + t.pnl, 0);
  return { date, strategy: strat.name, trades: taken, wins, total: taken.length, dayPnl: +dayPnl.toFixed(2) };
}

// ---- main ----
const outfile = process.argv[2];
const dates = (process.argv[3] || '').split(',').filter(Boolean);
const results: any[] = [];
for (const date of dates) {
  const c1 = readBarCacheFile(date, '1m', true);
  if (!c1 || !c1.spxBars.length) { for (const s of STRATS) results.push({ date, strategy: s.name, trades: [], wins: 0, total: 0, dayPnl: 0, error: 'no-cache' }); continue; }
  const p1 = readBarCacheFile(prevDate(date), '1m', true);
  for (const strat of STRATS) {
    try { results.push(runDay(date, strat, c1, p1)); }
    catch (e: any) { results.push({ date, strategy: strat.name, trades: [], wins: 0, total: 0, dayPnl: 0, error: e.message }); }
  }
}
import * as fs from 'fs';
fs.writeFileSync(outfile, JSON.stringify(results));
console.log(`worker pid=${process.pid} wrote ${results.length} results for ${dates.length} dates -> ${outfile}`);
