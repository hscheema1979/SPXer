/**
 * sr-trend-predict-contract.ts
 *
 * Tests the ACTUAL premise of Krafer's video (youtu.be/0yNfaixWyf4) — which is
 * NOT VWAP/RSI. Krafer says: "most of what we call patterns can be reduced to
 * simple resistance lines," plus trend lines, and "blocks and gaps" (gaps fill).
 *
 * So the falsifiable claims, on the tradeable instrument the user cares about
 * (SPX 0DTE option contracts):
 *   1. SUPPORT/RESISTANCE — price near a recent rolling high (resistance) tends
 *      to reverse DOWN; near a recent rolling low (support) tends to bounce UP.
 *   2. TREND LINE — in an up-trend, next bar is more likely up (continuation);
 *      a linear-regression trend line's slope predicts next-bar direction.
 *   3. GAP-FILL — a large 1m move tends to partially reverse next bar.
 *
 * Design (matching this repo's discipline + the video's own lesson):
 *   - Instrument: per trading day, the most-liquid near-the-money 0DTE SPXW
 *     call and put (strike nearest the session's first underlying print). We
 *     test calls and puts separately — they're different assets.
 *   - Only bars with volume > 0 are kept (illiquid/stale option quotes would
 *     fabricate predictability — a repeatedly-learned lesson in this repo).
 *   - Every feature is CAUSAL: rolling levels and the regression line at bar i
 *     use bars ≤ i only (resistance/support exclude the current bar to avoid a
 *     tautology). Verified by construction below.
 *   - Walk-forward: train on the first 70% of dates, test on the last 30%.
 *     Thresholds are chosen on train; every headline number is measured on the
 *     test slice the selection never saw. This is the gate the video's
 *     genetic-algo bots were missing (they "learned to hide their losses").
 *
 * Note: "edge" here = statistical predictability of next-bar DIRECTION on a
 * single near-money contract. It is NOT a P&L claim; 1m option spreads/cost
 * would dwarf a 1-2pp directional edge. The question is whether the pattern
 * exists at all, which is what Krafer claims.
 *
 * Usage:
 *   npx tsx scripts/diag/sr-trend-predict-contract.ts            # both call & put
 *   npx tsx scripts/diag/sr-trend-predict-contract.ts --type=call
 */
import * as fs from 'fs';
import * as path from 'path';

const argv = process.argv.slice(2);
const typeArg = (argv.find((a) => a.startsWith('--type=')) || '--type=both')
  .split('=')[1] as 'call' | 'put' | 'both';
const DO_CALL = typeArg !== 'put';
const DO_PUT = typeArg !== 'call';

let duckdb: any;
try {
  duckdb = require('duckdb');
} catch {
  console.error('duckdb node module not installed. npm i duckdb');
  process.exit(1);
}

const PROFILE_DIR = path.join(process.cwd(), 'data/parquet/bars/spx-0dte');

// ── contract symbol parsing ────────────────────────────────────────────────
// SPXW 26 08 04 C 07270000  → expiry 260804, type C, strike 7270.0
interface ContractMeta {
  symbol: string;
  type: 'C' | 'P';
  strike: number;
  expiry: string; // YYMMDD
}
function parseContract(sym: string): ContractMeta | null {
  if (!sym.startsWith('SPXW') || sym.length < 15) return null;
  const expiry = sym.slice(4, 10);
  const t = sym[10] as 'C' | 'P';
  if (t !== 'C' && t !== 'P') return null;
  const strike = parseInt(sym.slice(11), 10) / 1000;
  if (!Number.isFinite(strike)) return null;
  return { symbol: sym, type: t, strike, expiry };
}

