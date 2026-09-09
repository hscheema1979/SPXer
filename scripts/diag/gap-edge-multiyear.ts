/**
 * gap-edge-multiyear.ts — Multi-year gap-up statistical study on DAILY data.
 *
 * Pulls ~7 years of daily OHLC from Polygon (I:SPX, I:NDX, I:XSP) and repeats the
 * gap-up edge analysis at scale. Daily bars are all the open→close edge needs:
 *   gap%     = (open - prevClose)/prevClose * 100
 *   dayMove% = (close - open)/open * 100   (long from the open, exit at close)
 *   CONT     = close > open (gap-up kept rising) ; FADE = close < open
 *   sma20/ema10 = trailing DAILY MAs of prior closes (exclude today)
 *
 * Reports, per size bucket and per trend split: n, mean dayMove%, t & p (mean≠0),
 * continuation win% & binomial p (≠50%), 95% CI.
 *
 * Usage: npx tsx scripts/diag/gap-edge-multiyear.ts [--from 2018-06-01] [--minGap 0.1]
 */
import 'dotenv/config';

const KEY = process.env.POLYGON_API_KEY;
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const FROM = arg('from', '2018-06-01');
const TO = arg('to', '2026-06-13');
const MIN_GAP = parseFloat(arg('minGap', '0.1'));
const MODE = arg('mode', 'edge');              // 'edge' (continuation) | 'range' (condor/fly) | 'both'
const SOURCE = arg('source', 'yahoo');         // 'yahoo' (long history) | 'polygon'
const YRANGE = arg('range', '10y');
// [displayName, polygonTicker, yahooSymbol]
const TICKERS: [string, string, string][] = [
  ['SPX', 'I:SPX', '^GSPC'], ['NDX', 'I:NDX', '^NDX'], ['XSP', 'I:XSP', '^XSP'],
];

// ── stats ─────────────────────────────────────────────────────────────────
function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
const twoSidedP = (z: number) => 2 * (1 - normCdf(Math.abs(z)));
function mean(xs: number[]) { return xs.reduce((a, b) => a + b, 0) / xs.length; }
function sd(xs: number[]) { const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); }
const star = (p: number) => p < 0.01 ? '***' : p < 0.05 ? '**' : p < 0.10 ? '*' : '';

interface DailyBar { t: number; o: number; h: number; l: number; c: number }
async function fetchPolygon(polyTicker: string): Promise<DailyBar[]> {
  const url = `https://api.polygon.io/v2/aggs/ticker/${polyTicker}/range/1/day/${FROM}/${TO}?adjusted=true&sort=asc&limit=50000&apiKey=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${polyTicker} HTTP ${res.status}`);
  const j: any = await res.json();
  return (j.results ?? []).map((r: any) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c }));
}
async function fetchYahoo(symbol: string): Promise<DailyBar[]> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${YRANGE}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`${symbol} HTTP ${res.status}`);
  const j: any = await res.json();
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`${symbol} no result`);
  const ts: number[] = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const out: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || c == null || h == null || l == null) continue;   // skip holiday gaps
    out.push({ t: ts[i] * 1000, o, h, l, c });
  }
  return out;
}
const fetchDaily = (poly: string, yh: string) => SOURCE === 'polygon' ? fetchPolygon(poly) : fetchYahoo(yh);

interface Row {
  gap: number; dayMove: number; aboveSma: boolean | null; aboveEma: boolean | null;
  rangePct: number;   // intraday (high-low)/open — total wandering
  upExc: number;      // (high-open)/open — max up excursion from open
  dnExc: number;      // (open-low)/open — max down excursion from open
  date: string; year: number;
  vix: number | null; // PRIOR-day VIX close (regime known before entry, no look-ahead)
}
const dateOf = (tsMs: number) => new Date(tsMs).toISOString().slice(0, 10);
function buildRows(bars: DailyBar[], vixByDate?: Map<string, number>): Row[] {
  const rows: Row[] = [];
  const closes: number[] = []; let ema10: number | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i > 0) {
      const prevClose = bars[i - 1].c;
      const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, x) => a + x, 0) / 20 : null;
      const d = dateOf(b.t);
      rows.push({
        gap: (b.o - prevClose) / prevClose * 100,
        dayMove: (b.c - b.o) / b.o * 100,
        aboveSma: sma20 == null ? null : b.o > sma20,
        aboveEma: ema10 == null ? null : b.o > ema10,
        rangePct: (b.h - b.l) / b.o * 100,
        upExc: (b.h - b.o) / b.o * 100,
        dnExc: (b.o - b.l) / b.o * 100,
        date: d, year: new Date(b.t).getUTCFullYear(),
        vix: vixByDate?.get(dateOf(bars[i - 1].t)) ?? null,   // prior-day VIX close
      });
    }
    closes.push(b.c);
    ema10 = ema10 == null ? b.c : b.c * (2 / 11) + ema10 * (1 - 2 / 11);
  }
  return rows;
}

