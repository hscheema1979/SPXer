/**
 * fib-swing-multiday.ts
 *
 * The multi-DAY companion to fib-swing-study.ts. The intraday study reset every
 * session and force-exited at the close — wrong frame for a swing strategy whose
 * "measured move" can take days. This version:
 *
 *   - Stitches the whole history into ONE continuous series per timeframe:
 *       • 30m / 60m / 120m — intraday bars aggregated per session then
 *         concatenated across days (a continuous intraday chart; overnight gaps
 *         ignored, as every charting platform shows them).
 *       • Daily / Weekly — true multi-day bars (aggregateDaily / aggregateWeekly).
 *   - Detects pivots / legs on that continuous series, so a leg can span days.
 *   - HOLDS positions across days to the stop or the measured-move target — no
 *     EOD exit (the trade ends only at stop / target / end-of-history).
 *
 * Same signal + simulator as the intraday study (imported from fib-swing-core),
 * so the only difference is the bar series and the hold horizon.
 *
 * Run:
 *   npx tsx scripts/diag/fib-swing-multiday.ts --symbol SPX
 *   npx tsx scripts/diag/fib-swing-multiday.ts --symbol NDX --tfs 30,60,120,D,W
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadDay, listDatesFor, resolveSymbolTarget, outPath } from './sweep-symbol';
import { aggregateIntraday, aggregateDaily, aggregateWeekly, OHLCBar } from './ohlc-aggregate';
import { simulate } from './fib-swing-core';

function arg(name: string, def: string): string {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  if (flag) return flag.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const TARGET = resolveSymbolTarget(process.argv);
// timeframes: integer minutes are stitched-intraday; 'D' daily, 'W' weekly.
const TFS = arg('tfs', '30,60,120,D,W').split(',').map(s => s.trim());
const PIVOTS = arg('pivots', '3/3,5/2,8/3').split(',').map(s => { const [l, r] = s.split('/').map(Number); return { left: l, right: r }; });
const ENTRY_FIBS = arg('entryFibs', '0.382,0.5,0.618').split(',').map(Number);
const EXT_FIBS = arg('extFibs', '1.0,1.272,1.618').split(',').map(Number);
const DIRS = arg('dirs', 'long,short').split(',') as ('long' | 'short')[];
const TREND_GATE = arg('trendGate', 'on') !== 'off';
const STOP_BUF = parseFloat(arg('stopBuf', '0.0'));
// a multi-day retracement can take many bars to fill — give it room on slow TFs.
const ENTRY_WINDOW = parseInt(arg('entryWindow', '20'), 10);

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}

// ──────────────────────────── build continuous series ────────────────────────────
const dates = listDatesFor(TARGET);
if (dates.length === 0) { console.error(`No parquet dates for ${TARGET.symbol}`); process.exit(1); }

console.log(`fib-swing-multiday: ${TARGET.symbol} ${TARGET.profileId} | ${dates.length} days (${dates[0]}..${dates[dates.length - 1]})`);
console.log(`  tfs=${TFS.join(',')}  pivots=${PIVOTS.map(p => p.left + '/' + p.right).join(',')}  entryFibs=${ENTRY_FIBS.join(',')}  extFibs=${EXT_FIBS.join(',')}  dirs=${DIRS.join(',')}  trendGate=${TREND_GATE}  HOLD ACROSS DAYS, no EOD exit`);

// Load every day's 1m bars once; keep the full 1m tape (for daily/weekly) and a
// stitched series per requested intraday minute-TF.
const all1m: OHLCBar[] = [];
const stitched: Record<string, OHLCBar[]> = {};
const minuteTfs = TFS.filter(t => /^\d+$/.test(t)).map(Number);
for (const t of minuteTfs) stitched[String(t)] = [];

let loaded = 0;
for (const date of dates) {
  const day = loadDay(TARGET, date, '1m');
  const bars1m: OHLCBar[] = day?.spxBars ?? [];
  if (bars1m.length === 0) continue;
  loaded++;
  for (const b of bars1m) all1m.push(b);
  const sess = sessOpenTs(date);
  for (const t of minuteTfs) {
    const agg = aggregateIntraday(bars1m, t, sess);
    for (const b of agg) stitched[String(t)].push(b);
  }
}
all1m.sort((a, b) => a.ts - b.ts);

function seriesFor(tf: string): OHLCBar[] {
  if (tf === 'D') return aggregateDaily(all1m);
  if (tf === 'W') return aggregateWeekly(all1m);
  return stitched[tf] ?? [];
}

// ──────────────────────────── run ────────────────────────────
interface Agg { trades: number; wins: number; losses: number; flats: number; pts: number; rSum: number; holdDays: number; }
const results = new Map<string, Agg>();

for (const tf of TFS) {
  const series = seriesFor(tf);
  if (series.length < 12) { console.log(`  [skip ${tf}] only ${series.length} bars`); continue; }
  for (const lr of PIVOTS) {
    for (const dir of DIRS) {
      for (const ef of ENTRY_FIBS) {
        for (const xf of EXT_FIBS) {
          const trades = simulate(series, { left: lr.left, right: lr.right, entryFib: ef, extFib: xf, dir, trendGate: TREND_GATE, stopBuf: STOP_BUF, entryWindow: ENTRY_WINDOW });
          if (trades.length === 0) continue;
          const k = `FIB ${tf} L${lr.left}R${lr.right} e${ef} x${xf} ${dir}`;
          let a = results.get(k);
          if (!a) { a = { trades: 0, wins: 0, losses: 0, flats: 0, pts: 0, rSum: 0, holdDays: 0 }; results.set(k, a); }
          for (const t of trades) {
            a.trades++; a.pts += t.pnlPts; a.rSum += t.r;
            a.holdDays += (t.exitTs - t.entryTs) / 86400;
            if (t.outcome === 'win') a.wins++; else if (t.outcome === 'loss') a.losses++; else a.flats++;
          }
        }
      }
    }
  }
}

// ──────────────────────────── summarize ────────────────────────────
interface Row { signal: string; tf: string; n: number; wr: number; pnl: number; avgR: number; avgPerTrade: number; avgHoldDays: number; flats: number; }
const rows: Row[] = [];
for (const [k, a] of results) {
  const decided = a.wins + a.losses;
  rows.push({
    signal: k, tf: k.split(' ')[1],
    n: a.trades,
    wr: decided > 0 ? (100 * a.wins) / decided : 0,
    pnl: a.pts,
    avgR: a.trades > 0 ? a.rSum / a.trades : 0,
    avgPerTrade: a.trades > 0 ? a.pts / a.trades : 0,
    avgHoldDays: a.trades > 0 ? a.holdDays / a.trades : 0,
    flats: a.flats,
  });
}
rows.sort((x, y) => y.pnl - x.pnl);

console.log(`\nLoaded ${loaded} days. ${rows.length} configs with >=1 trade.\n`);
const pad = (s: any, n: number) => String(s).padStart(n);
console.log(`${'signal'.padEnd(32)} ${pad('n', 5)} ${pad('wr%', 6)} ${pad('pnlPts', 9)} ${pad('pts/t', 7)} ${pad('avgR', 6)} ${pad('holdD', 6)} ${pad('flat', 5)}`);
console.log('-'.repeat(86));
for (const r of rows.slice(0, 30)) {
  console.log(`${r.signal.padEnd(32)} ${pad(r.n, 5)} ${pad(r.wr.toFixed(1), 6)} ${pad(r.pnl.toFixed(1), 9)} ${pad(r.avgPerTrade.toFixed(2), 7)} ${pad(r.avgR.toFixed(3), 6)} ${pad(r.avgHoldDays.toFixed(1), 6)} ${pad(r.flats, 5)}`);
}

// Per-timeframe best-config rollup so the multi-day vs intraday question is direct.
console.log(`\nBest config per timeframe:`);
const byTf = new Map<string, Row>();
for (const r of rows) { const cur = byTf.get(r.tf); if (!cur || r.pnl > cur.pnl) byTf.set(r.tf, r); }
for (const tf of TFS) { const r = byTf.get(tf); if (r) console.log(`  ${tf.padEnd(4)} ${r.signal.padEnd(30)} n=${pad(r.n, 4)} pnl=${pad(r.pnl.toFixed(0), 7)} avgR=${r.avgR.toFixed(3)} holdDays=${r.avgHoldDays.toFixed(1)}`); }

const OUT = outPath('scripts/autoresearch/output/fib-swing-multiday.json', TARGET);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\nWrote ${rows.length} rows → ${OUT}`);
