/**
 * fib-bb-option-study.ts
 *
 * Maps Fibonacci Bollinger Band rejection SIGNALS (detected on SPY 1m, where
 * volume makes the VWMA basis work) onto tradeable option CONTRACTS (SPX 0DTE
 * primary, SPY fallback) and reports realistic dollar P&L after spread +
 * commission across D60/D180/D280 walk-forward windows.
 *
 * ── Signal/contract split ──────────────────────────────────────────────────
 *   1. Run fib-bb-core.simulate() on SPY 1m bars → signal trades (entryTs,
 *      exitTs, dir, exitReason on the SPY underlying).
 *   2. For each trade, look up the SPX underlying at entryTs → ATM strike.
 *   3. Resolve the target strike from moneyness, build the SPX contract symbol.
 *   4. Price entry/exit on the SPX contract bar at entryTs/exitTs. If the SPX
 *      contract is missing, fall back to the SPY contract (same strike offset,
 *      SPY interval=1) and tag the trade SPY.
 *
 * The signal fires on SPY; the P&L comes from the contract actually traded.
 *
 * ── Look-ahead ─────────────────────────────────────────────────────────────
 * Enforced in fib-bb-option-core.priceOptionFill: the option fill reads the
 * contract bar at ts >= entryTs (forward fill), never a prior bar. The signal
 * itself already confirms at bar i's close and fills at i+1's open (fib-bb-core).
 *
 * Run:
 *   npx tsx scripts/diag/fib-bb-option-study.ts --moneyness=-1,0,1
 *   npx tsx scripts/diag/fib-bb-option-study.ts --tf=1 --length=150 --mult=2.5 \
 *     --entryRatio=0.5 --target=basis --stopBuf=1.5 --dir=long --moneyness=0,1,2
 */
import * as fs from 'fs';
import { loadDay, listDatesFor, resolveSymbolTarget } from './sweep-symbol';
import { aggregateIntraday, OHLCBar } from './ohlc-aggregate';
import { fibBands, rollingATR, lastBarOfSessionIdx, simulate, etDate, regressionChannel, type SimOpts, type TargetSpec } from './fib-bb-core';
import { priceOptionFill, priceOptionNativeExit, priceCreditSpread, type OptionBarMap, type OptionTrade } from './fib-bb-option-core';
import { resolveSpreadModel } from '../../src/core/friction';

