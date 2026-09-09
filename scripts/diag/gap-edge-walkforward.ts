/**
 * gap-edge-walkforward.ts — Out-of-sample validation of the gap-up edges.
 *
 * Edge under test (from gap-size-edge-study): a GAP-UP open (gap% > gapMin) that
 * opens BELOW its daily moving average (counter-trend pop) continues higher into
 * the 16:00 close. We validate it the rigorous way — walk-forward on the
 * assumption-free underlying open→close return — then translate the surviving
 * rule into realistic dollar P&L two ways:
 *   (1) LONG 0DTE ATM call  (pure direction, theta-negative)
 *   (2) PUT CREDIT SPREAD   (direction + theta, defined risk) — the natural vehicle
 * both BS-priced at the 09:30 open, settled at 16:00 intrinsic, with the standard
 * friction model ($0.05 half-spread + $0.35 commission per leg per side).
 *
 * NOT the replay engine — standalone, parquet-direct, in the style of the long /
 * credit sweeps. Friction math mirrors src/core/friction.ts.
 *
 * Usage: npx tsx scripts/diag/gap-edge-walkforward.ts [--profiles spx,ndx]
 *        [--trainFrac 0.6] [--ivMult 1.0]
 */
import fs from 'fs';
import path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';
import { bsCallPrice, bsPutPrice } from './black-scholes';

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PROFILES = arg('profiles', 'spx,ndx').split(',').map(s => s.trim()).filter(Boolean);
const TRAIN_FRAC = parseFloat(arg('trainFrac', '0.6'));
const IV_MULT = parseFloat(arg('ivMult', '1.0'));   // multiplier on realized-vol → IV proxy

// friction (mirror src/core/friction.ts flat mode)
const HALF_SPREAD = 0.05;
const COMMISSION = 0.35;
const RATE = 0.04;

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

// ── load ─────────────────────────────────────────────────────────────────
interface Bar { ts: number; open: number; high: number; low: number; close: number }
function etMin(tsSec: number): number {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsSec * 1000));
  return parseInt(p.find(x => x.type === 'hour')!.value, 10) * 60 + parseInt(p.find(x => x.type === 'minute')!.value, 10);
}
function loadDay(profileId: string, date: string): Bar[] {
  const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const cache = loadBarCacheFromParquetSync({
    profileId, date, underlyingSymbol: profileId.toUpperCase(),
    symbolRange: { lo: '￿', hi: '￿' }, timeframe: '1m',
    startTs: dayStart, endTs: dayStart + 86400 - 1, skipContractIndicators: true,
  }) as any;
  const bars: Bar[] = (cache?.spxBars ?? []).map((b: any) => ({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }));
  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}

interface Row {
  date: string; prevClose: number; open: number; close: number;
  gap: number; sma20: number | null; ema10: number | null;
  realizedVol: number | null;   // trailing 20d annualized, prior days only
}
function buildRows(profileId: string): Row[] {
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) { console.error(`! no parquet dir for ${profileId}`); return []; }
  const dates = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f)).map(f => f.slice(0, 10)).sort();
  const rows: Row[] = [];
  const closes: number[] = []; const rets: number[] = [];
  let ema10: number | null = null; let prevClose: number | null = null;
  for (const date of dates) {
    const bars = loadDay(profileId, date);
    const rth = bars.filter(b => { const m = etMin(b.ts); return m >= 570 && m <= 959; });
    if (!rth.length) continue;
    const byMin = new Map<number, Bar>(); for (const b of rth) byMin.set(etMin(b.ts), b);
    const open930 = byMin.get(570); const dayClose = rth[rth.length - 1].close;
    const sma20 = closes.length >= 20 ? closes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
    const rv = rets.length >= 20 ? sd(rets.slice(-20)) * Math.sqrt(252) : null;
    if (open930 && prevClose != null) {
      rows.push({
        date, prevClose, open: open930.open, close: dayClose,
        gap: (open930.open - prevClose) / prevClose * 100,
        sma20, ema10, realizedVol: rv,
      });
    }
    if (prevClose != null) rets.push((dayClose - prevClose) / prevClose);
    closes.push(dayClose);
    ema10 = ema10 == null ? dayClose : dayClose * (2 / 11) + ema10 * (1 - 2 / 11);
    prevClose = dayClose;
  }
  return rows;
}