// side='up': continuation = close>open (move up). side='down': continuation = close<open (move down).
function summarize(label: string, days: Row[], side: 'up' | 'down') {
  const n = days.length;
  if (n < 10) { console.log(`  ${label.padEnd(24)} n=${n} (too few)`); return; }
  const moves = days.map(d => d.dayMove);
  const m = mean(moves); const s = sd(moves); const se = s / Math.sqrt(n); const t = m / se;
  const pMean = twoSidedP(t);
  const wins = days.filter(d => side === 'up' ? d.dayMove > 0 : d.dayMove < 0).length;
  const winPct = wins / n * 100;
  const pWin = twoSidedP((wins - n * 0.5) / Math.sqrt(n * 0.25));
  const ci = 1.96 * se;
  console.log(
    `  ${label.padEnd(24)} n=${String(n).padStart(4)}  ` +
    `dayMove=${(m >= 0 ? '+' : '') + m.toFixed(3)}%  95%CI[${(m - ci).toFixed(3)},${(m + ci).toFixed(3)}]  ` +
    `t=${t.toFixed(2)} p=${pMean.toFixed(3)}${star(pMean)}  cont=${winPct.toFixed(1)}% (binom p=${pWin.toFixed(3)}${star(pWin)})`);
}

// bins are MAGNITUDE ranges; applied to |gap|.
const SIZE_BINS: [string, number, number][] = [
  ['tiny  0.1-0.3%', 0.1, 0.3], ['small 0.3-0.6%', 0.3, 0.6],
  ['med   0.6-1.0%', 0.6, 1.0], ['large >1.0%', 1.0, Infinity],
];

function reportSide(name: string, rows: Row[], side: 'up' | 'down') {
  // gap-up: gap>+min ; gap-down: gap<-min . mag = |gap|.
  const sel = rows.filter(d => side === 'up' ? d.gap > MIN_GAP : d.gap < -MIN_GAP);
  const mag = (d: Row) => Math.abs(d.gap);
  const word = side === 'up' ? 'UP' : 'DOWN';
  const contDef = side === 'up' ? 'close>open (keeps rising)' : 'close<open (keeps falling)';
  // for gap-DOWN, "counter-trend" = open ABOVE its MA (down-gap in an uptrend)
  const counter = side === 'up' ? 'below' : 'above';
  console.log(`\n${'='.repeat(110)}\n${name} — gap-${word}: ${sel.length} days (|gap%|>${MIN_GAP}).  Outcome=open→close, cont=${contDef}.\n${'='.repeat(110)}`);
  console.log(`\n[A] gap-${word.toLowerCase()}s by SIZE:`);
  summarize(`ALL gap-${word.toLowerCase()}s`, sel, side);
  for (const [nm, lo, hi] of SIZE_BINS) summarize(nm, sel.filter(d => mag(d) > lo && mag(d) <= hi), side);
  console.log('\n[B] by TREND (open vs 20d SMA):');
  summarize('above SMA20', sel.filter(d => d.aboveSma === true), side);
  summarize('below SMA20', sel.filter(d => d.aboveSma === false), side);
  console.log(`   (counter-trend = open ${counter} SMA)`);
  console.log('\n[C] by TREND (open vs 10d EMA):');
  summarize('above EMA10', sel.filter(d => d.aboveEma === true), side);
  summarize('below EMA10', sel.filter(d => d.aboveEma === false), side);
  console.log('\n[D] SIZE × TREND (SMA20):');
  for (const [nm, lo, hi] of SIZE_BINS) {
    summarize(nm + ' | aboveSMA', sel.filter(d => mag(d) > lo && mag(d) <= hi && d.aboveSma === true), side);
    summarize(nm + ' | belowSMA', sel.filter(d => mag(d) > lo && mag(d) <= hi && d.aboveSma === false), side);
  }
}

