/**
 * stockx-backtest.ts — StockX Phase B stock-HMA backtest engine.
 *
 * Backtests the SAME stock entry/exit trigger model the live OptionX engine
 * trades (see src/shared/stockx-triggers.ts — copied verbatim from optionx so
 * backtest == live). Key conventions (verified against the live engine):
 *
 *   1. Entry signal evaluated at bar CLOSE via evaluateEntryTriggers (default
 *      edge: 'price_cross_fast_up' — close crosses above fast MA).
 *   2. Entry fill at the NEXT BAR OPEN (no look-ahead).
 *   3. Exits via evaluateExitTriggers, checked from the entry bar onward (the
 *      live monitor watches quotes immediately post-entry): tp/sl tested on
 *      the bar's extremes with conservative intrabar SL-before-TP (both
 *      extremes hit → loss). SL fills at slLevel (resting stop); TP fills at
 *      max(bar.close, tpLevel) — candle-close market exit capturing momentum
 *      overshoot (optionx candle_close_market convention). 'ma_cross_down' is
 *      evaluated on the bar close and fills at the NEXT bar open (live fires
 *      a market order on the close print ≈ next open). The exitTriggers list
 *      is respected (a strategy may disable 'sl', etc.).
 *   4. SHARE sizing (P&L ×1, no option multiplier): dollars / shares / risk,
 *      integer shares via Math.floor (matches live sizeStockPosition).
 *   5. Optional slippage (cents/share, applied to each side) + commission
 *      ($ per order side).
 *
 * CLI:
 *   npx tsx scripts/diag/stockx-backtest.ts --symbol ASTX --timeframe 5m \
 *     --fast 5 --slow 100 --entry price_cross_fast_up --tp 1.15 --sl 0.93 \
 *     --exit tp,sl,ma_cross_down --dollars 1000 --session rth
 *
 * Also exports runBacktest(params) for the HTTP route in
 * scripts/autoresearch/backtest-server.ts. With --json-out <file> the full
 * {summary, trades, equity, buyHold} payload is written to disk (used by the
 * server's job runner); the last stdout line is always the summary JSON.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';
import {
  computeMA,
  evaluateEntryTriggers,
  evaluateExitTriggers,
  tpSlLevels,
  type MaType,
  type StockEntryTrigger,
  type StockExitTrigger,
} from '../../src/shared/stockx-triggers';

const PARQUET_ROOT = path.resolve(process.cwd(), process.env.PARQUET_ROOT || 'data/parquet/bars');

// ── params / result shapes (HTTP route contract — keep stable) ───────────────
export interface StockxParams {
  symbol: string;                                   // e.g. 'ASTX', 'USD'
  timeframe?: string;                               // default '5m'
  maType?: MaType;                                  // default 'hma'
  hmaFast: number;                                  // e.g. 5
  hmaSlow: number;                                  // e.g. 100
  entryTriggers: StockEntryTrigger[];               // e.g. ['price_cross_fast_up']
  entryMatch?: 'all' | 'any';                       // default 'all'
  tpMult: number;                                   // long: tpLevel = entry × tpMult (e.g. 1.15)
  slMult: number;                                   // long: slLevel = entry × slMult (e.g. 0.93)
  exitTriggers: StockExitTrigger[];                 // e.g. ['tp','sl','ma_cross_down']
  direction?: 'long' | 'short';                     // default 'long'; 'short' = sell-short entries, invert P&L
  sizing: { type: 'dollars' | 'shares' | 'risk'; value: number };
  maxRiskPerTrade?: number;                         // risk sizing override ($)
  slippage?: number;                                // cents/share, applied each side (default 0)
  commission?: number;                              // $ per order side (default 0)
  session?: 'rth' | 'rth+ah';                       // default 'rth' (09:30–16:00 ET; +ah → 20:00 ET)
  startDate?: string;                               // YYYY-MM-DD inclusive
  endDate?: string;                                 // YYYY-MM-DD inclusive
}

export interface StockxTrade {
  entryTime: string;      // 'YYYY-MM-DD HH:MM' ET
  exitTime: string;
  entryPx: number;        // fill incl. slippage
  exitPx: number;
  qty: number;
  pnl: number;            // $ net of commission
  retPct: number;         // % on entry notional
  bars: number;
  reason: StockExitTrigger | 'open';
}

export interface StockxResult {
  summary: {
    symbol: string; timeframe: string; maType: MaType; hmaFast: number; hmaSlow: number;
    entryTriggers: StockEntryTrigger[]; exitTriggers: StockExitTrigger[];
    tpMult: number; slMult: number; session: string;
    direction: 'long' | 'short';
    dates: { start: string; end: string; days: number };
    bars: number;
    trades: number; wins: number; losses: number; winRate: number;   // winRate in %
    totalPnl: number;          // $ summed over trades
    cumPnlPct: number;         // totalPnl / sizing basis × 100 (basis: dollars→value, shares→qty×firstEntry, risk→value)
    profitFactor: number;
    avgPnlPerTrade: number;    // $
    avgWin: number; avgLoss: number;   // $
    maxDrawdown: number;       // $ peak-to-trough on the per-trade equity curve
    sharpe: number;            // per-trade $ P&L mean/stdev (not annualized)
    slippage: number; commission: number;
    sizing: StockxParams['sizing'];
  };
  trades: StockxTrade[];
  equity: { t: string; equity: number; pnl: number }[];  // per-trade cumulative $ equity (starts at 0)
  buyHold: { pnl: number; pct: number };                 // same $ basis, first open → last close
}

// ── timeframe / ET helpers ────────────────────────────────────────────────────
const TF_MIN: Record<string, number> = {
  '1m': 1, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30,
  '1h': 60, '2h': 120, '4h': 240, '1d': 390,
};

interface Bar1m { ts: number; open: number; high: number; low: number; close: number; volume: number }
interface TFBar { ts: number; open: number; high: number; low: number; close: number }

const ET_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false });
function etMinutesOfDay(tsSec: number): number {
  const parts = ET_FMT.formatToParts(new Date(tsSec * 1000));
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10) % 24;
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return h * 60 + m;
}
function etDate(tsSec: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsSec * 1000));
}
function fmtETDateTime(tsSec: number): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(tsSec * 1000));
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** Session filter: RTH 09:30–16:00 ET; 'rth+ah' extends to 20:00 ET. Bars are minute-stamped Unix seconds; converted to ET here. */
function inSession(tsSec: number, session: 'rth' | 'rth+ah'): boolean {
  const min = etMinutesOfDay(tsSec);
  const end = session === 'rth+ah' ? 20 * 60 : 16 * 60;
  return min >= 9 * 60 + 30 && min < end;
}

