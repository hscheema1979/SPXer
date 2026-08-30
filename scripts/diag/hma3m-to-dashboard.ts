/**
 * hma3m-to-dashboard.ts — reshape hma3m-tpsl-study outputs into the canonical
 * etf-long-sweep-{ticker}.json + etf-long-hourly-{ticker}.json files served by
 * scripts/autoresearch/backtest-server.ts (:3700). Drops them into
 * scripts/autoresearch/output/ so the Studio Backtest page auto-discovers them.
 *
 * Each (signal × offset × tp × sl × time-window) becomes ONE row, with the
 * window embedded in the `signal` field so windows are distinguishable in the
 * dashboard table (per user request: "spend them as different config and use
 * the time window for the name").
 *
 *   npx tsx scripts/diag/hma3m-to-dashboard.ts \
 *     --in scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d.json::9:30-12:00 \
 *     --in scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-fullday.json::9:30-16:00 \
 *     --hourly scripts/autoresearch/output/hma3m-tpsl-study.spx-fixed-365d-fullday.json::9:30-16:00 \
 *     --ticker hma3m
 *
 * Each --in arg is `<path>::<window-label>`. The window label is glued into
 * the dashboard row's `signal` so the same TP/SL config appears as separate
 * rows for the morning vs full-day windows.
 */
import * as fs from 'fs';
import * as path from 'path';

function argAll(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === flag) out.push(process.argv[i + 1]);
  return out;
}
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const INS = argAll('--in');                 // path::window
const HOURLY_INS = argAll('--hourly');      // path::window (only for hourly bucketer)
const TICKER = argVal('--ticker', 'hma3m'); // dashboard discovery key
const OUT_DIR = path.join(process.cwd(), 'scripts/autoresearch/output');

if (!INS.length) { console.error('usage: --in <path>::<window> [--in ...] [--hourly <path>::<window>] [--ticker hma3m]'); process.exit(2); }

interface HourBucket { pnl: number; n: number; wins: number }
// Cap result at a specific maxConcurrent contracts level. Mirrors the spread
// risk-cache shape so the Studio applyCapFromRiskCache() helper picks it up.
interface CapResult { cumPnl: number; wr: number; maxDD: number; n: number }
interface Row {
  source: string; configId: string; symbol: string;
  signal: string; spread: string; exit: string;
  tp: number; sl: number; offset: number; moneyness: string; maType: string; tfClass: string;
  pnl: number; pnlPct: number; n: number; wins: number; losses: number; wr: number;
  dd: number; ratio: number; sharpe: number; profitFactor: number; expectancy: number;
  posDays: number; negDays: number; pos: number; worstDay: number; bestDay: number;
  avgCredit: number; avgMaxRisk: number; avgPnlPerTrade: number; avgDurMin: number;
  numActiveDays: number;
  // 30-min bucket pnl/trade/win counts keyed by HHMM (e.g. "0930", "1530").
  // Drives the time-of-day filter and per-row hourly heatmap in the UI.
  hourlyPnl: { [bucket: string]: HourBucket };
  // Mean entry price per contract. Multiply by $100 for per-contract capital.
  avgEntryPx: number;
  // peakConcurrent + capResults populate the cap-sim machinery the Studio
  // already has for spreads. captureFraction() uses peakConcurrent+avgMaxRisk
  // for the live dial; applyCapFromRiskCache() uses capResults for exact
  // snap-to-cap values.
  peakConcurrent?: number;
}