// ──────────────────────────── CLI ────────────────────────────
function arg(name: string, def: string): string {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  if (flag) return flag.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const TF = parseInt(arg('tf', '1'), 10);
const LENGTH = parseInt(arg('length', '150'), 10);
const MULT = parseFloat(arg('mult', '2.5'));
const ENTRY_RATIO = parseFloat(arg('entryRatio', '0.5'));
const TARGET: TargetSpec = arg('target', 'basis') === 'basis' ? { kind: 'basis' } : { kind: 'band', ratio: parseFloat(arg('target', '0.5')) };
const STOP_BUF = parseFloat(arg('stopBuf', '1.5'));
const DIR = arg('dir', 'long') as 'long' | 'short';
const MONEYNESSES = arg('moneyness', '-2,-1,0,1,2').split(',').map(Number);
const MAX_DAYS = parseInt(arg('maxDays', '0'), 10);   // 0 = all
const ATR_PERIOD = parseInt(arg('atrPeriod', '14'), 10);
// Exit mode: 'signal' = close at the underlying signal's exit bar (basis/SL/
// session). 'option' = ignore the signal exit; manage the option by its OWN
// premium — exit on +optTpPct gain (TP limit) or -optSlPct loss (SL market)
// or session close. Option-native cuts theta damage and captures gamma pops.
const EXIT_MODE = arg('exitMode', 'signal') as 'signal' | 'option';
const OPT_TP_PCT = parseFloat(arg('optTpPct', '0.50'));   // +50% → take profit
const OPT_SL_PCT = parseFloat(arg('optSlPct', '0.30'));   // -30% → stop loss
// ── Stricter entry trigger (iteration on the "reject off any level" critique) ──
const WICK_FRAC = parseFloat(arg('wickFrac', '0.5'));    // reject wick >= 50% of bar range
const SEQ_RATIO = parseFloat(arg('seqRatio', '0'));       // require prior touch of this outer band
const SEQ_WINDOW = parseInt(arg('seqWindow', '5'), 10);   // lookback bars for sequence
const TOD_START = parseInt(arg('todStart', '0'), 10);     // ET min-of-day start (660=11:00)
const TOD_END = parseInt(arg('todEnd', '0'), 10);         // ET min-of-day end (840=14:00)
// ── Option structure: long single-leg vs 2-leg credit spread ──────────────
// 'call'/'put' = buy a single call/put (long premium, theta-negative).
// 'cs_put'     = put credit spread: bullish signal, sell premium, theta-positive.
// 'cs_call'    = call credit spread: bearish signal, sell premium.
const STRUCTURE = arg('structure', 'call') as 'call' | 'put' | 'cs_put' | 'cs_call';
const SHORT_OFFSET = parseInt(arg('shortOffset', '2'), 10); // short-leg strikes OTM from ATM
const WIDTH = parseInt(arg('width', '5'), 10);              // wing distance in strikes
// ── Regression-channel confirmation gate ──────────────────────────────────
const RC_GATE = arg('rcGate', 'off') !== 'off';
const RC_LENGTH = parseInt(arg('rcLength', '50'), 10);
const RC_K = parseFloat(arg('rcK', '2.0'));

const SPREAD = process.argv.includes('--zeroFriction')
  ? { mode: 'flat' as const, spreadFloor: 0, spreadPct: 0 }
  : resolveSpreadModel();   // default flat $0.05

const SPY = resolveSymbolTarget(['--symbol', 'SPY']);
const SPX = resolveSymbolTarget(['--symbol', 'SPX']);
const spyDates = listDatesFor(SPY);
const spxDates = new Set(listDatesFor(SPX));
let dates = spyDates.filter(d => spxDates.has(d));
if (MAX_DAYS > 0) dates = dates.slice(0, MAX_DAYS);
if (!dates.length) { console.error('No overlapping SPY+SPX dates.'); process.exit(1); }
console.log(`fib-bb-option-study: ${dates.length} overlapping SPY+SPX dates (${dates[0]}..${dates[dates.length - 1]})`);
console.log(`  signal: SPY ${TF}m L${LENGTH} m${MULT} b${ENTRY_RATIO} ${TARGET.kind === 'basis' ? 'basis' : 'band' + TARGET.ratio} sb${STOP_BUF} ${DIR}`);
console.log(`  moneyness: ${MONEYNESSES.join(',')} (SPX interval 5, SPY interval 1 fallback)`);

/** SPY bar timestamp → SPX underlying close (for ATM at signal entry). */
function spxSpotAt(spxBars: OHLCBar[], ts: number): number | null {
  for (const b of spxBars) if (b.ts >= ts) return b.close;
  return null;
}
function spxSpotBeforeOrAt(spxBars: OHLCBar[], ts: number): number | null {
  let last: number | null = null;
  for (const b of spxBars) { if (b.ts > ts) break; last = b.close; }
  return last;
}

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + (12 - etHour), 30, 0) / 1000);
}

function expiryYYMMDD(date: string): string {
  // 0DTE: contract expires same trading day. Format YYMMDD from the ISO date.
  const [y, mo, d] = date.split('-').map(Number);
  return String(y).slice(2) + String(mo).padStart(2, '0') + String(d).padStart(2, '0');
}

/** Map fib-bb exit reason → friction exit kind. */
function exitKindOf(reason: string): 'tp' | 'sl' | 'market' {
  if (reason === 'target') return 'tp';
  if (reason === 'stop') return 'sl';
  return 'market';
}

// ──────────────────────────── run ────────────────────────────
interface SigTrade { date: string; entryTs: number; exitTs: number; dir: 'long' | 'short'; exitReason: string; sessionEndTs: number; }

