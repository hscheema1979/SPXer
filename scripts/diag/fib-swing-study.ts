/**
 * fib-swing-study.ts
 *
 * Marci Silfrain "Measured Move / Fibonacci Swing" trend-continuation strategy
 * (Chart Fanatics "Little RZY" playbook), backtested directionally on the
 * UNDERLYING across multiple intraday timeframes for SPX and NDX.
 *
 * The strategy in one line: in a trend, price makes an impulse leg, pulls back
 * a Fibonacci fraction of that leg, then resumes — and the next move travels a
 * "measured move" (a Fib extension of the same leg). We:
 *   1. Detect swing pivots (fractal left/right) — no look-ahead.
 *   2. Form an impulse leg from the last two alternating confirmed pivots.
 *   3. Gate on trend (higher-low for longs / lower-high for shorts) when asked.
 *   4. Enter on a limit at the Fib RETRACEMENT of the leg (0.382/0.5/0.618).
 *   5. Stop just beyond the leg origin (the swing it bounced from).
 *   6. Target a measured-move Fib EXTENSION (1.0/1.272/1.618 × leg from entry).
 *   7. Backstop-exit at the session close (intraday data → no overnight hold).
 *
 * This validates whether the SIGNAL has directional edge before we ever map it
 * onto an option structure. P&L is reported in index POINTS and R-multiples
 * (target/stop), which is the honest, friction-light measure of signal edge.
 *
 * Look-ahead discipline (mirrors smc-signal.ts):
 *   - Aggregated bar.ts is the bucket OPEN. A pivot centered at c is confirmed
 *     no earlier than bar c+right; we only ever act on bars >= that index.
 *   - A retracement limit fill on bar i uses only bar i's own OHLC.
 *   - When a single bar straddles both stop and target, we assume STOP first
 *     (conservative).
 *
 * Run:
 *   npx tsx scripts/diag/fib-swing-study.ts --symbol SPX
 *   npx tsx scripts/diag/fib-swing-study.ts --symbol NDX
 *   SWEEP_DAYS=60 npx tsx scripts/diag/fib-swing-study.ts --symbol SPX --tfs 5,15,30,60
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadDay, listDatesFor, resolveSymbolTarget, outPath } from './sweep-symbol';
import { aggregateIntraday, OHLCBar } from './ohlc-aggregate';
import { simulate, Trade } from './fib-swing-core';

// ──────────────────────────── CLI ────────────────────────────
function arg(name: string, def: string): string {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  if (flag) return flag.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TARGET = resolveSymbolTarget(process.argv);
const TFS = arg('tfs', '5,15,30,60').split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);
const PIVOTS = arg('pivots', '3/3,5/2,8/3').split(',').map(s => {
  const [l, r] = s.split('/').map(Number);
  return { left: l, right: r };
});
const ENTRY_FIBS = arg('entryFibs', '0.382,0.5,0.618').split(',').map(Number);
const EXT_FIBS = arg('extFibs', '1.0,1.272,1.618').split(',').map(Number);
const DIRS = arg('dirs', 'long,short').split(',') as ('long' | 'short')[];
const TREND_GATE = arg('trendGate', 'on') !== 'off';   // require HL (long) / LH (short)
const STOP_BUF = parseFloat(arg('stopBuf', '0.0'));     // extra buffer beyond swing, as × leg
const ENTRY_WINDOW = parseInt(arg('entryWindow', '40'), 10); // max bars from leg to fill the retracement

// ──────────────────────────── helpers ────────────────────────────
/** 09:30-ET session open in unix seconds for an ET trading date 'YYYY-MM-DD'. */
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}

// ──────────────────────────── run ────────────────────────────
const dates = listDatesFor(TARGET);
if (dates.length === 0) {
  console.error(`No parquet dates for ${TARGET.symbol} (${TARGET.profileId}). Looked in data/parquet/bars/${TARGET.profileId}`);
  process.exit(1);
}

console.log(`fib-swing-study: ${TARGET.symbol} ${TARGET.profileId} | ${dates.length} days (${dates[0]}..${dates[dates.length - 1]})`);
console.log(`  tfs=${TFS.join(',')}m  pivots=${PIVOTS.map(p => p.left + '/' + p.right).join(',')}  entryFibs=${ENTRY_FIBS.join(',')}  extFibs=${EXT_FIBS.join(',')}  dirs=${DIRS.join(',')}  trendGate=${TREND_GATE}`);