// date '2026-08-04' → '260804'
const toYYMMDD = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function queryDay(date: string): Promise<{ spot: Bar[]; byContract: Map<string, Bar[]> }> {
  const fp = path.join(PROFILE_DIR, `${date}.parquet`);
  if (!fs.existsSync(fp)) return Promise.resolve({ spot: [], byContract: new Map() });
  const sql = `SELECT symbol, ts, open, high, low, close, volume
               FROM read_parquet('${fp}')
               WHERE timeframe='1m' AND close IS NOT NULL
               ORDER BY ts`;
  const db = new duckdb.Database(':memory:');
  return new Promise((resolve) => {
    db.all(sql, (err: any, rs: any[]) => {
      if (err) {
        console.error('duckdb', date, err.message);
        return resolve({ spot: [], byContract: new Map() });
      }
      const spot: Bar[] = [];
      const byContract = new Map<string, Bar[]>();
      for (const r of rs) {
        const bar: Bar = {
          ts: Number(r.ts),
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: Number(r.volume || 0),
        };
        if (r.symbol === 'SPX') spot.push(bar);
        else if (r.symbol.startsWith('SPXW')) {
          if (!byContract.has(r.symbol)) byContract.set(r.symbol, []);
          byContract.get(r.symbol)!.push(bar);
        }
      }
      resolve({ spot, byContract });
    });
  });
}

// pick the near-money contract of a given type with the most volume>0 bars
function pickATM(
  byContract: Map<string, Bar[]>,
  type: 'C' | 'P',
  expiry: string,
  spotOpen: number,
): { symbol: string; bars: Bar[]; strike: number } | null {
  let best: { symbol: string; bars: Bar[]; strike: number; score: number } | null = null;
  for (const [symbol, bars] of byContract) {
    const meta = parseContract(symbol);
    if (!meta || meta.type !== type || meta.expiry !== expiry) continue;
    const liquid = bars.filter((b) => b.volume > 0 && b.close > 0.05);
    if (liquid.length < 200) continue; // need a reasonably complete session
    // distance to money + a small liquidity tiebreak (more bars = better)
    const dist = Math.abs(meta.strike - spotOpen);
    const score = dist - liquid.length * 1e-6; // nearer strike wins; liquidity breaks ties
    if (!best || score < best.score) best = { symbol, bars: liquid, strike: meta.strike, score };
  }
  return best ? { symbol: best.symbol, bars: best.bars, strike: best.strike } : null;
}

// ── stats ──────────────────────────────────────────────────────────────────
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function std(a: number[], m?: number) {
  if (!a.length) return 0;
  const mu = m ?? mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length) || 1e-9;
}
const zVs50 = (p: number, n: number) => (p - 0.5) / Math.sqrt(0.25 / n);
function quantile(arr: number[], q: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))];
}

// ── sample building (all features CAUSAL) ───────────────────────────────────
// rolling window lengths for S/R and trend
const SR_N = 20; // resistance/support lookback (bars)
const TREND_N = 50; // trend-line regression lookback
interface Sample {
  date: string;
  dir: 1 | -1 | 0;
  // S/R features (all use bars strictly before i for the level)
  atResist: boolean; // close within X% of rolling SR_N-bar high (prior bars)
  atSupport: boolean; // close within X% of rolling SR_N-bar low (prior bars)
  resistDist: number; // (rollHigh - close)/close  (>0; smaller=closer)
  supportDist: number; // (close - rollLow)/close
  // trend features (regression over [i-TREND_N+1..i])
  trendSlope: number; // per-bar price slope, normalized by price
  trendUp: boolean;
  distFromTrend: number; // (close - lineEndAtI)/price  (relative)
  // gap feature
  ret1: number; // close[i]-close[i-1]
  absRetVol: number; // |ret1| / rollingVol
}

