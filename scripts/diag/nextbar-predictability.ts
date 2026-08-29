/**
 * nextbar-predictability.ts
 *
 * Tests the falsifiable core of Krafer's video (youtu.be/0yNfaixWyf4):
 *   1. 1-minute chart "patterns" arise from order-book gaps (math), and gaps
 *      get filled → large 1m moves should mean-revert next bar.
 *   2. Short timeframes are more predictable because psychology dominates on
 *      longer horizons.
 *   3. A neural net trained on ~35 days of 1m data can predict the next
 *      candle's close autoregressively (ChatGPT-style) on unseen data.
 *
 * We do NOT build a deep net. We build the *honest benchmark the video is
 * missing*: can ANY cheap model beat the efficient-markets naive baselines
 * (random-walk / no-change forecast) at predicting next-bar DIRECTION and
 * next-bar CLOSE, measured strictly out-of-sample?
 *
 * Why this design
 * ───────────────
 * The video's own cautionary tale is its genetic-algo bots that "learned to
 * hide their losses" — an in-sample illusion. The cure is the same one this
 * repo's fib/gap studies use: only ever score on a TEST slice the model and
 * every threshold selection never saw. Train on the first ~70% of dates,
 * test on the last ~30%. Dates are sorted; the split is a pure time cut, so
 * no future bar reaches a past decision.
 *
 * We predict the index series (SPX / NDX), which is not directly tradeable —
 * so "edge" here means statistical predictability of next-bar direction /
 * level, not P&L. That is exactly the claim the video makes ("predict the
 * close of one candle"). Transaction costs are noted but not modeled,
 * because the index isn't tradeable and the question is predictability.
 *
 * Indicators (HMA, RSI, BB, VWAP, ATR, KC) are precomputed in the parquet and
 * are causal at bar i's close (computed from bars ≤ i) — no look-ahead.
 *
 * Usage:
 *   npx tsx scripts/diag/nextbar-predictability.ts --symbol SPX
 *   npx tsx scripts/diag/nextbar-predictability.ts --symbol NDX
 */
import * as path from 'path';

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const symArg = (argv.find((a) => a.startsWith('--symbol=')) || '--symbol=SPX').split(
  '=',
)[1] as 'SPX' | 'NDX';
const PROFILE = symArg === 'NDX' ? 'ndx-0dte' : 'spx-0dte';
const SYM = symArg;

// ── duckdb (optional dep, like the rest of the repo) ───────────────────────
let duckdb: any;
try {
  duckdb = require('duckdb');
} catch {
  console.error('duckdb node module not installed. npm i duckdb');
  process.exit(1);
}

interface Row {
  ts: number;
  close: number;
  open: number;
  rsi14: number;
  hma3: number;
  hma5: number;
  vwap: number;
  bbUpper: number;
  bbLower: number;
  atr14: number;
}

function queryBars(): Row[] {
  const dir = path.join(process.cwd(), 'data/parquet/bars', PROFILE, '*.parquet');
  const sql = `
    SELECT ts, open, close, rsi14, hma3, hma5, vwap,
           bbUpper, bbLower, atr14
    FROM read_parquet('${dir}')
    WHERE symbol='${SYM}' AND timeframe='1m'
      AND close IS NOT NULL AND atr14 IS NOT NULL AND atr14 > 0
      AND vwap IS NOT NULL
    ORDER BY ts`;
  const db = new duckdb.Database(':memory:');
  return new Promise<Row[]>((resolve, reject) => {
    db.all(sql, (err: any, rows: any[]) => {
      if (err) reject(err);
      else
        resolve(
          rows.map((r) => ({
            ts: Number(r.ts),
            open: r.open,
            close: r.close,
            rsi14: r.rsi14,
            hma3: r.hma3,
            hma5: r.hma5,
            vwap: r.vwap,
            bbUpper: r.bbUpper,
            bbLower: r.bbLower,
            atr14: r.atr14,
          })),
        );
    });
  }) as unknown as Row[];
}

// ── stats helpers ──────────────────────────────────────────────────────────
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function std(a: number[], m?: number) {
  if (!a.length) return 0;
  const mu = m ?? mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length) || 1e-9;
}
// z-score of a win rate vs 50% given N trials
const zVs50 = (p: number, n: number) => (p - 0.5) / Math.sqrt(0.25 / n);