console.log('  loading SPY signal bars + running signal detection...');
const allSig: SigTrade[] = [];
const dayCacheSpy = new Map<string, OHLCBar[]>();      // date → SPY 1m aggregated to TF
const dayCacheSpxU = new Map<string, OHLCBar[]>();     // date → SPX 1m underlying
const dayCacheSpxC = new Map<string, OptionBarMap>();  // date → SPX contracts
const dayCacheSpyC = new Map<string, OptionBarMap>();  // date → SPY contracts

let loaded = 0;
for (const date of dates) {
  // SPY signal bars (1m → TF)
  let spyTf = dayCacheSpy.get(date);
  if (!spyTf) {
    const d = loadDay(SPY, date, '1m');
    const bars: OHLCBar[] = d?.spxBars ?? [];
    if (!bars.length) continue;
    spyTf = aggregateIntraday(bars, TF, sessOpenTs(date));
    dayCacheSpy.set(date, spyTf);
  }
  // SPX day (underlying + contracts)
  let spxU = dayCacheSpxU.get(date);
  let spxC = dayCacheSpxC.get(date);
  if (!spxU) {
    const d = loadDay(SPX, date, '1m');
    spxU = d?.spxBars ?? [];
    spxC = (d?.contractBars ?? new Map()) as OptionBarMap;
    dayCacheSpxU.set(date, spxU);
    dayCacheSpxC.set(date, spxC);
  }
  // SPY contracts (fallback)
  let spyC = dayCacheSpyC.get(date);
  if (!spyC) {
    const d = loadDay(SPY, date, '1m');
    spyC = (d?.contractBars ?? new Map()) as OptionBarMap;
    dayCacheSpyC.set(date, spyC);
  }

  // Run signal detection on SPY for BOTH directions (we filter by DIR after).
  for (const dir of ['long', 'short'] as const) {
    const o: SimOpts = {
      dir, entryRatio: ENTRY_RATIO, wickFrac: WICK_FRAC, length: LENGTH, mult: MULT,
      atrPeriod: ATR_PERIOD, stopBufAtr: STOP_BUF, minRiskAtr: 0.5,
      target: TARGET, sessionExit: true,
      seqRatio: SEQ_RATIO > 0 ? SEQ_RATIO : undefined,
      seqWindow: SEQ_WINDOW,
      todStartMin: TOD_START > 0 ? TOD_START : undefined,
      todEndMin: TOD_END > 0 ? TOD_END : undefined,
      rcGate: RC_GATE || undefined,
      rcLength: RC_LENGTH,
      rcK: RC_K,
    };
    const pre = {
      bands: fibBands(spyTf!, LENGTH, MULT),
      atr: rollingATR(spyTf!, ATR_PERIOD),
      lastOfDay: lastBarOfSessionIdx(spyTf!),
      rc: RC_GATE ? regressionChannel(spyTf!, RC_LENGTH, RC_K) : undefined,
    };
    const trades = simulate(spyTf!, o, pre);
    // Session end = last SPX underlying bar ts (the 16:00 close). SPX bars
    // share the SPY bar grid, so the last SPX bar ts is the session boundary
    // for option-native exit too.
    const sessionEndTs = spxU.length ? spxU[spxU.length - 1].ts : Number.MAX_SAFE_INTEGER;
    for (const t of trades) {
      if (t.dir !== DIR) continue;   // only price the requested direction
      allSig.push({ date, entryTs: t.entryTs, exitTs: t.exitTs, dir: t.dir, exitReason: t.exitReason, sessionEndTs });
    }
  }
  loaded++;
  if (loaded % 40 === 0) process.stdout.write('.');
}
console.log(` ${loaded} sessions, ${allSig.length} ${DIR} signal trades`);

if (!allSig.length) { console.error('No signal trades for this config.'); process.exit(1); }

// ──────────────────────────── price across moneyness ────────────────────────────
interface OptResult { moneyness: number; trades: (OptionTrade & { date: string; fallback: 'SPX' | 'SPY' })[]; skipped: number; }

