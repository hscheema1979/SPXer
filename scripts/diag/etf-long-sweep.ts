/**
 * etf-long-sweep.ts — leveraged-ETF long-only SHARE swing backtest.
 *
 * Unlike long-sweep.ts (0DTE option scalps, per-day, EOD-flat), this trades the
 * UNDERLYING ETF SHARES and HOLDS OVERNIGHT. It builds ONE CONTINUOUS multi-day
 * bar series per ticker, computes slow moving averages (periods up to 200) on
 * higher timeframes (5m / 15m / 1h / 1d), and enters/exits on MA-cross
 * alignment with a %TP / %SL and reversal exit — no forced EOD close.
 *
 *   npx tsx scripts/diag/etf-long-sweep.ts --symbol TQQQ
 *   npx tsx scripts/diag/etf-long-sweep.ts                 # all pilot tickers
 *   SWEEP_DAYS=N  → only the most-recent N trading days
 *
 * Output (per ticker, namespaced by suffix '-{ticker}'):
 *   scripts/autoresearch/output/etf-long-sweep-{ticker}.json   — flat rows
 *     (one per config variant), the SAME row shape /api/long-sweep consumes.
 *
 * Why a fresh engine and not a fork of runDay(): a 200-period DAILY MA and
 * cross-day holding require the full continuous series. The 0DTE engines reseed
 * per day and force EOD exit, which is structurally incompatible.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';

const PILOT = ['TQQQ', 'SQQQ', 'SOXL', 'TNA', 'FAS'];
const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
const OUT_DIR = path.resolve(process.cwd(), 'scripts/autoresearch/output');

// ── friction (shares): half-spread + per-share commission, in % of price ──────
// Mirrors the always-on friction principle. Leveraged ETFs are penny-wide and
// liquid; model a small round-trip cost as a flat % haircut on each trade.
const FRICTION_PCT = 0.10; // 0.10% round-trip (entry+exit) haircut on gross return

// ── timeframe minutes ─────────────────────────────────────────────────────────
const TF_MIN: Record<string, number> = {
  '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60, '2h': 120, '4h': 240, '1d': 390,
};
// 1 trading day = 390 RTH minutes, so a "1d" bar = one session aggregated from 1m.
// Intraday TFs (incl. 2h/4h) bucket by wall-clock alignment from 00:00 UTC; with
// RTH-only bars this yields the expected ~3–4 buckets/day for 2h and ~2/day for 4h.

// ── args ───────────────────────────────────────────────────────────────────────
function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  if (f) return f.split('=').slice(1).join('=');
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ── MA helpers (continuous series of closes) ──────────────────────────────────
function wma(arr: number[], end: number, p: number): number | null {
  if (end < p - 1) return null;
  let s = 0, w = 0;
  for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i); }
  return s / w;
}
/** HMA series via floor(sqrt) smoothing (matches TV ta.hma — see project memory). */
function hmaSeries(closes: number[], period: number): (number | null)[] {
  const half = Math.floor(period / 2), sq = Math.floor(Math.sqrt(period));
  const raw: number[] = []; const out: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    const a = wma(closes, i, half), b = wma(closes, i, period);
    if (a != null && b != null) {
      raw.push(2 * a - b);
      if (raw.length >= sq) out[i] = wma(raw, raw.length - 1, sq);
    }
  }
  return out;
}
function emaSeries(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  const a = 2 / (period + 1);
  let e = 0; for (let i = 0; i < period; i++) e += closes[i]; e /= period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) { e = a * closes[i] + (1 - a) * e; out[i] = e; }
  return out;
}
function maSeries(closes: number[], period: number, kind: 'hma' | 'ema'): (number | null)[] {
  return kind === 'ema' ? emaSeries(closes, period) : hmaSeries(closes, period);
}

// ── 1m → TF aggregation over a CONTINUOUS series ──────────────────────────────
interface Bar1m { ts: number; open: number; high: number; low: number; close: number; volume: number }
interface TFBar { ts: number; open: number; high: number; low: number; close: number }

