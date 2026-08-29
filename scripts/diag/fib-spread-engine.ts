/**
 * fib-spread-engine.ts — STANDALONE Fibonacci-swing put-credit-spread backtester.
 *
 * Built from scratch. It does NOT clone or import the (deleted) SMC engine. The
 * only shared pieces are neutral, canonical utilities:
 *   - data:     loadDay/listDatesFor/resolveSymbolTarget/outPath (parquet loader)
 *   - signal:   fibEntriesOnSeries (our own fib-swing-core)
 *   - pricing:  bsPutDelta / impliedVolFromPut (house Black-Scholes)
 * Everything else — strike selection, option pricing off the chain, friction,
 * exits, settlement, concurrency, output — is implemented here.
 *
 * What it does differently from the abandoned clone:
 *   • Takes EVERY qualifying 5m bull fill (no "first signal per day" cap).
 *   • Settles 0DTE at the REAL 16:00 close (not 15:45).
 *   • Reports true concurrency (peak simultaneous positions).
 *
 * Friction (matches the iron engine for parity; override via env):
 *   • Entry: sell the short at bid, buy the long at ask → credit loses
 *     2 × HS_PER_LEG. Commission $0.35/contract/side.
 *   • hold-to-settle: 0DTE index options are CASH-settled at intrinsic — no exit
 *     half-spread, no exit commission. This is the HONEST exit.
 *   • TP exits close in the market → pay 2 × HS_PER_LEG exit slippage + exit
 *     commission. (HS_PER_LEG default 0.10 understates real NDX NBBO ~0.6/leg,
 *     so TP rows are optimistic — run SWEEP_HS=0.6 to stress them.)
 *
 * Run:
 *   npx tsx scripts/diag/fib-spread-engine.ts --symbol NDX
 *   SWEEP_DAYS=120 SWEEP_HS=0.10 npx tsx scripts/diag/fib-spread-engine.ts --symbol NDX
 *   SWEEP_DAYS=120 SWEEP_HS=0.60 npx tsx scripts/diag/fib-spread-engine.ts --symbol SPX
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadDay, listDatesFor, resolveSymbolTarget, outPath } from './sweep-symbol';
import { aggregateIntraday, OHLCBar } from './ohlc-aggregate';
import { fibEntriesOnSeries, SimOpts } from './fib-swing-core';
import { bsPutDelta, impliedVolFromPut } from './black-scholes';

// ──────────────────────────── CLI / constants ────────────────────────────
function arg(name: string, def: string): string {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  if (f) return f.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TARGET = resolveSymbolTarget(process.argv);
const TF_MIN = parseInt(arg('tf', '5'), 10);
const WIDTH = parseInt(arg('width', '4'), 10);                 // spread width in strikes
const DELTAS = arg('deltas', '0.20,0.25,0.30,0.35,0.40,0.45,0.50,0.55,0.60,0.65,0.70').split(',').map(Number);
const ENTRY_FIBS = arg('entryFibs', '0.5,0.618').split(',').map(Number);
const PIVOTS = arg('pivots', '3/3,5/2').split(',').map(s => { const [l, r] = s.split('/').map(Number); return { left: l, right: r }; });
const HS_PER_LEG = Number(process.env.SWEEP_HS ?? 0.10);      // entry/exit half-spread per leg
const COMMISSION = 0.35;                                       // $/contract/side
const RATE = 0.04;
const TRADESTART = 1800;        // 10:00 ET (sec after 09:30)
const CUTOFF = 6 * 3600;        // 15:30 ET — no new entries
const SETTLE = 6 * 3600 + 30 * 60; // 16:00 ET — real 0DTE settlement
const EXITS = [
  { label: 'hold-to-settle', tp: 0 },
  { label: 'TP50', tp: 0.50 },
  { label: 'TP75', tp: 0.75 },
];

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const u = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const et = parseInt(u.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - et), 30, 0) / 1000);
}
/** Last close at or before ts (no look-ahead). */
function optPx(bars: any[], ts: number): number | null {
  if (!bars) return null;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
/** Strike interval = smallest positive gap between listed strikes near spot. */
function strikeInterval(strikes: number[], spot: number): number {
  const near = strikes.filter(k => Math.abs(k - spot) < spot * 0.1).sort((a, b) => a - b);
  let g = Infinity;
  for (let i = 1; i < near.length; i++) { const d = near[i] - near[i - 1]; if (d > 0 && d < g) g = d; }
  return Number.isFinite(g) ? g : TARGET.strikeInterval;
}

interface PutQuote { strike: number; price: number; sym: string; }
interface FibSpreadTrade { delta: number; entryTs: number; exitTs: number; credit: number; risk: number; pnl: number; win: boolean; exit: string; }

// ──────────────────────────── per-day simulation ────────────────────────────
function simulateDay(date: string): FibSpreadTrade[] {
  const day = loadDay(TARGET, date, '1m');
  const u: OHLCBar[] = day?.spxBars ?? [];
  if (u.length === 0) return [];
  const contractBars: Map<string, any[]> = day.contractBars ?? new Map();
  const contractStrikes: Map<string, number> = day.contractStrikes ?? new Map();
  if (contractBars.size === 0) return [];

  const sess = sessOpenTs(date);
  const cutoff = sess + CUTOFF;
  const settleTs = sess + SETTLE;
  const spxSettle = optPx(u, settleTs);
  if (spxSettle == null) return [];

  // Pre-index the put chain once.
  const putSyms: string[] = [];
  for (const [sym] of contractBars) if (sym[sym.length - 9] === 'P') putSyms.push(sym);
  if (putSyms.length < 2) return [];

  const out: FibSpreadTrade[] = [];

  for (const piv of PIVOTS) {
    const tf = aggregateIntraday(u, TF_MIN, sess);
    if (tf.length < piv.left + piv.right + 2) continue;
    for (const ef of ENTRY_FIBS) {
      const opts: SimOpts = { left: piv.left, right: piv.right, entryFib: ef, extFib: 1.0, dir: 'long', trendGate: true, stopBuf: 0, entryWindow: 20 };
      const bulls = fibEntriesOnSeries(tf, opts).filter(e => e.dir === 'bull' && e.ts >= sess + TRADESTART && e.ts < cutoff);

      for (const bull of bulls) {
        const entryTs = bull.ts + TF_MIN * 60;       // enter at the 5m bucket CLOSE (no look-ahead)
        if (entryTs >= cutoff) continue;
        const spot = optPx(u, entryTs);
        if (spot == null) continue;

        // Build the live put quote list at entry.
        const quotes: PutQuote[] = [];
        for (const sym of putSyms) {
          const k = contractStrikes.get(sym);
          const px = optPx(contractBars.get(sym)!, entryTs);
          if (typeof k === 'number' && px != null && px > 0) quotes.push({ strike: k, price: px, sym });
        }
        if (quotes.length < 2) continue;
        const grid = strikeInterval(quotes.map(q => q.strike), spot);

        // Year-fraction to settle (intraday 0DTE): fraction of a 6.5h trading day / 252.
        const T = Math.max((settleTs - entryTs) / (6.5 * 3600), 0.05) / 252;

        // Representative IV from the nearest-ATM put, fallback 0.20.
        const atm = quotes.reduce((a, b) => Math.abs(b.strike - spot) < Math.abs(a.strike - spot) ? b : a);
        const iv = impliedVolFromPut(atm.price, spot, atm.strike, T, RATE) ?? 0.20;

        const byStrike = new Map(quotes.map(q => [q.strike, q]));

        for (const targetDelta of DELTAS) {
          // short put = strike whose |delta| is closest to target.
          let short: PutQuote | null = null, bestErr = Infinity;
          for (const q of quotes) {
            const d = Math.abs(bsPutDelta(spot, q.strike, T, iv, RATE));
            const err = Math.abs(d - targetDelta);
            if (err < bestErr) { bestErr = err; short = q; }
          }
          if (!short) continue;
          const longStrike = short.strike - WIDTH * grid;
          const long = byStrike.get(longStrike);
          if (!long || long.strike >= short.strike) continue;
          const width = short.strike - longStrike;

          const creditMid = short.price - long.price;
          if (creditMid <= 0.05 || creditMid > width * 0.95) continue;
          // Entry friction: sell short at bid, buy long at ask → lose 2×HS.
          const netCredit = creditMid - 2 * HS_PER_LEG;
          if (netCredit <= 0) continue;
          const risk = (width - netCredit) * 100;
          const entryComm = COMMISSION * 2;

          const shortBars = contractBars.get(short.sym)!;
          const longBars = contractBars.get(long.sym)!;

          for (const ex of EXITS) {
            let exitTs = settleTs, exitVal: number, exitComm: number, exitSlip: number;
            if (ex.tp > 0) {
              // TP: close when the spread mid decays to (1-tp)×creditMid.
              const tpLevel = creditMid * (1 - ex.tp);
              let hit = -1;
              for (const sb of shortBars) {
                if (sb.ts <= entryTs || sb.ts > settleTs) continue;
                const v = (optPx(shortBars, sb.ts) ?? 0) - (optPx(longBars, sb.ts) ?? 0);
                if (v <= tpLevel) { hit = sb.ts; break; }
              }
              if (hit > 0) { exitTs = hit; exitVal = tpLevel; exitSlip = 2 * HS_PER_LEG; exitComm = COMMISSION * 2; }
              else { // never hit TP → settle at intrinsic
                exitVal = Math.max(short.strike - spxSettle, 0) - Math.max(longStrike - spxSettle, 0);
                exitSlip = 0; exitComm = 0;
              }
            } else {
              // hold-to-settle: cash-settled at intrinsic, no slippage/commission.
              exitVal = Math.max(short.strike - spxSettle, 0) - Math.max(longStrike - spxSettle, 0);
              exitSlip = 0; exitComm = 0;
            }
            exitVal = Math.min(Math.max(exitVal, 0), width);
            const pnl = (netCredit - exitVal - exitSlip) * 100 - entryComm - exitComm;
            out.push({ delta: targetDelta, entryTs, exitTs, credit: netCredit, risk, pnl, win: pnl > 0, exit: ex.label });
          }
        }
      }
    }
  }
  return out;
}

// ──────────────────────────── run all days ────────────────────────────
const dates = listDatesFor(TARGET);
if (dates.length === 0) { console.error(`No parquet dates for ${TARGET.symbol} (${TARGET.profileId})`); process.exit(1); }
console.log(`fib-spread-engine: ${TARGET.symbol} ${TARGET.profileId} | ${dates.length} days (${dates[0]}..${dates[dates.length - 1]})`);
console.log(`  tf=${TF_MIN}m width=${WIDTH} deltas=${DELTAS[0]}..${DELTAS[DELTAS.length - 1]} entryFibs=${ENTRY_FIBS.join(',')} pivots=${PIVOTS.map(p => p.left + '/' + p.right).join(',')} HS/leg=$${HS_PER_LEG} | ALL signals, settle 16:00`);

interface Agg { trades: FibSpreadTrade[]; }
const groups = new Map<string, Agg>();        // key = delta|exit
let loaded = 0;
for (const date of dates) {
  const trades = simulateDay(date);
  if (trades.length) loaded++;
  for (const t of trades) {
    const k = `${t.delta.toFixed(2)}|${t.exit}`;
    let g = groups.get(k); if (!g) { g = { trades: [] }; groups.set(k, g); }
    g.trades.push(t);
  }
}

// Concurrency: peak simultaneous open positions for a given key.
function peakConcurrent(ts: FibSpreadTrade[]): number {
  const ev: Array<[number, number]> = [];
  for (const t of ts) { ev.push([t.entryTs, 1]); ev.push([t.exitTs, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0; for (const [, d] of ev) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}
function maxDrawdown(pnls: number[]): number {
  let eq = 0, peak = 0, dd = 0; for (const p of pnls) { eq += p; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; } return dd;
}

interface Row { delta: number; exit: string; n: number; wr: number; pnl: number; avgPnl: number; avgCredit: number; avgRisk: number; dd: number; ratio: number; peakConc: number; }
const rows: Row[] = [];
for (const [k, g] of groups) {
  const [d, exit] = k.split('|');
  const ts = g.trades.sort((a, b) => a.entryTs - b.entryTs);
  const n = ts.length, wins = ts.filter(t => t.win).length;
  const pnl = ts.reduce((s, t) => s + t.pnl, 0);
  const dd = maxDrawdown(ts.map(t => t.pnl));
  rows.push({
    delta: +d, exit, n, wr: n ? 100 * wins / n : 0, pnl,
    avgPnl: n ? pnl / n : 0,
    avgCredit: n ? ts.reduce((s, t) => s + t.credit, 0) / n : 0,
    avgRisk: n ? ts.reduce((s, t) => s + t.risk, 0) / n : 0,
    dd, ratio: dd > 100 ? pnl / dd : (pnl > 0 ? 99 : 0), peakConc: peakConcurrent(ts),
  });
}
rows.sort((a, b) => a.exit.localeCompare(b.exit) || a.delta - b.delta);

console.log(`\nLoaded ${loaded} days with trades.\n`);
const pad = (s: any, n: number) => String(s).padStart(n);
for (const exit of EXITS.map(e => e.label)) {
  console.log(`── ${exit} ──`);
  console.log(`  ${'Δ'.padEnd(5)} ${pad('n', 5)} ${pad('wr%', 6)} ${pad('pnl$', 10)} ${pad('$/t', 7)} ${pad('cred', 6)} ${pad('risk', 6)} ${pad('ratio', 6)} ${pad('pkConc', 6)}`);
  for (const r of rows.filter(r => r.exit === exit)) {
    console.log(`  ${r.delta.toFixed(2).padEnd(5)} ${pad(r.n, 5)} ${pad(r.wr.toFixed(0), 6)} ${pad(Math.round(r.pnl), 10)} ${pad(r.avgPnl.toFixed(0), 7)} ${pad(r.avgCredit.toFixed(1), 6)} ${pad(Math.round(r.avgRisk), 6)} ${pad(r.ratio.toFixed(2), 6)} ${pad(r.peakConc, 6)}`);
  }
}

const OUT = outPath('scripts/autoresearch/output/fib-spread-engine.json', TARGET);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(rows, null, 2));
console.log(`\nWrote ${rows.length} rows → ${OUT}`);