// ── Trade-paired loader ─────────────────────────────────────────────────────
// Walks per-shard NDJSON files (entries + exits) for one cell and returns
// trades sorted by entry timestamp. Entries and exits are paired by `i` index
// within each shard; the merged trade list is the global pool.
interface Trade { es: number; xs: number; px: number; p: number; }
function loadTradesForCell(chunkBase: string, exitsBasename: string, entriesPrefix: string, exitsPrefix: string, shardCount = 4): Trade[] {
  const trades: Trade[] = [];
  for (let s = 0; s < shardCount; s++) {
    const entryFile = path.join(chunkBase, `${exitsBasename}/${entriesPrefix.slice(exitsBasename.length + 1)}${s}.ndjson`);
    const exitFile  = path.join(chunkBase, `${exitsBasename}/${exitsPrefix.slice(exitsBasename.length + 1)}${s}.ndjson`);
    if (!fs.existsSync(entryFile) || !fs.existsSync(exitFile)) continue;
    const entries: { d: string; es: number; px: number; dr: string; k: number; t: number }[] = [];
    for (const line of fs.readFileSync(entryFile, 'utf8').split('\n')) {
      if (line) entries.push(JSON.parse(line));
    }
    for (const line of fs.readFileSync(exitFile, 'utf8').split('\n')) {
      if (!line) continue;
      const ex = JSON.parse(line);
      const e = entries[ex.i];
      if (!e) continue;
      trades.push({ es: e.es, xs: ex.xs, px: e.px, p: ex.p });
    }
  }
  trades.sort((a, b) => a.es - b.es);
  return trades;
}

// ── Cap simulator ───────────────────────────────────────────────────────────
// Walks trades chronologically with a hard cap on concurrent open contracts.
// At each entry, tries to open `nominal` contracts; truncates to (cap - currently
// open) if not enough headroom. Skips if 0 contracts fit.
// Returns { cumPnl, wr, maxDD, n } at this cap level.
function simulateCap(trades: Trade[], cap: number, nominalPerTrade = 1): CapResult {
  if (!trades.length || cap <= 0) return { cumPnl: 0, wr: 0, maxDD: 0, n: 0 };
  // open = list of { releaseTs, contracts } sorted by releaseTs
  const open: { rs: number; c: number }[] = [];
  let cum = 0, peak = 0, maxDd = 0, wins = 0, n = 0;
  function releaseAndCount(now: number): number {
    let still = 0;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].rs <= now) {
        open.splice(i, 1);
      } else {
        still += open[i].c;
      }
    }
    return still;
  }
  for (const t of trades) {
    const currentlyOpen = releaseAndCount(t.es);
    const headroom = cap - currentlyOpen;
    if (headroom <= 0) continue;
    const contracts = Math.min(nominalPerTrade, headroom);
    if (contracts <= 0) continue;
    open.push({ rs: t.xs, c: contracts });
    const pnl = t.p * contracts;
    cum += pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
    if (pnl > 0) wins += 1;
    n += 1;
  }
  return {
    cumPnl: +cum.toFixed(2),
    wr: n > 0 ? +((wins / n) * 100).toFixed(2) : 0,
    maxDD: +maxDd.toFixed(2),
    n,
  };
}