/**
 * Aggregate a continuous 1m series into TF bars. For intraday TFs (5/15/60m) we
 * bucket by wall-clock minute alignment. For "1d" we bucket by ET trading date
 * so each daily bar = one full session (overnight gaps preserved across bars).
 */
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
  const tfm = TF_MIN[tf]; const sec = tfm * 60;
  const out: TFBar[] = []; let cur: TFBar | null = null;
  for (const b of bars1m) {
    const bk = Math.floor(b.ts / sec) * sec;
    if (!cur || cur.ts !== bk) { if (cur) out.push(cur); cur = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close }; }
    else { if (b.high > cur.high) cur.high = b.high; if (b.low < cur.low) cur.low = b.low; cur.close = b.close; }
  }
  if (cur) out.push(cur);
  return out;
}

function etDate(tsSec: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(tsSec * 1000));
}
function fmtETDateTime(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

// ── load continuous 1m series for a ticker across all its parquet dates ───────
function loadContinuous(profileId: string): { bars: Bar1m[]; dates: string[] } {
  const dir = path.join(PARQUET_ROOT, profileId);
  if (!fs.existsSync(dir)) return { bars: [], dates: [] };
  let dates = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f)).map(f => f.slice(0, 10)).sort();
  const n = parseInt(process.env.SWEEP_DAYS || '', 10);
  if (Number.isFinite(n) && n > 0 && n < dates.length) dates = dates.slice(-n);
  const sym = profileId.toUpperCase();
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

// ── config grid ────────────────────────────────────────────────────────────────
interface Variant { maType: 'hma' | 'ema'; tf: string; fast: number; slow: number; tp: number; sl: number }
function buildGrid(): Variant[] {
  const out: Variant[] = [];
  const maTypes: ('hma' | 'ema')[] = ['hma', 'ema'];
  const tfs = ['5m', '10m', '15m', '30m', '1h', '2h', '4h', '1d'];
  // Incremental MA grid: every fast<slow combination. Fast 3→20, slow 10→200,
  // so the sweep covers fast scalp-ish crosses through slow swing crosses
  // ("hold much longer"). 44 valid pairs.
  const fastPeriods = [3, 5, 10, 15, 20];
  const slowPeriods = [10, 15, 20, 25, 30, 50, 75, 100, 150, 200];
  const pairs: [number, number][] = [];
  for (const f of fastPeriods) for (const s of slowPeriods) if (f < s) pairs.push([f, s]);
  const tps = [10, 20, 40]; // % gain take-profit (shares, leveraged → big swings)
  const sls = [5, 10, 20];  // % loss stop
  for (const maType of maTypes)
    for (const tf of tfs)
      for (const [fast, slow] of pairs)
        for (const tp of tps)
          for (const sl of sls)
            out.push({ maType, tf, fast, slow, tp, sl });
  return out;
}

// ── run one variant over the continuous TF series ─────────────────────────────
interface Trade { entryTime: string; exitTime: string; entryPx: number; exitPx: number; retPct: number; durMin: number; reason: string; entryDate: string; exitDate: string; entryHour: string }
interface VariantResult { trades: Trade[]; daily: Map<string, number>; hourly: Map<string, number> }

