/**
 * sr-trend-strategy-pnl.ts
 *
 * The TRADEABLE test of Krafer's video premise (youtu.be/0yNfaixWyf4) —
 * "patterns reduce to resistance lines + trend lines + gaps." The companion
 * sr-trend-predict-contract.ts only measured next-bar DIRECTION statistics.
 * This script goes the rest of the way: it builds actual ENTRY SIGNALS, fills
 * them at the next bar's OPEN, applies the repo's real friction model, holds
 * one bar, exits at the next bar's CLOSE, and sums P&L — all out-of-sample.
 *
 * Signals (all causal: levels/slope use bars ≤ i; fill at open[i+1] = no look-ahead):
 *   SR_SUPPORT  — close within NEAR% of the srN-bar rolling LOW  → expect UP → long CALL
 *   SR_RESIST   — close within NEAR% of the srN-bar rolling HIGH → expect DN → long PUT
 *   TREND_UP    — regression slope strongly positive (top train quartile)  → long CALL
 *   TREND_DN    — regression slope strongly negative                     → long PUT
 *   GAP_DOWN    — large down 1m move (top train quintile |ret|/vol) → expect bounce → long CALL
 *   GAP_UP      — large up   1m move                       → expect fade    → long PUT
 *
 * Friction (from src/core/friction.ts): scaled half-spread = max($0.05, price×1%),
 *   commission $0.35/side. Round-turn floor ≈ $0.80/contract. Entry fills at
 *   mid+halfSpread; exit at mid−halfSpread; minus 2×commission.
 *
 * Hold = 1 bar (the predicted candle — faithful to the video). Baselines on the
 * same test bars: (a) always-long-CALL every bar (drift capture, net friction),
 *   (b) buy-&-hold CALL from bar 60 → last bar (one trade/day).
 *
 * Walk-forward: train on first 70% of dates (sets NEAR%, slope & gap thresholds),
 * trade the last 30%. One contract per trade, no compounding.
 *
 * Usage:
 *   npx tsx scripts/diag/sr-trend-strategy-pnl.ts
 */
import * as fs from 'fs';
import * as path from 'path';

let duckdb: any;
try {
  duckdb = require('duckdb');
} catch {
  console.error('duckdb node module not installed. npm i duckdb');
  process.exit(1);
}

const PROFILE_DIR = path.join(process.cwd(), 'data/parquet/bars/spx-0dte');
const HALF_SPREAD_FLOOR = 0.05;
const SPREAD_PCT = 0.01;
const COMMISSION_SIDE = 0.35;
const NEAR_BASE = 0.0015; // 0.15% "at level" band

// ── bar + contract parsing (same as sr-trend-predict-contract.ts) ───────────
interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
function parseContract(sym: string) {
  if (!sym.startsWith('SPXW') || sym.length < 15) return null;
  const expiry = sym.slice(4, 10);
  const t = sym[10];
  if (t !== 'C' && t !== 'P') return null;
  const strike = parseInt(sym.slice(11), 10) / 1000;
  if (!Number.isFinite(strike)) return null;
  return { type: t as 'C' | 'P', strike, expiry };
}
const toYYMMDD = (d: string) => d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10);

function queryDay(date: string): Promise<{ spot: Bar[]; byContract: Map<string, Bar[]> }> {
  const fp = path.join(PROFILE_DIR, `${date}.parquet`);
  if (!fs.existsSync(fp)) return Promise.resolve({ spot: [], byContract: new Map() });
  const sql = `SELECT symbol, ts, open, high, low, close, volume FROM read_parquet('${fp}')
               WHERE timeframe='1m' AND close IS NOT NULL ORDER BY ts`;
  const db = new duckdb.Database(':memory:');
  return new Promise((resolve) => {
    db.all(sql, (err: any, rs: any[]) => {
      if (err) return resolve({ spot: [], byContract: new Map() });
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
function pickATM(byContract: Map<string, Bar[]>, type: 'C' | 'P', expiry: string, spotOpen: number) {
  let best: { bars: Bar[]; strike: number; score: number } | null = null;
  for (const [symbol, bars] of byContract) {
    const m = parseContract(symbol);
    if (!m || m.type !== type || m.expiry !== expiry) continue;
    const liquid = bars.filter((b) => b.volume > 0 && b.close > 0.05);
    if (liquid.length < 200) continue;
    const score = Math.abs(m.strike - spotOpen) - liquid.length * 1e-6;
    if (!best || score < best.score) best = { bars: liquid, strike: m.strike, score };
  }
  return best ? best.bars : null;
}
function aggregate(bars: Bar[], factor: number): Bar[] {
  if (factor <= 1) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += factor) {
    const c = bars.slice(i, i + factor);
    if (!c.length) break;
    out.push({
      ts: c[0].ts,
      open: c[0].open,
      high: Math.max(...c.map((b) => b.high)),
      low: Math.min(...c.map((b) => b.low)),
      close: c[c.length - 1].close,
      volume: c.reduce((s, b) => s + b.volume, 0),
    });
  }
  return out;
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
function std(a: number[], m?: number) {
  if (!a.length) return 0;
  const mu = m ?? mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length) || 1e-9;
}
function quantile(arr: number[], q: number) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))];
}