// peakConcurrent = max number of overlapping trades at any moment, ignoring caps.
function peakConcurrentOf(trades: Trade[]): number {
  if (!trades.length) return 0;
  // Sweep events: +1 at entry, -1 at exit. Sort by ts; ties: exits before entries
  // so a position closing at the same instant a new one opens isn't double-counted.
  const events: { ts: number; d: number }[] = [];
  for (const t of trades) {
    events.push({ ts: t.es, d: +1 });
    events.push({ ts: t.xs, d: -1 });
  }
  events.sort((a, b) => a.ts - b.ts || a.d - b.d);
  let cur = 0, peak = 0;
  for (const ev of events) {
    cur += ev.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

function moneynessTag(off: number): string {
  if (off === 0) return 'ATM';
  return off < 0 ? `${Math.abs(off)}ITM` : `${off}OTM`;
}
function maTypeFromSig(label: string): string {
  return /HMA/i.test(label) ? 'HMA' : /DEMA/i.test(label) ? 'DEMA' : 'HMA';
}
function tfClassFromSig(label: string): string {
  const m = label.match(/(\d+m)\b/); return m ? m[1] : '3m';
}
function fastSlowFromSig(label: string): string {
  const m = label.match(/(\d+)x(\d+)/); return m ? `${m[1]}x${m[2]}` : '?';
}

const rows: Row[] = [];
for (const spec of INS) {
  const [file, window] = spec.split('::');
  if (!file || !window) { console.error(`bad --in: ${spec}`); process.exit(2); }
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const j = JSON.parse(fs.readFileSync(abs, 'utf8'));

  for (const [symbol, sd] of Object.entries<any>(j.symbols || {})) {
    for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
      // Two label shapes:
      //   (A) fixed-configs: "HMA 3m 3x9 @ 15ITM TP60/SL12" → one Row per label
      //   (B) full-grid:     "HMA 3m 3x9 @ 15ITM"          → one Row per coarse cell (TP/SL pair)
      const mFixed = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
      const mGrid  = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)$/);
      if (!mFixed && !mGrid) { console.warn(`skip unrecognized label: ${label}`); continue; }

      const sigBase = (mFixed || mGrid)![1];
      const money = (mFixed || mGrid)![2];
      const offset = money === 'ATM' ? 0 : money.endsWith('ITM') ? -parseInt(money) : parseInt(money);

      // The trade stream lets us compute hold-time, win/loss ratio, and per-day
      // extremes. Only populated when --emit-trades was on. For the full-grid
      // chunks it's empty (chunks 1-3 lost trades because the save path didn't
      // propagate them); for the focused fixed-configs runs it's present.
      let avgDurMin = 0, ratio = 0, worstDay = 0, bestDay = 0;
      const tradeArr: any[] = sig.trades || [];
      if (tradeArr.length) {
        let totDurSec = 0;
        let sumWinRet = 0, cntWin = 0, sumLossRet = 0, cntLoss = 0;
        const dayPnl = new Map<string, number>();
        for (const t of tradeArr) {
          totDurSec += Math.max(0, (t.exitTs - t.entryTs));
          const ret = (t.exitPx - t.entryPx) / t.entryPx;
          if (ret > 0) { sumWinRet += ret; cntWin++; } else { sumLossRet += ret; cntLoss++; }
          dayPnl.set(t.date, (dayPnl.get(t.date) || 0) + t.pnl);
        }
        avgDurMin = +(totDurSec / tradeArr.length / 60).toFixed(1);
        const avgWin = cntWin ? sumWinRet / cntWin : 0;
        const avgLoss = cntLoss ? Math.abs(sumLossRet / cntLoss) : 0;
        ratio = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(3) : 0;
        const pnls = [...dayPnl.values()];
        worstDay = +Math.min(...pnls).toFixed(2);
        bestDay  = +Math.max(...pnls).toFixed(2);
      }

      const dashSignal = `${sigBase} ${window}`;
      const tag = window.replace(/[^0-9]/g, '');

      // Sidecar bookkeeping for cap-sim. When the cell has an exitsFilePrefix
      // (full-grid path) we load its trades during pushRow and compute
      // peakConcurrent + capResults. The chunk's sidecars live alongside the
      // chunk file: <chunkFile>.exits/.
      const chunkDir = path.dirname(abs);
      const exitsBasename = path.basename(abs) + '.exits';
      const sigEntriesPrefix = sig.entriesFilePrefix as string | undefined;

      // Inner helper: emit one Row given (tp, sl, aggregate-stats).
      // Accepts an optional `maxDrawdown` from the cell (now populated by the
      // engine via the dailyPnl series); falls back to 0 for old chunks/configs.
      // hourlyPnl + avgEntryPx are also propagated when present.
      function pushRow(tp: number, sl: number, agg: { trades: number; wins: number; pnl: number; daysWithTrade: number; profitDays: number; winRate?: number; avgPnl?: number; maxDrawdown?: number; hourlyPnl?: { [bucket: string]: HourBucket }; avgEntryPx?: number; exitsFilePrefix?: string; }) {
        const n = agg.trades, wins = agg.wins;
        const losses = n - wins;
        const winRate = typeof agg.winRate === 'number' ? agg.winRate : (n > 0 ? wins / n : 0);
        const wr = +(winRate * 100).toFixed(2);
        const pnl = agg.pnl;
        const avgPnl = typeof agg.avgPnl === 'number' ? agg.avgPnl : (n > 0 ? pnl / n : 0);
        const daysWithTrade = agg.daysWithTrade;
        const profitDays = agg.profitDays;
        const negDays = daysWithTrade - profitDays;
        // dd is dollar drawdown (positive value, depth of deepest valley).
        const dd = +(agg.maxDrawdown ?? 0).toFixed(2);
        const ddRatio = dd > 0 ? +(pnl / dd).toFixed(2) : 0;
        const configId = `hma3m-spx-${fastSlowFromSig(sigBase).toLowerCase()}-${money.toLowerCase()}-tp${tp}-sl${sl}-w${tag}`;

        // Skipped: cap-sim for longs (peakConcurrent / capResults). Long
        // strategies flip-on-reversal — they don't accumulate open positions
        // the way credit spreads do. Sidecar data is preserved so future
        // analysis can still drill into trades, but the cap dropdown is
        // structurally meaningless for longs. avgMaxRisk is left at 0 since
        // it would only feed the disabled captureFraction path.
        const avgEntryPx = agg.avgEntryPx ?? 0;
        const avgMaxRisk = 0;

        rows.push({
          source: 'long', configId, symbol: 'SPX',
          signal: dashSignal,
          spread: `long ${money}`,
          exit: `TP${tp}/SL${sl}`,
          tp, sl, offset,
          moneyness: money,
          maType: maTypeFromSig(sigBase),
          tfClass: tfClassFromSig(sigBase),
          pnl: +pnl.toFixed(2),
          pnlPct: 0,
          n, wins, losses,
          wr,
          dd,
          ratio: ddRatio > 0 ? ddRatio : ratio,
          sharpe: 0,
          profitFactor: losses > 0 ? +(wins / losses).toFixed(3) : 0,
          expectancy: +avgPnl.toFixed(3),
          posDays: profitDays, negDays,
          pos: profitDays,
          worstDay, bestDay,
          avgCredit: 0, avgMaxRisk,
          avgPnlPerTrade: +avgPnl.toFixed(2),
          avgDurMin,
          numActiveDays: daysWithTrade,
          hourlyPnl: agg.hourlyPnl || {},
          avgEntryPx: +avgEntryPx.toFixed(2),
        });
      }

      if (mFixed) {
        // Fixed-configs path: one row per label, TP/SL come from the label.
        const tp = +mFixed[3], sl = +mFixed[4];
        const fixedRow = sig.fixed?.[0];
        if (!fixedRow) { console.warn(`no fixed row for ${label}`); continue; }
        pushRow(tp, sl, fixedRow);
      } else {
        // Full-grid path: emit one Row per coarse cell. Each cell already has
        // trades / wins / pnl / daysWithTrade / profitDays / winRate / avgPnl.
        for (const cell of (sig.coarse || [])) {
          if (cell.trades > 0) pushRow(cell.tp, cell.sl, cell);
        }
      }
    }
  }
}

