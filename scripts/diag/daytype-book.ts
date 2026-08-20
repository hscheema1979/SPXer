/**
 * daytype-book.ts — the four-strategy day-type book as a single engine run.
 *
 * Port of the 2026-08-19/20 research session into a self-contained study so
 * backtest-server (:3700) and spxer-studio (:3800) can serve it as data.
 *
 * Strategies (all: SPX 0DTE, short 0.30Δ, $10-wide, hold to 16:00 settle,
 * one entry when filters pass at the entry clock; all filters vs PRIOR CLOSE
 * = OA semantics):
 *   RED     12:00  call  VIX 16-22   Chg -0.75..-0.10   gap: any
 *   FLAT    13:50  call  VIX 14-25   Chg -0.50..+0.10   gap -0.30..+0.30
 *   DRIFT   13:30  put   VIX any     Chg +0.15..+0.50   gap >= -0.30
 *   STRONG  15:20  call  VIX 16-25   Chg +0.40..+0.80   gap: any
 * Chg vs prior close at entry = (1+gap)*(1+moveVsOpen)-1.
 *
 * Pricing = same path as delta-condor-slot / dc-fine (loadDay 1m chain,
 * optPx at entryTs-1, IV-inverted BS delta targeting, nearest-strike wing,
 * structure-scaled friction + SWEEP extra). Emits:
 *   output/daytype-book.json  { config, strategies[], trades[], daily[], book{} }
 *
 * Run: npx tsx scripts/diag/daytype-book.ts [--symbol SPX]
 * Env: DTB_EXTRA_FRICTION (default 20), DTB_SHORT_DELTA (0.30), DTB_WING (10),
 *      DTB_VIX_CSV (default data/cache/vix-daily.csv, fetched from Yahoo if absent)
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx, type Leg } from './flat-fly-study';
import { impliedVolFromPut, impliedVolFromCall, bsPutDelta, bsCallDelta } from './black-scholes';

const TARGET = resolveSymbolTarget(process.argv.slice(2));
const SYM = TARGET.symbol.toLowerCase();
const RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);
const EXTRA = Number(process.env.DTB_EXTRA_FRICTION ?? 20);
const SHORT_DELTA = Number(process.env.DTB_SHORT_DELTA ?? 0.30);
const WING_PTS = Number(process.env.DTB_WING ?? 10);
const SETTLE_HHMM = 6 * 3600 + 30 * 60;   // 16:00 ET
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
const entryFriction = (grossPrem: number) => Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);

interface StratSpec {
  key: string; label: string; side: 'call' | 'put';
  slot: string;                 // 'HH:MM' ET
  vixLo: number; vixHi: number; // 0..99 = any
  chgLo: number; chgHi: number; // % vs prior close at entry
  gapLo: number | null; gapHi: number | null;
}
const STRATS: StratSpec[] = [
  { key: 'RED',    label: 'Red day',        side: 'call', slot: '12:00', vixLo: 16, vixHi: 22, chgLo: -0.75, chgHi: -0.10, gapLo: null,     gapHi: null },
  { key: 'FLAT',   label: 'Flat day',       side: 'call', slot: '13:50', vixLo: 14, vixHi: 25, chgLo: -0.50, chgHi: 0.10,  gapLo: -0.30,   gapHi: 0.30 },
  { key: 'DRIFT',  label: 'Up-drift day',   side: 'put',  slot: '13:30', vixLo: 0,  vixHi: 99, chgLo: 0.15,  chgHi: 0.50,  gapLo: -0.30,   gapHi: null },
  { key: 'STRONG', label: 'Strong-up day',  side: 'call', slot: '15:20', vixLo: 16, vixHi: 25, chgLo: 0.40,  chgHi: 0.80,  gapLo: null,     gapHi: null },
];
const slotSec = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h * 60 + m - (9 * 60 + 30)) * 60;
};

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}

// ── VIX daily (cached CSV; fetched from Yahoo when absent) ───────────────────
function vixDaily(): Record<string, number> {
  const fp = process.env.DTB_VIX_CSV ?? path.resolve(process.cwd(), 'data/cache/vix-daily.csv');
  if (!fs.existsSync(fp)) {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?period1=1738368000&period2=1787145600&interval=1d&range=2y';
    const res = fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    // sync-fetch fallback: use curl via child (kept dependency-free)
    const { execSync } = require('child_process') as typeof import('child_process');
    const json = JSON.parse(execSync(`curl -s -A "Mozilla/5.0" "${url}"`, { encoding: 'utf8', timeout: 30000 }));
    const r = json.chart.result[0];
    const rows = ['ts,open,close'];
    for (let i = 0; i < r.timestamp.length; i++) {
      const c = r.indicators.quote[0].close[i];
      if (c != null) rows.push(`${r.timestamp[i]},,${c}`);
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, rows.join('\n'));
    console.error(`fetched VIX daily -> ${fp} (${rows.length - 1} rows)`);
  }
  const out: Record<string, number> = {};
  for (const line of fs.readFileSync(fp, 'utf8').trim().split('\n').slice(1)) {
    const [ts, , close] = line.split(',');
    if (!close) continue;
    const d = new Date(Number(ts) * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    out[d] = Number(close);
  }
  return out;
}

// ── engine ───────────────────────────────────────────────────────────────────
const VIX = vixDaily();
const DATES = listDatesFor(TARGET);
console.error(`[${TARGET.symbol}] daytype-book — ${DATES.length} days, ${STRATS.length} strategies, Δ${SHORT_DELTA} $${WING_PTS}w, +$${EXTRA} friction`);

interface TradeRow {
  date: string; strat: string; side: string; slot: string;
  short_k: number; long_k: number; credit: number; spot: number;
  settle: number; exit_value: number; pnl: number; win: number;
  vix: number; gap_pct: number; chg_pct: number;
}
const trades: TradeRow[] = [];
let prevClose: number | null = null;
let traded = 0;

for (const date of DATES) {
  let c1: any;
  try { c1 = loadDay(TARGET, date, '1m') as any; } catch { prevClose = null; continue; }
  const s1: any[] = c1?.spxBars;
  if (!s1?.length) { prevClose = null; continue; }
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  const spxAtSettle = optPx(s1, settle);
  if (spxAtSettle == null) { prevClose = null; continue; }
  const openPx = s1[0].open; // first 1m bar's open = session open

  for (const S of STRATS) {
    const entryTs = sess + slotSec(S.slot);
    const spot = optPx(s1, entryTs - 1);
    if (spot == null) continue;
    const moveVsOpen = (spot / openPx - 1) * 100;
    const gap = prevClose != null ? (openPx / prevClose - 1) * 100 : null;
    const chg = gap != null ? ((1 + gap / 100) * (1 + moveVsOpen / 100) - 1) * 100 : null;
    const vix = VIX[date] ?? null;
    if (chg == null || vix == null) continue;
    if (vix < S.vixLo || vix > S.vixHi) continue;
    if (chg < S.chgLo || chg > S.chgHi) continue;
    if (S.gapLo != null && (gap == null || gap < S.gapLo)) continue;
    if (S.gapHi != null && (gap == null || gap > S.gapHi)) continue;

    // price the spread (same selection as delta-condor-slot single-side path)
    const isPut = S.side === 'put';
    const T = Math.max(settle - entryTs, 1200) / (365 * 24 * 3600);
    const putSyms: string[] = [], callSyms: string[] = [];
    for (const [s] of c1.contractBars) { const sym = s as string; (sym[sym.length - 9] === 'P' ? putSyms : callSyms).push(sym); }
    const DK: { strike: number; sym: string; px: number; delta: number }[] = [];
    for (const sym of isPut ? putSyms : callSyms) {
      const bars = c1.contractBars.get(sym) as any[];
      const px = optPx(bars, entryTs - 1);
      if (px == null || px <= 0) continue;
      const k = c1.contractStrikes.get(sym) as number;
      const iv = isPut ? impliedVolFromPut(px, spot, k, T, RATE) : impliedVolFromCall(px, spot, k, T, RATE);
      if (iv == null) continue;
      const delta = isPut ? bsPutDelta(spot, k, T, iv, RATE) : bsCallDelta(spot, k, T, iv, RATE);
      DK.push({ strike: k, sym, px, delta });
    }
    if (DK.length < 2) continue;
    let sh = DK[0], bd = Infinity;
    for (const d of DK) { const dd = Math.abs(Math.abs(d.delta) - SHORT_DELTA); if (dd < bd) { bd = dd; sh = d; } }
    let lg = DK[0], bk = Infinity;
    for (const d of DK) { if (d.strike === sh.strike) continue; const dk = Math.abs(d.strike - (isPut ? sh.strike - WING_PTS : sh.strike + WING_PTS)); if (dk < bk) { bk = dk; lg = d; } }
    if (isPut ? lg.strike >= sh.strike : lg.strike <= sh.strike) continue;
    const wing = Math.abs(sh.strike - lg.strike);
    const credit = sh.px - lg.px;
    if (credit <= 0.10 || credit >= wing * 0.95) continue;
    const intrAt = (px: number) => isPut
      ? Math.max(0, sh.strike - px) - Math.max(0, lg.strike - px)
      : Math.max(0, px - sh.strike) - Math.max(0, px - lg.strike);
    const exitV = Math.max(0, intrAt(spxAtSettle as number));
    const grossPrem = Math.abs(sh.px) + Math.abs(lg.px);
    const pnlGross = (credit - exitV) * 100;
    const pnl = pnlGross - entryFriction(grossPrem) - EXTRA;
    traded++;
    trades.push({
      date, strat: S.key, side: S.side, slot: S.slot,
      short_k: sh.strike, long_k: lg.strike, credit: +credit.toFixed(2), spot: +spot.toFixed(2),
      settle: +(spxAtSettle as number).toFixed(2), exit_value: +exitV.toFixed(2),
      pnl: Math.round(pnl), win: pnl > 0 ? 1 : 0,
      vix: +vix.toFixed(2), gap_pct: gap != null ? +gap.toFixed(3) : 0, chg_pct: +chg.toFixed(3),
    });
  }
  prevClose = openPx && s1 ? (optPx(s1, settle - 60) ?? s1[s1.length - 1].close) : null;
}
console.error(`  ${trades.length} trades on ${new Set(trades.map(t => t.date)).size} days`);

// ── aggregate ────────────────────────────────────────────────────────────────
const splitIdx = Math.floor(DATES.length / 2);
const trainSet = new Set(DATES.slice(0, splitIdx));
const CUT1Y = DATES.slice(-252)[0];

function stats(pnls: number[]) {
  const n = pnls.length;
  if (!n) return { n: 0, wr: 0, pnl: 0, avg: 0, worst: 0 };
  const wr = 100 * pnls.filter(p => p > 0).length / n;
  let cum = 0, peak = 0, mdd = 0;
  for (const p of pnls) { cum += p; peak = Math.max(peak, cum); mdd = Math.max(mdd, peak - cum); }
  return { n, wr: +wr.toFixed(1), pnl: Math.round(cum), avg: +(cum / n).toFixed(1), worst: Math.round(Math.min(...pnls)), maxDD: Math.round(mdd) };
}

const strategies = STRATS.map(S => {
  const t = trades.filter(x => x.strat === S.key);
  const pnls = t.map(x => x.pnl);
  const te = t.filter(x => !trainSet.has(x.date)).map(x => x.pnl);
  const y1 = t.filter(x => x.date >= CUT1Y).map(x => x.pnl);
  return { ...S, stats: stats(pnls), test: stats(te), yr1: stats(y1) };
});

// daily book (sum of fired trades per day)
const dayMap = new Map<string, number[]>();
for (const t of trades) {
  if (!dayMap.has(t.date)) dayMap.set(t.date, []);
  dayMap.get(t.date)!.push(t.pnl);
}
const daily = [...dayMap.entries()].sort().map(([date, ps]) => ({ date, pnl: ps.reduce((a, b) => a + b, 0), trades: ps.length }));
const bookPnls = daily.map(d => d.pnl);
const book = {
  ...stats(bookPnls),
  test: stats(daily.filter(d => !trainSet.has(d.date)).map(d => d.pnl)),
  yr1: stats(daily.filter(d => d.date >= CUT1Y).map(d => d.pnl)),
  tradedDays: daily.length,
  totalDays: DATES.length,
  days2Fired: daily.filter(d => d.trades >= 2).length,
};

const out = {
  generatedAt: new Date().toISOString(),
  config: { symbol: TARGET.symbol, shortDelta: SHORT_DELTA, wingPts: WING_PTS, extraFriction: EXTRA, settle: '16:00 ET', trainSplitIdx: splitIdx, dateRange: [DATES[0], DATES[DATES.length - 1]] },
  strategies, trades, daily, book,
};
const fp = path.resolve(process.cwd(), 'output/daytype-book.json');
fs.mkdirSync(path.dirname(fp), { recursive: true });
fs.writeFileSync(fp, JSON.stringify(out, null, 2));
console.log(`Wrote ${fp}`);
console.log(`BOOK: ${book.tradedDays}/${book.totalDays} days, WR ${book.wr}%, $${book.pnl} total, maxDD $${book.maxDD}`);
