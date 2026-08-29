/**
 * spx-bs-stress.ts  —  portfolio/concurrency stress test for the honest (BS) OTM hold-to-settle edge.
 *
 * The per-cell study counted each trade once, so it MISSED concurrency: a DTE-day
 * spread entered daily means ~DTE open positions at once, and a selloff hits them
 * ALL simultaneously. This rebuilds the daily-entry BOOK, marks every open spread
 * to market (BS, from the SPX path) at each session close, and reports the TRUE
 * portfolio drawdown — plus the book loss through the worst SPX selloff windows.
 *
 *   npx tsx scripts/diag/spx-bs-stress.ts
 * Edit CONFIGS below to choose (dte, delta, width). Study dir output, NOT dashboard.
 */
import * as dotenv from 'dotenv';
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { readDiskCache, sessOpenTs } from './flat-file-reader';
import { expiryForDate, tradingDaysBetween } from './sweep-dates';
import { deriveStrikeInterval } from './strike-grid';
import { selectStrikeByDelta, type DeltaCandidate } from './delta-grid';
import { bsPutPrice, impliedVolFromPut } from './black-scholes';
import { geometryForDte } from './sweep-geometry';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config();

const SYM = (process.env.SYM ?? 'SPX');
const SPX0 = resolveSymbolTarget(['--symbol', SYM, '--dte', '0']) as any;
const RATE = 0.04, SKEW_BETA = Number(process.env.SKEW_BETA ?? 1.0);
const ET_1PM_SEC = 3 * 3600 + 1800, SETTLE_HHMM = 6 * 3600 + 15 * 60, MIN_PER_YR = 252 * 390;
const CONFIGS = [
  { dte: 10, delta: 0.20, width: 4 },
  { dte: 20, delta: 0.35, width: 4 },
  { dte: 5,  delta: 0.20, width: 3 },
  { dte: 3,  delta: 0.30, width: 4 },
];

const occType = (s: string) => s[s.length - 9];
const occExp = (s: string) => s.slice(s.length - 15, s.length - 9);
const occStrike = (s: string) => parseInt(s.slice(s.length - 8)) / 1000;
const expToYYMMDD = (d: string) => d.slice(2).replace(/-/g, '');
const optPx = (bars: any[], ts: number): number | null => { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; };
const spxCache = new Map<string, any[]>();
function spxBarsFor(date: string): any[] { if (spxCache.has(date)) return spxCache.get(date)!; let b: any[] = []; try { b = loadDay(SPX0, date, '1m')?.spxBars ?? []; } catch {} spxCache.set(date, b); return b; }
function legBars(sym: string, caches: Map<string, any[]>[]) { const o: any[] = []; for (const c of caches) { const b = c.get(sym); if (b) o.push(...b); } return o; }

type Trade = { entryDate: string; settleDate: string; credit: number; finalPnl: number; dailyV: Map<string, number> };