// Drop in BOTH canonical locations:
//   etf-long-sweep-<ticker>.json — for the ETF-longs viewer (/api/etf-long-sweep)
//   long-sweep-<ticker>.json     — for the Studio /dashboard/backtest page
//                                   (which reads /api/long-sweep?profile=-<ticker>)
const etfOut = path.join(OUT_DIR, `etf-long-sweep-${TICKER}.json`);
fs.writeFileSync(etfOut, JSON.stringify(rows, null, 2));
console.log(`✓ wrote ${etfOut} — ${rows.length} rows`);

const longOut = path.join(OUT_DIR, `long-sweep-${TICKER}.json`);
fs.writeFileSync(longOut, JSON.stringify(rows, null, 2));
console.log(`✓ wrote ${longOut} — ${rows.length} rows`);

// The Studio profile dropdown is populated from /api/profiles, which globs
// `spread-sweep<suffix>.json`. So even though our data is longs (not credit
// spreads), we need an empty spread-sweep stub to make the SPXHMA profile
// appear in the dropdown. The actual Backtest table reads long-sweep above.
const spreadStub = path.join(OUT_DIR, `spread-sweep-${TICKER}.json`);
if (!fs.existsSync(spreadStub)) {
  fs.writeFileSync(spreadStub, JSON.stringify([], null, 2));
  console.log(`✓ wrote ${spreadStub} — [] (stub to register profile in dropdown)`);
}

