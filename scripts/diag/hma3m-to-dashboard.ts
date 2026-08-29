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

interface Row {
  source: string; configId: string; symbol: string;
  signal: string; spread: string; exit: string;
  tp: number; sl: number; offset: number; moneyness: string; maType: string; tfClass: string;
  pnl: number; pnlPct: number; n: number; wins: number; losses: number; wr: number;
  dd: number; ratio: number; sharpe: number; profitFactor: number; expectancy: number;
  posDays: number; negDays: number; pos: number; worstDay: number; bestDay: number;
  avgCredit: number; avgMaxRisk: number; avgPnlPerTrade: number; avgDurMin: number;
  numActiveDays: number;
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
    const dates: string[] = sd.dates || [];
    for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
      // label = "HMA 3m 3x9 @ 15ITM TP60/SL12" (fixed-configs path)
      const m = label.match(/^(HMA 3m \dx\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
      if (!m) { console.warn(`skip non-fixed label: ${label}`); continue; }
      const [, sigBase, money, tpStr, slStr] = m;
      const tp = +tpStr, sl = +slStr;
      const offset = money === 'ATM' ? 0 : money.endsWith('ITM') ? -parseInt(money) : parseInt(money);

      const fixedRow = sig.fixed?.[0];
      if (!fixedRow) { console.warn(`no fixed row for ${label}`); continue; }
      const { trades: n, wins, winRate, pnl, avgPnl, daysWithTrade, profitDays } = fixedRow;
      const losses = n - wins;
      const wr = +(winRate * 100).toFixed(2);
      const negDays = daysWithTrade - profitDays;

      // Compute hold-time, ratio (avg-win-pct / |avg-loss-pct|), and per-day
      // P&L extremes from the trade stream when available. The morning-only
      // sweep had no --emit-trades originally so sig.trades may be missing;
      // those rows show 0 for HoldMin and ratio (cosmetic).
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

      // Embed window in the dashboard `signal` so each window is its own row.
      const dashSignal = `${sigBase} ${window}`;
      const tag = window.replace(/[^0-9]/g, '');  // e.g. "0930-1200" → "09301200"
      const configId = `hma3m-spx-${fastSlowFromSig(sigBase).toLowerCase()}-${money.toLowerCase()}-tp${tp}-sl${sl}-w${tag}`;

      rows.push({
        source: 'long', configId, symbol: 'SPX',
        signal: dashSignal,
        spread: `long ${money}`,         // shows in Spread column → "long 15ITM"
        exit: `TP${tp}/SL${sl}`,
        tp, sl, offset,
        moneyness: money,
        maType: maTypeFromSig(sigBase),
        tfClass: tfClassFromSig(sigBase),
        pnl: +pnl.toFixed(2),
        pnlPct: 0,                       // not meaningful for $-denominated long
        n, wins, losses,
        wr,
        dd: 0,                           // not computed (would need equity curve)
        ratio,
        sharpe: 0,
        profitFactor: losses > 0 ? +(wins / losses).toFixed(3) : 0,
        expectancy: +avgPnl.toFixed(3),
        posDays: profitDays, negDays,
        // pos = profitable-day count (Backtest table "+days" column reads this)
        pos: profitDays,
        worstDay, bestDay,
        avgCredit: 0, avgMaxRisk: 0,
        avgPnlPerTrade: +avgPnl.toFixed(2),
        avgDurMin,
        numActiveDays: daysWithTrade,
      });
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
        const m = label.match(/^(HMA 3m \dx\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
        if (!m) continue;
        const [, sigBase, money, tpStr, slStr] = m;
        const dashSignal = `${sigBase} ${window}`;
        const key = `${dashSignal}|long ${money}|TP${tpStr}/SL${slStr}`;
        const dayMap = dailyByVariant.get(key) || new Map<string, number>();
        for (const t of (sig.trades || [])) dayMap.set(t.date, (dayMap.get(t.date) || 0) + t.pnl);
        dailyByVariant.set(key, dayMap);
      }
    }
  }
  const sortedDates = [...allDates].sort();
  const series: { [k: string]: number[] } = {};
  for (const [key, dayMap] of dailyByVariant) {
    series[key] = sortedDates.map(d => +(dayMap.get(d) || 0).toFixed(2));
  }
  const dailyOut = path.join(OUT_DIR, `spread-daily-${TICKER}.json`);
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
// Shape consumed by /api/etf-long-hourly: { hours: string[], series: { "sig|spread|exit": number[] } }
// where key matches the table row's signal|spread|exit join exactly.
if (HOURLY_INS.length) {
  const HOURS = ['09', '10', '11', '12', '13', '14', '15'];
  const series: { [k: string]: number[] } = {};

  function etHour(ts: number): string {
    const d = new Date(ts * 1000);
    const hh = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
    return hh.padStart(2, '0');
  }

  for (const spec of HOURLY_INS) {
    const [file, window] = spec.split('::');
    if (!file || !window) { console.error(`bad --hourly: ${spec}`); process.exit(2); }
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const j = JSON.parse(fs.readFileSync(abs, 'utf8'));
    for (const [_sym, sd] of Object.entries<any>(j.symbols || {})) {
      for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
        const m = label.match(/^(HMA 3m \dx\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)\s+TP(\d+)\/SL(\d+)$/);
        if (!m) continue;
        const [, sigBase, money, tpStr, slStr] = m;
        const dashSignal = `${sigBase} ${window}`;
        const spread = `long ${money}`;
        const exit = `TP${tpStr}/SL${slStr}`;
        const key = `${dashSignal}|${spread}|${exit}`;
        const arr = Array(HOURS.length).fill(0);
        for (const t of (sig.trades || [])) {
          const idx = HOURS.indexOf(etHour(t.entryTs));
          if (idx >= 0) arr[idx] += t.pnl;
        }
        series[key] = arr.map(v => +v.toFixed(2));
      }
    }
  }

  const hourlyOut = path.join(OUT_DIR, `etf-long-hourly-${TICKER}.json`);
  fs.writeFileSync(hourlyOut, JSON.stringify({ hours: HOURS, series }, null, 2));
  console.log(`✓ wrote ${hourlyOut} — ${Object.keys(series).length} series`);
}

// Dashboard auto-discovers via /api/etf-profiles glob.
console.log(`\n→ Visible at: Studio Backtest page, profile "${TICKER.toUpperCase()}" (or via ?profile=-${TICKER})`);
