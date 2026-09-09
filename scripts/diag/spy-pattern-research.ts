/**
 * spy-pattern-research.ts — Krafer premise on SPY at 1h/2h/4h/1d.
 * Direction (vs DRIFT baseline) + tradeable P&L (vs BUY&HOLD Sharpe), walk-forward.
 * See parent conversation for prior SPX/0DTE negative results.
 */
import * as fs from 'fs';
import * as path from 'path';

interface Bar { ts: number; o: number; h: number; l: number; c: number; v: number; }
const OUT = path.join(process.cwd(), 'scripts/autoresearch/output');
const PROG = path.join(OUT, 'spy-research-progress.md');
function log(m: string) {
  const line = `${new Date().toISOString()} | ${m}`;
  console.log(line);
  fs.appendFileSync(PROG, line + '\n');
}
const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a: number[], m?: number) => {
  if (!a.length) return 0;
  const mu = m ?? mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / a.length) || 1e-9;
};
function quantile(a: number[], q: number) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * q))];
}

function loadBars(file: string): Bar[] {
  const raw: any[] = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
  return raw.map((r) => ({ ts: r.ts, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0 }));
}
function aggregate(bars: Bar[], factor: number): Bar[] {
  if (factor <= 1) return bars;
  const out: Bar[] = [];
  for (let i = 0; i < bars.length; i += factor) {
    const c = bars.slice(i, i + factor);
    if (!c.length) break;
    out.push({ ts: c[0].ts, o: c[0].o, h: Math.max(...c.map((b) => b.h)), l: Math.min(...c.map((b) => b.l)), c: c[c.length - 1].c, v: c.reduce((s, b) => s + b.v, 0) });
  }
  return out;
}

// ── per-bar features (causal) ───────────────────────────────────────────────
interface Feat {
  atSup: boolean; atRes: boolean;
  strongUp: boolean; strongDn: boolean;
  gapDown: boolean; gapUp: boolean;
  gapOpenUp: boolean; gapOpenDn: boolean; // overnight/session open gap
  dir: number; // label sign(c[i+1]-c[i])
  atr: number; c: number; o: number; h1: number; l1: number; c1: number; // next bar for sim
}
function buildFeats(bars: Bar[], srN: number, trendN: number, nearPct: number, slopeEdge: number, gapEdge: number, gapOpenEdge: number): Feat[] {
  const out: Feat[] = [];
  // ATR(14)
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 15) { atr.push(0); continue; }
    let s = 0;
    for (let k = i - 13; k <= i; k++) {
      const tr = Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c));
      s += tr;
    }
    atr.push(s / 14);
  }
  for (let i = 0; i < bars.length; i++) {
    const f: Feat = { atSup: false, atRes: false, strongUp: false, strongDn: false, gapDown: false, gapUp: false, gapOpenUp: false, gapOpenDn: false, dir: 0, atr: atr[i], c: bars[i].c, o: bars[i].o, h1: 0, l1: 0, c1: 0 };
    out.push(f);
    if (i < Math.max(trendN, srN) + 1 || i >= bars.length - 1) continue;
    const close = bars[i].c;
    let rh = -Infinity, rl = Infinity;
    for (let k = i - srN; k < i; k++) { if (bars[k].h > rh) rh = bars[k].h; if (bars[k].l < rl) rl = bars[k].l; }
    const a = atr[i] || close * 0.01;
    const near = nearPct > 0 ? nearPct * a : a * 0.2;
    f.atRes = rh - close >= 0 && rh - close <= near;
    f.atSup = close - rl >= 0 && close - rl <= near;
    // trend slope
    const N = trendN;
    const y = bars.slice(i - N + 1, i + 1).map((b) => b.c);
    const yMu = mean(y);
    let sm = 0, sv = 0;
    const tMu = (N - 1) / 2;
    for (let t = 0; t < N; t++) { sm += (t - tMu) * (y[t] - yMu); sv += (t - tMu) ** 2; }
    const slope = sv > 1e-12 ? sm / sv : 0;
    const sNorm = Math.abs(slope) / close;
    f.strongUp = slope > 0 && sNorm >= slopeEdge;
    f.strongDn = slope < 0 && sNorm >= slopeEdge;
    // bar gap (ret magnitude)
    const ret = close - bars[i - 1].c;
    const vol = std(bars.slice(Math.max(0, i - 20), i).map((b) => b.c)) || a;
    const absRetVol = Math.abs(ret) / vol;
    f.gapDown = ret < 0 && absRetVol >= gapEdge;
    f.gapUp = ret > 0 && absRetVol >= gapEdge;
    // open gap (overnight/session)
    const go = (bars[i].o - bars[i - 1].c) / bars[i - 1].c;
    f.gapOpenUp = go >= gapOpenEdge;
    f.gapOpenDn = go <= -gapOpenEdge;
    // label + next bar
    f.dir = Math.sign(bars[i + 1].c - close);
    f.h1 = bars[i + 1].h; f.l1 = bars[i + 1].l; f.c1 = bars[i + 1].c;
  }
  return out;
}