// ── Per-day P&L series ──────────────────────────────────────────────────────
// Powers the Equity Curve, Daily Heatmap, Coverage, Regime, and Correlation
// tabs. Endpoint /api/spreads/daily reads spread-daily<suffix>.json with
// shape: { dates: string[], series: { "signal|spread|exit": number[] } }.
// Keys MUST match the row's `${signal}|${spread}|${exit}` join verbatim.
{
  const allDates = new Set<string>();
  const dailyByVariant = new Map<string, Map<string, number>>();
  for (const spec of INS) {
    const [file, window] = spec.split('::');
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const [_sym, sd] of Object.entries<any>(j.symbols || {})) {
      const dates: string[] = sd.dates || [];
      dates.forEach((d: string) => allDates.add(d));
      for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
        // Two label shapes — same as the table reshape above.
        const mFixed = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
        const mGrid  = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)$/);
        if (!mFixed && !mGrid) continue;
        const sigBase = (mFixed || mGrid)![1];
        const money = (mFixed || mGrid)![2];
        const dashSignal = `${sigBase} ${window}`;

        // Native long-row key shape: matches `variantKey(r)` in the Studio
        // frontend ("long::sig::money::exit"), so no translation needed at
        // the fetch boundary. The Backtest page now uses dedicated long-*
        // endpoints, NOT the spread-* ones.
        if (mFixed) {
          const tpStr = mFixed[3], slStr = mFixed[4];
          const key = `long::${dashSignal}::${money}::TP${tpStr}/SL${slStr}`;
          const dayMap = dailyByVariant.get(key) || new Map<string, number>();
          for (const t of (sig.trades || [])) dayMap.set(t.date, (dayMap.get(t.date) || 0) + t.pnl);
          dailyByVariant.set(key, dayMap);
        } else {
          for (const cell of (sig.coarse || [])) {
            if (!cell.dailyPnl) continue;
            const key = `long::${dashSignal}::${money}::TP${cell.tp}/SL${cell.sl}`;
            const dayMap = dailyByVariant.get(key) || new Map<string, number>();
            for (const [d, v] of Object.entries<number>(cell.dailyPnl)) {
              dayMap.set(d, (dayMap.get(d) || 0) + (v as number));
            }
            dailyByVariant.set(key, dayMap);
          }
        }
      }
    }
  }
  const sortedDates = [...allDates].sort();
  const series: { [k: string]: number[] } = {};
  for (const [key, dayMap] of dailyByVariant) {
    series[key] = sortedDates.map(d => +(dayMap.get(d) || 0).toFixed(2));
  }
  const dailyOut = path.join(OUT_DIR, `long-daily-${TICKER}.json`);
  fs.writeFileSync(dailyOut, JSON.stringify({ dates: sortedDates, series }, null, 2));
  console.log(`✓ wrote ${dailyOut} — ${Object.keys(series).length} series × ${sortedDates.length} dates`);
}