// ── feature engineering (all causal: close[i], indicators[i], ret up to i) ──
interface Sample {
  // label
  dir: 1 | -1 | 0; // sign(close[i+1] - close[i])
  nextClose: number;
  close: number;
  // features
  ret1: number; // close[i] - close[i-1]
  absRetAtr: number; // |ret1| / atr  (the "gap" magnitude — video's claim)
  vwapDev: number; // (close - vwap) / atr
  rsi: number;
  hmaSlope: number; // (hma3 - hma5) / atr  (short momentum)
  bbPctb: number; // (close - bbLower) / (bbUpper - bbLower)
  minFromOpen: number; // bar index within day (time-of-day regime)
}

function buildSamples(rows: Row[]): Sample[] {
  // group by UTC date (RTH session lands entirely in one UTC day)
  const byDate = new Map<string, Row[]>();
  for (const r of rows) {
    const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(r);
  }
  const dates = [...byDate.keys()].sort();
  const out: Sample[] = [];
  for (const d of dates) {
    const day = byDate.get(d)!; // already ts-sorted
    for (let i = 1; i < day.length - 1; i++) {
      const cur = day[i];
      const prev = day[i - 1];
      const next = day[i + 1];
      const atr = cur.atr14 || prev.atr14 || 1e-9;
      const ret1 = cur.close - prev.close;
      const bbW = cur.bbUpper - cur.bbLower;
      out.push({
        dir: Math.sign(next.close - cur.close) as 1 | -1 | 0,
        nextClose: next.close,
        close: cur.close,
        ret1,
        absRetAtr: Math.abs(ret1) / atr,
        vwapDev: (cur.close - cur.vwap) / atr,
        rsi: cur.rsi14,
        hmaSlope: (cur.hma3 - cur.hma5) / atr,
        bbPctb: bbW > 1e-9 ? (cur.close - cur.bbLower) / bbW : 0.5,
        minFromOpen: i,
      });
    }
  }
  return out;
}

// ── baseline classifiers ───────────────────────────────────────────────────
// accuracy of "predict dir = guess" against true dir, ignoring dir==0 ties
function acc(pred: (s: Sample) => number, samples: Sample[]) {
  let n = 0,
    hit = 0;
  for (const s of samples) {
    if (s.dir === 0) continue;
    n++;
    if (pred(s) === s.dir) hit++;
  }
  return { acc: n ? hit / n : 0, n };
}

// ── feature-bucket analysis (the gap-fill test) ────────────────────────────
// Pick quantile thresholds on TRAIN, measure P(up) per bucket on a target set.
function quantile(arr: number[], q: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * q)];
}

interface BucketRow {
  label: string;
  nTrain: number;
  pUpTrain: number;
  nTest: number;
  pUpTest: number;
  zTest: number;
}
function bucketReport(
  samples: Sample[],
  trainIdx: Set<number>,
  testIdx: Set<number>,
  featName: keyof Sample,
  edges: number[],
  bucketLabel: (lo: number, hi: number, idx: number) => string,
): BucketRow[] {
  const allEdges = [-Infinity, ...edges, Infinity];
  const rows: BucketRow[] = [];
  for (let b = 0; b < allEdges.length - 1; b++) {
    const lo = allEdges[b],
      hi = allEdges[b + 1];
    const inB = (v: number) => v > lo && v <= hi;
    const tr = [...trainIdx]
      .map((i) => samples[i])
      .filter((s) => inB(s[featName] as number) && s.dir !== 0);
    const te = [...testIdx]
      .map((i) => samples[i])
      .filter((s) => inB(s[featName] as number) && s.dir !== 0);
    const pUpTr = tr.length ? tr.filter((s) => s.dir > 0).length / tr.length : 0;
    const pUpTe = te.length ? te.filter((s) => s.dir > 0).length / te.length : 0;
    rows.push({
      label: bucketLabel(lo, hi, b),
      nTrain: tr.length,
      pUpTrain: pUpTr,
      nTest: te.length,
      pUpTest: pUpTe,
      zTest: te.length ? zVs50(pUpTe, te.length) : 0,
    });
  }
  return rows;
}

// ── logistic regression (single-layer net = honest lightweight analog) ──────
const FEATS: (keyof Sample)[] = [
  'ret1',
  'absRetAtr',
  'vwapDev',
  'rsi',
  'hmaSlope',
  'bbPctb',
  'minFromOpen',
];

function standardize(samples: Sample[], idx: number[]) {
  const mu: Record<string, number> = {};
  const sd: Record<string, number> = {};
  for (const f of FEATS) {
    const vals = idx.map((i) => samples[i][f] as number);
    mu[f] = mean(vals);
    sd[f] = std(vals, mu[f]);
  }
  return { mu, sd };
}

function featsVec(s: Sample, mu: Record<string, number>, sd: Record<string, number>) {
  return FEATS.map((f) => ((s[f] as number) - mu[f]) / sd[f]);
}