// ── simulate long/short, exit next-bar with ATR stop/TP ─────────────────────
const HS = 0.005, COMM = 0.0035; // half-spread, commission per share per side
interface Trade { entry: number; exit: number; pnl: number; retPct: number; exitBarIdx: number; }
function sim(feats: Feat[], pick: (f: Feat) => boolean, dir: 1 | -1, useStop: boolean): Trade[] {
  const trades: Trade[] = [];
  const km = 1.5, tp = 3.0; // stop = 1.5 ATR, TP = 3 ATR (structural 2:1)
  for (let i = 0; i < feats.length - 1; i++) {
    const f = feats[i];
    if (!pick(f)) continue;
    const entry = f.o + dir * HS + COMM; // fill at next bar open (o stored is next-bar open? no — f.o is current bar open)
    // NOTE: signal confirmed at close[i]; fill at open[i+1]. We stored f.h1/l1/c1 = next bar, but not next open.
    // Approx fill at close[i] + gap: use current close as conservative fill proxy is wrong. Use next bar open via rebuild.
    trades.push({ entry: 0, exit: 0, pnl: 0, retPct: 0, exitBarIdx: i + 1 });
  }
  return trades;
}
// (sim above unused — replaced by sim2 which has next-bar open)

interface Feat2 extends Feat { o1: number; }
function sim2(feats: Feat2[], pick: (f: Feat2) => boolean, dir: 1 | -1, useStop: boolean): Trade[] {
  const trades: Trade[] = [];
  const km = 1.5, tp = 3.0;
  for (let i = 0; i < feats.length - 1; i++) {
    const f = feats[i];
    if (!pick(f) || f.dir === 0) continue;
    // close-to-close: matches the direction label sign(c[i+1]-c[i]) exactly,
    // so direction-z and P&L are on the SAME basis (no overnight-gap mismatch).
    const entryMid = f.c;
    const hs = HS; // SPY half-spread ~$0.005 (NOT price-scaled; 0.1% would be $0.50 = 100x too wide)
    const entryFill = dir > 0 ? entryMid + hs + COMM : entryMid - hs - COMM;
    let exitMid = f.c1;
    if (useStop) {
      const stop = f.atr || entryMid * 0.01;
      if (dir > 0) {
        if (f.l1 <= entryMid - km * stop) exitMid = entryMid - km * stop;
        else if (f.h1 >= entryMid + tp * stop) exitMid = entryMid + tp * stop;
      } else {
        if (f.h1 >= entryMid + km * stop) exitMid = entryMid + km * stop;
        else if (f.l1 <= entryMid - tp * stop) exitMid = entryMid - tp * stop;
      }
    }
    const exitFill = dir > 0 ? exitMid - hs - COMM : exitMid + hs + COMM;
    const gross = (exitFill - entryFill) * dir;
    const pnl = gross; // costs already in fills
    trades.push({ entry: entryFill, exit: exitFill, pnl, retPct: pnl / entryMid, exitBarIdx: i + 1 });
  }
  return trades;
}

function tradeStats(trades: Trade[]) {
  const n = trades.length;
  if (!n) return { n: 0, win: 0, avg: 0, tot: 0, pf: 0, sharpe: 0 };
  const wins = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0);
  const tot = trades.reduce((s, t) => s + t.pnl, 0);
  const rets = trades.map((t) => t.retPct);
  const sharpe = std(rets) > 0 ? (mean(rets) / std(rets)) * Math.sqrt(252) : 0; // trade-frequency Sharpe proxy
  return { n, win: trades.filter((t) => t.pnl > 0).length / n, avg: tot / n, tot, pf: losses > 0 ? wins / losses : wins > 0 ? Infinity : 0, sharpe };
}