// ── option P&L (BS-priced, settle at intrinsic, full friction) ──────────────
const T_DAY = 6.5 / (24 * 365);   // 09:30→16:00 in years
interface OptPnl { call: number; spread: number }
// long ATM call: pay (premium + halfspread + commission) at open; settle intrinsic
// put credit spread: ATM short put / OTM long put (width ≈ 1% of spot), collect net
//   credit (minus entry friction), settle at intrinsic; defined risk = width - credit.
function optionPnl(open: number, close: number, ivAnnual: number): OptPnl {
  const iv = Math.max(0.05, ivAnnual);
  const K = open;                                   // ATM at the open
  // (1) long call
  const callPrem = bsCallPrice(open, K, T_DAY, iv, RATE);
  const callEntry = callPrem + HALF_SPREAD + COMMISSION;        // pay
  const callSettle = Math.max(0, close - K) - COMMISSION;       // intrinsic, exit commission
  const callPnl = (callSettle - callEntry) * 100;               // 1 contract = ×100
  // (2) put credit spread, width = 1% of spot (rounded to a sane increment)
  const width = Math.max(5, Math.round(open * 0.01));
  const Kshort = open;                              // ATM short put
  const Klong = open - width;                       // OTM long put
  const shortPrem = bsPutPrice(open, Kshort, T_DAY, iv, RATE);
  const longPrem = bsPutPrice(open, Klong, T_DAY, iv, RATE);
  const grossCredit = shortPrem - longPrem;
  // entry friction: 2 legs × (halfspread + commission)
  const netCredit = grossCredit - 2 * (HALF_SPREAD + COMMISSION);
  // settle intrinsic of the spread (short put ITM if close<Kshort)
  const settleVal = Math.max(0, Kshort - close) - Math.max(0, Klong - close);
  const spreadPnl = (netCredit - settleVal) * 100 - 2 * COMMISSION; // exit commissions
  return { call: callPnl, spread: spreadPnl };
}

// ── rule = gap-up & MA relation; returns matching rows ──────────────────────
type MaRel = 'below' | 'above' | 'any';
function selectRule(rows: Row[], maType: 'sma20' | 'ema10', rel: MaRel, gapMin: number, gapMax: number): Row[] {
  return rows.filter(r => {
    if (!(r.gap > gapMin && r.gap <= gapMax)) return false;
    const ma = maType === 'sma20' ? r.sma20 : r.ema10;
    if (rel === 'any') return ma != null;
    if (ma == null) return false;
    return rel === 'below' ? r.open < ma : r.open > ma;
  });
}