function runConfig(cfg: { dte: number; delta: number; width: number }) {
  const TARGET = resolveSymbolTarget(['--symbol', SYM, '--dte', String(cfg.dte)]) as any;
  const GEO = geometryForDte(cfg.dte);
  const CLOSE_PENALTY = 2 * GEO.closeHalfSpread, SLIP = GEO.entrySlippage2leg;
  const dates = listDatesFor(SPX0);
  const trades: Trade[] = [];

  for (const date of dates) {
    const expiryDate = expiryForDate(date, cfg.dte);
    const entryTs = sessOpenTs(date) + ET_1PM_SEC;
    const settleTs = sessOpenTs(expiryDate) + SETTLE_HHMM;
    const s1 = spxBarsFor(date); const spxEntry = optPx(s1, entryTs - 1); if (spxEntry == null) continue;
    const day = readDiskCache(date, TARGET.optionPrefix); if (!day) continue;
    const want = expToYYMMDD(expiryDate);
    const strikes = new Map<string, number>(); const barsBy = new Map<string, any[]>();
    for (const [sym, b] of day) { if (occType(sym) !== 'P' || occExp(sym) !== want) continue; strikes.set(sym, occStrike(sym)); barsBy.set(sym, b); }
    if (strikes.size < 2) continue;
    const grid = deriveStrikeInterval([...strikes.values()], spxEntry) ?? TARGET.strikeInterval;
    const T_select = Math.max(cfg.dte, 0.25) / 252;
    const cands: DeltaCandidate[] = []; const symByK = new Map<number, string>();
    for (const [sym, k] of strikes) { const px = optPx(barsBy.get(sym)!, entryTs - 1); if (px == null || px <= 0) continue; cands.push({ strike: k, price: px }); symByK.set(k, sym); }
    if (cands.length < 2) continue;
    const sel = selectStrikeByDelta(cands, cfg.delta, spxEntry, T_select, RATE); if (!sel) continue;
    const Ks = sel.strike, shortSym = symByK.get(Ks)!;
    let Kl = -1, longSym = '', best = Infinity; const tgt = Ks - cfg.width * grid;
    for (const [sym, k] of strikes) { if (k >= Ks) continue; const dd = Math.abs(k - tgt); if (dd < best) { best = dd; Kl = k; longSym = sym; } }
    if (!longSym) continue;
    const widthPts = Ks - Kl; if (widthPts <= 0) continue;

    const sessionDates = tradingDaysBetween(date, expiryDate);
    const caches = sessionDates.map(d => readDiskCache(d, TARGET.optionPrefix) ?? new Map<string, any[]>());
    const sBars = legBars(shortSym, caches), lBars = legBars(longSym, caches);
    const sEntry = optPx(sBars, entryTs - 1), lEntry = optPx(lBars, entryTs - 1);
    if (sEntry == null || lEntry == null) continue;
    const credit = sEntry - lEntry; if (credit <= 0.05 || credit > widthPts * 0.95) continue;

    const spxPath: any[] = [];
    for (const d of sessionDates) for (const b of spxBarsFor(d)) if (b.ts > entryTs && b.ts <= settleTs) spxPath.push(b);
    spxPath.sort((a, b) => a.ts - b.ts); if (!spxPath.length) continue;
    const totalMin = spxPath.length, T0 = totalMin / MIN_PER_YR;
    const ivS = impliedVolFromPut(sEntry, spxEntry, Ks, T0, RATE) ?? 0.15;
    const ivL = impliedVolFromPut(lEntry, spxEntry, Kl, T0, RATE) ?? ivS;

    // BS value at each minute; sample the last value at-or-before each session's 15:45.
    const dailyV = new Map<string, number>();
    const sampleTsByDate = new Map<string, number>();
    for (const d of sessionDates) sampleTsByDate.set(d, sessOpenTs(d) + SETTLE_HHMM);
    let lastV = credit;
    let di = 0; const sortedSamples = [...sampleTsByDate.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < spxPath.length; i++) {
      const spot = spxPath[i].close, T = Math.max((totalMin - (i + 1)) / MIN_PER_YR, 0), pct = (spot - spxEntry) / spxEntry;
      lastV = Math.max(0, bsPutPrice(spot, Ks, T, Math.max(0.01, ivS - SKEW_BETA * pct), RATE) - bsPutPrice(spot, Kl, T, Math.max(0.01, ivL - SKEW_BETA * pct), RATE));
      while (di < sortedSamples.length && spxPath[i].ts >= sortedSamples[di][1]) { dailyV.set(sortedSamples[di][0], lastV); di++; }
    }
    const spxAtSettle = spxPath[spxPath.length - 1].close;
    const settleV = Math.max(0, Math.max(0, Ks - spxAtSettle) - Math.max(0, Kl - spxAtSettle));
    const finalPnl = (credit - settleV) * 100 - SLIP;   // cash-settled expiry: no close-spread cost
    dailyV.set(expiryDate, settleV);
    trades.push({ entryDate: date, settleDate: expiryDate, credit, finalPnl, dailyV });
  }

  // Portfolio equity at each session close: Σ_trades MTM-as-of-D.
  const allDates = listDatesFor(SPX0);
  const closeByDate = new Map<string, number>();
  for (const d of allDates) { const b = spxBarsFor(d); const c = optPx(b, sessOpenTs(d) + SETTLE_HHMM); if (c != null) closeByDate.set(d, c); }
  let peak = -Infinity, maxDD = 0, ddPeakDate = '', ddTroughDate = '', curPeakDate = '';
  const equitySeries: { date: string; eq: number; openN: number }[] = [];
  for (const D of allDates) {
    let eq = 0, openN = 0;
    for (const t of trades) {
      if (t.settleDate <= D) eq += t.finalPnl;                              // realized
      else if (t.entryDate <= D) {                                          // open → MTM
        const v = t.dailyV.get(D); if (v != null) { eq += (t.credit - v) * 100; openN++; }
      }
    }
    equitySeries.push({ date: D, eq, openN });
    if (eq > peak) { peak = eq; curPeakDate = D; }
    if (peak - eq > maxDD) { maxDD = peak - eq; ddPeakDate = curPeakDate; ddTroughDate = D; }
  }
  const avgConc = equitySeries.reduce((a, b) => a + b.openN, 0) / equitySeries.length;
  const peakConc = Math.max(...equitySeries.map(e => e.openN));
  return { cfg, trades, equitySeries, finalEq: equitySeries[equitySeries.length - 1].eq, maxDD, ddPeakDate, ddTroughDate, avgConc, peakConc, closeByDate };
}