// ── Risk analysis ───────────────────────────────────────────────────────────
// Powers the Risk tab. Endpoint /api/risk-analysis reads risk-analysis<suffix>.json
// with shape: { "signal|spread|exit": { totalDays, totalMinutes, meanConcurrent,
// minutePercentiles, dailyPeakPercentiles, pnlByPeakBucket, capResults }, ... }.
// Each variant gets its own concurrent-positions distribution over the 6.5h
// session: at every minute count how many positions are open, then percentile.
// This is cheap with our trade rows (entry+exit ts already in hand).
{
  const SESSION_MINUTES = 6.5 * 60;
  const riskByVariant: { [k: string]: any } = {};
  for (const spec of INS) {
    const [file, window] = spec.split('::');
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const [_sym, sd] of Object.entries<any>(j.symbols || {})) {
      for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
        const m = label.match(/^(HMA 3m \dx\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
        if (!m) continue;
        const [, sigBase, money, tpStr, slStr] = m;
        const dashSignal = `${sigBase} ${window}`;
        const key = `${dashSignal}|long ${money}|TP${tpStr}/SL${slStr}`;
        const trades: any[] = sig.trades || [];
        if (!trades.length) continue;

        // Group trades by date, then for each date walk minute-by-minute to
        // count concurrent positions. Cap minute counts at SESSION_MINUTES.
        const byDate = new Map<string, any[]>();
        for (const t of trades) {
          const arr = byDate.get(t.date) || [];
          arr.push(t);
          byDate.set(t.date, arr);
        }
        const minuteCounts: number[] = [];
        const dailyPeaks: number[] = [];
        const dailyPnls = new Map<string, { pnl: number; peak: number }>();
        for (const [date, ts] of byDate) {
          // Build per-minute counts for this date.
          const minMs = Math.min(...ts.map((t: any) => t.entryTs)) * 1000;
          const maxMs = Math.max(...ts.map((t: any) => t.exitTs)) * 1000;
          const sessionStart = Math.floor(minMs / 60000) * 60;  // session-local start
          const sessionEnd   = Math.ceil(maxMs / 60000)  * 60;
          const len = Math.min(SESSION_MINUTES, Math.max(0, (sessionEnd - sessionStart) / 60));
          const arr: number[] = new Array(len).fill(0);
          for (const t of ts) {
            const a = Math.max(0, Math.floor((t.entryTs - sessionStart) / 60));
            const b = Math.min(len, Math.ceil((t.exitTs - sessionStart) / 60));
            for (let i = a; i < b; i++) arr[i]++;
          }
          let peak = 0, dayPnl = 0;
          for (const c of arr) { if (c > peak) peak = c; minuteCounts.push(c); }
          for (const t of ts) dayPnl += t.pnl;
          dailyPeaks.push(peak);
          dailyPnls.set(date, { pnl: dayPnl, peak });
        }

        function pct(arr: number[], p: number): number {
          if (!arr.length) return 0;
          const s = [...arr].sort((a, b) => a - b);
          const idx = Math.min(s.length - 1, Math.floor((s.length - 1) * p));
          return s[idx];
        }
        const totalMinutes = minuteCounts.length;
        const meanConcurrent = totalMinutes > 0 ? +(minuteCounts.reduce((s, c) => s + c, 0) / totalMinutes).toFixed(3) : 0;
        const minutePercentiles = {
          p50: pct(minuteCounts, 0.50), p75: pct(minuteCounts, 0.75), p80: pct(minuteCounts, 0.80),
          p85: pct(minuteCounts, 0.85), p90: pct(minuteCounts, 0.90), p95: pct(minuteCounts, 0.95),
          p98: pct(minuteCounts, 0.98), p99: pct(minuteCounts, 0.99), p995: pct(minuteCounts, 0.995),
          p100: pct(minuteCounts, 1.00),
        };
        const dailyPeakPercentiles = {
          p50: pct(dailyPeaks, 0.50), p75: pct(dailyPeaks, 0.75), p80: pct(dailyPeaks, 0.80),
          p85: pct(dailyPeaks, 0.85), p90: pct(dailyPeaks, 0.90), p95: pct(dailyPeaks, 0.95),
          p99: pct(dailyPeaks, 0.99), p100: pct(dailyPeaks, 1.00),
        };
        // Bucket days by their concurrent-peak; report avgPnl, win-rate, min/max P&L.
        const buckets = new Map<number, { days: number; sumPnl: number; wins: number; pnlMin: number; pnlMax: number }>();
        for (const [_d, info] of dailyPnls) {
          const b = buckets.get(info.peak) || { days: 0, sumPnl: 0, wins: 0, pnlMin: Infinity, pnlMax: -Infinity };
          b.days++;
          b.sumPnl += info.pnl;
          if (info.pnl > 0) b.wins++;
          if (info.pnl < b.pnlMin) b.pnlMin = info.pnl;
          if (info.pnl > b.pnlMax) b.pnlMax = info.pnl;
          buckets.set(info.peak, b);
        }
        const pnlByPeakBucket = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([peak, b]) => ({
          peak, days: b.days,
          avgPnl: +(b.sumPnl / b.days).toFixed(0),
          wr: +((b.wins / b.days) * 100).toFixed(0),
          pnlMin: +b.pnlMin.toFixed(0),
          pnlMax: +b.pnlMax.toFixed(0),
        }));
        riskByVariant[key] = {
          totalDays: byDate.size,
          totalMinutes,
          meanConcurrent,
          minutePercentiles,
          dailyPeakPercentiles,
          pnlByPeakBucket,
          capResults: [],   // computed by /api/risk-analysis/compute on demand
        };
      }
    }
  }
  const riskOut = path.join(OUT_DIR, `risk-analysis-${TICKER}.json`);
  fs.writeFileSync(riskOut, JSON.stringify(riskByVariant, null, 2));
  console.log(`✓ wrote ${riskOut} — ${Object.keys(riskByVariant).length} variants`);
}

