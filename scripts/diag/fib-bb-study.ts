/**
 * fib-bb-study.ts
 *
 * Backtest the "Fibonacci Bollinger Band rejection" mean-reversion idea on the
 * UNDERLYING, in index points and R-multiples: price stretches to an outer Fib
 * band, rejects (wicks through, closes back inside), and we fade it back toward
 * the mean with a hard stop beyond the rejection wick.
 *
 * Band math, signal and simulation live in fib-bb-core.ts (pure, unit-tested
 * for look-ahead). This file owns loading, aggregation, the parameter sweep,
 * and — the part that decides whether any of it is real — the train/test split.
 *
 * ── Why points and not dollars ─────────────────────────────────────────────
 * P&L in index points and R is the honest, friction-light measure of whether
 * the SIGNAL has directional edge. Mapping onto an option structure first would
 * let fill assumptions dominate the answer (a repeatedly-learned lesson in this
 * repo). Options are phase 2, and only if the signal survives out-of-sample.
 *
 * ── Why a train/test split ─────────────────────────────────────────────────
 * Sweeping ~5k parameter combinations over one dataset guarantees a good-looking
 * winner even in pure noise. So the search only ever ranks on the TRAIN slice,
 * and every headline number is measured on the TEST slice the search never saw.
 * The reported "survival rate" (how many top-train configs stay positive OOS)
 * is the overfit thermometer: at ~50% the study found nothing but noise.
 *
 * ── Look-ahead ─────────────────────────────────────────────────────────────
 * Enforced in fib-bb-core.ts and covered by tests/diag/fib-bb-core.test.ts:
 * bands at bar i use bars <= i; a rejection confirmed at bar i's close fills at
 * bar i+1's OPEN; a bar holding both stop and target counts as a STOP. Bars are
 * one continuous chronological series, so the split is purely a time cut on the
 * resulting trades — no future data ever reaches a past decision.
 *
 * Run:
 *   npx tsx scripts/diag/fib-bb-study.ts --symbol SPX
 *   npx tsx scripts/diag/fib-bb-study.ts --symbol SPX --tfs 15,30 --top 10
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadDay, listDatesFor, resolveSymbolTarget } from './sweep-symbol';
import { aggregateIntraday, OHLCBar } from './ohlc-aggregate';
import {
  fibBands, rollingATR, lastBarOfSessionIdx, detectRejections, simulate, etDate,
  type FibBand, type HtfContext, type SimOpts, type TargetSpec, type Trade,
} from './fib-bb-core';
import { summarize, type Summary } from './study-stats';

// ──────────────────────────── CLI ────────────────────────────
function arg(name: string, def: string): string {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  if (flag) return flag.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const nums = (s: string) => s.split(',').map(x => parseFloat(x.trim())).filter(Number.isFinite);
const pad = (s: string | number, w: number) => String(s).padStart(w);

const TARGET = resolveSymbolTarget(process.argv);
const TFS = nums(arg('tfs', '5,15,30,60'));
const LENGTHS = nums(arg('lengths', '50,100,200'));
const MULTS = nums(arg('mults', '2,3'));
const ENTRY_RATIOS = nums(arg('entryRatios', '0.618,0.786,1.0'));
const STOP_BUFS = nums(arg('stopBufs', '0,0.5,1.0'));
const MIN_RISK_ATR = parseFloat(arg('minRiskAtr', '0.5'));
// Cycle 1: confluence-at-rejection. `htfTouchAtrs` in ATRs of the SIGNAL TF —
// a rejection wick must be within this many ATRs of the higher-TF band.
// 0 → cycle-1 disabled.
const HTF_TOUCH_ATRS = nums(arg('htfTouchAtrs', '0'));
// Cycle 1: also gate on higher-TF basis slope agreement.
const HTF_REQUIRE_SLOPE = arg('htfRequireSlope', 'off') !== 'off';
// Cycle 2: use higher-TF basis cross as the exit.
const HTF_CROSS_EXIT = arg('htfCrossExit', 'off') !== 'off';
// Cycle 2: SLOPE WINDOW for the higher-TF basis slope used by cycle 1.
const HTF_SLOPE_WINDOW = parseInt(arg('htfSlopeWindow', '3'), 10);
/** Higher-TF context candidates. Each signal-TF picks the next one up. */
const HTF_MAP: Record<number, number> = { 5: 60, 15: 60, 30: 60, 60: 0 };
const WICK_FRACS = nums(arg('wickFracs', '0,0.3,0.5'));
const TARGETS: TargetSpec[] = arg('targets', 'basis,band:0.382,band:0.5,r:2').split(',').map(s => {
  const t = s.trim();
  if (t === 'basis') return { kind: 'basis' } as TargetSpec;
  const [k, v] = t.split(':');
  return k === 'r' ? { kind: 'r', mult: parseFloat(v) } : { kind: 'band', ratio: parseFloat(v) };
});
const DIRS = arg('dirs', 'long,short').split(',') as ('long' | 'short')[];
const ATR_PERIOD = parseInt(arg('atrPeriod', '14'), 10);
const SESSION_EXIT = arg('sessionExit', 'on') !== 'off';
const TRAIN_FRAC = parseFloat(arg('trainFrac', '0.7'));
const MIN_TRAIN_TRADES = parseInt(arg('minTrainTrades', '40'), 10);
const MIN_TEST_TRADES = parseInt(arg('minTestTrades', '15'), 10);
const TOP = parseInt(arg('top', '15'), 10);
/** Per-trade round-trip cost in index points, for a friction sensitivity read. */
const FRICTION_PTS = parseFloat(arg('frictionPts', '0'));

