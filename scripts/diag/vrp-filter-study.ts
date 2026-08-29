/**
 * vrp-filter-study.ts  —  Variance-Risk-Premium entry filter on hold-to-settle credit spreads
 *
 * The "Black-Scholes statistical arbitrage" idea (video): trade the gap between
 * the MODEL's fair vol and the MARKET's implied vol, not the price level. With
 * implied vol inverted from the mark, BS price ≡ market price — no edge. The edge
 * only exists when you supply an INDEPENDENT vol forecast and trade the spread:
 *
 *     VRP = IV_market(short leg)  −  RV_forecast(trailing realized vol)
 *
 * IV_market is inverted from the real short-leg mark at entry; RV_forecast is the
 * annualized stdev of the prior RV_LEN daily SPX log-returns (strictly prior days
 * — no look-ahead). High VRP = market vol is rich vs realized = premium-selling is
 * fat. The hypothesis: gating credit-spread entries to high-VRP days beats trading
 * the SAME structure UNCONDITIONALLY. If it doesn't, the video's framing is true
 * but adds nothing over "always sell premium."
 *
 * Base structure: 0.50–0.55Δ short, hold-to-settle ONLY (the honest floor — no
 * early exit, so settle = cash intrinsic and the OPT/BS fill distinction is moot).
 * Runs BOTH put-credit (bull put) and call-credit (bear call) spreads — call-side
 * VRP behaves differently because of put skew, so it's the control.
 *
 * Friction/credit/strike-selection math is byte-for-byte the same as
 * spx-bs-credit-study.ts (cross-engine friction parity).
 *
 *   npx tsx scripts/diag/vrp-filter-study.ts --symbol SPX --dte 1
 * Env: DELTAS (0.50,0.55), WIDTHS (2,4), RV_LEN (20), BUCKETS (3), MAXDATES (0=all),
 *      SIDES (put,call), ENTRY_SEC (1pm).
 */
import * as dotenv from 'dotenv';
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { readDiskCache, sessOpenTs } from './flat-file-reader';
import { expiryForDate } from './sweep-dates';
import { deriveStrikeInterval } from './strike-grid';
import { selectStrikeByDelta, selectCallStrikeByDelta, type DeltaCandidate } from './delta-grid';
import { impliedVolFromPut, impliedVolFromCall } from './black-scholes';
import { geometryForDte } from './sweep-geometry';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config();