// ── Hourly file ─────────────────────────────────────────────────────────────
// Two outputs for compatibility:
//   etf-long-hourly-<ticker>.json   — old flat-array shape (kept for older callers)
//   spread-hourly-<ticker>.json     — canonical Studio shape that /api/spreads/hourly
//                                     serves: { "0": { signal, structure, exit,
//                                     hours: { "10": { n, avgPnl, wr, totalPnl } } } }
// Only the focused-configs runs with trade rows can populate hourly (the full
// grid chunks don't emit trades). Other rows will render "—" in the heatmap.
if (HOURLY_INS.length) {
  const HOURS = ['09', '10', '11', '12', '13', '14', '15'];
  const flatSeries: { [k: string]: number[] } = {};   // legacy etf-long-hourly shape
  const studioHourly: { [idx: string]: any } = {};    // canonical spread-hourly shape

  function etHour(ts: number): string {
    const d = new Date(ts * 1000);
    const hh = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
    return hh.padStart(2, '0');
  }

  let studioIdx = 0;
  for (const spec of HOURLY_INS) {
    const [file, window] = spec.split('::');
    if (!file || !window) { console.error(`bad --hourly: ${spec}`); process.exit(2); }
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const [_sym, sd] of Object.entries<any>(j.symbols || {})) {
      for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
        // Same label-matching as the table reshape — supports all signal families.
        const mFixed = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
        if (!mFixed) continue;
        const [, sigBase, money, tpStr, slStr] = mFixed;
        const dashSignal = `${sigBase} ${window}`;
        const spread = `long ${money}`;
        const exit = `TP${tpStr}/SL${slStr}`;
        // Native variant key (matches Studio variantKey() for source="long").
        const key = `long::${dashSignal}::${money}::${exit}`;

        // Per-hour stats from trade rows.
        const flatArr = Array(HOURS.length).fill(0);
        const perHour: { [h: string]: { n: number; wins: number; sumPnl: number } } = {};
        for (const h of HOURS) perHour[h] = { n: 0, wins: 0, sumPnl: 0 };
        for (const t of (sig.trades || [])) {
          const h = etHour(t.entryTs);
          if (!(h in perHour)) continue;
          flatArr[HOURS.indexOf(h)] += t.pnl;
          perHour[h].n += 1;
          if (t.pnl > 0) perHour[h].wins += 1;
          perHour[h].sumPnl += t.pnl;
        }
        flatSeries[key] = flatArr.map(v => +v.toFixed(2));

        const hoursOut: { [h: string]: any } = {};
        for (const h of HOURS) {
          const b = perHour[h];
          if (b.n === 0) continue;
          hoursOut[h] = {
            n: b.n,
            avgPnl: +(b.sumPnl / b.n).toFixed(2),
            wr: +((b.wins / b.n) * 100).toFixed(1),
            totalPnl: +b.sumPnl.toFixed(2),
          };
        }
        // Native long shape: store under the variant key directly so the
        // /api/long-hourly endpoint can do a single lookup without rebuilding
        // a `signal|spread|exit` join.
        studioHourly[String(studioIdx++)] = { variantKey: key, signal: dashSignal, spread, exit, hours: hoursOut };
      }
    }
  }

  const hourlyOut = path.join(OUT_DIR, `etf-long-hourly-${TICKER}.json`);
  fs.writeFileSync(hourlyOut, JSON.stringify({ hours: HOURS, series: flatSeries }, null, 2));
  console.log(`✓ wrote ${hourlyOut} — ${Object.keys(flatSeries).length} series (legacy shape)`);

  const studioOut = path.join(OUT_DIR, `long-hourly-${TICKER}.json`);
  fs.writeFileSync(studioOut, JSON.stringify(studioHourly, null, 2));
  console.log(`✓ wrote ${studioOut} — ${Object.keys(studioHourly).length} variants (long shape)`);
}

// Dashboard auto-discovers via /api/etf-profiles glob.
console.log(`\n→ Visible at: Studio Backtest page, profile "${TICKER.toUpperCase()}" (or via ?profile=-${TICKER})`);