const labelOf = (t: TargetSpec) =>
  t.kind === 'basis' ? 'basis' : t.kind === 'band' ? `band${t.ratio}` : `${t.mult}R`;

// ──────────────────────────── load ────────────────────────────
/** 09:30-ET session open in unix seconds for an ET trading date 'YYYY-MM-DD'. */
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}

const dates = listDatesFor(TARGET);
if (dates.length === 0) {
  console.error(`No parquet dates for ${TARGET.symbol} (${TARGET.profileId}).`);
  process.exit(1);
}

console.log(`fib-bb-study: ${TARGET.symbol} ${TARGET.profileId} | ${dates.length} days (${dates[0]}..${dates[dates.length - 1]})`);

// Reading 331 parquet days takes ~2 minutes, which makes iterating on the grid
// painful. Cache the raw 1m series keyed by the date range; it is pure input
// data, so a stale cache can only appear when the date list itself changes.
type Day1m = { date: string; bars: OHLCBar[] };
const cacheFile = path.join(process.cwd(), 'data/cache',
  `fib-bb-${TARGET.profileId}-${dates[0]}_${dates[dates.length - 1]}_${dates.length}.json`);
let perDay1m: Day1m[] = [];
if (arg('cache', 'on') !== 'off' && fs.existsSync(cacheFile)) {
  perDay1m = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  console.log(`  loaded ${perDay1m.length} sessions from cache`);
} else {
  process.stdout.write('  loading 1m bars ');
  for (const date of dates) {
    const day = loadDay(TARGET, date, '1m');
    const bars: OHLCBar[] = day?.spxBars ?? [];
    if (bars.length) perDay1m.push({ date, bars });
    if (perDay1m.length % 50 === 0) process.stdout.write('.');
  }
  console.log(` ${perDay1m.length} sessions`);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(perDay1m));
}
if (perDay1m.length < 20) { console.error('Not enough sessions loaded.'); process.exit(1); }

const totalVol = perDay1m.reduce((a, d) => a + d.bars.reduce((s, b) => s + (b.volume || 0), 0), 0);
if (totalVol === 0) console.log('  note: underlying bars carry no volume — VWMA basis degenerates to a simple mean (expected for a cash index).');

// Train/test cut by DATE. The bar series stays continuous and chronological;
// only the resulting trades are partitioned, so warm-up is not re-paid and no
// future bar ever informs a past decision.
const loadedDates = perDay1m.map(d => d.date);
const cutIdx = Math.floor(loadedDates.length * TRAIN_FRAC);
const CUT_DATE = loadedDates[cutIdx];
const TEST_DATES = new Set(loadedDates.slice(cutIdx));
console.log(`  train ${loadedDates[0]}..${loadedDates[cutIdx - 1]} (${cutIdx}d)  |  test ${CUT_DATE}..${loadedDates[loadedDates.length - 1]} (${loadedDates.length - cutIdx}d)`);