// direction z vs drift baseline
function dirZ(feats: Feat2[], pick: (f: Feat2) => boolean, baseUp: number, subset: Feat2[]) {
  const sub = subset.filter((f) => pick(f) && f.dir !== 0);
  const n = sub.length;
  const pu = n ? sub.filter((f) => f.dir > 0).length / n : 0;
  const base = Math.max(baseUp, 1 - baseUp);
  const z = n ? (pu - baseUp) / Math.sqrt((baseUp * (1 - baseUp)) / n) : 0;
  return { n, pu, z };
}

// buy&hold over test bars (per-bar returns) -> annualized sharpe
function bhSharpe(testFeats: Feat2[], ppy: number) {
  const rs: number[] = [];
  for (let i = 0; i < testFeats.length - 1; i++) {
    const f = testFeats[i];
    if (f.c <= 0) continue;
    rs.push((testFeats[i + 1].c - f.c) / f.c);
  }
  return std(rs) > 0 ? (mean(rs) / std(rs)) * Math.sqrt(ppy) : 0;
}

interface SigDef { key: string; pick: (f: Feat2) => boolean; dir: 1 | -1; }
const SIGNALS: SigDef[] = [
  { key: 'SR_SUPPORT', pick: (f) => f.atSup, dir: 1 },
  { key: 'SR_RESIST ', pick: (f) => f.atRes, dir: -1 },
  { key: 'TREND_UP  ', pick: (f) => f.strongUp, dir: 1 },
  { key: 'TREND_DN  ', pick: (f) => f.strongDn, dir: -1 },
  { key: 'GAP_DOWN  ', pick: (f) => f.gapDown, dir: 1 },
  { key: 'GAP_UP    ', pick: (f) => f.gapUp, dir: -1 },
  { key: 'GAPOPEN_UP', pick: (f) => f.gapOpenUp, dir: -1 },
  { key: 'GAPOPEN_DN', pick: (f) => f.gapOpenDn, dir: 1 },
];