interface Agg { trades: number; wins: number; losses: number; flats: number; pts: number; rSum: number; days: Set<string>; posDays: Map<string, number>; }
const results = new Map<string, Agg>();
const keyOf = (tf: number, lr: { left: number; right: number }, ef: number, xf: number, d: string) =>
  `FIB ${tf}m L${lr.left}R${lr.right} e${ef} x${xf} ${d}`;

let loaded = 0;
for (const date of dates) {
  const day = loadDay(TARGET, date, '1m');
  const bars1m: OHLCBar[] = day?.spxBars ?? [];
  if (bars1m.length === 0) continue;
  loaded++;
  const sess = sessOpenTs(date);

  for (const tf of TFS) {
    const tfBars = aggregateIntraday(bars1m, tf, sess);
    if (tfBars.length < 12) continue;
    for (const lr of PIVOTS) {
      // pivots depend only on (tf, left, right) — but simulate per fib/ext/dir
      for (const dir of DIRS) {
        for (const ef of ENTRY_FIBS) {
          for (const xf of EXT_FIBS) {
            const trades = simulate(tfBars, { left: lr.left, right: lr.right, entryFib: ef, extFib: xf, dir, trendGate: TREND_GATE, stopBuf: STOP_BUF, entryWindow: ENTRY_WINDOW });
            if (trades.length === 0) continue;
            const k = keyOf(tf, lr, ef, xf, dir);
            let agg = results.get(k);
            if (!agg) { agg = { trades: 0, wins: 0, losses: 0, flats: 0, pts: 0, rSum: 0, days: new Set(), posDays: new Map() }; results.set(k, agg); }
            let dayPts = 0;
            for (const t of trades) {
              agg.trades++; agg.pts += t.pnlPts; agg.rSum += t.r; dayPts += t.pnlPts;
              if (t.outcome === 'win') agg.wins++; else if (t.outcome === 'loss') agg.losses++; else agg.flats++;
            }
            agg.days.add(date);
            agg.posDays.set(date, dayPts);
          }
        }
      }
    }
  }
}

// ──────────────────────────── summarize ────────────────────────────
interface Row {
  signal: string; n: number; wr: number; pnl: number; avgR: number; expR: number;
  posDayPct: number; numDays: number; avgPerTrade: number; flats: number;
}
const rows: Row[] = [];
for (const [k, a] of results) {
  const decided = a.wins + a.losses;
  const posDays = [...a.posDays.values()].filter(v => v > 0).length;
  rows.push({
    signal: k,
    n: a.trades,
    wr: decided > 0 ? (100 * a.wins) / decided : 0,
    pnl: a.pts,
    avgR: a.trades > 0 ? a.rSum / a.trades : 0,
    expR: a.trades > 0 ? a.rSum / a.trades : 0, // expectancy in R per trade
    posDayPct: a.days.size > 0 ? (100 * posDays) / a.days.size : 0,
    numDays: a.days.size,
    avgPerTrade: a.trades > 0 ? a.pts / a.trades : 0,
    flats: a.flats,
  });
}
rows.sort((x, y) => y.pnl - x.pnl);

console.log(`\nLoaded ${loaded} days. ${rows.length} configs with >=1 trade.\n`);
const top = rows.slice(0, 30);
const pad = (s: any, n: number) => String(s).padStart(n);
console.log(`${'signal'.padEnd(34)} ${pad('n', 5)} ${pad('wr%', 6)} ${pad('pnlPts', 9)} ${pad('pts/t', 7)} ${pad('avgR', 6)} ${pad('posDay%', 8)} ${pad('days', 5)}`);
console.log('-'.repeat(90));
for (const r of top) {
  console.log(`${r.signal.padEnd(34)} ${pad(r.n, 5)} ${pad(r.wr.toFixed(1), 6)} ${pad(r.pnl.toFixed(1), 9)} ${pad(r.avgPerTrade.toFixed(2), 7)} ${pad(r.avgR.toFixed(3), 6)} ${pad(r.posDayPct.toFixed(1), 8)} ${pad(r.numDays, 5)}`);
}

const OUT = outPath('scripts/autoresearch/output/fib-swing-study.json', TARGET);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\nWrote ${rows.length} rows → ${OUT}`);