function sigmoid(z: number) {
  return 1 / (1 + Math.exp(-z));
}

// train logistic on labeled (dir != 0) train samples; return weights + bias
function trainLogistic(samples: Sample[], idx: number[], iters = 4000, lr = 0.05) {
  const labeled = idx.map((i) => samples[i]).filter((s) => s.dir !== 0);
  const { mu, sd } = standardize(samples, idx);
  const X = labeled.map((s) => featsVec(s, mu, sd));
  const y = labeled.map((s) => (s.dir > 0 ? 1 : 0));
  const w = new Array(FEATS.length).fill(0);
  let b = 0;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(FEATS.length).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const z = b + X[k].reduce((s, x, j) => s + x * w[j], 0);
      const err = sigmoid(z) - y[k];
      for (let j = 0; j < FEATS.length; j++) gw[j] += err * X[k][j];
      gb += err;
    }
    for (let j = 0; j < FEATS.length; j++) w[j] -= (lr * gw[j]) / n;
    b -= (lr * gb) / n;
  }
  return { w, b, mu, sd };
}

// linear regression on the standardized PRICE CHANGE (nextClose - close).
// Predicting the level (~5000) diverges under gradient descent; predicting the
// change is well-conditioned AND is the right benchmark — the no-change
// forecast is "delta = 0", so we compare RMSE of our predicted delta vs 0.
function trainLinear(samples: Sample[], idx: number[], iters = 4000, lr = 0.05) {
  const { mu, sd } = standardize(samples, idx);
  const X = idx.map((i) => samples[i]).map((s) => featsVec(s, mu, sd));
  const yRaw = idx.map((i) => samples[i].nextClose - samples[i].close);
  const yMu = mean(yRaw);
  const ySd = std(yRaw, yMu) || 1;
  const y = yRaw.map((v) => (v - yMu) / ySd); // standardized target
  const w = new Array(FEATS.length).fill(0);
  let b = 0;
  const n = X.length;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(FEATS.length).fill(0);
    let gb = 0;
    for (let k = 0; k < n; k++) {
      const pred = b + X[k].reduce((s, x, j) => s + x * w[j], 0);
      const err = pred - y[k];
      for (let j = 0; j < FEATS.length; j++) gw[j] += err * X[k][j];
      gb += err;
    }
    for (let j = 0; j < FEATS.length; j++) w[j] -= (lr * gw[j]) / n;
    b -= (lr * gb) / n;
  }
  return { w, b, mu, sd, yMu, ySd };
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== nextbar-predictability — ${SYM} (profile ${PROFILE}) ===`);
  const rows = await queryBars();
  const datesAsc = [...new Set(rows.map((r) => new Date(r.ts * 1000).toISOString().slice(0, 10)))].sort();
  const samples = buildSamples(rows);
  console.log(`bars=${rows.length}  dates=${datesAsc.length}  samples=${samples.length}`);

  // walk-forward split: first 70% dates train, last 30% test (pure time cut)
  const cutIdx = Math.floor(datesAsc.length * 0.7);
  const trainDateSet = new Set(datesAsc.slice(0, cutIdx));
  const testDateSet = new Set(datesAsc.slice(cutIdx));
  // map sample → date via ts isn't stored on Sample; rebuild via index parallel
  // (samples were built date-by-date in sorted order, so we can tag them now)
  const sampleDate: string[] = (() => {
    const out: string[] = [];
    const byDate = new Map<string, Row[]>();
    for (const r of rows) {
      const d = new Date(r.ts * 1000).toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d)!.push(r);
    }
    for (const d of [...byDate.keys()].sort()) {
      const day = byDate.get(d)!;
      for (let i = 1; i < day.length - 1; i++) out.push(d);
    }
    return out;
  })();

  const trainIdx: number[] = [];
  const testIdx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (trainDateSet.has(sampleDate[i])) trainIdx.push(i);
    else if (testDateSet.has(sampleDate[i])) testIdx.push(i);
  }
  const trainSet = trainIdx.map((i) => samples[i]);
  const testSet = testIdx.map((i) => samples[i]);
  console.log(
    `train dates=${cutIdx} samples=${trainIdx.length}   test dates=${datesAsc.length - cutIdx} samples=${testIdx.length}`,
  );

  // ── baselines ──
  const upFull = samples.filter((s) => s.dir > 0).length;
  const dirNFull = samples.filter((s) => s.dir !== 0).length;
  const baseRateFull = upFull / dirNFull;
  const upTest = testSet.filter((s) => s.dir > 0).length;
  const dirNTest = testSet.filter((s) => s.dir !== 0).length;
  const baseRateTest = upTest / dirNTest;

  console.log(`\n--- BASE RATE P(next bar up) ---`);
  console.log(`  full : ${baseRateFull.toFixed(4)} (n=${dirNFull})`);
  console.log(`  test : ${baseRateTest.toFixed(4)} (n=${dirNTest})`);

  const persistFull = acc((s) => (s.ret1 > 0 ? 1 : -1), samples);
  const persistTest = acc((s) => (s.ret1 > 0 ? 1 : -1), testSet);
  const revertFull = acc((s) => (s.ret1 > 0 ? -1 : 1), samples);
  const revertTest = acc((s) => (s.ret1 > 0 ? -1 : 1), testSet);
  const noChangeTest = baseRateTest; // always predict up ≈ no-change-direction baseline
  console.log(`\n--- NAIVE DIRECTION BASELINES (test-set accuracy) ---`);
  console.log(`  always-up        : ${baseRateTest.toFixed(4)}  (= no-change forecast)`);
  console.log(`  persistence      : ${persistTest.acc.toFixed(4)} (full ${persistFull.acc.toFixed(4)})  ← random walk`);
  console.log(`  reversion        : ${revertTest.acc.toFixed(4)} (full ${revertFull.acc.toFixed(4)})  ← gap-fill`);

  // ── logistic model ──
  const lg = trainLogistic(samples, trainIdx);
  const lgTest = acc(
    (s) => {
      const v = featsVec(s, lg.mu, lg.sd);
      const z = lg.b + v.reduce((sum, x, j) => sum + x * lg.w[j], 0);
      return sigmoid(z) >= 0.5 ? 1 : -1;
    },
    testSet,
  );
  const lgTrain = acc(
    (s) => {
      const v = featsVec(s, lg.mu, lg.sd);
      const z = lg.b + v.reduce((sum, x, j) => sum + x * lg.w[j], 0);
      return sigmoid(z) >= 0.5 ? 1 : -1;
    },
    trainSet,
  );

  // ── linear next-CHANGE model vs no-change forecast (delta=0) ──
  const ln = trainLinear(samples, trainIdx);
  const predDelta = (s: Sample) => {
    const v = featsVec(s, ln.mu, ln.sd);
    const zStd = ln.b + v.reduce((sum, x, j) => sum + x * ln.w[j], 0);
    return ln.yMu + ln.ySd * zStd; // un-standardize → points
  };
  const rmse = (xs: Sample[]) => {
    let noChange = 0,
      model = 0;
    for (const s of xs) {
      const actual = s.nextClose - s.close;
      noChange += actual ** 2; // no-change forecast predicts delta = 0
      model += (actual - predDelta(s)) ** 2;
    }
    return {
      noChange: Math.sqrt(noChange / xs.length),
      model: Math.sqrt(model / xs.length),
    };
  };
  const rmseTest = rmse(testSet);
  // directional accuracy of the linear change forecast
  const lnDirTest = acc((s) => (predDelta(s) >= 0 ? 1 : -1), testSet);

  console.log(`\n--- MODELS (trained on train slice, scored on test slice) ---`);
  console.log(
    `  logistic dir acc : test ${lgTest.acc.toFixed(4)}  train ${lgTrain.acc.toFixed(4)}  (n=${lgTest.n})`,
  );
  console.log(
    `  linear  dir acc  : test ${lnDirTest.acc.toFixed(4)}  (n=${lnDirTest.n})`,
  );
  console.log(`  next-close RMSE  :`);
  console.log(`     no-change fcst: ${rmseTest.noChange.toFixed(3)} pts`);
  console.log(`     linear model  : ${rmseTest.model.toFixed(3)} pts`);
  console.log(
    `     model vs no-chg: ${((rmseTest.model / rmseTest.noChange - 1) * 100).toFixed(2)}%  (negative = beats random walk)`,
  );

  // ── gap-fill bucket (the video's specific claim) ──
  const trainIdxSet = new Set(trainIdx);
  const testIdxSet = new Set(testIdx);
  console.log(`\n--- GAP-FILL TEST: P(up) by |1m return| / ATR bucket (video's claim) ---`);
  console.log(`    (large move → should revert: low P(up) after up-move, high after down-move)`);
  const gapEdges = [0.15, 0.3, 0.6, 1.0]; // |1m return| in ATR units (σ-multiples)
  const gapRows = bucketReport(
    samples,
    trainIdxSet,
    testIdxSet,
    'absRetAtr',
    gapEdges,
    (lo, _hi, i) =>
      (i === 0 ? '|ret|<0.15σ' : `${lo.toFixed(2)}–${gapEdges[i] ?? '∞'}σ`),
  );
  console.log(
    `    ${'bucket'.padEnd(14)} ${'nTrain'.padStart(7)} ${'PupTr'.padStart(7)} ${'nTest'.padStart(7)} ${'PupTe'.padStart(7)} ${'zTe'.padStart(7)}`,
  );
  for (const r of gapRows)
    console.log(
      `    ${r.label.padEnd(14)} ${String(r.nTrain).padStart(7)} ${r.pUpTrain.toFixed(3).padStart(7)} ${String(r.nTest).padStart(7)} ${r.pUpTest.toFixed(3).padStart(7)} ${r.zTest.toFixed(2).padStart(7)}`,
    );

  // Conditional gap-fill: split by SIGN of the move (the actual reversion signal)
  console.log(`\n--- GAP-FILL BY SIGN (P(up | last bar was big DOWN) vs base rate) ---`);
  const bigDown = [...testIdxSet]
    .map((i) => samples[i])
    .filter((s) => s.dir !== 0 && s.ret1 < 0 && s.absRetAtr > 0.6);
  const bigUp = [...testIdxSet]
    .map((i) => samples[i])
    .filter((s) => s.dir !== 0 && s.ret1 > 0 && s.absRetAtr > 0.6);
  const pUpAfterDown = bigDown.length ? bigDown.filter((s) => s.dir > 0).length / bigDown.length : 0;
  const pUpAfterUp = bigUp.length ? bigUp.filter((s) => s.dir > 0).length / bigUp.length : 0;
  console.log(
    `    base rate P(up) test      : ${baseRateTest.toFixed(4)}`,
  );
  console.log(
    `    P(up | big down, |ret|>.6σ): ${pUpAfterDown.toFixed(4)}  n=${bigDown.length}  z=${bigDown.length ? zVs50(pUpAfterDown, bigDown.length).toFixed(2) : 'na'}`,
  );
  console.log(
    `    P(up | big up,   |ret|>.6σ): ${pUpAfterUp.toFixed(4)}  n=${bigUp.length}  z=${bigUp.length ? zVs50(pUpAfterUp, bigUp.length).toFixed(2) : 'na'}`,
  );

  // ── feature buckets: time of day, vwap dev, rsi ──
  console.log(`\n--- P(up) by TIME OF DAY (open/midday/close regime) ---`);
  const tod = bucketReport(
    samples,
    trainIdxSet,
    testIdxSet,
    'minFromOpen',
    [30, 150, 330],
    (_lo, _hi, i) =>
      ['open(0-30)', 'early(30-150)', 'mid(150-330)', 'late(330+)'][i] || `seg${i}`,
  );
  for (const r of tod)
    console.log(
      `    ${r.label.padEnd(16)} PupTe=${r.pUpTest.toFixed(3)} (n=${r.nTest}, z=${r.zTest.toFixed(2)})`,
    );

  console.log(`\n--- P(up) by VWAP deviation (train-quintile edges, in ATR units) ---`);
  const trainVwap = [...trainIdxSet].map((i) => samples[i].vwapDev);
  const vwapEdges = [0.2, 0.4, 0.6, 0.8].map((q) => quantile(trainVwap, q));
  const vwap = bucketReport(
    samples,
    trainIdxSet,
    testIdxSet,
    'vwapDev',
    vwapEdges,
    (lo, hi, i) => {
      const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : x > 0 ? '+∞' : '-∞');
      return i === 0 || i === vwapEdges.length ? `dev(${f(lo)},${f(hi)})` : `dev[${f(lo)},${f(hi)})`;
    },
  );
  for (const r of vwap)
    console.log(
      `    ${r.label.padEnd(20)} PupTe=${r.pUpTest.toFixed(3)} (n=${r.nTest}, z=${r.zTest.toFixed(2)})`,
    );

  // ── verdict ──
  const bestDir = Math.max(baseRateTest, persistTest.acc, revertTest.acc, lgTest.acc, lnDirTest.acc);
  const edgeOverCoin = bestDir - 0.5;
  console.log(`\n=== VERDICT — ${SYM} ===`);
  console.log(`  best test direction accuracy : ${bestDir.toFixed(4)}`);
  console.log(`  edge over 50%                : ${(edgeOverCoin * 100).toFixed(2)} pp`);
  console.log(`  next-close RMSE: model ${rmseTest.model.toFixed(2)} vs no-change ${rmseTest.noChange.toFixed(2)} → ${((rmseTest.model / rmseTest.noChange - 1) * 100).toFixed(2)}%`);
  console.log(`  (note: ${SYM} is an INDEX, not tradeable; "edge" = statistical predictability, not P&L)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