function worstWindows(closeByDate: Map<string, number>) {
  const ds = [...closeByDate.keys()].sort(); const px = ds.map(d => closeByDate.get(d)!);
  const day1 = ds.map((d, i) => i ? { d, r: (px[i] / px[i - 1] - 1) * 100 } : { d, r: 0 }).sort((a, b) => a.r - b.r).slice(0, 5);
  const win5: { d: string; r: number }[] = [];
  for (let i = 5; i < ds.length; i++) win5.push({ d: `${ds[i - 5]}→${ds[i]}`, r: (px[i] / px[i - 5] - 1) * 100 });
  win5.sort((a, b) => a.r - b.r);
  return { day1, win5: win5.slice(0, 5) };
}

async function main() {
  console.log(`\n=== BS PORTFOLIO STRESS — ${SYM} | daily-entry book, concurrency-aware, marked through selloffs ===`);
  const results = CONFIGS.map(runConfig);
  const ww = worstWindows(results[0].closeByDate);
  console.log(`\nWorst SPX single days: ${ww.day1.map(x => `${x.d} ${x.r.toFixed(1)}%`).join('  ')}`);
  console.log(`Worst SPX 5-day windows: ${ww.win5.map(x => `${x.d} ${x.r.toFixed(1)}%`).join('  ')}\n`);
  console.log(['config'.padEnd(18), 'finalEq'.padStart(11), 'trueDD'.padStart(10), 'peakConc'.padStart(9), 'avgConc'.padStart(8), 'net/DD'.padStart(7), 'DD window'].join(' '));
  console.log('-'.repeat(95));
  const out: any = { sym: SYM, beta: SKEW_BETA, configs: [] as any[] };
  for (const r of results) {
    const label = `${r.cfg.dte}d ${r.cfg.delta}d w${r.cfg.width}c`;
    const ratio = r.maxDD > 0 ? (r.finalEq / r.maxDD).toFixed(2) : 'inf';
    console.log([label.padEnd(18), ('$' + Math.round(r.finalEq)).padStart(11), ('$' + Math.round(r.maxDD)).padStart(10), String(r.peakConc).padStart(9), r.avgConc.toFixed(1).padStart(8), ratio.padStart(7), `${r.ddPeakDate}→${r.ddTroughDate}`].join(' '));
    // worst single-day book drop during the period
    let worstDay = { date: '', drop: 0 };
    for (let i = 1; i < r.equitySeries.length; i++) { const drop = r.equitySeries[i].eq - r.equitySeries[i - 1].eq; if (drop < worstDay.drop) worstDay = { date: r.equitySeries[i].date, drop }; }
    console.log(`  ${' '.repeat(16)}worst single-day book move: $${Math.round(worstDay.drop)} on ${worstDay.date}`);
    out.configs.push({ label, finalEq: r.finalEq, trueDD: r.maxDD, peakConc: r.peakConc, avgConc: r.avgConc, ddWindow: `${r.ddPeakDate}→${r.ddTroughDate}`, worstDay });
  }
  console.log('-'.repeat(95));
  console.log(`\nNOTE: trueDD here is the CONCURRENCY-AWARE book drawdown (all open spreads marked together), vs the per-trade study's single-position DD.`);
  const dir = path.join(process.cwd(), 'scripts/autoresearch/output/STUDY-bs-reprice');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `stress-${SYM.toLowerCase()}.json`), JSON.stringify(out, null, 2));
  console.log(`→ ${path.join(dir, `stress-${SYM.toLowerCase()}.json`)}`);
}
main().catch(e => { console.error(e); process.exit(1); });