const TARGET = resolveSymbolTarget(process.argv.slice(2));
const SPX0 = { ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any;
const GEO = geometryForDte(TARGET.dte);
const RATE = 0.04;
const MAXDATES = Number(process.env.MAXDATES ?? 0);
const RV_LEN = Number(process.env.RV_LEN ?? 20);     // trailing window (days) for the realized-vol forecast
// RV_MODE: 'daily' = trailing close-to-close daily vol (fits 1DTE). 'intraday' =
// horizon-matched realized vol of the actual entry→settle window (fits 0DTE).
const RV_MODE = (process.env.RV_MODE ?? (TARGET.dte <= 0 ? 'intraday' : 'daily')) as 'daily' | 'intraday';
const N_BUCKETS = Math.max(2, Number(process.env.BUCKETS ?? 3));   // VRP quantile buckets per side
const ET_1PM_SEC = 3 * 3600 + 1800;
const ENTRY_SEC = Number(process.env.ENTRY_SEC ?? ET_1PM_SEC);
const SETTLE_HHMM = 6 * 3600 + 15 * 60;
const SLIP = GEO.entrySlippage2leg;
const MIN_PER_YR = 252 * 390;

const DELTAS = (process.env.DELTAS ?? '0.50,0.55').split(',').map(Number);
const WIDTHS = (process.env.WIDTHS ?? '2,4').split(',').map(Number);
const SIDES = (process.env.SIDES ?? 'put,call').split(',') as ('put' | 'call')[];

const occType = (s: string) => s[s.length - 9];
const occExp = (s: string) => s.slice(s.length - 15, s.length - 9);
const occStrike = (s: string) => parseInt(s.slice(s.length - 8)) / 1000;
const expToYYMMDD = (d: string) => d.slice(2).replace(/-/g, '');
const optPx = (bars: any[], ts: number): number | null => { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; };

const spxCache = new Map<string, any[]>();
function spxBarsFor(date: string): any[] {
  if (spxCache.has(date)) return spxCache.get(date)!;
  let bars: any[] = []; try { bars = loadDay(SPX0, date, '1m')?.spxBars ?? []; } catch {}
  spxCache.set(date, bars); return bars;
}
// Option chain for ONE side (P or C) of the entry date, filtered to the target expiry.
function entryChain(entryDate: string, expiryDate: string, side: 'put' | 'call') {
  const day = readDiskCache(entryDate, TARGET.optionPrefix); if (!day) return null;
  const want = expToYYMMDD(expiryDate);
  const wantType = side === 'put' ? 'P' : 'C';
  const bars = new Map<string, any[]>(), strikes = new Map<string, number>();
  for (const [sym, b] of day) { if (occType(sym) !== wantType || occExp(sym) !== want) continue; bars.set(sym, b); strikes.set(sym, occStrike(sym)); }
  return bars.size ? { bars, strikes } : null;
}

// ── per-trade record. Hold-to-settle, so pnl is the honest cash-settled number. ──
type Trade = { side: 'put' | 'call'; delta: number; width: number; pnl: number; vrp: number; iv: number; rv: number };
const trades: Trade[] = [];

async function main() {
  const dates = listDatesFor(SPX0);
  const used = MAXDATES > 0 ? dates.slice(-MAXDATES) : dates;
  console.error(`[vrp] ${TARGET.symbol} ${TARGET.dte}DTE | deltas ${DELTAS.join('/')} | widths ${WIDTHS.join('/')} | sides ${SIDES.join('/')} | rv=${RV_MODE}/${RV_LEN} | ${used.length} dates | slip=${SLIP}`);

  // Trailing realized-vol forecast: annualized stdev of the prior RV_LEN daily-close
  // log-returns, strictly BEFORE `date` (no look-ahead). Mirrors gap-edge-walkforward.
  const idxByDate = new Map(dates.map((d, i) => [d, i]));
  const closeCache = new Map<string, number | null>();
  const dailyClose = (d: string): number | null => { if (closeCache.has(d)) return closeCache.get(d)!; const b = spxBarsFor(d); const c = b.length ? b[b.length - 1].close : null; closeCache.set(d, c); return c; };
  function rvForecastDaily(date: string): number | null {
    const i = idxByDate.get(date); if (i == null || i <= RV_LEN) return null;
    const rets: number[] = [];
    for (let k = i - RV_LEN; k < i; k++) { const p0 = dailyClose(dates[k - 1]), p1 = dailyClose(dates[k]); if (p0 != null && p1 != null && p0 > 0 && p1 > 0) rets.push(Math.log(p1 / p0)); }
    if (rets.length < RV_LEN / 2) return null;
    const m = rets.reduce((a, b) => a + b, 0) / rets.length;
    const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length;
    return Math.sqrt(v) * Math.sqrt(252);
  }

  // Horizon-matched intraday RV: for each prior day, take the SPX move over the
  // SAME entry→settle window and normalize by sqrt(window years) so it's an
  // annualized vol comparable to IV. RV_ann = stdev over RV_LEN days of (r/√T).
  // Strictly prior days → no look-ahead.
  const windowCache = new Map<string, { r: number; T: number } | null>();
  function windowMove(d: string): { r: number; T: number } | null {
    if (windowCache.has(d)) return windowCache.get(d)!;
    let res: { r: number; T: number } | null = null;
    try {
      const exp = expiryForDate(d, TARGET.dte);
      const eTs = sessOpenTs(d) + ENTRY_SEC, sTs = sessOpenTs(exp) + SETTLE_HHMM;
      const sEntry = optPx(spxBarsFor(d), eTs - 1), sSettle = optPx(spxBarsFor(exp), sTs);
      let mins = 0;
      for (const b of spxBarsFor(d)) if (b.ts > eTs && b.ts <= sTs) mins++;
      if (exp !== d) for (const b of spxBarsFor(exp)) if (b.ts > eTs && b.ts <= sTs) mins++;
      if (sEntry != null && sSettle != null && sEntry > 0 && mins > 0) res = { r: (sSettle - sEntry) / sEntry, T: mins / MIN_PER_YR };
    } catch {}
    windowCache.set(d, res); return res;
  }
  function rvForecastIntraday(date: string): number | null {
    const i = idxByDate.get(date); if (i == null || i <= RV_LEN) return null;
    const xs: number[] = [];
    for (let k = i - RV_LEN; k < i; k++) { const w = windowMove(dates[k]); if (w && w.T > 0) xs.push(w.r / Math.sqrt(w.T)); }
    if (xs.length < RV_LEN / 2) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
    return Math.sqrt(v);   // already annualized (r ≈ σ_ann·√T)
  }
  const rvForecast = (date: string) => RV_MODE === 'intraday' ? rvForecastIntraday(date) : rvForecastDaily(date);

  let nTraded = 0;
  for (const date of used) {
    const rv = rvForecast(date); if (rv == null) continue;   // need enough history to forecast
    const expiryDate = expiryForDate(date, TARGET.dte);
    const sess = sessOpenTs(date);
    const entryTs = sess + ENTRY_SEC;
    const settleTs = sessOpenTs(expiryDate) + SETTLE_HHMM;
    const s1 = spxBarsFor(date);
    const spxEntry = optPx(s1, entryTs - 1); if (spxEntry == null) continue;
    const spxAtSettle = optPx(spxBarsFor(expiryDate), settleTs) ?? (spxBarsFor(expiryDate).slice(-1)[0]?.close ?? null);
    if (spxAtSettle == null) continue;

    // T0 = entry→settle in years, measured in 1m bars (parity with spx-bs-credit-study).
    const spxPath: any[] = [];
    for (const b of s1) if (b.ts > entryTs && b.ts <= settleTs) spxPath.push(b);
    if (expiryDate !== date) for (const b of spxBarsFor(expiryDate)) if (b.ts > entryTs && b.ts <= settleTs) spxPath.push(b);
    if (!spxPath.length) continue;
    const T0 = spxPath.length / MIN_PER_YR;
    const T_select = Math.max(TARGET.dte, 0.25) / 252;

    let dateTraded = false;
    for (const side of SIDES) {
      const ch = entryChain(date, expiryDate, side); if (!ch) continue;
      const allStrikes = [...ch.strikes.values()];
      const grid = deriveStrikeInterval(allStrikes, spxEntry) ?? TARGET.strikeInterval;
      const cands: DeltaCandidate[] = []; const symByK = new Map<number, string>();
      for (const [sym, k] of ch.strikes) { const px = optPx(ch.bars.get(sym)!, entryTs - 1); if (px == null || px <= 0) continue; cands.push({ strike: k, price: px }); symByK.set(k, sym); }
      if (cands.length < 2) continue;

      for (const delta of DELTAS) {
        const shortSel = side === 'put'
          ? selectStrikeByDelta(cands, delta, spxEntry, T_select, RATE)
          : selectCallStrikeByDelta(cands, delta, spxEntry, T_select, RATE);
        if (!shortSel) continue;
        const Ks = shortSel.strike, shortSym = symByK.get(Ks)!;
        const shortEntry = optPx(ch.bars.get(shortSym)!, entryTs - 1); if (shortEntry == null || shortEntry <= 0) continue;

        // Market IV for the VRP signal: inverted from the real short-leg mark.
        const ivMkt = side === 'put'
          ? impliedVolFromPut(shortEntry, spxEntry, Ks, T0, RATE)
          : impliedVolFromCall(shortEntry, spxEntry, Ks, T0, RATE);
        if (ivMkt == null) continue;
        const vrp = ivMkt - rv;

        for (const width of WIDTHS) {
          // Long protective leg: `width` strikes further OTM (lower for puts, higher for calls).
          const tgt = side === 'put' ? Ks - width * grid : Ks + width * grid;
          let Kl = -1, longSym = '', best = Infinity;
          for (const [sym, k] of ch.strikes) {
            if (side === 'put' ? k >= Ks : k <= Ks) continue;
            const dd = Math.abs(k - tgt); if (dd < best) { best = dd; Kl = k; longSym = sym; }
          }
          if (!longSym || (side === 'put' ? Kl >= Ks : Kl <= Ks)) continue;
          const widthPts = Math.abs(Ks - Kl);
          const longEntry = optPx(ch.bars.get(longSym)!, entryTs - 1); if (longEntry == null) continue;
          const credit = shortEntry - longEntry;
          if (credit <= 0.05 || credit > widthPts * 0.95) continue;

          // Hold-to-settle: SPX is cash-settled → settle value is the spread's intrinsic.
          const settleV = side === 'put'
            ? Math.max(0, Math.max(0, Ks - spxAtSettle) - Math.max(0, Kl - spxAtSettle))
            : Math.max(0, Math.max(0, spxAtSettle - Ks) - Math.max(0, spxAtSettle - Kl));
          const pnl = (credit - settleV) * 100 - SLIP;
          trades.push({ side, delta, width, pnl, vrp, iv: ivMkt, rv });
          dateTraded = true;
        }
      }
    }
    if (dateTraded) nTraded++;
  }

  // ── stats ──
  function stat(rows: Trade[]) {
    const pnls = rows.map(r => r.pnl);
    const n = pnls.length, wins = pnls.filter(p => p > 0).length, net = pnls.reduce((a, b) => a + b, 0);
    let peak = 0, cum = 0, dd = 0; for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const mean = n ? net / n : 0;
    const sd = n ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) : 0;
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;   // ~1 trade/day → annualize by sqrt(252)
    const avgIv = n ? rows.reduce((a, b) => a + b.iv, 0) / n : 0;
    const avgRv = n ? rows.reduce((a, b) => a + b.rv, 0) / n : 0;
    const avgVrp = n ? rows.reduce((a, b) => a + b.vrp, 0) / n : 0;
    return { n, wr: n ? 100 * wins / n : 0, net, dd, avg: mean, sharpe, avgIv, avgRv, avgVrp };
  }

  // Bucket a side's trades into nB quantiles by `keyFn` (low→high). Default key = VRP.
  function bucketize(rows: Trade[], keyFn: (t: Trade) => number = t => t.vrp, nB = N_BUCKETS) {
    const sorted = [...rows].sort((a, b) => keyFn(a) - keyFn(b));
    const out: { label: string; lo: number; hi: number; rows: Trade[] }[] = [];
    for (let q = 0; q < nB; q++) {
      const a = Math.floor((q * sorted.length) / nB), b = Math.floor(((q + 1) * sorted.length) / nB);
      const slice = sorted.slice(a, b);
      out.push({ label: `Q${q + 1}`, lo: slice.length ? keyFn(slice[0]) : 0, hi: slice.length ? keyFn(slice[slice.length - 1]) : 0, rows: slice });
    }
    return out;
  }

  const out: any = { config: { symbol: TARGET.symbol, dte: TARGET.dte, deltas: DELTAS, widths: WIDTHS, rvMode: RV_MODE, rvLen: RV_LEN, buckets: N_BUCKETS, datesTraded: nTraded, exit: 'hold-to-settle' }, sides: {} as any };

  const fmt = (s: any) => [String(s.n).padStart(4), s.wr.toFixed(0).padStart(5), ('$' + Math.round(s.avg)).padStart(7), ('$' + Math.round(s.net)).padStart(9), ('$' + Math.round(s.dd)).padStart(9), s.sharpe.toFixed(2).padStart(7), (100 * s.avgVrp).toFixed(1).padStart(7)].join(' ');
  const HDR = ['  n'.padStart(4), 'WR'.padStart(5), 'avg'.padStart(7), 'net'.padStart(9), 'maxDD'.padStart(9), 'Sharpe'.padStart(7), 'VRP%'.padStart(7)].join(' ');

  console.log(`\n=== VRP FILTER STUDY — ${TARGET.symbol} ${TARGET.dte}DTE | hold-to-settle | ${nTraded} dates | rvLen=${RV_LEN} ===`);
  console.log(`(VRP = IV_market(short) − RV_forecast.  Headline test: does the HIGH-VRP bucket beat ALL?)\n`);

  for (const side of SIDES) {
    const sideRows = trades.filter(t => t.side === side);
    if (!sideRows.length) { console.log(`${side.toUpperCase()}: no trades\n`); continue; }
    const all = stat(sideRows);
    const buckets = bucketize(sideRows).map(bk => ({ label: bk.label, lo: bk.lo, hi: bk.hi, stat: stat(bk.rows) }));
    const hi = buckets[buckets.length - 1].stat, lo = buckets[0].stat;

    console.log(`── ${side === 'put' ? 'PUT credit (bull put)' : 'CALL credit (bear call)'} ──`);
    console.log('bucket'.padEnd(8) + HDR);
    console.log('ALL'.padEnd(8) + fmt(all));
    for (const bk of buckets) console.log(`${bk.label} [${(100 * bk.lo).toFixed(1)},${(100 * bk.hi).toFixed(1)}]`.padEnd(8).slice(0, 8) + fmt(bk.stat));
    const edge = hi.avg - all.avg, verdict = hi.avg > all.avg && hi.avg > lo.avg ? '✅ gating helps' : '❌ no VRP edge';
    console.log(`  → HIGH-VRP avg $${Math.round(hi.avg)} vs ALL $${Math.round(all.avg)}  (Δ $${edge.toFixed(1)}/trade)  ${verdict}`);

    // ── CONTROL 1: IV-LEVEL sort. If raw IV alone sorts P&L just as well, the
    //    "edge" is a vol-level effect, not the IV−RV spread. ──
    const ivBuckets = bucketize(sideRows, t => t.iv).map(bk => ({ lo: bk.lo, hi: bk.hi, stat: stat(bk.rows) }));
    console.log(`  IV-level control (sort by raw IV):  ${ivBuckets.map((b, i) => `Q${i + 1} $${Math.round(b.stat.avg)}`).join('  ')}`);

    // ── CONTROL 2: double-sort. Within each IV tercile, split by VRP median.
    //    If VRP-high beats VRP-low INSIDE every IV bucket, the spread adds edge
    //    beyond the level (the strong claim). ──
    const ivTerc = bucketize(sideRows, t => t.iv, 3);
    let addsWithin = 0;
    const dbl = ivTerc.map((iv, i) => {
      const half = bucketize(iv.rows, t => t.vrp, 2);
      const loA = stat(half[0].rows).avg, hiA = stat(half[1].rows).avg;
      if (hiA > loA) addsWithin++;
      return { ivBucket: `IV-Q${i + 1}`, ivRange: [iv.lo, iv.hi], vrpLoAvg: loA, vrpHiAvg: hiA, n: iv.rows.length };
    });
    console.log(`  Double-sort (VRP-hi − VRP-lo within each IV tercile):  ${dbl.map(d => `${d.ivBucket} ${(d.vrpHiAvg - d.vrpLoAvg) >= 0 ? '+' : ''}$${Math.round(d.vrpHiAvg - d.vrpLoAvg)}`).join('  ')}`);
    console.log(`  → VRP adds within ${addsWithin}/3 IV terciles  ${addsWithin >= 2 ? '✅ spread, not just level' : '⚠️ likely just IV level'}\n`);

    out.sides[side] = { all, buckets, ivBuckets, doubleSort: dbl, perCell: [] as any[] };
    for (const delta of DELTAS) for (const width of WIDTHS) {
      const cellRows = sideRows.filter(t => t.delta === delta && t.width === width);
      if (!cellRows.length) continue;
      const cellAll = stat(cellRows);
      const cellBuckets = bucketize(cellRows).map(bk => ({ label: bk.label, lo: bk.lo, hi: bk.hi, stat: stat(bk.rows) }));
      out.sides[side].perCell.push({ spread: `${delta.toFixed(2)}d w${width}c`, all: cellAll, buckets: cellBuckets });
    }
  }

  const dir = path.join(process.cwd(), 'scripts/autoresearch/output/STUDY-vrp');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `vrp-${TARGET.symbol.toLowerCase()}-${TARGET.dte}dte-${RV_MODE}rv${RV_LEN}${ENTRY_SEC !== ET_1PM_SEC ? `-e${ENTRY_SEC}` : ''}.json`);
  fs.writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`→ ${fp}`);
}
main().catch(e => { console.error(e); process.exit(1); });