function runVariant(v: Variant, tfBars: TFBar[], tfMinutes: number): VariantResult {
  const closes = tfBars.map(b => b.close);
  const fastMA = maSeries(closes, v.fast, v.maType);
  const slowMA = maSeries(closes, v.slow, v.maType);
  const dir = (i: number): 'bull' | 'bear' | null => {
    const f = fastMA[i], s = slowMA[i];
    if (f == null || s == null) return null;
    return f > s ? 'bull' : 'bear';
  };
  const trades: Trade[] = [];
  const daily = new Map<string, number>();
  const hourly = new Map<string, number>();
  let inPos = false, entryIdx = -1, entryPx = 0;
  for (let i = 1; i < tfBars.length; i++) {
    const dPrev = dir(i - 1), dNow = dir(i);
    if (dPrev == null || dNow == null) continue;
    if (!inPos) {
      // Enter long on a fresh bull cross (bear/null → bull).
      if (dNow === 'bull' && dPrev !== 'bull') { inPos = true; entryIdx = i; entryPx = tfBars[i].close; }
      continue;
    }
    // Holding: check %TP / %SL intrabar, then reversal-to-bear cross.
    const bar = tfBars[i];
    const tpPx = entryPx * (1 + v.tp / 100);
    const slPx = entryPx * (1 - v.sl / 100);
    let exitPx: number | null = null, reason = '';
    if (bar.low <= slPx) { exitPx = slPx; reason = 'SL'; }       // SL checked first (conservative)
    else if (bar.high >= tpPx) { exitPx = tpPx; reason = 'TP'; }
    else if (dNow === 'bear' && dPrev !== 'bear') { exitPx = bar.close; reason = 'reverse'; }
    if (exitPx != null) {
      const gross = (exitPx - entryPx) / entryPx * 100;
      const retPct = +(gross - FRICTION_PCT).toFixed(2);
      const entryTimeStr = fmtETDateTime(tfBars[entryIdx].ts);
      const exitTimeStr = fmtETDateTime(bar.ts);
      const entryDate = entryTimeStr.slice(0, 10);
      const exitDate = exitTimeStr.slice(0, 10);
      const entryHour = entryTimeStr.slice(11, 13);
      const exitHour = exitTimeStr.slice(11, 13);
      trades.push({
        entryTime: entryTimeStr,
        exitTime: exitTimeStr,
        entryDate, exitDate, entryHour,
        entryPx: +entryPx.toFixed(2), exitPx: +exitPx.toFixed(2),
        retPct,
        durMin: (i - entryIdx) * tfMinutes,
        reason,
      });
      // Aggregate exit P&L into exit date's daily and exit hour's hourly
      daily.set(exitDate, (daily.get(exitDate) || 0) + retPct);
      hourly.set(exitHour, (hourly.get(exitHour) || 0) + retPct);
      inPos = false; entryIdx = -1; entryPx = 0;
    }
  }
  // Close any open position at the last bar (mark-to-market, reason=open).
  if (inPos && entryIdx >= 0) {
    const last = tfBars[tfBars.length - 1];
    const gross = (last.close - entryPx) / entryPx * 100;
    const retPct = +(gross - FRICTION_PCT).toFixed(2);
    const entryTimeStr = fmtETDateTime(tfBars[entryIdx].ts);
    const exitTimeStr = fmtETDateTime(last.ts);
    const entryDate = entryTimeStr.slice(0, 10);
    const exitDate = exitTimeStr.slice(0, 10);
    const entryHour = entryTimeStr.slice(11, 13);
    trades.push({
      entryTime: entryTimeStr, exitTime: exitTimeStr,
      entryDate, exitDate, entryHour,
      entryPx: +entryPx.toFixed(2), exitPx: +last.close.toFixed(2),
      retPct, durMin: (tfBars.length - 1 - entryIdx) * tfMinutes, reason: 'open',
    });
    daily.set(exitDate, (daily.get(exitDate) || 0) + retPct);
    hourly.set(entryHour, (hourly.get(entryHour) || 0) + retPct);
  }
  return { trades, daily, hourly };
}