// ── run one TF ──────────────────────────────────────────────────────────────
function runTF(label: string, bars: Bar[], srN: number, trendN: number, ppy: number) {
  // train thresholds need a Feat2 build with placeholder edges then recompute; do two-pass
  // pass1: build with dummy edges to get distributions
  const f0 = buildFeats(bars, srN, trendN, 0, 0, 0, 0) as Feat2[];
  // attach next-bar open
  for (let i = 0; i < f0.length; i++) (f0[i] as Feat2).o1 = i + 1 < bars.length ? bars[i + 1].o : bars[i].o;
  const cut = Math.floor(bars.length * 0.7);
  const train = f0.slice(0, cut);
  const test = f0.slice(cut);
  // thresholds from train
  const slopes = train.map((f) => Math.abs(f.atr ? slopeNorm(bars, train, f) : 0));
  // simpler: recompute slope on train via buildFeats internals — but we stored flags only. Recompute edges from raw:
  const trainSlopeNorm: number[] = [];
  const trainAbsRetVol: number[] = [];
  for (let i = trendN; i < cut; i++) {
    const y = bars.slice(i - trendN + 1, i + 1).map((b) => b.c);
    const yMu = mean(y); let sm = 0, sv = 0; const tMu = (trendN - 1) / 2;
    for (let t = 0; t < trendN; t++) { sm += (t - tMu) * (y[t] - yMu); sv += (t - tMu) ** 2; }
    const slope = sv > 1e-12 ? sm / sv : 0;
    trainSlopeNorm.push(Math.abs(slope) / bars[i].c);
    const vol = std(bars.slice(Math.max(0, i - 20), i).map((b) => b.c)) || bars[i].c * 0.01;
    trainAbsRetVol.push(Math.abs(bars[i].c - bars[i - 1].c) / vol);
  }
  const slopeEdge = quantile(trainSlopeNorm, 0.75);
  const gapEdge = quantile(trainAbsRetVol, 0.8);
  const gapOpenEdge = 0.005; // 0.5% overnight gap (structural, fixed)
  const nearPct = 0.2; // "at level" = within 0.2 ATR (structural, fixed)
  // pass2: real features
  const feats = buildFeats(bars, srN, trendN, nearPct, slopeEdge, gapEdge, gapOpenEdge) as Feat2[];
  for (let i = 0; i < feats.length; i++) (feats[i] as Feat2).o1 = i + 1 < bars.length ? bars[i + 1].o : bars[i].o;
  const trainF = feats.slice(0, cut);
  const testF = feats.slice(cut);

  const baseUpAll = testF.filter((f) => f.dir > 0).length / Math.max(1, testF.filter((f) => f.dir !== 0).length);
  const bh = bhSharpe(testF, ppy);
  log(`${label} | cut=${cut} testBars=${testF.length} baseUp=${baseUpAll.toFixed(3)} bhSharpe=${bh.toFixed(2)} (ppy=${ppy})`);

  console.log(`\n═══ ${label} ═══  testBars=${testF.length}  baseP(up)=${baseUpAll.toFixed(3)}  driftBaseline=${Math.max(baseUpAll, 1 - baseUpAll).toFixed(3)}  buy&holdSharpe=${bh.toFixed(2)}`);
  console.log(`  ${'signal'.padEnd(10)} ${'dirZ.n'.padStart(7)} ${'dirZ.z'.padStart(7)} │ ${'1bar.n'.padStart(6)} ${'win'.padStart(6)} ${'sharpe'.padStart(7)} ${'dSharpe'.padStart(8)} ${'PF'.padStart(6)} ${'tot'.padStart(9)} │ ${'stop.n'.padStart(6)} ${'stop.shp'.padStart(8)} ${'stop.dShp'.padStart(9)}`);
  const survivors: string[] = [];
  for (const sig of SIGNALS) {
    const dz = dirZ(feats, sig.pick, baseUpAll, testF);
    const t1 = tradeStats(sim2(testF, sig.pick, sig.dir, false));
    const ts = tradeStats(sim2(testF, sig.pick, sig.dir, true));
    const d1 = t1.sharpe - bh;
    const ds = ts.sharpe - bh;
    console.log(
      `  ${sig.key} ${String(dz.n).padStart(7)} ${dz.z.toFixed(2).padStart(7)} │ ${String(t1.n).padStart(6)} ${t1.win.toFixed(3).padStart(6)} ${t1.sharpe.toFixed(2).padStart(7)} ${(d1).toFixed(2).padStart(8)} ${t1.pf.toFixed(2).padStart(6)} ${t1.tot.toFixed(0).padStart(9)} │ ${String(ts.n).padStart(6)} ${ts.sharpe.toFixed(2).padStart(8)} ${ds.toFixed(2).padStart(9)}`,
    );
    if (t1.n >= 500 && Math.abs(dz.z) > 1.96 && d1 > 0.2) survivors.push(`${sig.key}(1bar,z${dz.z.toFixed(1)},Δ${d1.toFixed(2)})`);
    if (ts.n >= 500 && Math.abs(dz.z) > 1.96 && ds > 0.2) survivors.push(`${sig.key}(stop,z${dz.z.toFixed(1)},Δ${ds.toFixed(2)})`);
    log(`${label} ${sig.key} | dirZ=${dz.z.toFixed(2)} n=${dz.n} | 1bar: n=${t1.n} shp=${t1.sharpe.toFixed(2)} Δ=${d1.toFixed(2)} | stop: n=${ts.n} shp=${ts.sharpe.toFixed(2)} Δ=${ds.toFixed(2)}`);
  }
  console.log(`  SURVIVORS (≥500 trades, |z|>1.96, Δ-Sharpe>+0.2): ${survivors.length ? survivors.join('; ') : 'NONE'}`);
  log(`${label} | SURVIVORS: ${survivors.length ? survivors.join(';') : 'NONE'}`);
  return { label, bh, survivors };
}

// helper stub (unused, kept to satisfy earlier ref)
function slopeNorm(_bars: Bar[], _train: Feat2[], _f: Feat2): number { return 0; }