function priceAll(moneyness: number): OptResult {
  const out: (OptionTrade & { date: string; fallback: 'SPX' | 'SPY' })[] = [];
  let skipped = 0;
  // Price on one instrument's contract chain, honouring the exit mode.
  const priceOn = (
    bars: OptionBarMap, prefix: 'SPXW' | 'SPY', strikeInterval: number,
    spot: number, mon: number, s: SigTrade,
  ): OptionTrade | null => {
    const expiry = expiryYYMMDD(s.date);
    // ── Credit spreads (2-leg) ── shortOffset maps to the moneyness axis,
    // width is the wing distance. Moneyness here = short-leg OTM strikes.
    if (STRUCTURE === 'cs_put' || STRUCTURE === 'cs_call') {
      const csDir = STRUCTURE === 'cs_put' ? 'long' : 'short';  // put cs = bullish, call cs = bearish
      if (csDir !== s.dir) return null;                          // signal dir must match the spread's dir
      const cs = priceCreditSpread(bars, {
        dir: csDir, entryTs: s.entryTs, exitTs: s.exitTs,
        shortOffset: Math.abs(mon) || SHORT_OFFSET, width: WIDTH,
        strikeInterval, prefix, expiry, underlyingAtEntry: spot,
        exitKind: exitKindOf(s.exitReason), spreadModel: SPREAD, qty: 1,
      });
      if (!cs) return null;
      // Adapt the CreditSpreadTrade to the OptionTrade shape the reporter expects.
      return {
        instrument: prefix === 'SPXW' ? 'SPX' : 'SPY',
        symbol: `${cs.structure} ${cs.shortStrike}/${cs.wingStrike}`,
        strike: cs.shortStrike, cp: cs.structure === 'put_credit' ? 'P' : 'C',
        entryOptPrice: cs.entryCredit, exitOptPrice: cs.exitSpreadValue,
        entryMid: cs.entryCredit, exitMid: cs.exitSpreadValue,
        pnlPerShare: cs.pnlPerShare, pnlDollars: cs.pnlDollars,
        dir: cs.dir, entryTs: cs.entryTs, exitTs: cs.exitTs, exitKind: cs.exitKind,
      };
    }
    // ── Single-leg long call/put ──
    if (EXIT_MODE === 'option') {
      return priceOptionNativeExit(bars, {
        dir: s.dir, entryTs: s.entryTs, sessionEndTs: s.sessionEndTs, moneyness: mon,
        strikeInterval, prefix, expiry, underlyingAtEntry: spot,
        tpPct: OPT_TP_PCT, slPct: OPT_SL_PCT, spreadModel: SPREAD, qty: 1,
      });
    }
    return priceOptionFill(bars, {
      dir: s.dir, entryTs: s.entryTs, exitTs: s.exitTs, moneyness: mon,
      strikeInterval, prefix, expiry, underlyingAtEntry: spot,
      exitKind: exitKindOf(s.exitReason), spreadModel: SPREAD, qty: 1,
    });
  };

  for (const s of allSig) {
    const spxU = dayCacheSpxU.get(s.date)!;
    const spot = spxSpotAt(spxU, s.entryTs) ?? spxSpotBeforeOrAt(spxU, s.entryTs);
    if (spot == null) { skipped++; continue; }
    // Primary: SPX contract (interval 5)
    let t = priceOn(dayCacheSpxC.get(s.date)!, 'SPXW', 5, spot, moneyness, s);
    if (t) { out.push({ ...t, date: s.date, fallback: 'SPX' }); continue; }
    // Fallback: SPY contract (interval 1). SPY spot ≈ SPX/~305; convert the
    // SPX-moneyness offset to SPY strikes in % terms so the trade is the same
    // economic distance from ATM on either instrument.
    const spyU = dayCacheSpy.get(s.date)!;
    const spySpot = spxSpotAt(spyU, s.entryTs) ?? spxSpotBeforeOrAt(spyU, s.entryTs);
    if (spySpot == null) { skipped++; continue; }
    const spyMoneyness = Math.round(moneyness * 5 / spot * spySpot);
    t = priceOn(dayCacheSpyC.get(s.date)!, 'SPY', 1, spySpot, spyMoneyness, s);
    if (t) { out.push({ ...t, date: s.date, fallback: 'SPY' }); continue; }
    skipped++;
  }
  return { moneyness, trades: out, skipped };
}

