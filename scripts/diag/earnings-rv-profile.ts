/**
 * earnings-rv-profile.ts — STAGE 1 (price-only prototype)
 *
 * Premise under test (Karl Domm, "I Studied 687 Option Strategies"):
 *   the survivors are direction-free, LONG-VEGA structures — buy premium at a
 *   discount, profit from vol expansion, exit before the post-earnings crush.
 *
 * Two pre-earnings structures were proposed:
 *   - ATM straddle   = long vega / long gamma / short theta  (wants vol UP)
 *   - ATM debit fly  = net SHORT vega / long theta           (pin trade, wants vol DOWN)
 *
 * Those are OPPOSITE vega bets. At T-14 the straddle has the right sign but is
 * late/crowded; the fly has the wrong sign entirely for a pre-earnings hold.
 * The only defensible long-vega window is earlier: buy ~30-45 DTE at the vol
 * baseline, sell the ramp at T-5..T-3, never eat the crush.
 *
 * WHAT THIS STAGE TESTS (falsifiable, price-only):
 *   Without option chains we cannot know IV/theta/fills. So we test the one
 *   thing daily prices reveal: does REALIZED vol actually expand in the
 *   pre-earnings window, and by how much vs the pre-ramp baseline? That is the
 *   gamma/realized-vol leg the straddle needs. The IV-ramp (vega) leg is
 *   deferred to Stage 2 (real chains + friction).
 *
 *   Core signal = RV-ramp-delta = windowRV − baselineRV
 *     > 0  → vol expanding pre-earnings → supports long straddle (gamma + reason for IV to ramp)
 *     < 0  → vol compressing           → supports the fly / pin thesis
 *
 * GO / NO-GO to Stage 2:
 *   GREEN for a window if mean ramp-delta > +1pp annualized AND %events with
 *   ramp>0 exceeds 55%, consistently. Then pull option IV/chains to test
 *   vega-vs-theta under realistic 2-leg friction. Otherwise RED — the gamma leg
 *   is already dead and only a crowded pure-IV markup could save it.
 *
 * DATA (configured Polygon key is options-only; ThetaData account cancelled per
 * ecosystem.config.js — so equity/earnings come from free sources):
 *   - daily OHLCV: Yahoo chart API (free, no key, period1/period2 long history)
 *   - earnings dates: API Ninjas /v1/earningscalendar (real announcement dates
 *     back to ~2009). ⚠ timing (AMC/BMO) is premium-only → we default AMC;
 *     timing only affects the secondary jump calc, NOT the ramp signal.
 *
 * Honest simplifications (printed at end):
 *   - close-to-close RV (overnight gaps ignored); min 5 returns/window
 *   - AMC/BMO timing unknown (premium API Ninjas) → jump calc defaults AMC
 *   - no IV, no theta, no fills, no $ P&L — realized-vol profile only
 *   - survivorship: universe is hand-picked liquid names
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

const NINJAS = process.env.API_NINJAS_KEY || '';
if (!NINJAS) {
  console.error('API_NINJAS_KEY not set (export API_NINJAS_KEY=...)');
  process.exit(1);
}

// ---------- CLI ----------
const args = process.argv.slice(2);
function flag(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const FROM = flag('from', '2023-01-01')!;
const TO = flag('to', '2025-12-31')!;
const CONC = parseInt(flag('conc', '6')!, 10);
const OUT = flag('out', 'output/earnings-rv-profile-trades.csv')!;
const DETAIL_TICKERS = (flag('detail', 'NVDA,META,AMD,TSLA,AMZN,AAPL')!)
  .split(',').map((s) => s.trim().toUpperCase());

const DEFAULT_UNIVERSE = [
  // high-IV / big-mover mega caps
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'NFLX', 'AMD', 'AVGO',
  'CRM', 'ORCL', 'ADBE', 'INTC', 'QCOM', 'MU', 'JPM', 'BAC', 'GS', 'WMT',
  'COST', 'HD', 'DIS', 'NKE', 'BA', 'CAT', 'XOM', 'CVX', 'PFE', 'JNJ',
  'UNH', 'V', 'MA', 'PYPL', 'UBER', 'COIN', 'SMCI', 'MRVL', 'C', 'WFC',
  // calmer, lower-IV large/mid caps (where IV-crush should dominate)
  'KO', 'PEP', 'MCD', 'PG', 'T', 'VZ', 'CISCO', 'IBM', 'TXN', 'HON',
  'LOW', 'TGT', 'SBUX', 'GILD', 'MDLZ', 'CL', 'SO', 'DUK', 'USB', 'MMM',
].map((t) => (t === 'CISCO' ? 'CSCO' : t));
const UNIVERSE = (flag('tickers') ? flag('tickers')!.split(',') : DEFAULT_UNIVERSE).map((s) => s.trim().toUpperCase());

// trading-day offsets BEFORE the announcement day (di). entry at di-E, exit at di-X.
const ENTRY_OFFSETS = [45, 30, 21, 14];
const EXIT_OFFSETS = [5, 3, 1];
const BASELINE_FROM = 75; // baseline window = [di-75, di-46] (kept clear of the ramp zone)
const BASELINE_TO = 46;
const MIN_RETURNS = 5;
const SNAP_MAX = 6; // earnings date → nearest trading day (real dates, so tight)

// ---------- fetch helpers ----------
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const cur = idx++; out[cur] = await fn(items[cur], cur); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- date helpers ----------
function addDays(yyyymmdd: string, n: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
function toEpochSec(yyyymmdd: string): number {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}
// Yahoo daily timestamps land at market open; label by ET calendar date.
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' });
function etDate(ms: number): string {
  const p = etFmt.formatToParts(ms).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

type EarnEvent = { ticker: string; date: string };
type DailyBar = { date: string; o: number; h: number; l: number; c: number; v: number };

// ---------- API Ninjas: real earnings announcement dates ----------
// Free tier returns dates but NOT timing (premium). Results come newest-first;
// paginate offset until we pass FROM. ~50/page.
async function getEarnings(ticker: string): Promise<EarnEvent[]> {
  const out: EarnEvent[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const url = `https://api.api-ninjas.com/v1/earningscalendar?ticker=${encodeURIComponent(ticker)}&offset=${offset}`;
    let j: any[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(url, { headers: { 'X-Api-Key': NINJAS } });
        if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
        if (!r.ok) { if (attempt === 2) return out; await sleep(500 * (attempt + 1)); continue; }
        j = await r.json();
        break;
      } catch { await sleep(500 * (attempt + 1)); }
    }
    if (!j || j.length === 0) break;
    for (const e of j) {
      if (e.date && e.date >= FROM && e.date <= TO) out.push({ ticker, date: e.date });
    }
    if (j.length < 50) break; // last page
    // if oldest on this page is already before FROM, stop
    if (j[j.length - 1].date < FROM) break;
  }
  // dedupe by date (API can return duplicates across pages)
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.date) ? false : (seen.add(e.date), true))).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Yahoo: multi-year daily bars (free, no key) ----------
async function getDaily(ticker: string): Promise<DailyBar[]> {
  const p1 = toEpochSec(addDays(FROM, -150));
  const p2 = toEpochSec(addDays(TO, 1));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) { if (attempt === 2) return []; await sleep(500 * (attempt + 1)); continue; }
      const j = await r.json();
      const res = j?.chart?.result?.[0];
      if (!res) return [];
      const ts: number[] = res.timestamp || [];
      const q = res.indicators?.quote?.[0] || {};
      const out: DailyBar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close?.[i];
        if (c == null) continue;
        out.push({ date: etDate(ts[i] * 1000), o: q.open?.[i] ?? c, h: q.high?.[i] ?? c, l: q.low?.[i] ?? c, c, v: q.volume?.[i] ?? 0 });
      }
      return out;
    } catch { await sleep(500 * (attempt + 1)); }
  }
  return [];
}

// close-to-close annualized RV over bars[i0..i1] inclusive (needs >= MIN_RETURNS log-returns)
function rvClose(bars: DailyBar[], i0: number, i1: number): { rv: number; sumSq: number; n: number } | null {
  if (i0 < 0 || i1 >= bars.length || i1 - i0 < MIN_RETURNS) return null;
  const rets: number[] = [];
  for (let i = i0 + 1; i <= i1; i++) rets.push(Math.log(bars[i].c / bars[i - 1].c));
  const n = rets.length;
  if (n < MIN_RETURNS) return null;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1);
  const sumSq = rets.reduce((a, b) => a + b * b, 0);
  return { rv: Math.sqrt(varc) * Math.sqrt(252), sumSq, n };
}

function nearestTradingIdx(tradingDays: string[], target: string): { idx: number; off: number } {
  let best = 0, bd = Infinity;
  for (let i = 0; i < tradingDays.length; i++) {
    const d = Math.abs(daysBetween(target, tradingDays[i]));
    if (d < bd) { bd = d; best = i; }
  }
  return { idx: best, off: bd };
}

type Row = {
  ticker: string; earnDate: string; approxOff: number;
  baselineRV: number; avgVol30: number; jump: number;
  entryOff: number; exitOff: number;
  windowRV: number; rampDelta: number; realVar: number; nDays: number;
};
type Skip = { skip: string };

async function processEvent(ev: EarnEvent, daily: DailyBar[]): Promise<{ rows: Row[] } | Skip> {
  const tradingDays = daily.map((b) => b.date);
  if (tradingDays.length === 0) return { skip: 'no daily bars' };
  const { idx: di, off: approxOff } = nearestTradingIdx(tradingDays, ev.date);
  if (approxOff > SNAP_MAX) return { skip: `earnings date not a trading day (±${approxOff}d)` };

  const base = rvClose(daily, di - BASELINE_FROM, di - BASELINE_TO);
  if (!base) return { skip: 'insufficient baseline history' };

  const prior30 = daily.filter((_, i) => i < di).slice(-30);
  if (prior30.length < 20) return { skip: 'insufficient vol history' };
  const avgVol30 = prior30.reduce((a, b) => a + b.v, 0) / prior30.length;

  // jump: timing unknown (premium) → default AMC = |close(D) → close(D+1)| / close(D)
  let jump = NaN;
  if (di + 1 < daily.length) jump = Math.abs(Math.log(daily[di + 1].c / daily[di].c));

  const rows: Row[] = [];
  for (const E of ENTRY_OFFSETS) {
    for (const X of EXIT_OFFSETS) {
      if (X >= E) continue;
      const w = rvClose(daily, di - E, di - X);
      if (!w) continue;
      rows.push({
        ticker: ev.ticker, earnDate: daily[di].date, approxOff,
        baselineRV: base.rv, avgVol30, jump: Number.isNaN(jump) ? NaN : jump,
        entryOff: E, exitOff: X,
        windowRV: w.rv, rampDelta: w.rv - base.rv, realVar: w.sumSq, nDays: w.n,
      });
    }
  }
  return rows.length ? { rows } : { skip: 'no valid windows' };
}

// ---------- aggregation ----------
function pct(x: number) { return (x * 100).toFixed(1) + '%'; }
function pp(x: number) { return (x * 100).toFixed(2); }

function summarize(rows: Row[], entryOff: number, exitOff: number) {
  const sub = rows.filter((r) => r.entryOff === entryOff && r.exitOff === exitOff);
  if (sub.length === 0) return null;
  const deltas = sub.map((r) => r.rampDelta);
  const n = deltas.length;
  const mean = deltas.reduce((a, b) => a + b, 0) / n;
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const pos = deltas.filter((d) => d > 0).length;
  const meanWinRV = sub.reduce((a, r) => a + r.windowRV, 0) / n;
  const meanBaseRV = sub.reduce((a, r) => a + r.baselineRV, 0) / n;
  const jsub = sub.filter((r) => !Number.isNaN(r.jump));
  const meanJump = jsub.length ? jsub.reduce((a, r) => a + r.jump, 0) / jsub.length : NaN;
  const green = mean > 0.01 && pos / n > 0.55;
  return { n, mean, median, posPct: pos / n, meanWinRV, meanBaseRV, meanJump, green };
}

async function main() {
  const fs = await import('fs');
  console.error(`Universe: ${UNIVERSE.length} tickers | ${FROM}..${TO} | conc=${CONC}`);
  console.error(`Entry offsets (trading days pre-earn): ${ENTRY_OFFSETS} | Exit offsets: ${EXIT_OFFSETS}`);
  console.error(`Baseline window: T-${BASELINE_FROM}..T-${BASELINE_TO} | earnings: API Ninjas (real dates)\n`);

  // 1) earnings per ticker (API Ninjas)
  const earnByTicker = await mapLimit(UNIVERSE, CONC, async (t) => ({ t, evs: await getEarnings(t) }));
  const allEvents = earnByTicker.flatMap((x) => x.evs);
  console.error(`Earnings events found: ${allEvents.length}`);

  // 2) daily bars per ticker (Yahoo)
  const dailyByTicker = new Map<string, DailyBar[]>();
  await mapLimit(UNIVERSE, CONC, async (t) => { dailyByTicker.set(t, await getDaily(t)); });
  const gotBars = [...dailyByTicker.values()].filter((d) => d.length > 0).length;
  console.error(`Tickers with daily bars: ${gotBars}/${UNIVERSE.length}`);

  // 3) process events
  const allRows: Row[] = [];
  let nSkips = 0;
  const skipReasons: Record<string, number> = {};
  for (const ev of allEvents) {
    const res = await processEvent(ev, dailyByTicker.get(ev.ticker)!);
    if ('skip' in res) { nSkips++; skipReasons[res.skip] = (skipReasons[res.skip] || 0) + 1; continue; }
    allRows.push(...res.rows);
  }
  console.error(`Rows: ${allRows.length} | skipped events: ${nSkips}`);
  console.error('Skip reasons:', skipReasons);

  // ---- window summary table ----
  console.log('\n================ PRE-EARNINGS RV-RAMP PROFILE (price-only) ================');
  console.log('rampDelta = windowRV − baselineRV   (+ = vol expanding → straddle-supportive, − = fly/pin)');
  console.log(`${'entry\\exit'.padStart(12)} |     n | meanΔ(pp) | medΔ(pp) | %expand | winRV% | baseRV% | earnJump% | verdict`);
  console.log('-'.repeat(100));
  for (const E of ENTRY_OFFSETS) {
    for (const X of EXIT_OFFSETS) {
      if (X >= E) continue;
      const s = summarize(allRows, E, X);
      if (!s) continue;
      console.log(
        `T-${String(E).padStart(2)}/T-${String(X).padEnd(2)}  | ${String(s.n).padStart(5)} | ${pp(s.mean).padStart(9)} | ${pp(s.median).padStart(8)} | ${pct(s.posPct).padStart(7)} | ${pp(s.meanWinRV).padStart(6)} | ${pp(s.meanBaseRV).padStart(7)} | ${pct(s.meanJump).padStart(9)} | ${s.green ? '🟢 GREEN' : '🔴 RED'}`
      );
    }
  }

  // ---- per-ticker breakdown at T-30→T-3 ----
  console.log(`\n---- per-ticker ramp-delta @ T-30→T-3 (sorted by meanΔ) ----`);
  console.log(`${'ticker'.padEnd(8)} |     n | meanΔ(pp) | medΔ(pp) | %expand | baseRV% | earnJump%`);
  const byTk: [string, NonNullable<ReturnType<typeof summarize>>][] = [];
  for (const t of UNIVERSE) {
    const s = summarize(allRows.filter((r) => r.ticker === t), 30, 3);
    if (s) byTk.push([t, s]);
  }
  byTk.sort((a, b) => b[1].mean - a[1].mean);
  for (const [t, s] of byTk) {
    console.log(
      `${t.padEnd(8)} | ${String(s.n).padStart(5)} | ${pp(s.mean).padStart(9)} | ${pp(s.median).padStart(8)} | ${pct(s.posPct).padStart(7)} | ${pp(s.meanBaseRV).padStart(7)} | ${pct(s.meanJump).padStart(9)}`
    );
  }

  // ---- detail tickers @ T-30→T-3 ----
  console.log(`\n---- detail tickers @ T-30→T-3 ----`);
  for (const t of DETAIL_TICKERS) {
    const s = summarize(allRows.filter((r) => r.ticker === t), 30, 3);
    if (!s) { console.log(`${t}: no rows`); continue; }
    console.log(`${t}: n=${s.n} meanΔ=${pp(s.mean)}pp medΔ=${pp(s.median)}pp %expand=${pct(s.posPct)} baseRV=${pp(s.meanBaseRV)}% earnJump=${pct(s.meanJump)} → ${s.green ? '🟢' : '🔴'}`);
  }

  // ---- CSV ----
  const dir = OUT.includes('/') ? OUT.slice(0, OUT.lastIndexOf('/')) : '.';
  fs.mkdirSync(dir, { recursive: true });
  const cols = ['ticker', 'earnDate', 'approxOff', 'baselineRV', 'avgVol30', 'jump', 'entryOff', 'exitOff', 'windowRV', 'rampDelta', 'realVar', 'nDays'];
  const lines = [cols.join(',')];
  for (const r of allRows) lines.push(cols.map((c) => (r as any)[c]).join(','));
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`\nCSV → ${OUT} (${allRows.length} rows)`);

  // ---- honesty block ----
  console.log('\n================ README / HONESTY ================');
  console.log('* PRICE-ONLY: no IV, no theta, no fills, no $ P&L. Realized-vol profile only.');
  console.log('* Earnings dates are REAL (API Ninjas). AMC/BMO timing is premium-only → jump');
  console.log('  calc defaults AMC; timing does NOT affect the ramp signal.');
  console.log('* rampDelta>0 = realized vol elevated pre-earnings — NECESSARY for a long');
  console.log('  straddle, NOT SUFFICIENT. Vega−theta−friction is Stage 2.');
  console.log(`* close-to-close RV (overnight gaps ignored); min ${MIN_RETURNS} returns/window.`);
  console.log('* Price source: Yahoo (free). Earnings: API Ninjas (free, dates only).');
  const eventsUsed = new Set(allRows.map((r) => `${r.ticker}:${r.earnDate}`)).size;
  console.log(`* events used: ${eventsUsed} (skipped ${nSkips}). Universe: ${UNIVERSE.length} names, ${gotBars} w/ bars.`);
  console.log('* VERDICT RULE: GREEN iff meanΔ>+1pp annualized AND >55% of events expand.');
  console.log('  GREEN → Stage 2 (option IV/chains via Polygon options-only key, realistic 2-leg friction).');
  console.log('  RED   → gamma leg dead pre-earnings; only crowded pure-IV markup could save it.');
}

main().catch((e) => { console.error(e); process.exit(1); });
