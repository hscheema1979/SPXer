/**
 * earnings-straddle-pnl.ts — STAGE 2 (real options P&L, the vega-vs-theta test)
 *
 * Stage 1 (earnings-rv-profile.ts) found realized vol COMPRESSES into earnings
 * (53/60 names negative ramp-delta, worst in the biggest movers). So the gamma
 * leg of a pre-earnings long straddle is dead. This stage settles the ONE
 * survivor question: does the IV markup (vega) beat theta + friction?
 *
 * TRADE: long ATM straddle (buy 1 ATM call + 1 ATM put), same post-earnings
 * monthly expiry, entered T-E and exited T-X (both BEFORE the print — we never
 * hold through earnings, never eat the crush). Defined risk = debit.
 *
 *   Windows: {T-30→T-3, T-30→T-1, T-14→T-3, T-14→T-1}
 *   T-30 = "buy at baseline" thesis; T-14 = the original user idea.
 *
 * P&L = (exitStraddle − entryStraddle)·100 − friction. Friction shown as a
 * SENSITIVITY across half-spreads {0, 0.10, 0.20, 0.35}/leg (straddle = 2 legs
 * entry + 2 exit = 4 crosses) so we can see whether any edge survives realistic
 * single-name fills (earnings-name spreads widen near the event).
 *
 * Decomposition reported per window: entry/exit IV (ΔIV = vega driver), the
 * underlying's % move over the hold (gamma driver), hold days, debit.
 *
 * GO/NO-GO: GREEN iff mean net P&L/straddle > $0 at slip=0.20 AND win-rate >52%.
 * Expected (per Stage 1 + the fairly-priced-earnings-IV prior): RED.
 *
 * DATA: Polygon (re-subscribed: stocks ✅ + options ✅; Benzinga ❌).
 *   - option chains/intraday 15m: Polygon
 *   - underlying daily (entry spot): Polygon /v2/aggs
 *   - earnings dates: API Ninjas (real; timing premium → irrelevant here)
 *   - IV: Black-Scholes inversion (./black-scholes)
 *
 * Honest simplifications (printed at end):
 *   - fills = 15m bar prices at 15:45 (not NBBO mid); close-to-close mark
 *   - ATM = nearest listed strike to entry spot (may be .5/1 pt off)
 *   - one expiry per event (post-earnings monthly); carry/financing ignored
 *   - AMC/BMO timing unknown → irrelevant (we exit pre-print)
 *   - n per name small (~12); trust cross-sectional means, not single tickers
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

const POLY = process.env.POLYGON_API_KEY!;
const NINJAS = process.env.API_NINJAS_KEY || '';
if (!POLY) { console.error('POLYGON_API_KEY not set'); process.exit(1); }
if (!NINJAS) { console.error('API_NINJAS_KEY not set'); process.exit(1); }

import { impliedVolFromCall, impliedVolFromPut } from './black-scholes';

// ---------- CLI ----------
const args = process.argv.slice(2);
function flag(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const FROM = flag('from', '2023-01-01')!;
const TO = flag('to', '2025-12-31')!;
const CONC = parseInt(flag('conc', '4')!, 10);
const RATE = parseFloat(flag('rate', '0.045')!);
const COMM = parseFloat(flag('commission', '0.65')!); // per contract
const OUT = flag('out', 'output/earnings-straddle-pnl.csv')!;
const SLIPS = [0, 0.1, 0.2, 0.35]; // half-spread $/leg sensitivity
const WINDOWS = [
  { E: 30, X: 3 }, { E: 30, X: 1 }, { E: 14, X: 3 }, { E: 14, X: 1 },
];

// biggest movers from Stage 1 (highest earnJump / most negative ramp) + chips/MAG7
const DEFAULT_UNIVERSE = ['SMCI', 'MRVL', 'META', 'AVGO', 'MU', 'NVDA', 'ARM', 'COHR', 'NFLX', 'AMD'];
const UNIVERSE = (flag('tickers') ? flag('tickers')!.split(',') : DEFAULT_UNIVERSE).map((s) => s.trim().toUpperCase());

// ---------- fetch with retry / 429 backoff ----------
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function fetchJson(url: string, tries = 5): Promise<any> {
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}apiKey=${POLY}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(full);
      if (r.status === 429) { await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) { if (i === tries - 1) return null; await sleep(400 * (i + 1)); continue; }
      return await r.json();
    } catch { await sleep(400 * (i + 1)); }
  }
  return null;
}
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() { while (idx < items.length) { const cur = idx++; out[cur] = await fn(items[cur], cur); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- ET time helpers ----------
const etFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function etParts(ms: number): { date: string; hh: number; mm: number } {
  const p = etFmt.formatToParts(ms).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  let hh = parseInt(p.hour, 10); if (hh === 24) hh = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, hh, mm: parseInt(p.minute, 10) };
}
const etDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function etDate(ms: number): string {
  const p = etDayFmt.formatToParts(ms).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// ---------- date helpers ----------
function addDays(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number); const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}
function isThirdFriday(s: string): boolean { const [y, m, d] = s.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCDay() === 5 && d >= 15 && d <= 21; }

// ---------- earnings (API Ninjas, real dates) ----------
type EarnEvent = { ticker: string; date: string };
async function getEarnings(ticker: string): Promise<EarnEvent[]> {
  const out: EarnEvent[] = [];
  for (let offset = 0; offset < 200; offset += 50) {
    const r = await fetch(`https://api.api-ninjas.com/v1/earningscalendar?ticker=${encodeURIComponent(ticker)}&offset=${offset}`, { headers: { 'X-Api-Key': NINJAS } });
    if (!r.ok) { await sleep(500); continue; }
    const j: any[] = await r.json();
    if (!j.length) break;
    for (const e of j) if (e.date && e.date >= FROM && e.date <= TO) out.push({ ticker, date: e.date });
    if (j.length < 50) break;
    if (j[j.length - 1].date < FROM) break;
  }
  const seen = new Set<string>();
  return out.filter((e) => (seen.has(e.date) ? false : (seen.add(e.date), true))).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- underlying daily (Polygon) ----------
type DailyBar = { date: string; c: number };
async function getDaily(ticker: string): Promise<DailyBar[]> {
  const j = await fetchJson(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${addDays(FROM, -30)}/${TO}?adjusted=true&sort=asc&limit=5000`);
  if (!j?.results) return [];
  return j.results.map((b: any) => ({ date: etDate(b.t), c: b.c }));
}

// ---------- options plumbing (from earnings-vol-sell-study) ----------
function optTicker(root: string, expYYYYMMDD: string, cp: 'C' | 'P', strike: number): string {
  const [y, m, d] = expYYYYMMDD.split('-'); const yy = y.slice(2);
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return `O:${root}${yy}${m}${d}${cp}${strikeStr}`;
}
async function getChain(ticker: string, expFrom: string, expTo: string): Promise<Map<string, number[]>> {
  const byExp = new Map<string, Set<number>>();
  let url: string | null = `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}&expiration_date.gte=${expFrom}&expiration_date.lte=${expTo}&expired=true&limit=1000`;
  for (let page = 0; page < 6 && url; page++) {
    const j = await fetchJson(url); if (!j?.results) break;
    for (const c of j.results) { if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, new Set()); byExp.get(c.expiration_date)!.add(c.strike_price); }
    url = j.next_url || null;
  }
  const out = new Map<string, number[]>();
  for (const [k, s] of byExp) out.set(k, [...s].sort((a, b) => a - b));
  return out;
}
function nearest(arr: number[], x: number): number { let best = arr[0], bd = Infinity; for (const v of arr) { const d = Math.abs(v - x); if (d < bd) { bd = d; best = v; } } return best; }

// price of an option at 15:45 ET on a given day, from 15m bars (fallback to last bar <=15:45)
async function opt1545(opt: string, day: string): Promise<number | null> {
  const j = await fetchJson(`https://api.polygon.io/v2/aggs/ticker/${opt}/range/15/minute/${day}/${day}?adjusted=true&sort=asc&limit=50000`);
  const bars = (j?.results || []).map((b: any) => ({ ...etParts(b.t), o: b.o, c: b.c })).filter((b: any) => b.date === day);
  if (!bars.length) return null;
  const exact = bars.find((b: any) => b.hh === 15 && b.mm === 45);
  if (exact) return exact.o;
  const before = bars.filter((b: any) => b.hh * 60 + b.mm <= 15 * 60 + 45);
  return before.length ? before[before.length - 1].c : bars[0].c;
}

type Trade = {
  ticker: string; earnDate: string; E: number; X: number; entryDay: string; exitDay: string;
  exp: string; dteEntry: number; holdDays: number; strike: number; spotEntry: number; spotExit: number;
  callEntry: number; putEntry: number; callExit: number; putExit: number;
  debit: number; exitVal: number; grossPnl: number; // $ per straddle (×100)
  ivEntry: number | null; ivExit: number | null; dIV: number | null;
  underMove: number; // signed % spotEntry→spotExit
};
type Skip = { skip: string };

async function processEvent(ev: EarnEvent, daily: DailyBar[]): Promise<{ trades: Trade[] } | Skip> {
  const days = daily.map((b) => b.date);
  if (!days.length) return { skip: 'no daily' };
  // snap earnings date to nearest trading day (real dates; tight)
  let di = 0, bd = Infinity;
  for (let i = 0; i < days.length; i++) { const d = Math.abs(daysBetween(ev.date, days[i])); if (d < bd) { bd = d; di = i; } }
  if (bd > 6) return { skip: 'earnings date not a trading day' };

  // post-earnings monthly expiry: first third-Friday strictly after earnings
  const expTo = addDays(days[di], 40);
  const chain = await getChain(ev.ticker, days[di], expTo);
  if (!chain.size) return { skip: 'no chain' };
  const exps = [...chain.keys()].filter((e) => e > days[di]).sort();
  if (!exps.length) return { skip: 'no expiry after earnings' };
  const monthlies = exps.filter(isThirdFriday);
  const exp = (monthlies.length ? monthlies : exps)[0];
  const strikes = chain.get(exp)!;

  const trades: Trade[] = [];
  for (const { E, X } of WINDOWS) {
    const ei = di - E, xi = di - X;
    if (ei < 0 || xi >= days.length || ei >= xi) continue;
    const entryDay = days[ei], exitDay = days[xi];
    const spotEntry = daily[ei].c, spotExit = daily[xi].c;
    const strike = nearest(strikes, spotEntry);

    // 15:45 prices: call/put × entry/exit
    const [callEntry, putEntry, callExit, putExit] = await Promise.all([
      opt1545(optTicker(ev.ticker, exp, 'C', strike), entryDay),
      opt1545(optTicker(ev.ticker, exp, 'P', strike), entryDay),
      opt1545(optTicker(ev.ticker, exp, 'C', strike), exitDay),
      opt1545(optTicker(ev.ticker, exp, 'P', strike), exitDay),
    ]);
    if (callEntry == null || putEntry == null || callExit == null || putExit == null) continue;
    if (callEntry <= 0 || putEntry <= 0) continue;

    const debit = callEntry + putEntry;
    const exitVal = callExit + putExit;
    const grossPnl = (exitVal - debit) * 100; // per straddle (100 mult)

    // IV (avg call/put) at entry & exit via BS
    const dteEntry = daysBetween(entryDay, exp);
    const Te = Math.max(dteEntry, 1) / 365;
    const Tx = Math.max(daysBetween(exitDay, exp), 1) / 365;
    const ivCe = impliedVolFromCall(callEntry, spotEntry, strike, Te, RATE);
    const ivPe = impliedVolFromPut(putEntry, spotEntry, strike, Te, RATE);
    const ivCx = impliedVolFromCall(callExit, spotExit, strike, Tx, RATE);
    const ivPx = impliedVolFromPut(putExit, spotExit, strike, Tx, RATE);
    const ivEntry = ivCe != null && ivPe != null ? (ivCe + ivPe) / 2 : null;
    const ivExit = ivCx != null && ivPx != null ? (ivCx + ivPx) / 2 : null;

    trades.push({
      ticker: ev.ticker, earnDate: days[di], E, X, entryDay, exitDay, exp,
      dteEntry, holdDays: daysBetween(entryDay, exitDay), strike, spotEntry, spotExit,
      callEntry, putEntry, callExit, putExit, debit, exitVal, grossPnl,
      ivEntry, ivExit, dIV: ivEntry != null && ivExit != null ? ivExit - ivEntry : null,
      underMove: (spotExit - spotEntry) / spotEntry,
    });
  }
  return trades.length ? { trades } : { skip: 'no valid windows/prices' };
}

// ---------- aggregation ----------
function stats(arr: number[]) {
  if (!arr.length) return null;
  const n = arr.length; const mean = arr.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const sorted = [...arr].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const win = arr.filter((x) => x > 0).length / n;
  const tot = arr.reduce((a, b) => a + b, 0);
  const p05 = sorted[Math.floor(0.05 * n)];
  return { n, mean, median, sd, win, tot, p05, worst: sorted[0] };
}
const d2 = (x: number) => x.toFixed(2);
const pct = (x: number) => (x * 100).toFixed(1) + '%';

function summarize(trades: Trade[], E: number, X: number, slip: number) {
  const sub = trades.filter((t) => t.E === E && t.X === X);
  if (!sub.length) return null;
  // net P&L per straddle at this slip: gross − (commission×4) − (slip×4 legs ×100)
  const net = sub.map((t) => t.grossPnl - COMM * 4 - slip * 4 * 100);
  const s = stats(net);
  if (!s) return null;
  const ivChg = sub.filter((t) => t.dIV != null).map((t) => t.dIV!);
  const ivMean = ivChg.length ? ivChg.reduce((a, b) => a + b, 0) / ivChg.length : NaN;
  const moveAbs = sub.map((t) => Math.abs(t.underMove));
  const moveMean = moveAbs.reduce((a, b) => a + b, 0) / moveAbs.length;
  const debitMean = sub.reduce((a, t) => a + t.debit, 0) / sub.length;
  const green = s.mean > 0 && s.win > 0.52;
  return { n: s.n, meanNet: s.mean, medianNet: s.median, win: s.win, tot: s.tot, p05: s.p05, worst: s.worst, ivMean, moveMean, debitMean, green };
}

async function main() {
  const fs = await import('fs');
  console.error(`Universe: ${UNIVERSE.join(',')} | ${FROM}..${TO} | conc=${CONC} | comm=$${COMM}/contract`);
  console.error(`Windows: ${WINDOWS.map((w) => `T-${w.E}/T-${w.X}`).join(', ')} | slips ${SLIPS}\n`);

  const earnByTk = await mapLimit(UNIVERSE, CONC, async (t) => ({ t, evs: await getEarnings(t) }));
  const allEvents = earnByTk.flatMap((x) => x.evs);
  console.error(`Earnings events: ${allEvents.length}`);
  const dailyByTk = new Map<string, DailyBar[]>();
  await mapLimit(UNIVERSE, CONC, async (t) => { dailyByTk.set(t, await getDaily(t)); });

  const all: Trade[] = [];
  let skips = 0; const reasons: Record<string, number> = {};
  for (const ev of allEvents) {
    const r = await processEvent(ev, dailyByTk.get(ev.ticker)!);
    if ('skip' in r) { skips++; reasons[r.skip] = (reasons[r.skip] || 0) + 1; continue; }
    all.push(...r.trades);
  }
  console.error(`Trades: ${all.length} | skipped events: ${skips}`, reasons, '\n');

  // ---- summary per window × slip ----
  console.log('================ LONG ATM STRADDLE — pre-earnings ($/straddle, after friction) ================');
  console.log('Entered T-E, exited T-X (BEFORE the print). Tests vega(markup) vs theta over the hold.\n');
  for (const { E, X } of WINDOWS) {
    console.log(`--- window T-${E} → T-${X} ---`);
    console.log(`${'slip/leg'.padStart(9)} |     n | mean$ | median$ | win% |  tot$ |   p05$ |  worst$ | meanΔIV(pp) | |move|% | debit$ | verdict`);
    for (const slip of SLIPS) {
      const s = summarize(all, E, X, slip);
      if (!s) { console.log(`  $${slip.toFixed(2).padStart(6)} | no trades`); continue; }
      console.log(
        `  $${slip.toFixed(2).padStart(6)} | ${String(s.n).padStart(5)} | ${d2(s.meanNet).padStart(6)} | ${d2(s.medianNet).padStart(7)} | ${pct(s.win).padStart(4)} | ${d2(s.tot).padStart(6)} | ${d2(s.p05).padStart(6)} | ${d2(s.worst).padStart(7)} | ${(isFinite(s.ivMean) ? (s.ivMean * 100).toFixed(2) : 'n/a').padStart(11)} | ${pct(s.moveMean).padStart(6)} | ${d2(s.debitMean).padStart(6)} | ${s.green ? '🟢' : '🔴'}`
      );
    }
    console.log();
  }

  // ---- per-ticker at the thesis window T-30→T-3, slip=0.20 ----
  console.log('---- per-ticker @ T-30→T-3, slip=$0.20/leg ----');
  console.log(`${'ticker'.padEnd(7)} |     n | mean$ | median$ | win% | meanΔIV(pp) | |move|%`);
  const byTk: [string, NonNullable<ReturnType<typeof summarize>>][] = [];
  for (const t of UNIVERSE) { const s = summarize(all.filter((x) => x.ticker === t), 30, 3, 0.2); if (s) byTk.push([t, s]); }
  byTk.sort((a, b) => b[1].meanNet - a[1].meanNet);
  for (const [t, s] of byTk) console.log(`${t.padEnd(7)} | ${String(s.n).padStart(5)} | ${d2(s.meanNet).padStart(6)} | ${d2(s.medianNet).padStart(7)} | ${pct(s.win).padStart(4)} | ${(isFinite(s.ivMean) ? (s.ivMean * 100).toFixed(2) : 'n/a').padStart(11)} | ${pct(s.moveMean).padStart(6)}`);

  // ---- CSV ----
  const dir = OUT.includes('/') ? OUT.slice(0, OUT.lastIndexOf('/')) : '.';
  fs.mkdirSync(dir, { recursive: true });
  const cols = ['ticker', 'earnDate', 'E', 'X', 'entryDay', 'exitDay', 'exp', 'dteEntry', 'holdDays', 'strike', 'spotEntry', 'spotExit', 'debit', 'exitVal', 'grossPnl', 'ivEntry', 'ivExit', 'dIV', 'underMove'];
  const lines = [cols.join(',')];
  for (const t of all) lines.push(cols.map((c) => (t as any)[c]).join(','));
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`\nCSV → ${OUT} (${all.length} trades)`);

  // ---- honesty ----
  console.log('\n================ README / HONESTY ================');
  console.log('* REAL options P&L (Polygon 15m bars). Long ATM straddle, exit BEFORE earnings (no crush).');
  console.log('* Friction = commission×4 + half-spread×4-legs×100, shown as a slip sensitivity.');
  console.log('* meanΔIV>0 = IV rose over the hold (vega tailwind); |move|% = how much the underlying moved (gamma).');
  console.log('* VERDIFT RULE: GREEN iff mean$>0 at slip=$0.20 AND win>52%.');
  console.log('* fills = 15m bar @15:45 (not NBBO mid); ATM = nearest strike; one post-earnings monthly expiry.');
  console.log(`* n per name ~12 (3yr×4q). Trust cross-sectional means, not single tickers. trades=${all.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