/** One continuous chronological series per timeframe. */
const seriesByTf = new Map<number, OHLCBar[]>();
for (const tf of TFS) {
  const out: OHLCBar[] = [];
  for (const d of perDay1m) out.push(...aggregateIntraday(d.bars, tf, sessOpenTs(d.date)));
  seriesByTf.set(tf, out);
  console.log(`  tf ${tf}m → ${out.length} bars`);
}

/** Bands depend only on (tf, length, mult) — compute each once, not per config. */
const bandCache = new Map<string, (FibBand | null)[]>();
function bandsFor(tf: number, length: number, mult: number): (FibBand | null)[] {
  const k = `${tf}|${length}|${mult}`;
  let b = bandCache.get(k);
  if (!b) { b = fibBands(seriesByTf.get(tf)!, length, mult); bandCache.set(k, b); }
  return b;
}
/** ATR and session boundaries depend only on the series — hoist them too. */
const atrByTf = new Map<number, number[]>();
const eodByTf = new Map<number, Set<number>>();
for (const tf of TFS) {
  atrByTf.set(tf, rollingATR(seriesByTf.get(tf)!, ATR_PERIOD));
  eodByTf.set(tf, lastBarOfSessionIdx(seriesByTf.get(tf)!));
}

/** Cycle 1 / 2 need a higher-TF context per signal TF. Built once per
 *  (signalTF, lengthHtf, multHtf) — same caching discipline as the signal bands. */
const htfCache = new Map<string, HtfContext>();
function htfFor(signalTf: number, htfTf: number, length: number, mult: number): HtfContext | null {
  if (!htfTf || !seriesByTf.has(htfTf)) return null;
  const k = `${htfTf}|${length}|${mult}`;
  let h = htfCache.get(k);
  if (!h) {
    const bars = seriesByTf.get(htfTf)!;
    h = { bars, bands: fibBands(bars, length, mult), slopeWindow: HTF_SLOPE_WINDOW };
    htfCache.set(k, h);
  }
  return h;
}

// ──────────────────────────── sweep ────────────────────────────
// `--diag` answers "does this band get touched at all?" before we read anything
// into P&L. A grid whose outer bands are never pierced produces zero trades and
// an empty study, which is a grid problem, not a result.
if (process.argv.includes('--diag')) {
  console.log('\nrejection counts (touches of the band that close back inside):');
  console.log('  tf  len  mult  band   dir     n   per-session');
  for (const tf of TFS) {
    const bars = seriesByTf.get(tf)!;
    for (const length of LENGTHS) {
      if (bars.length < length + 50) continue;
      for (const mult of MULTS) {
        const bands = bandsFor(tf, length, mult);
        for (const entryRatio of ENTRY_RATIOS) {
          for (const dir of DIRS) {
            const n = detectRejections(bars, bands, { dir, entryRatio, wickFrac: 0 }).length;
            console.log(`  ${pad(tf, 3)} ${pad(length, 4)} ${pad(mult, 5)} ${pad(entryRatio, 5)}  ${dir.padEnd(5)} ${pad(n, 5)}   ${(n / loadedDates.length).toFixed(2)}`);
          }
        }
      }
    }
  }
  process.exit(0);
}

interface Row {
  label: string;
  tf: number; length: number; mult: number; entryRatio: number;
  target: string; stopBuf: number; wickFrac: number; dir: string;
  train: Summary; test: Summary;
  trainR: number; testR: number;
  trades: Trade[];
}