interface Perf { n: number; winPct: number; binomP: number; meanRet: number; t: number; pMean: number; callTot: number; spreadTot: number; callPer: number; spreadPer: number; callWin: number; spreadWin: number }
function perf(rows: Row[]): Perf {
  const n = rows.length;
  if (!n) return { n: 0, winPct: NaN, binomP: NaN, meanRet: NaN, t: NaN, pMean: NaN, callTot: 0, spreadTot: 0, callPer: NaN, spreadPer: NaN, callWin: NaN, spreadWin: NaN };
  const rets = rows.map(r => (r.close - r.open) / r.open * 100);
  const m = mean(rets); const s = sd(rets); const se = s / Math.sqrt(n); const t = m / se;
  const wins = rows.filter(r => r.close > r.open).length;
  const zWin = (wins - n * 0.5) / Math.sqrt(n * 0.25);
  let callTot = 0, spreadTot = 0, callW = 0, spreadW = 0;
  for (const r of rows) {
    const iv = (r.realizedVol ?? 0.15) * IV_MULT;
    const p = optionPnl(r.open, r.close, iv);
    callTot += p.call; spreadTot += p.spread;
    if (p.call > 0) callW++; if (p.spread > 0) spreadW++;
  }
  return {
    n, winPct: wins / n * 100, binomP: twoSidedP(zWin), meanRet: m, t, pMean: twoSidedP(t),
    callTot, spreadTot, callPer: callTot / n, spreadPer: spreadTot / n,
    callWin: callW / n * 100, spreadWin: spreadW / n * 100,
  };
}
function fmtPerf(label: string, p: Perf) {
  if (p.n < 5) { console.log(`  ${label.padEnd(26)} n=${p.n} (too few)`); return; }
  console.log(
    `  ${label.padEnd(26)} n=${String(p.n).padStart(3)}  ` +
    `cont=${p.winPct.toFixed(1)}%${star(p.binomP).padEnd(3)} ` +
    `ret=${(p.meanRet >= 0 ? '+' : '') + p.meanRet.toFixed(3)}% t=${p.t.toFixed(2)}${star(p.pMean).padEnd(3)} | ` +
    `CALL $${p.callTot.toFixed(0).padStart(6)} (${(p.callPer >= 0 ? '+' : '') + p.callPer.toFixed(0)}/trade, win ${p.callWin.toFixed(0)}%)  ` +
    `SPREAD $${p.spreadTot.toFixed(0).padStart(6)} (${(p.spreadPer >= 0 ? '+' : '') + p.spreadPer.toFixed(0)}/trade, win ${p.spreadWin.toFixed(0)}%)`);
}

function run(profileId: string) {
  const rows = buildRows(profileId).filter(r => r.sma20 != null && r.ema10 != null && r.realizedVol != null);
  const cut = Math.floor(rows.length * TRAIN_FRAC);
  const train = rows.slice(0, cut); const test = rows.slice(cut);
  const span = (rs: Row[]) => rs.length ? `${rs[0].date}…${rs[rs.length - 1].date}` : '—';
  console.log(`\n${'#'.repeat(120)}\n${profileId.toUpperCase()}  ${rows.length} usable days | TRAIN ${train.length} (${span(train)})  TEST ${test.length} (${span(test)})  | IV×${IV_MULT}\n${'#'.repeat(120)}`);

  // candidate rules to validate
  const rules: { name: string; maType: 'sma20' | 'ema10'; rel: MaRel; gapMin: number; gapMax: number }[] = [
    { name: 'all gap-ups (baseline)', maType: 'sma20', rel: 'any', gapMin: 0.1, gapMax: Infinity },
    { name: 'gap-up BELOW SMA20', maType: 'sma20', rel: 'below', gapMin: 0.1, gapMax: Infinity },
    { name: 'gap-up BELOW SMA20, <1%', maType: 'sma20', rel: 'below', gapMin: 0.1, gapMax: 1.0 },
    { name: 'gap-up BELOW EMA10', maType: 'ema10', rel: 'below', gapMin: 0.1, gapMax: Infinity },
    { name: 'gap-up ABOVE SMA20', maType: 'sma20', rel: 'above', gapMin: 0.1, gapMax: Infinity },
    { name: 'large gap-up >1% (any)', maType: 'sma20', rel: 'any', gapMin: 1.0, gapMax: Infinity },
  ];
  for (const ru of rules) {
    console.log(`\n▶ ${ru.name}`);
    fmtPerf('FULL', perf(selectRule(rows, ru.maType, ru.rel, ru.gapMin, ru.gapMax)));
    fmtPerf('TRAIN', perf(selectRule(train, ru.maType, ru.rel, ru.gapMin, ru.gapMax)));
    fmtPerf('TEST (out-of-sample)', perf(selectRule(test, ru.maType, ru.rel, ru.gapMin, ru.gapMax)));
  }
}

for (const p of PROFILES) run(p);
console.log(`\nSig: *** p<0.01  ** p<0.05  * p<0.10  | cont = close>open. CALL/SPREAD = BS-priced 0DTE, full friction, settle@close.`);
console.log(`IV proxy = trailing 20d realized vol × ${IV_MULT} (0DTE IV usually richer → call P&L optimistic, spread credit conservative).`);
console.log(`XSP = SPX/10 → identical % edge; dollar P&L scales 1/10 per contract.`);