// ── metrics → flat row (shape /api/long-sweep consumes) ───────────────────────
function tfClassOf(tf: string): string { return tf; } // single-TF for shares
function toRow(symbol: string, v: Variant, trades: Trade[]) {
  const n = trades.length;
  const rets = trades.map(t => t.retPct);
  const wins = trades.filter(t => t.retPct > 0).length;
  const losses = trades.filter(t => t.retPct < 0).length;
  const wr = n ? +(100 * wins / n).toFixed(2) : 0;
  // % returns compounded into an equity curve for drawdown + cumulative pnl%.
  let eq = 100, peak = 100, mdd = 0; let worstDay = 0, bestDay = 0;
  for (const t of trades) {
    eq *= (1 + t.retPct / 100);
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, (peak - eq) / peak * 100);
    worstDay = Math.min(worstDay, t.retPct);
    bestDay = Math.max(bestDay, t.retPct);
  }
  const pnlPct = +(eq - 100).toFixed(2);
  const sumRet = rets.reduce((s, r) => s + r, 0);
  const avgPnlPerTrade = n ? +(sumRet / n).toFixed(3) : 0;
  const avgDurMin = n ? +(trades.reduce((s, t) => s + t.durMin, 0) / n).toFixed(1) : 0;
  const ratio = mdd > 0 ? +(pnlPct / mdd).toFixed(2) : 0;
  const activeDays = new Set(trades.map(t => t.entryTime.slice(0, 10))).size;

  // ── extra comparison stats (match the SPX longs/spreads metric set) ────────
  // Sharpe on per-trade returns (mean / stdev). Not annualized — comparable
  // across configs of the same ticker since trade cadence differs by TF.
  const mean = n ? sumRet / n : 0;
  const variance = n > 1 ? rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const sharpe = stdev > 0 ? +(mean / stdev).toFixed(3) : 0;
  // Profit factor = gross win % / gross loss % (>1 profitable). Capped display.
  const grossWin = trades.filter(t => t.retPct > 0).reduce((s, t) => s + t.retPct, 0);
  const grossLoss = Math.abs(trades.filter(t => t.retPct < 0).reduce((s, t) => s + t.retPct, 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : (grossWin > 0 ? 99.99 : 0);
  // Expectancy ($-neutral, in % per trade) = avg win·WR − avg loss·LR.
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  const expectancy = +(avgWin * (wr / 100) - avgLoss * (losses / (n || 1))).toFixed(3);
  // posDays/negDays: trading days with net-positive vs net-negative summed return.
  const dayNet = new Map<string, number>();
  for (const t of trades) { const d = t.entryTime.slice(0, 10); dayNet.set(d, (dayNet.get(d) || 0) + t.retPct); }
  let posDays = 0, negDays = 0;
  for (const net of dayNet.values()) { if (net > 0.01) posDays++; else if (net < -0.01) negDays++; }

  const sig = `${v.maType.toUpperCase()} ${v.tf} ${v.fast}x${v.slow}`;
  const configId = `etflong-${symbol.toLowerCase()}-${v.maType}-${v.tf}-${v.fast}x${v.slow}-tp${v.tp}-sl${v.sl}`;
  return {
    source: 'long',
    configId,
    symbol,
    signal: sig,
    spread: 'shares',
    exit: `${v.tp}TP/${v.sl}SL`,
    tp: v.tp, sl: v.sl,
    offset: 0,            // n/a for shares (UI strike column) — neutral
    moneyness: 'shares',  // n/a for shares
    maType: v.maType.toUpperCase(),
    tfClass: tfClassOf(v.tf),
    pnl: pnlPct,          // shares engine reports % (no $ notional) → pnl == pnlPct
    pnlPct,
    n, wins, losses, wr,
    dd: +mdd.toFixed(2),
    ratio,
    sharpe,
    profitFactor,
    expectancy,
    posDays, negDays,
    pos: 0,
    worstDay: +worstDay.toFixed(2),
    bestDay: +bestDay.toFixed(2),
    avgCredit: 0, avgMaxRisk: 0,
    avgPnlPerTrade,
    avgDurMin,
    numActiveDays: activeDays,
  };
}

// ── per-ticker sweep ────────────────────────────────────────────────────────────
function sweepTicker(symbol: string) {
  const profileId = symbol.toLowerCase();
  const { bars, dates } = loadContinuous(profileId);
  if (!bars.length) { console.error(`  [${symbol}] no bars — skip`); return; }
  const grid = buildGrid();
  // Pre-aggregate each TF once (shared across all variants on that TF). Derive
  // the TF set from the grid so it never drifts from buildGrid()'s tfs list.
  const tfBarsByTf: Record<string, TFBar[]> = {};
  for (const tf of [...new Set(grid.map(v => v.tf))]) tfBarsByTf[tf] = aggregate(bars, tf);
  const rows: any[] = [];
  const allDaily = new Map<string, Map<string, number>>();  // configId -> { date -> pnl }
  const allHourly = new Map<string, Map<string, number>>();  // configId -> { hour -> pnl }
  for (const v of grid) {
    const tfBars = tfBarsByTf[v.tf];
    const tfMin = TF_MIN[v.tf];
    const { trades, daily, hourly } = runVariant(v, tfBars, tfMin);
    rows.push(toRow(symbol, v, trades));
    const configId = `etflong-${symbol.toLowerCase()}-${v.maType}-${v.tf}-${v.fast}x${v.slow}-tp${v.tp}-sl${v.sl}`;
    allDaily.set(configId, daily);
    allHourly.set(configId, hourly);
  }
  const outFile = path.join(OUT_DIR, `etf-long-sweep-${profileId}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(rows));
  const best = [...rows].sort((a, b) => b.pnlPct - a.pnlPct)[0];
  console.error(`✓ [${symbol}] ${rows.length} variants × ${dates.length} days → ${path.basename(outFile)}  | best ${best.signal} ${best.exit}: pnl ${best.pnlPct}% wr ${best.wr}% n ${best.n} dd ${best.dd}%`);

  // Write daily/hourly aggregations (like spreads do)
  const allDates = new Set<string>();
  for (const d of allDaily.values()) for (const date of d.keys()) allDates.add(date);
  const sortedDates = Array.from(allDates).sort();
  const dailyByConfig: Record<string, number[]> = {};
  for (const [configId, dateMap] of allDaily) {
    const arr = new Array(sortedDates.length).fill(0);
    for (let i = 0; i < sortedDates.length; i++) arr[i] = dateMap.get(sortedDates[i]) || 0;
    dailyByConfig[configId] = arr;
  }
  const dailyOutFile = path.join(OUT_DIR, `etf-long-daily-${profileId}.json`);
  try {
    fs.writeFileSync(dailyOutFile, JSON.stringify({ dates: sortedDates, series: dailyByConfig }, null, 2));
  } catch {}

  const allHours = new Set<string>();
  for (const h of allHourly.values()) for (const hour of h.keys()) allHours.add(hour);
  const sortedHours = Array.from(allHours).sort();
  const hourlyByConfig: Record<string, number[]> = {};
  for (const [configId, hourMap] of allHourly) {
    const arr = new Array(sortedHours.length).fill(0);
    for (let i = 0; i < sortedHours.length; i++) arr[i] = hourMap.get(sortedHours[i]) || 0;
    hourlyByConfig[configId] = arr;
  }
  const hourlyOutFile = path.join(OUT_DIR, `etf-long-hourly-${profileId}.json`);
  try {
    fs.writeFileSync(hourlyOutFile, JSON.stringify({ hours: sortedHours, series: hourlyByConfig }, null, 2));
  } catch {}
}

// ── main ─────────────────────────────────────────────────────────────────────
// Ticker selection precedence: --symbol (one) → --tickers=CSV (many) →
// --all / no flag (every ETF parquet dir present). Falls back to PILOT only if
// no parquet dirs are discoverable.
function discoverEtfDirs(): string[] {
  if (!fs.existsSync(PARQUET_ROOT)) return [];
  const skip = new Set(['spx-0dte', 'ndx-0dte', 'qqq-0dte', 'qqq-1dte', 'spy-0dte', 'spy-1dte', 'nvda', 'tsla']);
  return fs.readdirSync(PARQUET_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !skip.has(d.name))
    .map(d => d.name.toUpperCase())
    .sort();
}
const sym = argVal('symbol');
const tickersCsv = argVal('tickers');
let tickers: string[];
if (sym) tickers = [sym.toUpperCase()];
else if (tickersCsv) tickers = tickersCsv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
else { const dirs = discoverEtfDirs(); tickers = dirs.length ? dirs : PILOT; }
console.error(`[etf-long-sweep] ${tickers.length} ticker(s): ${tickers.join(', ')}`);
for (const t of tickers) sweepTicker(t);
console.error('[etf-long-sweep] done.');