// ── main ───────────────────────────────────────────────────────────────────
function main() {
  if (!fs.existsSync(PROG)) fs.writeFileSync(PROG, '# SPY pattern research progress\n');
  log('START spy-pattern-research');
  const daily = loadBars('spy-1d.json');
  const h1 = loadBars('spy-1h.json');
  const h2 = aggregate(h1, 2);
  const h4 = aggregate(h1, 4);
  const results: any[] = [];
  results.push(runTF('1d (N_sr=20,N_tr=50)', daily, 20, 50, 252));
  results.push(runTF('1h (N_sr=24,N_tr=50)', h1, 24, 50, 1638));
  results.push(runTF('2h (N_sr=24,N_tr=50)', h2, 24, 50, 819));
  results.push(runTF('4h (N_sr=24,N_tr=50)', h4, 24, 50, 409));
  // MTF: 1h trend × 1d trend agreement → next-1h bias
  log('MTF 1h×1d start');
  const f1h = buildFeats(h1, 24, 50, 0.2, quantile(h1.slice(0, Math.floor(h1.length * 0.7)).map((_, i) => i), 0.75), 0, 0) as Feat2[];
  // compute 1d trend sign per 1h bar (as-of last completed 1d bar) — simplified MTF below
  const cut1h = Math.floor(h1.length * 0.7);
  let upBoth = 0, upBothN = 0, dnBoth = 0, dnBothN = 0, baseUp = 0, baseN = 0;
  // build daily slope sign series
  const daySlope: { ts: number; up: boolean }[] = [];
  for (let i = 50; i < daily.length; i++) {
    const y = daily.slice(i - 49, i + 1).map((b) => b.c);
    const yMu = mean(y); let sm = 0, sv = 0; const tMu = 49 / 2;
    for (let t = 0; t < 50; t++) { sm += (t - tMu) * (y[t] - yMu); sv += (t - tMu) ** 2; }
    daySlope.push({ ts: daily[i].ts, up: sm > 0 });
  }
  const h1TrendUp: boolean[] = [];
  for (let i = 0; i < h1.length; i++) {
    if (i < 50) { h1TrendUp.push(false); continue; }
    const y = h1.slice(i - 49, i + 1).map((b) => b.c);
    const yMu = mean(y); let sm = 0, sv = 0; const tMu = 49 / 2;
    for (let t = 0; t < 50; t++) { sm += (t - tMu) * (y[t] - yMu); sv += (t - tMu) ** 2; }
    h1TrendUp.push(sm > 0);
  }
  for (let i = 1; i < h1.length - 1; i++) {
    if (i < cut1h) continue; // test only
    const dUp = (() => { let u: boolean | null = null; for (const d of daySlope) { if (d.ts <= h1[i].ts) u = d.up; else break; } return u; })();
    if (dUp == null) continue;
    const dir = Math.sign(h1[i + 1].c - h1[i].c);
    if (dir === 0) continue;
    baseN++; baseUp += dir > 0 ? 1 : 0;
    if (h1TrendUp[i] && dUp) { upBothN++; upBoth += dir > 0 ? 1 : 0; }
    if (!h1TrendUp[i] && !dUp) { dnBothN++; dnBoth += dir > 0 ? 1 : 0; }
  }
  const bUp = baseUp / baseN;
  const pUU = upBothN ? upBoth / upBothN : 0;
  const pDD = dnBothN ? dnBoth / dnBothN : 0;
  console.log(`\n═══ MTF 1h×1d (test) base P(up)=${bUp.toFixed(3)} | both↑ P(up)=${pUU.toFixed(3)} (n=${upBothN}, z=${upBothN ? ((pUU - bUp) / Math.sqrt(bUp * (1 - bUp) / upBothN)).toFixed(2) : 'na'}) | both↓ P(up)=${pDD.toFixed(3)} (n=${dnBothN}, z=${dnBothN ? ((pDD - bUp) / Math.sqrt(bUp * (1 - bUp) / dnBothN)).toFixed(2) : 'na'})`);
  log(`MTF 1h×1d | base=${bUp.toFixed(3)} bothUp=${pUU.toFixed(3)}(n${upBothN}) bothDn=${pDD.toFixed(3)}(n${dnBothN})`);

  // results file
  let md = '# SPY pattern research — Krafer premise (1h/2h/4h/1d)\n\n';
  md += `Walk-forward 70/30 per TF. Baseline to beat = BUY&HOLD SPY Sharpe (SPY drifts up). Gates: ≥500 trades, |dir-z|>1.96, Δ-Sharpe>+0.2.\n\n`;
  md += `| TF | buy&hold Sharpe | survivors |\n|----|-----------------|-----------|\n`;
  for (const r of results) md += `| ${r.label} | ${r.bh.toFixed(2)} | ${r.survivors.length ? r.survivors.join('; ') : 'NONE'} |\n`;
  md += `\n## MTF 1h×1d (test)\nbase P(up)=${bUp.toFixed(3)}; both↑ P(up)=${pUU.toFixed(3)} (n=${upBothN}); both↓ P(up)=${pDD.toFixed(3)} (n=${dnBothN}).\n`;
  md += `\nSee scripts/autoresearch/output/spy-research-progress.md for per-signal numbers.\n`;
  fs.writeFileSync('spy-research-RESULTS.md', md);
  log('WROTE spy-research-RESULTS.md');
  console.log(`\nResults → spy-research-RESULTS.md ; progress → ${PROG}`);
}
main();