// ── 1m → TF aggregation (same wall-clock bucketing as etf-long-sweep.ts) ─────
function aggregate(bars1m: Bar1m[], tf: string): TFBar[] {
  if (tf === '1d') {
    const byDay = new Map<string, TFBar>();
    const order: string[] = [];
    for (const b of bars1m) {
      const day = etDate(b.ts);
      let bar = byDay.get(day);
      if (!bar) { bar = { ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close }; byDay.set(day, bar); order.push(day); }
      else { if (b.high > bar.high) bar.high = b.high; if (b.low < bar.low) bar.low = b.low; bar.close = b.close; }
    }
    return order.map(d => byDay.get(d)!);
  }
  const sec = TF_MIN[tf] * 60;
  const out: TFBar[] = []; let cur: TFBar | null = null;
  for (const b of bars1m) {
    const bk = Math.floor(b.ts / sec) * sec;
    if (!cur || cur.ts !== bk) { if (cur) out.push(cur); cur = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close }; }
    else { if (b.high > cur.high) cur.high = b.high; if (b.low < cur.low) cur.low = b.low; cur.close = b.close; }
  }
  if (cur) out.push(cur);
  return out;
}

// ── load continuous 1m series across parquet dates (same loader as etf-long-sweep) ──
function loadContinuous(symbol: string, startDate?: string, endDate?: string): { bars: Bar1m[]; dates: string[] } {
  const profileId = symbol.toLowerCase();
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) return { bars: [], dates: [] };
  let dates = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f)).map(f => f.slice(0, 10)).sort();
  if (startDate) dates = dates.filter(d => d >= startDate);
  if (endDate) dates = dates.filter(d => d <= endDate);
  const sym = symbol.toUpperCase();
  const all: Bar1m[] = [];
  for (const date of dates) {
    const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const cache = loadBarCacheFromParquetSync({
      profileId, date, underlyingSymbol: sym,
      symbolRange: { lo: '￿', hi: '￿' }, // no contracts — shares only
      timeframe: '1m', startTs: dayStart, endTs: dayStart + 86400 - 1,
      skipContractIndicators: true,
    }) as any;
    for (const b of (cache?.spxBars ?? [])) all.push({ ts: b.ts, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 });
  }
  all.sort((a, b) => a.ts - b.ts);
  return { bars: all, dates };
}