const rows: Row[] = [];
let evaluated = 0;
for (const tf of TFS) {
  const bars = seriesByTf.get(tf)!;
  const htfTf = HTF_MAP[tf] ?? 0;
  for (const length of LENGTHS) {
    if (bars.length < length + 50) continue;
    for (const mult of MULTS) {
      const bands = bandsFor(tf, length, mult);
      // HTF context for cycles 1 & 2: signal-TF × (length, mult). Cycles 1/2
      // both run on top of every config, so we evaluate them once per row
      // rather than re-sweeping everything. The HTF series itself uses the
      // same length/mult as the signal TF — a separate sweep over the HTF
      // params would be a cycle-3 lever, not now.
      const htf = htfTf ? htfFor(tf, htfTf, length, mult) : null;
      for (const dir of DIRS) {
        for (const entryRatio of ENTRY_RATIOS) {
          for (const wickFrac of WICK_FRACS) {
            for (const stopBuf of STOP_BUFS) {
              for (const target of TARGETS) {
                for (const touchAtr of HTF_TOUCH_ATRS) {
                  const o: SimOpts = {
                    dir, entryRatio, wickFrac, length, mult,
                    atrPeriod: ATR_PERIOD, stopBufAtr: stopBuf, minRiskAtr: MIN_RISK_ATR, target,
                    sessionExit: SESSION_EXIT,
                    htfWickTouchAtr: touchAtr > 0 ? touchAtr : undefined,
                    requireHtfSlopeAgreement: HTF_REQUIRE_SLOPE || undefined,
                    htfFlipOnCross: HTF_CROSS_EXIT || undefined,
                  };
                  evaluated++;
                  const trades = simulate(bars, o, {
                    bands, atr: atrByTf.get(tf)!, lastOfDay: eodByTf.get(tf)!,
                    htf: htf ?? undefined,
                  }).map(t =>
                    FRICTION_PTS ? { ...t, pnlPts: t.pnlPts - FRICTION_PTS, r: (t.pnlPts - FRICTION_PTS) / t.risk } : t);
                  const trainT = trades.filter(t => !TEST_DATES.has(etDate(t.entryTs)));
                  const testT = trades.filter(t => TEST_DATES.has(etDate(t.entryTs)));
                  if (trainT.length < MIN_TRAIN_TRADES || testT.length < MIN_TEST_TRADES) continue;
                  const tag = [
                    `FIBBB`, `${tf}m`, `L${length}`, `m${mult}`, `b${entryRatio}`, labelOf(target),
                    `sb${stopBuf}`, `wf${wickFrac}`, `htfT${touchAtr}`,
                    HTF_REQUIRE_SLOPE ? 'slope' : '',
                    HTF_CROSS_EXIT ? 'crossExit' : '',
                    dir,
                  ].filter(Boolean).join(' ');
                  rows.push({
                    label: tag,
                    tf, length, mult, entryRatio, target: labelOf(target), stopBuf, wickFrac, dir,
                    train: summarize(trainT.map(t => t.pnlPts)),
                    test: summarize(testT.map(t => t.pnlPts)),
                    trainR: +trainT.reduce((a, t) => a + t.r, 0).toFixed(1),
                    testR: +testT.reduce((a, t) => a + t.r, 0).toFixed(1),
                    trades,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
}
console.log(`\n  evaluated ${evaluated} configs, ${rows.length} met the minimum trade counts\n`);
if (!rows.length) { console.error('No config produced enough trades.'); process.exit(1); }

// ──────────────────────────── report ────────────────────────────
// Rank on TRAIN only, by total POINTS. Total R looks like the more principled
// choice but is trivially gamed: a fill that opens next to its stop takes ~1pt
// of risk, so a normal move scores 10R, and a config that loses money outright
// can top an R ranking. Points are what the account actually sees.
const ranked = [...rows].sort((a, b) => b.train.totalPnl - a.train.totalPnl);

function line(r: Row, s: Summary, totR: number): string {
  return `${pad(s.n, 5)} ${pad(s.wr.toFixed(1), 6)}% ${pad(s.beWr == null ? '-' : s.beWr.toFixed(1), 6)}% ` +
    `${pad(s.edge == null ? '-' : s.edge.toFixed(1), 6)} ${pad(s.avgPnl.toFixed(2), 8)} ${pad(s.totalPnl, 8)} ` +
    `${pad(totR.toFixed(1), 8)} ${pad(s.profitFactor ?? '-', 6)} ${pad(s.p5, 7)} ${pad(s.worst, 7)} ${pad(s.maxDD, 7)}`;
}
const HEAD = `    n     WR    beWR   edge   avgPts   totPts    totR    PF     p5   worst   maxDD`;

console.log('═'.repeat(120));
console.log(`TOP ${TOP} BY TRAIN — each shown with its OUT-OF-SAMPLE result underneath`);
console.log('═'.repeat(120));
for (const r of ranked.slice(0, TOP)) {
  console.log(`\n${r.label}`);
  console.log(`  ${HEAD}`);
  console.log(`  TRAIN ${line(r, r.train, r.trainR)}`);
  console.log(`  TEST  ${line(r, r.test, r.testR)}`);
}

// The overfit thermometer. If roughly half the top-train configs are positive
// out-of-sample, the sweep selected noise and nothing here is tradeable.
const top = ranked.slice(0, Math.min(50, ranked.length));
const survived = top.filter(r => r.test.totalPnl > 0).length;
const allPosTest = rows.filter(r => r.test.totalPnl > 0).length;
console.log('\n' + '═'.repeat(120));
console.log('OUT-OF-SAMPLE SURVIVAL');
console.log('═'.repeat(120));
console.log(`  top-${top.length} train configs positive on test : ${survived}/${top.length} (${(100 * survived / top.length).toFixed(0)}%)`);
console.log(`  ALL configs positive on test               : ${allPosTest}/${rows.length} (${(100 * allPosTest / rows.length).toFixed(0)}%)`);
console.log(`  → a top-set survival rate near the all-config rate means the ranking learned nothing.`);

// Per-side split: an edge on one side only is usually just the index's drift.
for (const d of DIRS) {
  const side = rows.filter(r => r.dir === d);
  if (!side.length) continue;
  const pos = side.filter(r => r.test.totalPnl > 0).length;
  console.log(`  ${d.padEnd(5)} : ${pos}/${side.length} (${(100 * pos / side.length).toFixed(0)}%) of configs positive out-of-sample`);
}

// Recent-window detail on the single best-by-train config.
const best = ranked[0];
const recentDates = loadedDates.slice(-5);
const recent = best.trades.filter(t => recentDates.includes(etDate(t.entryTs)));
console.log('\n' + '═'.repeat(120));
console.log(`LAST 5 SESSIONS — ${best.label}`);
console.log('═'.repeat(120));
if (!recent.length) console.log('  no trades in the last 5 sessions');
for (const t of recent) {
  console.log(`  ${etDate(t.entryTs)} ${new Date(t.entryTs * 1000).toISOString().slice(11, 16)}Z ${t.dir.padEnd(5)} ` +
    `entry ${t.entry.toFixed(2)}  stop ${t.stop.toFixed(2)}  tgt ${t.target.toFixed(2)}  ` +
    `→ ${t.exitReason.padEnd(7)} ${t.exitPrice.toFixed(2)}  ${t.pnlPts >= 0 ? '+' : ''}${t.pnlPts.toFixed(2)}pts  ${t.r.toFixed(2)}R  ${t.barsHeld} bars`);
}

// ──────────────────────────── output ────────────────────────────
const outDir = path.join(process.cwd(), 'scripts/diag/output');
fs.mkdirSync(outDir, { recursive: true });
const stem = `fib-bb-${TARGET.symbol.toLowerCase()}`;

fs.writeFileSync(path.join(outDir, `${stem}-study.json`), JSON.stringify({
  namespace: 'FIBBB',
  symbol: TARGET.symbol, profile: TARGET.profileId,
  generatedAt: new Date().toISOString(),
  dates: { first: loadedDates[0], last: loadedDates[loadedDates.length - 1], n: loadedDates.length, cut: CUT_DATE },
  params: { tfs: TFS, lengths: LENGTHS, mults: MULTS, entryRatios: ENTRY_RATIOS, targets: TARGETS.map(labelOf), stopBufs: STOP_BUFS, wickFracs: WICK_FRACS, dirs: DIRS, atrPeriod: ATR_PERIOD, sessionExit: SESSION_EXIT, frictionPts: FRICTION_PTS },
  survival: { topN: top.length, topPositiveOnTest: survived, allConfigs: rows.length, allPositiveOnTest: allPosTest },
  rows: ranked.map(({ trades, ...r }) => r),
}, null, 2));

const csv = ['label,date,time,dir,entry,stop,target,exitReason,exitPrice,pnlPts,r,barsHeld,slice'];
for (const r of ranked.slice(0, TOP)) {
  for (const t of r.trades) {
    const d = etDate(t.entryTs);
    csv.push([r.label, d, new Date(t.entryTs * 1000).toISOString().slice(11, 16), t.dir,
      t.entry.toFixed(2), t.stop.toFixed(2), t.target.toFixed(2), t.exitReason, t.exitPrice.toFixed(2),
      t.pnlPts.toFixed(2), t.r.toFixed(3), t.barsHeld, TEST_DATES.has(d) ? 'test' : 'train'].join(','));
  }
}
fs.writeFileSync(path.join(outDir, `${stem}-trades.csv`), csv.join('\n'));
console.log(`\nwrote scripts/diag/output/${stem}-study.json and ${stem}-trades.csv`);