// ── RANGE / PIN analysis for iron condors & butterflies ─────────────────────
// Condor/fly entered at the OPEN profit when the CLOSE lands near the open.
// We measure |close-open| (realized move from entry) and P(close within ±band).
const BANDS = [0.25, 0.5, 1.0, 1.5, 2.0];   // % bands around the open
function pct(sorted: number[], q: number) { return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]; }
function rangeRow(label: string, days: Row[]) {
  const n = days.length;
  if (n < 10) { console.log(`  ${label.padEnd(22)} n=${n} (too few)`); return; }
  const abs = days.map(d => Math.abs(d.dayMove)).sort((a, b) => a - b);
  const signed = mean(days.map(d => d.dayMove));
  const within = BANDS.map(b => days.filter(d => Math.abs(d.dayMove) <= b).length / n * 100);
  console.log(
    `  ${label.padEnd(22)} n=${String(n).padStart(4)}  ` +
    `|move| med=${pct(abs, 0.5).toFixed(2)}% mean=${mean(abs).toFixed(2)}% p75=${pct(abs, 0.75).toFixed(2)}% p90=${pct(abs, 0.90).toFixed(2)}%  ` +
    `drift=${(signed >= 0 ? '+' : '') + signed.toFixed(3)}% | within ±: ` +
    BANDS.map((b, i) => `${b}%=${within[i].toFixed(0)}`).join('  '));
}
function reportRange(name: string, rows: Row[]) {
  console.log(`\n${'='.repeat(124)}\n${name} — CLOSE-vs-OPEN RANGE (for condors/flies entered at 09:30 open). "within ±X% = % of days |close-open| ≤ X%".\n${'='.repeat(124)}`);
  rangeRow('ALL days', rows);
  rangeRow('FLAT (|gap|≤0.1%)', rows.filter(d => Math.abs(d.gap) <= MIN_GAP));
  console.log('  -- gap-UPS --');
  rangeRow('gap-up ALL', rows.filter(d => d.gap > MIN_GAP));
  rangeRow('gap-up small .1-.6%', rows.filter(d => d.gap > 0.1 && d.gap <= 0.6));
  rangeRow('gap-up large >1%', rows.filter(d => d.gap > 1.0));
  console.log('  -- gap-DOWNS --');
  rangeRow('gap-dn ALL', rows.filter(d => d.gap < -MIN_GAP));
  rangeRow('gap-dn small .1-.6%', rows.filter(d => d.gap < -0.1 && d.gap >= -0.6));
  rangeRow('gap-dn large >1%', rows.filter(d => d.gap < -1.0));
}

// ── INTRADAY RANGE analysis — tests "gap days consolidate (tighter range)" ──
function intradayRow(label: string, days: Row[]) {
  const n = days.length;
  if (n < 10) { console.log(`  ${label.padEnd(22)} n=${n} (too few)`); return; }
  const rng = days.map(d => d.rangePct).sort((a, b) => a - b);
  const up = mean(days.map(d => d.upExc));
  const dn = mean(days.map(d => d.dnExc));
  console.log(
    `  ${label.padEnd(22)} n=${String(n).padStart(4)}  ` +
    `range(H-L)/O med=${pct(rng, 0.5).toFixed(2)}% mean=${mean(rng).toFixed(2)}% p90=${pct(rng, 0.90).toFixed(2)}%  ` +
    `| from OPEN: up=${up.toFixed(2)}% dn=${dn.toFixed(2)}% (avg max excursion each way)`);
}
function reportIntraday(name: string, rows: Row[]) {
  console.log(`\n${'='.repeat(124)}\n${name} — INTRADAY RANGE (high-low) by gap type. Tests "gap days are more contained / consolidate".\n${'='.repeat(124)}`);
  intradayRow('ALL days', rows);
  intradayRow('FLAT (|gap|≤0.1%)', rows.filter(d => Math.abs(d.gap) <= MIN_GAP));
  console.log('  -- gap-UPS --');
  intradayRow('gap-up small .1-.6%', rows.filter(d => d.gap > 0.1 && d.gap <= 0.6));
  intradayRow('gap-up med .6-1%', rows.filter(d => d.gap > 0.6 && d.gap <= 1.0));
  intradayRow('gap-up large >1%', rows.filter(d => d.gap > 1.0));
  console.log('  -- gap-DOWNS --');
  intradayRow('gap-dn small .1-.6%', rows.filter(d => d.gap < -0.1 && d.gap >= -0.6));
  intradayRow('gap-dn med .6-1%', rows.filter(d => d.gap < -0.6 && d.gap >= -1.0));
  intradayRow('gap-dn large >1%', rows.filter(d => d.gap < -1.0));
}