// ── per-bar feature flags for a contract's bar series ───────────────────────
interface Feats {
  atSup: boolean;
  atRes: boolean;
  strongUp: boolean;
  strongDn: boolean;
  gapDown: boolean;
  gapUp: boolean;
}
function buildFeats(bars: Bar[], srN: number, trendN: number, near: number, slopeEdge: number, gapEdge: number): Feats[] {
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const out: Feats[] = [];
  for (let i = 0; i < bars.length; i++) {
    out.push({ atSup: false, atRes: false, strongUp: false, strongDn: false, gapDown: false, gapUp: false });
    if (i < Math.max(trendN, srN) + 1) continue;
    const close = closes[i];
    let rh = -Infinity,
      rl = Infinity;
    for (let k = i - srN; k < i; k++) {
      if (highs[k] > rh) rh = highs[k];
      if (lows[k] < rl) rl = lows[k];
    }
    const resistDist = (rh - close) / close;
    const supportDist = (close - rl) / close;
    // trend slope
    const N = trendN;
    const y = closes.slice(i - N + 1, i + 1);
    const yMu = mean(y);
    let sm = 0,
      sv = 0;
    const tMu = (N - 1) / 2;
    for (let t = 0; t < N; t++) {
      sm += (t - tMu) * (y[t] - yMu);
      sv += (t - tMu) ** 2;
    }
    const slope = sv > 1e-12 ? sm / sv : 0;
    const ret1 = closes[i] - closes[i - 1];
    const vol = std(closes.slice(Math.max(0, i - 20), i)) || 1e-9;
    const absRetVol = Math.abs(ret1) / vol;
    out[i] = {
      atSup: supportDist >= 0 && supportDist <= near,
      atRes: resistDist >= 0 && resistDist <= near,
      strongUp: slope > 0 && Math.abs(slope) / close >= slopeEdge,
      strongDn: slope < 0 && Math.abs(slope) / close >= slopeEdge,
      gapDown: ret1 < 0 && absRetVol >= gapEdge,
      gapUp: ret1 > 0 && absRetVol >= gapEdge,
    };
  }
  return out;
}

// ── simulate: on signal at bar i (confirmed at close[i]), fill entry at
//    open[i+1], exit at close[i+1]. Returns P&L per trade in $ (1 contract).
function simSignal(
  signalBars: Bar[],
  feats: Feats[],
  pick: (f: Feats) => boolean,
): { entry: number; exit: number; pnl: number }[] {
  const trades: { entry: number; exit: number; pnl: number }[] = [];
  for (let i = 0; i < signalBars.length - 1; i++) {
    if (!pick(feats[i])) continue;
    const entryMid = signalBars[i + 1].open; // fill at next bar open
    const exitMid = signalBars[i + 1].close; // hold 1 bar
    const hs = Math.max(HALF_SPREAD_FLOOR, entryMid * SPREAD_PCT);
    const entryFill = entryMid + hs;
    const exitFill = exitMid - hs;
    const pnl = exitFill - entryFill - 2 * COMMISSION_SIDE;
    trades.push({ entry: entryFill, exit: exitFill, pnl });
  }
  return trades;
}

function stats(trades: { pnl: number }[]) {
  const n = trades.length;
  if (!n) return { n: 0, win: 0, avg: 0, total: 0, pf: 0 };
  const wins = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    n,
    win: trades.filter((t) => t.pnl > 0).length / n,
    avg: total / n,
    total,
    pf: losses > 0 ? wins / losses : wins > 0 ? Infinity : 0,
  };
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
];

const SIGNALS = [
  { key: 'SR_SUPPORT', pick: (f: Feats) => f.atSup, contract: 'C' as const },
  { key: 'SR_RESIST ', pick: (f: Feats) => f.atRes, contract: 'P' as const },
  { key: 'TREND_UP  ', pick: (f: Feats) => f.strongUp, contract: 'C' as const },
  { key: 'TREND_DN  ', pick: (f: Feats) => f.strongDn, contract: 'P' as const },
  { key: 'GAP_DOWN  ', pick: (f: Feats) => f.gapDown, contract: 'C' as const },
  { key: 'GAP_UP    ', pick: (f: Feats) => f.gapUp, contract: 'P' as const },
];