// ── the engine ────────────────────────────────────────────────────────────────
export function runBacktest(p: StockxParams): StockxResult {
  const tf = p.timeframe ?? '5m';
  const maType = p.maType ?? 'hma';
  const session = p.session ?? 'rth';
  const slip = (p.slippage ?? 0) / 100;              // cents/share → $/share
  const comm = p.commission ?? 0;                    // $ per side
  const entryTriggers = p.entryTriggers;
  const exitTriggers = p.exitTriggers;
  const side: 1 | -1 = p.direction === 'short' ? -1 : 1;
  // Signed per-share delta: long profits when exit > entry, short when exit < entry.
  const signedDelta = (exitPx: number, entryPx: number) => side === 1 ? exitPx - entryPx : entryPx - exitPx;
  if (!TF_MIN[tf]) throw new Error(`unknown timeframe ${tf}`);

  const { bars: bars1m, dates } = loadContinuous(p.symbol, p.startDate, p.endDate);
  const sessBars = bars1m.filter(b => inSession(b.ts, session));
  const tfBars = aggregate(sessBars, tf);
  const closes = tfBars.map(b => b.close);

  const empty = (reason: string): StockxResult => ({
    summary: {
      symbol: p.symbol, timeframe: tf, maType, hmaFast: p.hmaFast, hmaSlow: p.hmaSlow,
      entryTriggers, exitTriggers, tpMult: p.tpMult, slMult: p.slMult, session,
      dates: { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '', days: dates.length },
      bars: tfBars.length, trades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, cumPnlPct: 0, profitFactor: 0, avgPnlPerTrade: 0, avgWin: 0, avgLoss: 0,
      maxDrawdown: 0, sharpe: 0, slippage: p.slippage ?? 0, commission: comm, sizing: p.sizing,
    },
    trades: [], equity: [], buyHold: { pnl: 0, pct: 0 },
  });
  if (tfBars.length < p.hmaSlow + 2) return empty('insufficient bars');

  // Aligned trailing series (same contract as the live engine's
  // buildStockMaSeries): fast/slow/closes share index i; bar = tfBars[N0 + i].
  const fastRaw = computeMA(closes, p.hmaFast, maType);
  const slowRaw = computeMA(closes, p.hmaSlow, maType);
  const N = Math.min(fastRaw.length, slowRaw.length);
  if (N < 2) return empty('insufficient MA history');
  const fastMA = fastRaw.slice(fastRaw.length - N);
  const slowMA = slowRaw.slice(slowRaw.length - N);
  const closesA = closes.slice(closes.length - N);
  const N0 = tfBars.length - N;

  const trades: StockxTrade[] = [];
  let inPos = false, entryIdx = -1, entryPx = 0, qty = 0;

  const sizeQty = (fill: number): number => {
    if (p.sizing.type === 'shares') return Math.floor(p.sizing.value);
    if (p.sizing.type === 'dollars') return Math.floor(p.sizing.value / fill);
    // risk: qty such that qty × (fill − slLevel) ≤ risk$
    const riskDollars = p.maxRiskPerTrade ?? p.sizing.value;
    const perShare = fill - fill * p.slMult;
    return perShare > 0 ? Math.floor(riskDollars / perShare) : 0;
  };

  for (let i = 1; i < N; i++) {
    if (!inPos) {
      const fired = evaluateEntryTriggers({
        closes: closesA, fastMA, slowMA,
        triggers: entryTriggers, match: p.entryMatch ?? 'all', i,
      });
      if (fired && i + 1 < N) {
        const fill = tfBars[N0 + i + 1].open + slip;    // NEXT BAR OPEN (no look-ahead)
        const q = sizeQty(fill);
        if (q > 0) { inPos = true; entryIdx = i + 1; entryPx = fill; qty = q; }
      }
      continue;
    }
    // Holding: conservative intrabar SL-before-TP, then the MA-cross exit on close.
    // For a short the ADVERSE extreme (SL) is the high and the FAVORABLE (TP) is
    // the low — the opposite of a long. SL-before-TP means if both extremes hit,
    // assume the stop (adverse) fired first.
    const bar = tfBars[N0 + i];
    const { tpLevel, slLevel } = tpSlLevels(entryPx, side, p.tpMult, p.slMult);
    const slPrice = side === 1 ? bar.low : bar.high;
    const tpPrice = side === 1 ? bar.high : bar.low;
    const slHit = exitTriggers.includes('sl') &&
      evaluateExitTriggers({ price: slPrice, entry: entryPx, side, tpMult: p.tpMult, slMult: p.slMult, triggers: ['sl'] }) === 'sl';
    const tpHit = !slHit && exitTriggers.includes('tp') &&
      evaluateExitTriggers({ price: tpPrice, entry: entryPx, side, tpMult: p.tpMult, slMult: p.slMult, triggers: ['tp'] }) === 'tp';
    const crossExit = !slHit && !tpHit && exitTriggers.some(tt => tt === 'ma_cross_down' || tt === 'ma_cross_up') &&
      evaluateExitTriggers({
        price: bar.close, entry: entryPx, side, tpMult: p.tpMult, slMult: p.slMult,
        fastMA, slowMA, triggers: side === 1 ? ['ma_cross_down'] : ['ma_cross_up'], i,
      }) !== null;

    let exitPx: number | null = null, reason: StockExitTrigger | null = null;
    let exitIdx = i;                       // bar whose ts labels the exit
    if (slHit) { exitPx = slLevel; reason = 'sl'; }
    else if (tpHit) {
      // TP fills capturing momentum overshoot PAST the level (candle-close market
      // exit, optionx candle_close_market convention): long → max(close, tpLevel)
      // (never below the level); short → min(close, tpLevel) (never above it).
      // Filling long at exactly tpLevel instead drops the regression-gate run
      // from ~+203%/PF 1.14 to ~+137%/PF 1.09.
      exitPx = side === 1 ? Math.max(bar.close, tpLevel) : Math.min(bar.close, tpLevel); reason = 'tp';
    }
    else if (crossExit) {
      // MA-cross signal fires on the CLOSING bar; the flattening order fills at
      // the NEXT bar's open — same convention as live (the monitor fires on the
      // close, the order fills ~next open). Exiting at the detection close
      // instead roughly halves per-trade P&L and overstates fills.
      const trig: StockExitTrigger = side === 1 ? 'ma_cross_down' : 'ma_cross_up';
      const nextBar = i + 1 < N ? tfBars[N0 + i + 1] : null;
      if (nextBar) { exitPx = nextBar.open; reason = trig; exitIdx = i + 1; }
      // else: last bar with no next — leave open; the post-loop mark closes it.
    }

    if (exitPx != null && reason) {
      const fill = exitPx - slip;
      const delta = signedDelta(fill, entryPx);
      const pnl = +(delta * qty - 2 * comm).toFixed(2);
      trades.push({
        entryTime: fmtETDateTime(tfBars[N0 + entryIdx].ts),
        exitTime: fmtETDateTime(tfBars[N0 + exitIdx].ts),
        entryPx: +entryPx.toFixed(4), exitPx: +fill.toFixed(4), qty,
        pnl, retPct: +(delta / entryPx * 100).toFixed(2),
        bars: exitIdx - entryIdx, reason,
      });
      inPos = false; entryIdx = -1; entryPx = 0; qty = 0;
    }
  }
  // Mark any open position at the last bar close.
  if (inPos) {
    const last = tfBars[tfBars.length - 1];
    const fill = last.close - slip;
    const delta = signedDelta(fill, entryPx);
    const pnl = +(delta * qty - 2 * comm).toFixed(2);
    trades.push({
      entryTime: fmtETDateTime(tfBars[N0 + entryIdx].ts),
      exitTime: fmtETDateTime(last.ts),
      entryPx: +entryPx.toFixed(4), exitPx: +fill.toFixed(4), qty,
      pnl, retPct: +(delta / entryPx * 100).toFixed(2),
      bars: N - 1 - entryIdx, reason: 'open',
    });
  }

  // ── metrics ──────────────────────────────────────────────────────────────
  const n = trades.length;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = +trades.reduce((s, t) => s + t.pnl, 0).toFixed(2);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const basis = p.sizing.type === 'shares'
    ? (trades.length ? trades[0].qty * trades[0].entryPx : p.sizing.value)
    : p.sizing.value;
  let eq = 0, peak = 0, mdd = 0;
  const equity = trades.map(t => {
    eq += t.pnl; peak = Math.max(peak, eq); mdd = Math.max(mdd, peak - eq);
    return { t: t.exitTime, equity: +eq.toFixed(2), pnl: t.pnl };
  });
  const mean = n ? totalPnl / n : 0;
  const variance = n > 1 ? trades.reduce((s, t) => s + (t.pnl - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const firstOpen = tfBars[0].open, lastClose = tfBars[tfBars.length - 1].close;
  const bhQty = Math.floor(basis / firstOpen);
  // Buy-&-hold (long) or sell-&-hold (short) benchmark on the same $ basis.
  const bhPnl = +(signedDelta(lastClose, firstOpen) * bhQty).toFixed(2);

  return {
    summary: {
      symbol: p.symbol, timeframe: tf, maType, hmaFast: p.hmaFast, hmaSlow: p.hmaSlow,
      entryTriggers, exitTriggers, tpMult: p.tpMult, slMult: p.slMult, session,
      direction: side === 1 ? 'long' : 'short',
      dates: { start: dates[0] ?? '', end: dates[dates.length - 1] ?? '', days: dates.length },
      bars: tfBars.length,
      trades: n, wins: wins.length, losses: losses.length,
      winRate: n ? +(100 * wins.length / n).toFixed(2) : 0,
      totalPnl,
      cumPnlPct: basis > 0 ? +(100 * totalPnl / basis).toFixed(2) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99.99 : 0),
      avgPnlPerTrade: n ? +mean.toFixed(2) : 0,
      avgWin: wins.length ? +(grossWin / wins.length).toFixed(2) : 0,
      avgLoss: losses.length ? +(grossLoss / losses.length).toFixed(2) : 0,
      maxDrawdown: +mdd.toFixed(2),
      sharpe: stdev > 0 ? +(mean / stdev).toFixed(3) : 0,
      slippage: p.slippage ?? 0, commission: comm, sizing: p.sizing,
    },
    trades,
    equity,
    buyHold: { pnl: bhPnl, pct: basis > 0 ? +(100 * bhPnl / basis).toFixed(2) : 0 },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  if (f) return f.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const symbol = (argVal('symbol') ?? 'ASTX').toUpperCase();
  const direction = (argVal('direction') ?? 'long') as 'long' | 'short';
  // Default triggers/exit flip with direction: short enters on the down-cross
  // and exits on the up-cross, unless the caller overrides --entry/--exit.
  const entryDefault = direction === 'short' ? 'price_cross_fast_down' : 'price_cross_fast_up';
  const exitDefault = direction === 'short' ? 'tp,sl,ma_cross_up' : 'tp,sl,ma_cross_down';
  const entry = (argVal('entry') ?? entryDefault).split(',').filter(Boolean) as StockEntryTrigger[];
  const exit = (argVal('exit') ?? exitDefault).split(',').filter(Boolean) as StockExitTrigger[];
  const sizing: StockxParams['sizing'] = argVal('shares')
    ? { type: 'shares', value: parseFloat(argVal('shares')!) }
    : argVal('risk')
      ? { type: 'risk', value: parseFloat(argVal('risk')!) }
      : { type: 'dollars', value: parseFloat(argVal('dollars') ?? '1000') };
  const params: StockxParams = {
    symbol,
    timeframe: argVal('timeframe') ?? argVal('tf') ?? '5m',
    maType: (argVal('ma-type') ?? 'hma') as MaType,
    hmaFast: parseInt(argVal('fast') ?? '5', 10),
    hmaSlow: parseInt(argVal('slow') ?? '100', 10),
    entryTriggers: entry,
    entryMatch: (argVal('entry-match') ?? 'all') as 'all' | 'any',
    tpMult: parseFloat(argVal('tp') ?? '1.15'),
    slMult: parseFloat(argVal('sl') ?? '0.93'),
    exitTriggers: exit,
    direction,
    sizing,
    maxRiskPerTrade: argVal('max-risk') ? parseFloat(argVal('max-risk')!) : undefined,
    slippage: argVal('slippage') ? parseFloat(argVal('slippage')!) : 0,
    commission: argVal('commission') ? parseFloat(argVal('commission')!) : 0,
    session: (argVal('session') ?? 'rth') as 'rth' | 'rth+ah',
    startDate: argVal('start'), endDate: argVal('end'),
  };
  const result = runBacktest(params);
  const jsonOut = argVal('json-out');
  if (jsonOut) {
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(result));
  }
  const s = result.summary;
  console.error(`[stockx-backtest] ${s.symbol} ${s.direction} ${s.timeframe} ${s.maType} ${s.hmaFast}x${s.hmaSlow} entry=[${s.entryTriggers}] exit=[${s.exitTriggers}] tp=${s.tpMult} sl=${s.slMult} ${s.session} ${s.dates.start}→${s.dates.end} (${s.dates.days}d, ${s.bars} bars)`);
  console.error(`[stockx-backtest] cum ${s.cumPnlPct}% ($${s.totalPnl}) PF ${s.profitFactor} WR ${s.winRate}% trades ${s.trades} avgPnl $${s.avgPnlPerTrade} maxDD $${s.maxDrawdown} sharpe ${s.sharpe} | buyHold ${s.cumPnlPct === 0 ? '' : ''}${result.buyHold.pct}%`);
  // Last stdout line = summary JSON (the server job runner parses this).
  console.log(JSON.stringify({ summary: s, buyHold: result.buyHold, jsonOut: jsonOut ?? null }));
}

if (require.main === module) main();