// ── VIX REGIME analysis — is the condor edge concentrated in a vol regime? ───
function vixStatRow(label: string, days: Row[]) {
  const n = days.length;
  if (n < 10) { console.log(`  ${label.padEnd(20)} n=${n} (few)`); return; }
  const abs = days.map(d => Math.abs(d.dayMove)).sort((a, b) => a - b);
  const w05 = days.filter(d => Math.abs(d.dayMove) <= 0.5).length / n * 100;
  const w10 = days.filter(d => Math.abs(d.dayMove) <= 1.0).length / n * 100;
  const avgVix = mean(days.filter(d => d.vix != null).map(d => d.vix!));
  console.log(
    `  ${label.padEnd(20)} n=${String(n).padStart(4)}  avgVIX=${avgVix.toFixed(1)}  ` +
    `med|close-open|=${pct(abs, 0.5).toFixed(2)}%  within ±0.5%=${w05.toFixed(0)}%  ±1%=${w10.toFixed(0)}%  ` +
    `range(H-L) med=${pct(days.map(d => d.rangePct).sort((a, b) => a - b), 0.5).toFixed(2)}%`);
}
function reportVix(name: string, rows0: Row[]) {
  const rows = rows0.filter(d => d.vix != null);
  console.log(`\n${'='.repeat(116)}\n${name} — VIX REGIME (prior-day VIX). Condor wins when |close-open| stays small. Does the edge depend on vol?\n${'='.repeat(116)}`);
  console.log('\n[by YEAR]');
  const years = [...new Set(rows.map(d => d.year))].sort();
  for (const y of years) vixStatRow(String(y), rows.filter(d => d.year === y));
  console.log('\n[by VIX BUCKET]');
  const buckets: [string, (v: number) => boolean][] = [
    ['VIX <14', v => v < 14], ['VIX 14-18', v => v >= 14 && v < 18],
    ['VIX 18-22', v => v >= 18 && v < 22], ['VIX 22-28', v => v >= 22 && v < 28], ['VIX >28', v => v >= 28],
  ];
  for (const [lbl, f] of buckets) vixStatRow(lbl, rows.filter(d => f(d.vix!)));
}

function report(name: string, rows: Row[]) {
  if (MODE === 'edge' || MODE === 'both') { reportSide(name, rows, 'up'); reportSide(name, rows, 'down'); }
  if (MODE === 'range' || MODE === 'both') reportRange(name, rows);
  if (MODE === 'intraday' || MODE === 'both') reportIntraday(name, rows);
  if (MODE === 'vix' || MODE === 'both') reportVix(name, rows);
}

(async () => {
  if (SOURCE === 'polygon' && !KEY) { console.error('POLYGON_API_KEY not set'); process.exit(1); }
  console.log(`source=${SOURCE}${SOURCE === 'yahoo' ? ' range=' + YRANGE : ' ' + FROM + '…' + TO}`);
  // VIX (daily close) for regime conditioning — always from Yahoo (^VIX), keyed by date.
  let vixByDate: Map<string, number> | undefined;
  if (MODE === 'vix' || MODE === 'both') {
    try {
      const vbars = await fetchYahoo('^VIX');
      vixByDate = new Map(vbars.map(b => [dateOf(b.t), b.c]));
      console.log(`VIX: ${vixByDate.size} daily closes loaded (^VIX)`);
    } catch (e: any) { console.error(`! VIX fetch failed: ${e.message}`); }
  }
  for (const [name, ticker, yh] of TICKERS) {
    try {
      const bars = await fetchDaily(ticker, yh);
      const span = bars.length ? `${new Date(bars[0].t).toISOString().slice(0, 10)}…${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}` : '—';
      console.log(`\n# ${name} (${ticker}): ${bars.length} daily bars ${span}`);
      report(name, buildRows(bars, vixByDate));
    } catch (e: any) { console.error(`! ${name}: ${e.message}`); }
  }
  console.log('\nSig: *** p<0.01  ** p<0.05  * p<0.10  | DAILY index OHLC from Polygon. Index "open" = first computed value ~09:30 ET.');
})();