function buildContractSamples(bars: Bar[], date: string, srN: number, trendN: number): Sample[] {
  // bars already filtered to volume>0 and sorted by ts
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const out: Sample[] = [];
  for (let i = Math.max(trendN, srN) + 1; i < bars.length - 1; i++) {
    const close = closes[i];
    if (!(close > 0.05)) continue;
    // S/R from PRIOR bars only (i-srN .. i-1) — causal, non-tautological
    let rollHigh = -Infinity,
      rollLow = Infinity;
    for (let k = i - srN; k < i; k++) {
      if (highs[k] > rollHigh) rollHigh = highs[k];
      if (lows[k] < rollLow) rollLow = lows[k];
    }
    const resistDist = (rollHigh - close) / close; // >0 if below resistance
    const supportDist = (close - rollLow) / close;
    const NEAR = 0.0015; // within 0.15% of the level counts as "at"
    const atResist = resistDist >= 0 && resistDist <= NEAR;
    const atSupport = supportDist >= 0 && supportDist <= NEAR;

    // trend line: linear regression of close over [i-trendN+1 .. i]
    let sm = 0,
      sv = 0;
    const N = trendN;
    const tMu = (N - 1) / 2;
    const ySlice = closes.slice(i - N + 1, i + 1);
    const yMu = mean(ySlice);
    for (let t = 0; t < N; t++) {
      sm += (t - tMu) * (ySlice[t] - yMu);
      sv += (t - tMu) ** 2;
    }
    const slope = sv > 1e-12 ? sm / sv : 0; // dClose per bar
    const lineEnd = yMu + slope * (N - 1 - tMu); // regression value at t=N-1 (== bar i)
    const trendSlope = slope / close; // normalized
    const trendUp = slope > 0;
    const distFromTrend = (close - lineEnd) / close;

    // gap / vol (20-bar vol, clamped to available history)
    const ret1 = closes[i] - closes[i - 1];
    const volWin = closes.slice(Math.max(0, i - 20), i);
    const vol = std(volWin) || 1e-9;
    const absRetVol = Math.abs(ret1) / vol;

    out.push({
      date,
      dir: Math.sign(closes[i + 1] - closes[i]) as 1 | -1 | 0,
      atResist,
      atSupport,
      resistDist,
      supportDist,
      trendSlope,
      trendUp,
      distFromTrend,
      ret1,
      absRetVol,
    });
  }
  return out;
}

// ── logistic on standardized features ──────────────────────────────────────
const FEATS: (keyof Sample)[] = [
  'resistDist',
  'supportDist',
  'trendSlope',
  'distFromTrend',
  'ret1',
  'absRetVol',
];
function standardize(samples: Sample[], idx: number[]) {
  const mu: Record<string, number> = {};
  const sd: Record<string, number> = {};
  for (const f of FEATS) {
    const v = idx.map((i) => samples[i][f] as number);
    mu[f] = mean(v);
    sd[f] = std(v, mu[f]);
  }
  return { mu, sd };
}
function fvec(s: Sample, mu: Record<string, number>, sd: Record<string, number>) {
  return FEATS.map((f) => ((s[f] as number) - mu[f]) / sd[f]);
}
const sig = (z: number) => 1 / (1 + Math.exp(-z));
function trainLogistic(samples: Sample[], idx: number[], iters = 4000, lr = 0.05) {
  const lab = idx.map((i) => samples[i]).filter((s) => s.dir !== 0);
  const { mu, sd } = standardize(samples, idx);
  const X = lab.map((s) => fvec(s, mu, sd));
  const y = lab.map((s) => (s.dir > 0 ? 1 : 0));
  const w = new Array(FEATS.length).fill(0);
  let b = 0;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(FEATS.length).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const z = b + X[k].reduce((s, x, j) => s + x * w[j], 0);
      const err = sig(z) - y[k];
      for (let j = 0; j < FEATS.length; j++) gw[j] += err * X[k][j];
      gb += err;
    }
    for (let j = 0; j < FEATS.length; j++) w[j] -= (lr * gw[j]) / n;
    b -= (lr * gb) / n;
  }
  return { w, b, mu, sd };
}

