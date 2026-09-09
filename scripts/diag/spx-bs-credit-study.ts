/**
 * spx-bs-credit-study.ts  —  STANDALONE delta×width×exit BS-repricing study (study dir, NOT dashboard)
 *
 * Extends spx-bs-reprice-validate.ts into a grid. For the 1pm-daily put credit
 * spread, sweeps short-delta 0.20..0.70 × width {2,3,4} strikes × exit policies,
 * pricing each cell TWO ways:
 *   OPT — real option leg bars, ungated (reproduces the dashboard's fill artifact)
 *   BS  — repriced from the dense SPX 1m path (entry-anchored IV + skew), the honest number
 * Per-date it loads data ONCE then reprices the whole grid (cheap). Emits a study
 * JSON + a ranked table so positive-BS edges (if any) are obvious.
 *
 *   npx tsx scripts/diag/spx-bs-credit-study.ts --symbol SPX --dte 1
 * Env: DELTAS, WIDTHS, SKEW_BETA (1.0), MAXDATES (0=all).
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

const TARGET = resolveSymbolTarget(process.argv.slice(2));
const SPX0 = { ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any;
const GEO = geometryForDte(TARGET.dte);
const RATE = 0.04;
const SKEW_BETA = process.env.CONST_IV === '1' ? 0 : Number(process.env.SKEW_BETA ?? 1.0);
const MAXDATES = Number(process.env.MAXDATES ?? 0);
const SMA_LEN = Number(process.env.SMA_LEN ?? 10);  // SMA window; every trade is TAGGED above/below SMA at entry for post-hoc filtering (not a hard skip)
const ET_1PM_SEC = 3 * 3600 + 1800;
const ENTRY_SEC = Number(process.env.ENTRY_SEC ?? ET_1PM_SEC);  // seconds after 9:30 ET; default 1pm
const SETTLE_HHMM = 6 * 3600 + 15 * 60;
const CLOSE_PENALTY = 2 * GEO.closeHalfSpread;
const SLIP = GEO.entrySlippage2leg;
const MIN_PER_YR = 252 * 390;

const DELTAS = (process.env.DELTAS ?? '0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70').split(',').map(Number);
const WIDTHS = (process.env.WIDTHS ?? '2,3,4').split(',').map(Number);
const EXITS = [
  { label: 'hold-to-settle', tp: 0,    sl: 0 },
  { label: 'TP75',           tp: 0.75, sl: 0 },
  { label: 'TP50',           tp: 0.50, sl: 0 },
  { label: 'TP35',           tp: 0.35, sl: 0 },
  { label: 'TP25',           tp: 0.25, sl: 0 },
  { label: 'TP50 SL50%',     tp: 0.50, sl: 0.50 },
  { label: 'TP50 SL100%',    tp: 0.50, sl: 1.00 },
];

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
function entryChain(entryDate: string, expiryDate: string) {
  const day = readDiskCache(entryDate, TARGET.optionPrefix); if (!day) return null;
  const want = expToYYMMDD(expiryDate);
  const bars = new Map<string, any[]>(), strikes = new Map<string, number>();
  for (const [sym, b] of day) { if (occType(sym) !== 'P' || occExp(sym) !== want) continue; bars.set(sym, b); strikes.set(sym, occStrike(sym)); }
  return bars.size ? { bars, strikes } : null;
}
function legBarsAcross(sym: string, caches: Map<string, any[]>[]): any[] { const out: any[] = []; for (const c of caches) { const b = c.get(sym); if (b) out.push(...b); } return out; }

// Exit on a V-trajectory. tpFrac of credit; slFrac of max-risk (V=credit+slFrac*(width-credit)). settle on last.
function applyExit(traj: { ts: number; V: number }[], credit: number, width: number, tpFrac: number, slFrac: number, settleV: number) {
  const tpV = tpFrac > 0 ? (1 - tpFrac) * credit : -Infinity;
  const slV = slFrac > 0 ? credit + slFrac * (width - credit) : Infinity;
  for (const p of traj) {
    if (slFrac > 0 && p.V >= slV + CLOSE_PENALTY) return Math.max(0, slV + CLOSE_PENALTY);
    if (tpFrac > 0 && p.V <= tpV - CLOSE_PENALTY) return Math.max(0, tpV);
  }
  // Held to expiry: SPX is CASH-SETTLED — no closing trade, no spread crossed.
  // (Only early TP/SL exits above pay CLOSE_PENALTY.)
  return Math.max(0, settleV);
}

type Cell = { opt: number[]; bs: number[]; above: boolean[] };   // per-trade pnls + SPX-above-SMA tag
const cells = new Map<string, Cell>();
const key = (d: number, w: number, e: string) => `${d.toFixed(2)}d w${w}c|${e}`;

async function main() {
  const dates = listDatesFor(SPX0);
  const used = MAXDATES > 0 ? dates.slice(-MAXDATES) : dates;
  console.error(`[study] ${TARGET.symbol} ${TARGET.dte}DTE | deltas ${DELTAS[0]}-${DELTAS[DELTAS.length-1]} | widths ${WIDTHS.join('/')} | ${used.length} dates | beta=${SKEW_BETA} penalty=${CLOSE_PENALTY} slip=${SLIP}`);

  // 10-day SMA trend filter (SMA_LEN>0): only enter when SPX > SMA of prior N daily closes.
  const idxByDate = new Map(dates.map((d, i) => [d, i]));
  const closeCache = new Map<string, number | null>();
  const dailyClose = (d: string): number | null => { if (closeCache.has(d)) return closeCache.get(d)!; const b = spxBarsFor(d); const c = b.length ? b[b.length - 1].close : null; closeCache.set(d, c); return c; };
  const smaBefore = (date: string): number | null => { const i = idxByDate.get(date); if (i == null || i < SMA_LEN) return null; let s = 0, c = 0; for (let k = i - SMA_LEN; k < i; k++) { const v = dailyClose(dates[k]); if (v != null) { s += v; c++; } } return c ? s / c : null; };

  let nTraded = 0;
  for (const date of used) {
    const expiryDate = expiryForDate(date, TARGET.dte);
    const sess = sessOpenTs(date);
    const entryTs = sess + ENTRY_SEC;
    const settleTs = sessOpenTs(expiryDate) + SETTLE_HHMM;
    const s1 = spxBarsFor(date);
    const spxEntry = optPx(s1, entryTs - 1); if (spxEntry == null) continue;
    const smaVal = SMA_LEN > 0 ? smaBefore(date) : null;
    const aboveSMA = smaVal == null ? true : spxEntry > smaVal;   // TAG (not a hard skip): SPX above its N-day SMA at entry
    const ch = entryChain(date, expiryDate); if (!ch) continue;

    const allStrikes = [...ch.strikes.values()];
    const grid = deriveStrikeInterval(allStrikes, spxEntry) ?? TARGET.strikeInterval;
    const T_select = Math.max(TARGET.dte, 0.25) / 252;
    const cands: DeltaCandidate[] = []; const symByK = new Map<number, string>();
    for (const [sym, k] of ch.strikes) { const px = optPx(ch.bars.get(sym)!, entryTs - 1); if (px == null || px <= 0) continue; cands.push({ strike: k, price: px }); symByK.set(k, sym); }
    if (cands.length < 2) continue;

    // Per-date shared loads: carry caches + SPX path + clock.
    const sessionDates = tradingDaysBetween(date, expiryDate);
    const caches = sessionDates.map(d => readDiskCache(d, TARGET.optionPrefix) ?? new Map<string, any[]>());
    const spxPath: any[] = [];
    for (const d of sessionDates) for (const b of spxBarsFor(d)) if (b.ts > entryTs && b.ts <= settleTs) spxPath.push(b);
    spxPath.sort((a, b) => a.ts - b.ts);
    if (!spxPath.length) continue;
    const totalMin = spxPath.length;
    const T0 = totalMin / MIN_PER_YR;
    const spxAtSettle = spxPath[spxPath.length - 1].close;
    let dateTraded = false;

    for (const delta of DELTAS) {
      const shortSel = selectStrikeByDelta(cands, delta, spxEntry, T_select, RATE); if (!shortSel) continue;
      const Ks = shortSel.strike, shortSym = symByK.get(Ks)!;
      for (const width of WIDTHS) {
        let Kl = -1, longSym = '', best = Infinity; const tgt = Ks - width * grid;
        for (const [sym, k] of ch.strikes) { if (k >= Ks) continue; const dd = Math.abs(k - tgt); if (dd < best) { best = dd; Kl = k; longSym = sym; } }
        if (!longSym || Kl >= Ks) continue;
        const widthPts = Ks - Kl;
        const shortBars = legBarsAcross(shortSym, caches), longBars = legBarsAcross(longSym, caches);
        const shortEntry = optPx(shortBars, entryTs - 1), longEntry = optPx(longBars, entryTs - 1);
        if (shortEntry == null || longEntry == null) continue;
        const credit = shortEntry - longEntry;
        if (credit <= 0.05 || credit > widthPts * 0.95) continue;
        const ivS0 = impliedVolFromPut(shortEntry, spxEntry, Ks, T0, RATE) ?? 0.15;
        const ivL0 = impliedVolFromPut(longEntry, spxEntry, Kl, T0, RATE) ?? ivS0;

        // BS trajectory from SPX path.
        const bsTraj: { ts: number; V: number }[] = [];
        for (let i = 0; i < spxPath.length; i++) {
          const spot = spxPath[i].close; const T = Math.max((totalMin - (i + 1)) / MIN_PER_YR, 0);
          const pct = (spot - spxEntry) / spxEntry;
          const V = bsPutPrice(spot, Ks, T, Math.max(0.01, ivS0 - SKEW_BETA * pct), RATE) - bsPutPrice(spot, Kl, T, Math.max(0.01, ivL0 - SKEW_BETA * pct), RATE);
          bsTraj.push({ ts: spxPath[i].ts, V: Math.max(0, V) });
        }
        const bsSettleV = Math.max(0, Math.max(0, Ks - spxAtSettle) - Math.max(0, Kl - spxAtSettle));

        // OPT trajectory from option leg bars.
        const tsSet = new Set<number>();
        for (const b of shortBars) if (b.ts > entryTs && b.ts <= settleTs) tsSet.add(b.ts);
        for (const b of longBars) if (b.ts > entryTs && b.ts <= settleTs) tsSet.add(b.ts);
        const optTraj: { ts: number; V: number }[] = [];
        for (const ts of [...tsSet].sort((a, b) => a - b)) { const ps = optPx(shortBars, ts), pl = optPx(longBars, ts); if (ps == null || pl == null) continue; optTraj.push({ ts, V: Math.max(0, ps - pl) }); }
        const optSettleV = Math.max(0, (optPx(shortBars, settleTs) ?? 0) - (optPx(longBars, settleTs) ?? 0));

        for (const ex of EXITS) {
          const oV = applyExit(optTraj, credit, widthPts, ex.tp, ex.sl, optSettleV);
          const bV = applyExit(bsTraj, credit, widthPts, ex.tp, ex.sl, bsSettleV);
          const k = key(delta, width, ex.label);
          let c = cells.get(k); if (!c) { c = { opt: [], bs: [], above: [] }; cells.set(k, c); }
          c.opt.push((credit - oV) * 100 - SLIP);
          c.bs.push((credit - bV) * 100 - SLIP);
          c.above.push(aboveSMA);
        }
        dateTraded = true;
      }
    }
    if (dateTraded) nTraded++;
  }

  // Aggregate.
  function stat(pnls: number[]) {
    const n = pnls.length, wins = pnls.filter(p => p > 0).length, net = pnls.reduce((a, b) => a + b, 0);
    let peak = 0, cum = 0, dd = 0; for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const mean = n ? net / n : 0;
    const sd = n ? Math.sqrt(pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) : 0;
    // ~1 trade realizes per trading day (daily entry → daily expiry), so annualize per-trade Sharpe by sqrt(252).
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
    return { n, wr: n ? 100 * wins / n : 0, net, dd, avg: mean, sharpe };
  }
  const sub = (pnls: number[], above: boolean[], want: 'all' | 'up' | 'dn') =>
    stat(pnls.filter((_, i) => want === 'all' ? true : want === 'up' ? above[i] : !above[i]));
  const out: any = { config: { symbol: TARGET.symbol, dte: TARGET.dte, beta: SKEW_BETA, smaLen: SMA_LEN, datesTraded: nTraded, deltas: DELTAS, widths: WIDTHS }, cells: [] as any[] };
  for (const [k, c] of cells) {
    const [sp, ex] = k.split('|');
    // bs = all trades; bsUp = SPX above SMA at entry; bsDn = below.
    out.cells.push({ spread: sp, exit: ex, bs: sub(c.bs, c.above, 'all'), bsUp: sub(c.bs, c.above, 'up'), bsDn: sub(c.bs, c.above, 'dn'), opt: stat(c.opt) });
  }

  // Rank by BS net — show where honest edge lives.
  const ranked = [...out.cells].sort((a, b) => b.bs.net - a.bs.net);
  console.log(`\n=== BS CREDIT STUDY — ${TARGET.symbol} ${TARGET.dte}DTE | 1pm daily | ${nTraded} dates | beta=${SKEW_BETA} ===`);
  console.log(`(OPT = dashboard fill-artifact pricing · BS = honest SPX-repriced)\n`);
  console.log(['spread'.padEnd(12), 'exit'.padEnd(14), 'BS_WR'.padStart(6), 'BS_net'.padStart(10), 'BS_DD'.padStart(9), '|', 'OPT_net'.padStart(10), 'OPT_WR'.padStart(7)].join(' '));
  console.log('-'.repeat(86));
  const top = ranked.slice(0, 25);
  for (const r of top) {
    console.log([r.spread.padEnd(12), r.exit.padEnd(14), r.bs.wr.toFixed(0).padStart(6), ('$' + Math.round(r.bs.net)).padStart(10), ('$' + Math.round(r.bs.dd)).padStart(9), '|', ('$' + Math.round(r.opt.net)).padStart(10), r.opt.wr.toFixed(0).padStart(7)].join(' '));
  }
  const posBs = out.cells.filter((c: any) => c.bs.net > 0).length;
  console.log('-'.repeat(86));
  console.log(`BS-positive cells: ${posBs}/${out.cells.length}   (top BS net = $${Math.round(ranked[0].bs.net)} @ ${ranked[0].spread} ${ranked[0].exit})`);

  const dir = path.join(process.cwd(), 'scripts/autoresearch/output/STUDY-bs-reprice');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `study-${TARGET.symbol.toLowerCase()}-${TARGET.dte}dte-beta${SKEW_BETA}${SMA_LEN ? `-sma${SMA_LEN}` : ''}${ENTRY_SEC!==ET_1PM_SEC?`-e${ENTRY_SEC}`:''}.json`);
  fs.writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\n→ ${fp}`);
}
main().catch(e => { console.error(e); process.exit(1); });