const results = MONEYNESSES.map(priceAll);

// ──────────────────────────── report ────────────────────────────
const cut = (n: number) => dates.slice(0, n).reduce((s: Set<string>, d) => (s.add(d), s), new Set<string>());
const D60 = cut(60), D180 = cut(180), DALL = new Set(dates);

function stats(rs: (OptionTrade & { date: string })[], label: string) {
  if (!rs.length) { console.log(`  ${label}: no trades`); return null; }
  const pnls = rs.map(t => t.pnlDollars);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const n = pnls.length, w = wins.length;
  const tot = pnls.reduce((a, b) => a + b, 0);
  const days = new Set(rs.map(t => t.date));
  const byDay = new Map<string, number>();
  for (const t of rs) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.pnlDollars);
  const dayPnls = [...byDay.values()];
  const mean = dayPnls.reduce((a, b) => a + b, 0) / dayPnls.length;
  const std = Math.sqrt(dayPnls.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, dayPnls.length - 1));
  const sharpe = std > 0 ? mean / std * Math.sqrt(252) : 0;
  let cum = 0, peak = 0, maxDD = 0;
  for (const p of dayPnls) { cum += p; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); }
  const pf = losses.length && losses.reduce((a, b) => a + Math.abs(b), 0) > 0
    ? wins.reduce((a, b) => a + b, 0) / losses.reduce((a, b) => a + Math.abs(b), 0) : Infinity;
  const m = {
    n, days: days.size, wr: 100 * w / n, tot: Math.round(tot), avg: tot / n,
    pf: +pf.toFixed(2), sharpe: +sharpe.toFixed(2), maxDD: Math.round(maxDD),
    worst: Math.round(Math.min(...pnls)), best: Math.round(Math.max(...pnls)),
  };
  console.log(`  ${label}: trades=${m.n} days=${m.days} WR=${m.wr.toFixed(1)}% $PnL=${m.tot} avg=$${m.avg.toFixed(2)} PF=${m.pf} Sharpe=${m.sharpe} maxDD=$${m.maxDD} worst=$${m.worst}`);
  return m;
}

console.log('\n=== RESULTS: $ P&L per 1-lot contract, after $0.05 spread + $0.35/side commission ===\n');
for (const r of results) {
  const spxCount = r.trades.filter(t => t.fallback === 'SPX').length;
  const spyCount = r.trades.length - spxCount;
  console.log(`MONEYNESS ${r.moneyness >= 0 ? '+' : ''}${r.moneyness} (strikes from ATM, ${r.moneyness < 0 ? 'ITM' : r.moneyness === 0 ? 'ATM' : 'OTM'})  [SPX:${spxCount} SPY-fallback:${spyCount} skipped:${r.skipped}]`);
  stats(r.trades.filter(t => D60.has(t.date)), '  D60 ');
  stats(r.trades.filter(t => D180.has(t.date)), '  D180');
  stats(r.trades.filter(t => DALL.has(t.date)), '  D280');
  console.log('');
}

// Save
const outDir = 'scripts/diag/output';
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/fib-bb-option-study.json`, JSON.stringify({
  signal: { tf: TF, length: LENGTH, mult: MULT, entryRatio: ENTRY_RATIO, target: TARGET, stopBuf: STOP_BUF, dir: DIR },
  dates: { n: dates.length, first: dates[0], last: dates[dates.length - 1] },
  results: results.map(r => ({
    moneyness: r.moneyness,
    spx: r.trades.filter(t => t.fallback === 'SPX').length,
    spy: r.trades.filter(t => t.fallback === 'SPY').length,
    skipped: r.skipped,
    d60: stats(r.trades.filter(t => D60.has(t.date)), 'x'),
    d180: stats(r.trades.filter(t => D180.has(t.date)), 'x'),
    d280: stats(r.trades.filter(t => DALL.has(t.date)), 'x'),
  })),
}, null, 2));
console.log(`wrote ${outDir}/fib-bb-option-study.json`);