// ── main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== S/R + TREND + GAP → signal/fill/P&L on SPX 0DTE (ATM call & put) ===`);
  console.log(`friction: scaled half-spread max($0.05, 1%×price) + $0.35/side. hold=1 bar. walk-forward 70/30.`);
  const dates = fs
    .readdirSync(PROFILE_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();

  // load per-day ATM call & put 1m bars
  const perDay: { date: string; call: Bar[]; put: Bar[] }[] = [];
  for (const date of dates) {
    const { spot, byContract } = await queryDay(date);
    if (!spot.length) continue;
    const spotOpen = spot[0].close;
    const expiry = toYYMMDD(date);
    const call = pickATM(byContract, 'C', expiry, spotOpen);
    const put = pickATM(byContract, 'P', expiry, spotOpen);
    if (!call || !put) continue;
    perDay.push({ date, call, put });
  }
  const cut = Math.floor(perDay.length * 0.7);
  const trainDays = new Set(perDay.slice(0, cut).map((d) => d.date));
  const testDaysArr = perDay.slice(cut);
  console.log(`days with both ATM call+put: ${perDay.length}  | train ${cut} / test ${testDaysArr.length}\n`);

  for (const cfg of TF_CONFIGS) {
    console.log(`═══ timeframe ${cfg.tf} ═══`);
    // train thresholds from CALL series on train days (apply to both C and P signals)
    const trainSlope: number[] = [];
    const trainGap: number[] = [];
    for (const d of perDay) {
      if (!trainDays.has(d.date)) continue;
      const bars = aggregate(d.call, cfg.factor);
      const closes = bars.map((b) => b.close);
      for (let i = cfg.trendN; i < bars.length; i++) {
        const N = cfg.trendN;
        const y = closes.slice(i - N + 1, i + 1);
        const yMu = mean(y);
        let sm = 0,
          sv = 0;
        const tMu = (N - 1) / 2;
        for (let t = 0; t < N; t++) {
          sm += (t - tMu) * (y[t] - yMu);
          sv += (t - tMu) ** 2;
        }
        const slope = sv > 1e-12 ? sm / sv : 0;
        trainSlope.push(Math.abs(slope) / closes[i]);
        const vol = std(closes.slice(Math.max(0, i - 20), i)) || 1e-9;
        trainGap.push(Math.abs(closes[i] - closes[i - 1]) / vol);
      }
    }
    const slopeEdge = quantile(trainSlope, 0.75);
    const gapEdge = quantile(trainGap, 0.8);

    // baselines on TEST: always-long-call every eligible bar (drift net friction),
    // and buy&hold call bar[60]→last (1 trade/day).
    const bh: number[] = [];
    for (const d of testDaysArr) {
      const bars = aggregate(d.call, cfg.factor);
      if (bars.length < 70) continue;
      const entryMid = bars[60].open;
      const exitMid = bars[bars.length - 1].close;
      const hs = Math.max(HALF_SPREAD_FLOOR, entryMid * SPREAD_PCT);
      bh.push(exitMid - hs - (entryMid + hs) - 2 * COMMISSION_SIDE);
    }
    const bhStats = stats(bh.map((pnl) => ({ pnl })));

    // always-long every bar (drift capture) — compute per signal-frequency below as "ALL"
    const allTrades: { pnl: number }[] = [];
    for (const d of testDaysArr) {
      const bars = aggregate(d.call, cfg.factor);
      const t = simSignal(bars, buildFeats(bars, cfg.srN, cfg.trendN, NEAR_BASE, slopeEdge, gapEdge), () => true);
      allTrades.push(...t);
    }
    const allStats = stats(allTrades);

    console.log(
      `  baseline  alwaysLongCall(1bar): n=${String(allStats.n).padStart(5)} win=${allStats.win.toFixed(3)} avg=${allStats.avg.toFixed(3)} total=${allStats.total.toFixed(1)} pf=${allStats.pf.toFixed(2)}`,
    );
    console.log(
      `  baseline  buy&holdCall(60→last): n=${String(bhStats.n).padStart(5)} win=${bhStats.win.toFixed(3)} avg=${bhStats.avg.toFixed(3)} total=${bhStats.total.toFixed(1)} pf=${bhStats.pf.toFixed(2)}`,
    );
    console.log(
      `  ${'signal'.padEnd(11)} ${'contract'.padStart(8)} ${'trades'.padStart(6)} ${'win'.padStart(6)} ${'avgPnL'.padStart(8)} ${'totalPnL'.padStart(10)} ${'PF'.padStart(6)}`,
    );
    for (const sig of SIGNALS) {
      const trades: { pnl: number }[] = [];
      for (const d of testDaysArr) {
        const bars = aggregate(sig.contract === 'C' ? d.call : d.put, cfg.factor);
        const feats = buildFeats(bars, cfg.srN, cfg.trendN, NEAR_BASE, slopeEdge, gapEdge);
        trades.push(...simSignal(bars, feats, sig.pick).map((t) => ({ pnl: t.pnl })));
      }
      const s = stats(trades);
      const tag = s.avg > 0 ? ' ' : '✗';
      console.log(
        `${tag} ${sig.key} ${sig.contract.padStart(8)} ${String(s.n).padStart(6)} ${s.win.toFixed(3).padStart(6)} ${s.avg.toFixed(3).padStart(8)} ${s.total.toFixed(1).padStart(10)} ${s.pf.toFixed(2).padStart(6)}`,
      );
    }
    console.log();
  }

  console.log(` legend: ✗ = negative avg P&L/trade. PF = profit factor (grossWin/grossLoss).`);
  console.log(` Round-turn friction floor ≈ $${(2 * HALF_SPREAD_FLOOR + 2 * COMMISSION_SIDE).toFixed(2)}/contract; scaled spread widens it on pricier contracts.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
