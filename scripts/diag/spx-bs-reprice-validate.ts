/**
 * spx-bs-reprice-validate.ts  —  STANDALONE validator (writes to a study dir, NOT the dashboard)
 *
 * Question: if we price a put credit spread from the DENSE SPX 1m path via
 * Black-Scholes (entry-anchored IV + a skew/vol-response term) instead of from
 * sparse option trade prints, does the drawdown converge to the honest
 * hold-to-settle number — and does the open/close phantom-TP artifact disappear?
 *
 * For each entry date it reconstructs ONE trade exactly like the sweep engine
 * (same chain, same delta-selected strikes, same real 1pm entry credit), then
 * prices the intraday trajectory TWO ways:
 *   OPT — real option leg bars, ungated  (reproduces exitGate:none → the artifact)
 *   BS  — repriced from the SPX path      (the proposed model)
 * and applies hold-to-settle / TP50 / TP75 / TP5 to each. Outputs a comparison
 * table + per-method worst days + a JSON dump under output/STUDY-bs-reprice/.
 *
 *   npx tsx scripts/diag/spx-bs-reprice-validate.ts --symbol SPX --dte 3
 * Env: SKEW_BETA (vol-frac per unit fractional spot move, default 1.0 → 1%=1volpt),
 *      DELTA (0.60), WIDTH (5), MAXDATES (0=all), CONST_IV=1 (disable skew → show the trap).
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

// ── Config ────────────────────────────────────────────────────────────────
const TARGET = resolveSymbolTarget(process.argv.slice(2));
const SPX0 = { ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any;
const GEO = geometryForDte(TARGET.dte);
const RATE = 0.04;
const DELTA = Number(process.env.DELTA ?? 0.60);
const WIDTH = Number(process.env.WIDTH ?? 5);           // w{WIDTH}c
const SKEW_BETA = process.env.CONST_IV === '1' ? 0 : Number(process.env.SKEW_BETA ?? 1.0);
const MAXDATES = Number(process.env.MAXDATES ?? 0);
const ET_1PM_SEC = 3 * 3600 + 1800;
const SETTLE_HHMM = 6 * 3600 + 15 * 60;                 // 15:45 ET
const CLOSE_PENALTY = 2 * GEO.closeHalfSpread;          // pay-through both legs on close
const SLIP = GEO.entrySlippage2leg;
const MIN_PER_YR = 252 * 390;

// ── OCC helpers (SPXW260318P05000000) ───────────────────────────────────────
const occType = (s: string) => s[s.length - 9];
const occExp = (s: string) => s.slice(s.length - 15, s.length - 9);
const occStrike = (s: string) => parseInt(s.slice(s.length - 8)) / 1000;
const expToYYMMDD = (d: string) => d.slice(2).replace(/-/g, '');
const optPx = (bars: any[], ts: number): number | null => {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
};

// SPX 1m bars for a session date (underlying series from the 0DTE profile).
const spxCache = new Map<string, any[]>();
function spxBarsFor(date: string): any[] {
  if (spxCache.has(date)) return spxCache.get(date)!;
  let bars: any[] = [];
  try { bars = loadDay(SPX0, date, '1m')?.spxBars ?? []; } catch {}
  spxCache.set(date, bars);
  return bars;
}

// Entry-day put chain for the TARGET expiry (mirrors loadEntryChainFromDisk).
function entryChain(entryDate: string, expiryDate: string) {
  const day = readDiskCache(entryDate, TARGET.optionPrefix);
  if (!day) return null;
  const want = expToYYMMDD(expiryDate);
  const bars = new Map<string, any[]>(), strikes = new Map<string, number>();
  for (const [sym, b] of day) {
    if (occType(sym) !== 'P' || occExp(sym) !== want) continue;
    bars.set(sym, b); strikes.set(sym, occStrike(sym));
  }
  return bars.size ? { bars, strikes } : null;
}

// Concatenate a leg's option bars across all carry sessions (entry→expiry).
function legBarsAcross(sym: string, sessionCaches: Map<string, any[]>[]): any[] {
  const out: any[] = [];
  for (const c of sessionCaches) { const b = c.get(sym); if (b) out.push(...b); }
  return out;
}

// ── Exit application on an arbitrary V-trajectory ────────────────────────────
// traj: [{ts, V}] strictly after entry, ascending, last point = settle.
// Returns exit value (what we pay to close) for a given TP fraction (0 = settle).
function applyExitTraj(traj: { ts: number; V: number }[], credit: number, tpFrac: number, settleV: number) {
  if (tpFrac > 0) {
    const tpV = (1 - tpFrac) * credit;
    for (const p of traj) {
      if (p.V <= tpV - CLOSE_PENALTY) return { exitV: Math.max(0, tpV), reason: 'TP' };
    }
  }
  return { exitV: Math.max(0, settleV + CLOSE_PENALTY), reason: 'settle' };
}

// ── Main ─────────────────────────────────────────────────────────────────
const EXITS = [
  { label: 'hold-to-settle', tp: 0 },
  { label: 'TP75', tp: 0.75 },
  { label: 'TP50', tp: 0.50 },
  { label: 'TP5',  tp: 0.05 },
];
type Row = { date: string; optPnl: Record<string, number>; bsPnl: Record<string, number> };

async function main() {
  const dates = listDatesFor(SPX0);
  const used = MAXDATES > 0 ? dates.slice(-MAXDATES) : dates;
  console.error(`[validate] ${TARGET.symbol} ${TARGET.dte}DTE | ${DELTA}d w${WIDTH}c | 1pm | ${used.length} dates | skewBeta=${SKEW_BETA} closePenalty=${CLOSE_PENALTY} slip=${SLIP}`);

  const rows: Row[] = [];
  let skipped = 0;
  for (const date of used) {
    const expiryDate = expiryForDate(date, TARGET.dte);
    const sess = sessOpenTs(date);
    const entryTs = sess + ET_1PM_SEC;
    const settleTs = sessOpenTs(expiryDate) + SETTLE_HHMM;

    const s1 = spxBarsFor(date);
    const spxEntry = optPx(s1, entryTs - 1);
    if (spxEntry == null) { skipped++; continue; }

    const ch = entryChain(date, expiryDate);
    if (!ch) { skipped++; continue; }

    // Real local strike interval near spot + delta-select the short put.
    const allStrikes = [...ch.strikes.values()];
    const grid = deriveStrikeInterval(allStrikes, spxEntry) ?? TARGET.strikeInterval;
    const T_entry_yrs = Math.max(TARGET.dte, 0.25) / 252;
    const cands: DeltaCandidate[] = [];
    const symByK = new Map<number, string>();
    for (const [sym, k] of ch.strikes) {
      const px = optPx(ch.bars.get(sym)!, entryTs - 1);
      if (px == null || px <= 0) continue;
      cands.push({ strike: k, price: px }); symByK.set(k, sym);
    }
    if (cands.length < 2) { skipped++; continue; }
    const shortSel = selectStrikeByDelta(cands, DELTA, spxEntry, T_entry_yrs, RATE);
    if (!shortSel) { skipped++; continue; }
    const Ks = shortSel.strike, shortSym = symByK.get(Ks)!;
    // Long leg: WIDTH strikes further OTM (lower strike), snap to nearest listed.
    let Kl = -1, longSym = '';
    { let best = Infinity; const tgt = Ks - WIDTH * grid;
      for (const [sym, k] of ch.strikes) { if (k >= Ks) continue; const d = Math.abs(k - tgt); if (d < best) { best = d; Kl = k; longSym = sym; } } }
    if (!longSym || Kl >= Ks) { skipped++; continue; }
    const widthPts = Ks - Kl;

    // Carry-session option caches (real leg bars for the OPT method).
    const sessionDates = tradingDaysBetween(date, expiryDate);
    const sessionCaches = sessionDates.map(d => readDiskCache(d, TARGET.optionPrefix) ?? new Map<string, any[]>());
    const shortBars = legBarsAcross(shortSym, sessionCaches);
    const longBars = legBarsAcross(longSym, sessionCaches);

    const shortEntry = optPx(shortBars, entryTs - 1);
    const longEntry = optPx(longBars, entryTs - 1);
    if (shortEntry == null || longEntry == null) { skipped++; continue; }
    const credit = shortEntry - longEntry;
    if (credit <= 0.05 || credit > widthPts * 0.95) { skipped++; continue; }

    // SPX path across all carry sessions, strictly after entry, up to settle.
    const spxPath: any[] = [];
    for (const d of sessionDates) for (const b of spxBarsFor(d)) if (b.ts > entryTs && b.ts <= settleTs) spxPath.push(b);
    spxPath.sort((a, b) => a.ts - b.ts);
    if (!spxPath.length) { skipped++; continue; }
    const totalMin = spxPath.length;                    // 1 bar = 1 trading min (no overnight bars)
    const spxAtSettle = spxPath[spxPath.length - 1].close;

    // Entry IV per leg, backed out of the REAL 1pm marks — at the SAME trading-time
    // clock the trajectory uses, so BS(entry) reproduces the entry credit exactly
    // (no entry discontinuity). T0 = total trading-minutes to settle / minutes-per-year.
    const T0 = totalMin / MIN_PER_YR;
    const ivS0 = impliedVolFromPut(shortEntry, spxEntry, Ks, T0, RATE) ?? 0.15;
    const ivL0 = impliedVolFromPut(longEntry, spxEntry, Kl, T0, RATE) ?? ivS0;

    // ── BS trajectory: reprice both legs along the SPX path ──
    const bsTraj: { ts: number; V: number }[] = [];
    for (let i = 0; i < spxPath.length; i++) {
      const spot = spxPath[i].close;
      const remMin = totalMin - (i + 1);
      const T = Math.max(remMin / MIN_PER_YR, 0);
      const pct = (spot - spxEntry) / spxEntry;         // skew: down move (pct<0) → IV up
      const ivS = Math.max(0.01, ivS0 - SKEW_BETA * pct);
      const ivL = Math.max(0.01, ivL0 - SKEW_BETA * pct);
      const V = bsPutPrice(spot, Ks, T, ivS, RATE) - bsPutPrice(spot, Kl, T, ivL, RATE);
      bsTraj.push({ ts: spxPath[i].ts, V: Math.max(0, V) });
    }
    const bsSettleV = Math.max(0, Math.max(0, Ks - spxAtSettle) - Math.max(0, Kl - spxAtSettle));

    // ── OPT trajectory: real spread value from option leg bars ──
    const tsSet = new Set<number>();
    for (const b of shortBars) if (b.ts > entryTs && b.ts <= settleTs) tsSet.add(b.ts);
    for (const b of longBars) if (b.ts > entryTs && b.ts <= settleTs) tsSet.add(b.ts);
    const optTraj: { ts: number; V: number }[] = [];
    for (const ts of [...tsSet].sort((a, b) => a - b)) {
      const ps = optPx(shortBars, ts), pl = optPx(longBars, ts);
      if (ps == null || pl == null) continue;
      optTraj.push({ ts, V: Math.max(0, ps - pl) });
    }
    // OPT settle = real leg marks at settle (settle-mtm), like the engine for DTE>=1.
    const optSettleV = Math.max(0, (optPx(shortBars, settleTs) ?? 0) - (optPx(longBars, settleTs) ?? 0));

    const optPnl: Record<string, number> = {}, bsPnl: Record<string, number> = {};
    for (const ex of EXITS) {
      const o = applyExitTraj(optTraj, credit, ex.tp, optSettleV);
      const b = applyExitTraj(bsTraj, credit, ex.tp, bsSettleV);
      optPnl[ex.label] = (credit - o.exitV) * 100 - SLIP;
      bsPnl[ex.label] = (credit - b.exitV) * 100 - SLIP;
    }
    rows.push({ date, optPnl, bsPnl });
  }

  // ── Aggregate: WR, net, maxDD per method×exit ──
  function agg(get: (r: Row) => number) {
    const pnls = rows.map(get);
    const n = pnls.length, wins = pnls.filter(p => p > 0).length;
    const net = pnls.reduce((a, b) => a + b, 0);
    let peak = 0, cum = 0, dd = 0;
    for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    return { n, wr: n ? (100 * wins / n) : 0, net, dd, avg: n ? net / n : 0 };
  }

  console.log(`\n=== BS-REPRICE VALIDATION — ${TARGET.symbol} ${TARGET.dte}DTE | ${DELTA}d w${WIDTH}c | 1pm daily ===`);
  console.log(`trades=${rows.length}  skipped=${skipped}  skewBeta=${SKEW_BETA}${SKEW_BETA === 0 ? ' (CONST-IV — the trap)' : ''}\n`);
  const H = ['exit'.padEnd(16), 'method', 'WR%'.padStart(7), '$net'.padStart(11), '$/trade'.padStart(9), '$maxDD'.padStart(10)];
  console.log(H.join(' '));
  console.log('-'.repeat(70));
  const out: any = { config: { symbol: TARGET.symbol, dte: TARGET.dte, delta: DELTA, width: WIDTH, skewBeta: SKEW_BETA, trades: rows.length }, table: [] as any[] };
  for (const ex of EXITS) {
    for (const m of ['OPT', 'BS'] as const) {
      const a = agg(r => (m === 'OPT' ? r.optPnl : r.bsPnl)[ex.label]);
      console.log([ex.label.padEnd(16), m.padEnd(6), a.wr.toFixed(1).padStart(7), ('$' + Math.round(a.net)).padStart(11), ('$' + Math.round(a.avg)).padStart(9), ('$' + Math.round(a.dd)).padStart(10)].join(' '));
      out.table.push({ exit: ex.label, method: m, ...a });
    }
    console.log('-'.repeat(70));
  }

  // Worst 5 days per method (TP50) — does BS surface real losses where OPT hid them?
  const worst = (get: (r: Row) => number) => [...rows].sort((a, b) => get(a) - get(b)).slice(0, 5).map(r => `${r.date}:$${Math.round(get(r))}`);
  console.log('\nWorst 5 TP50 days — OPT:', worst(r => r.optPnl['TP50']).join('  '));
  console.log('Worst 5 TP50 days — BS :', worst(r => r.bsPnl['TP50']).join('  '));

  const dir = path.join(process.cwd(), 'scripts/autoresearch/output/STUDY-bs-reprice');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `${TARGET.symbol.toLowerCase()}-${TARGET.dte}dte-${DELTA}d-w${WIDTH}c-beta${SKEW_BETA}.json`);
  out.rows = rows;
  fs.writeFileSync(fp, JSON.stringify(out, null, 2));
  console.log(`\n→ ${fp}`);
}
main().catch(e => { console.error(e); process.exit(1); });