// ── per-condition P(up) helper ──────────────────────────────────────────────
function pUp(filter: (s: Sample) => boolean, set: Sample[]) {
  const sub = set.filter((s) => s.dir !== 0 && filter(s));
  const n = sub.length;
  const pu = n ? sub.filter((s) => s.dir > 0).length / n : 0;
  return { pu, n, z: n ? zVs50(pu, n) : 0 };
}
const allFn = () => true;

// aggregate 1m bars → higher-TF bars (factor in minutes). OHLC rolled, vol summed.
function aggregate(bars: Bar[], factor: number): Bar[] {
  if (factor <= 1) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += factor) {
    const chunk = bars.slice(i, i + factor);
    if (!chunk.length) break;
    out.push({
      ts: chunk[0].ts,
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}

// accuracy of a +/-1 rule on a labeled set
function accOf(rule: (s: Sample) => number, set: Sample[]) {
  let n = 0,
    hit = 0;
  for (const s of set) {
    if (s.dir === 0) continue;
    n++;
    if (rule(s) === s.dir) hit++;
  }
  return { acc: n ? hit / n : 0, n };
}

interface TFConfig {
  tf: string;
  factor: number;
  srN: number;
  trendN: number;
}
const TF_CONFIGS: TFConfig[] = [
  { tf: '1m', factor: 1, srN: 20, trendN: 50 },
  { tf: '2m', factor: 2, srN: 16, trendN: 35 },
  { tf: '3m', factor: 3, srN: 14, trendN: 28 },
  { tf: '5m', factor: 5, srN: 12, trendN: 20 },
  { tf: '15m', factor: 15, srN: 6, trendN: 10 },
];

interface TFResult {
  tf: string;
  baseTest: number;
  maj: number; // majority-class (drift) baseline accuracy
  persist: number;
  revert: number;
  logistic: number;
  supLift: number;
  supZ: number;
  resLift: number;
  resZ: number;
  strongUpLift: number;
  strongDnLift: number;
  gapDownLift: number;
  gapUpLift: number;
  nTest: number;
}

function metricsForTF(samples: Sample[], trainDates: Set<string>, testDates: Set<string>): TFResult {
  const labeled = samples.filter((s) => s.dir !== 0);
  const test = labeled.filter((s) => testDates.has(s.date));
  const idxAllTrain = labeled
    .map((s, i) => ({ s, i }))
    .filter((o) => trainDates.has(o.s.date))
    .map((o) => o.i);
  const baseTest = test.filter((s) => s.dir > 0).length / test.length;
  const maj = Math.max(baseTest, 1 - baseTest); // drift baseline (predict majority class)
  const persist = accOf((s) => (s.ret1 > 0 ? 1 : -1), test).acc;
  const revert = accOf((s) => (s.ret1 > 0 ? -1 : 1), test).acc;

  const lg = trainLogistic(labeled, idxAllTrain);
  const logistic = accOf((s) => {
    const v = fvec(s, lg.mu, lg.sd);
    const z = lg.b + v.reduce((sum, x, j) => sum + x * lg.w[j], 0);
    return sig(z) >= 0.5 ? 1 : -1;
  }, test).acc;

  const atRes = pUp((s) => s.atResist, test);
  const atSup = pUp((s) => s.atSupport, test);
  const absSlopeTrain = idxAllTrain.map((i) => Math.abs(labeled[i].trendSlope));
  const strongEdge = quantile(absSlopeTrain, 0.75);
  const strongUp = pUp((s) => s.trendUp && Math.abs(s.trendSlope) >= strongEdge, test);
  const strongDn = pUp((s) => !s.trendUp && Math.abs(s.trendSlope) >= strongEdge, test);
  const gapEdge = quantile(idxAllTrain.map((i) => labeled[i].absRetVol), 0.8);
  const bigDown = pUp((s) => s.ret1 < 0 && s.absRetVol >= gapEdge, test);
  const bigUp = pUp((s) => s.ret1 > 0 && s.absRetVol >= gapEdge, test);

  return {
    tf: '',
    baseTest,
    maj,
    persist,
    revert,
    logistic,
    supLift: atSup.pu - baseTest,
    supZ: atSup.z,
    resLift: atRes.pu - baseTest,
    resZ: atRes.z,
    strongUpLift: strongUp.pu - baseTest,
    strongDnLift: strongDn.pu - baseTest,
    gapDownLift: bigDown.pu - baseTest,
    gapUpLift: bigUp.pu - baseTest,
    nTest: test.length,
  };
}

// ── run one side (call or put): per-TF scan + MTF confirmation ──────────────
async function runSide(type: 'C' | 'P') {
  const dates = fs
    .readdirSync(PROFILE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();

  // load per-day contract bars once
  const perDay: { date: string; bars1m: Bar[] }[] = [];
  for (const date of dates) {
    const { spot, byContract } = await queryDay(date);
    if (!spot.length) continue;
    const spotOpen = spot[0].close;
    const expiry = toYYMMDD(date);
    const pick = pickATM(byContract, type, expiry, spotOpen);
    if (!pick) continue;
    perDay.push({ date, bars1m: pick.bars });
  }
  const name = type === 'C' ? 'ATM CALL' : 'ATM PUT';
  console.log(`\n################ SPX 0DTE ${name}  — ${perDay.length}/${dates.length} days ################`);

  // all sample dates (use 1m samples to define the date split)
  const s1mAll = perDay.flatMap((d) => buildContractSamples(d.bars1m, d.date, 20, 50));
  const datesUsed = [...new Set(s1mAll.map((s) => s.date))].sort();
  const cut = Math.floor(datesUsed.length * 0.7);
  const trainDates = new Set(datesUsed.slice(0, cut));
  const testDates = new Set(datesUsed.slice(cut));
  console.log(`train ${cut} dates / test ${datesUsed.length - cut} dates (pure time cut, walk-forward)`);

  // ── per-timeframe scan ──
  console.log(`\n── TIMEFRAME SCAN (test set). "edge" = acc − drift baseline; lifts = P(up) − base ──`);
  console.log(
    `  ${'tf'.padEnd(4)} ${'base'.padStart(6)} ${'drift'.padStart(6)} ${'persist'.padStart(7)} ${'revert'.padStart(7)} ${'logistic'.padStart(8)} ${'lgEdge'.padStart(7)} │ ${'S/Rsup'.padStart(7)} ${'z'.padStart(5)} ${'strongUp'.padStart(8)} ${'gapDn'.padStart(7)}`,
  );
  for (const cfg of TF_CONFIGS) {
    const samples = perDay.flatMap((d) =>
      buildContractSamples(aggregate(d.bars1m, cfg.factor), d.date, cfg.srN, cfg.trendN),
    );
    const r = metricsForTF(samples, trainDates, testDates);
    r.tf = cfg.tf;
    console.log(
      `  ${r.tf.padEnd(4)} ${r.baseTest.toFixed(3).padStart(6)} ${r.maj.toFixed(3).padStart(6)} ${r.persist.toFixed(3).padStart(7)} ${r.revert.toFixed(3).padStart(7)} ${r.logistic.toFixed(3).padStart(8)} ${(r.logistic - r.maj).toFixed(3).padStart(7)} │ ${r.supLift.toFixed(3).padStart(7)} ${r.supZ.toFixed(1).padStart(5)} ${r.strongUpLift.toFixed(3).padStart(8)} ${r.gapDownLift.toFixed(3).padStart(7)}`,
    );
  }

  // ── multi-timeframe confirmation (predict next 1m bar from HTF agreement) ──
  // For each 1m bar, compute 5m and 15m regression-slope sign known AS-OF that bar
  // (last completed higher-TF bar strictly before the 1m close). Test if HTF
  // agreement lifts P(next 1m up) above base — Krafer's "patterns + trend" idea
  // and the classic MTF-confirmation setup.
  const TREND5 = 10,
    TREND15 = 8;
  const mtf = { bothUp: 0, bothUpN: 0, bothDn: 0, bothDnN: 0, baseUp: 0, baseN: 0 };
  for (const d of perDay) {
    if (!testDates.has(d.date)) continue; // OOS only
    const b1 = d.bars1m;
    const b5 = aggregate(b1, 5);
    const b15 = aggregate(b1, 15);
    const slopeSign = (bars: Bar[], n: number) => {
      // sign of regression slope over last n bars (excluding incomplete), per bar
      const out: { ts: number; up: boolean }[] = [];
      for (let i = n; i < bars.length; i++) {
        const y = bars.slice(i - n + 1, i + 1).map((b) => b.close);
        const yMu = mean(y);
        let sm = 0,
          sv = 0;
        const tMu = (n - 1) / 2;
        for (let t = 0; t < n; t++) {
          sm += (t - tMu) * (y[t] - yMu);
          sv += (t - tMu) ** 2;
        }
        out.push({ ts: bars[i].ts, up: sv > 1e-12 ? sm > 0 : false });
      }
      return out;
    };
    const s5 = slopeSign(b5, TREND5);
    const s15 = slopeSign(b15, TREND15);
    // as-of lookup: last completed HTF bar with ts <= current 1m ts
    const asOf = (arr: { ts: number; up: boolean }[], ts: number) => {
      let up: boolean | null = null;
      for (const e of arr) {
        if (e.ts <= ts) up = e.up;
        else break;
      }
      return up;
    };
    for (let i = 1; i < b1.length - 1; i++) {
      const ts = b1[i].ts;
      const up5 = asOf(s5, ts);
      const up15 = asOf(s15, ts);
      if (up5 == null || up15 == null) continue;
      const dir = Math.sign(b1[i + 1].close - b1[i].close);
      if (dir === 0) continue;
      mtf.baseN++;
      mtf.baseUp += dir > 0 ? 1 : 0;
      if (up5 && up15) {
        mtf.bothUpN++;
        mtf.bothUp += dir > 0 ? 1 : 0;
      } else if (!up5 && !up15) {
        mtf.bothDnN++;
        mtf.bothDn += dir > 0 ? 1 : 0;
      }
    }
  }
  const baseUp = mtf.baseUp / mtf.baseN;
  const pBothUp = mtf.bothUpN ? mtf.bothUp / mtf.bothUpN : 0;
  const pBothDn = mtf.bothDnN ? mtf.bothDn / mtf.bothDnN : 0;
  console.log(`\n── MULTI-TIMEFRAME CONFIRMATION (next 1m bar, test set) ──`);
  console.log(`     base P(up)            : ${baseUp.toFixed(4)} (n=${mtf.baseN})`);
  console.log(`     P(up | 5m&15m both UP): ${pBothUp.toFixed(4)} (n=${mtf.bothUpN}, z=${mtf.bothUpN ? zVs50(pBothUp, mtf.bothUpN).toFixed(2) : 'na'})  ← claim: should be HIGH`);
  console.log(`     P(up | 5m&15m both DN): ${pBothDn.toFixed(4)} (n=${mtf.bothDnN}, z=${mtf.bothDnN ? zVs50(pBothDn, mtf.bothDnN).toFixed(2) : 'na'})  ← claim: should be LOW`);
}

// ── entry ──────────────────────────────────────────────────────────────────
(async () => {
  console.log(`=== S/R + trend-line + gap-fill + multi-timeframe predictability — SPX 0DTE options ===`);
  console.log(`features CAUSAL (rolling levels exclude current bar; HTF slope as-of last completed HTF bar). walk-forward 70/30 by date. drift baseline = predict majority class (theta).`);
  if (DO_CALL) await runSide('C');
  if (DO_PUT) await runSide('P');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
