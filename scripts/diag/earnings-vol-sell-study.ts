/**
 * earnings-vol-sell-study.ts
 *
 * Tests the "sell earnings volatility on filtered setups" strategy described by
 * the Volatility Vibes YouTube video ("$10k -> $1M"), whose codified edge is a
 * 3-factor screen:
 *   1. term-structure slope (front -> ~45d ATM IV) sufficiently NEGATIVE  (<= -0.00406)
 *   2. IV30 / RV30 ratio high enough (IV overpriced vs realized)          (>= 1.25)
 *   3. 30-day average share volume above a liquidity floor                (>= 1.5M)
 * Recommended = all 3 pass (the only setups he trades). Avoid = slope fails.
 *
 * Trade modelled = the STRADDLE "jump": sell the ATM straddle on the front
 * expiry that brackets earnings, entered 15 min before the close of the day
 * PRIOR to an after-close (AMC) report, closed 15 min into the next session.
 * (Holding to next-day close — the "move" variant — is a documented loser due
 * to post-earnings drift, per the video; we model the jump only.)
 *
 * Core falsifiable claim being tested:
 *   - blind (all events) mean return ~ 0  (market prices earnings fairly)
 *   - Recommended-only mean return clearly > 0  (the filter adds the edge)
 *
 * Data: Polygon. Earnings dates+timing from Benzinga (/benzinga/v1/earnings),
 * per-contract intraday (15m) and daily aggregates, expired chains via
 * /v3/reference/options/contracts?expired=true. IV from Black-Scholes inversion.
 *
 * Honest simplifications (see README block printed at end):
 *   - fills = 15m trade-bar prices (not NBBO mid); friction approximated
 *   - RV30 = close-to-close (not Yang-Zhang); IV30 = 2-point term interpolation
 *   - flat r, no dividends; universe is hand-picked liquid names (survivorship)
 */

import {
  impliedVolFromCall,
  impliedVolFromPut,
} from './black-scholes';

const POLY = process.env.POLYGON_API_KEY!;
if (!POLY) {
  console.error('POLYGON_API_KEY not set');
  process.exit(1);
}

// ---------- CLI ----------
const args = process.argv.slice(2);
function flag(name: string, def?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
}
const FROM = flag('from', '2022-01-01')!;
const TO = flag('to', '2025-12-31')!;
const CONC = parseInt(flag('conc', '8')!, 10);
const SLIP_FRAC = parseFloat(flag('slip', '0.01')!); // half-spread cross, per side, as frac of straddle px
const COMMISSION_PER_CONTRACT = parseFloat(flag('commission', '0.65')!);
const RATE = parseFloat(flag('rate', '0.045')!);

// Filter thresholds (from the repo that codifies the video: Acelogic/Earnings-Volatility-Calculator)
const TH_SLOPE = parseFloat(flag('slope', '-0.00406')!);
const TH_IVRV = parseFloat(flag('ivrv', '1.25')!);
const TH_VOL = parseFloat(flag('vol', '1500000')!);

const DEFAULT_UNIVERSE = [
  // high-IV / big-mover mega caps
  'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'TSLA', 'NFLX', 'AMD', 'AVGO',
  'CRM', 'ORCL', 'ADBE', 'INTC', 'QCOM', 'MU', 'JPM', 'BAC', 'GS', 'WMT',
  'COST', 'HD', 'DIS', 'NKE', 'BA', 'CAT', 'XOM', 'CVX', 'PFE', 'JNJ',
  'UNH', 'V', 'MA', 'PYPL', 'UBER', 'COIN', 'SMCI', 'MRVL', 'C', 'WFC',
  // calmer, lower-IV large/mid caps (where IV-crush should dominate — fairer to the claim)
  'KO', 'PEP', 'MCD', 'PG', 'T', 'VZ', 'CSCO', 'IBM', 'TXN', 'HON',
  'LOW', 'TGT', 'SBUX', 'GILD', 'MDLZ', 'CL', 'SO', 'DUK', 'USB', 'MMM',
];
const UNIVERSE = (flag('tickers') ? flag('tickers')!.split(',') : DEFAULT_UNIVERSE).map((s) => s.trim().toUpperCase());

// ---------- fetch with retry / 429 backoff ----------
async function fetchJson(url: string, tries = 5): Promise<any> {
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}apiKey=${POLY}`;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(full);
      if (r.status === 429) {
        await sleep(1500 * (i + 1));
        continue;
      }
      if (!r.ok) {
        if (i === tries - 1) return null;
        await sleep(400 * (i + 1));
        continue;
      }
      return await r.json();
    } catch {
      await sleep(400 * (i + 1));
    }
  }
  return null;
}
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// concurrency mapper
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      out[cur] = await fn(items[cur], cur);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- ET time helpers (extraction only) ----------
const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function etParts(ms: number): { date: string; hh: number; mm: number } {
  const p = etFmt.formatToParts(ms).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  let hh = parseInt(p.hour, 10);
  if (hh === 24) hh = 0;
  return { date: `${p.year}-${p.month}-${p.day}`, hh, mm: parseInt(p.minute, 10) };
}

// ---------- option ticker formatting ----------
function optTicker(root: string, expYYYYMMDD: string, cp: 'C' | 'P', strike: number): string {
  const [y, m, d] = expYYYYMMDD.split('-');
  const yy = y.slice(2);
  const strikeInt = Math.round(strike * 1000);
  const strikeStr = String(strikeInt).padStart(8, '0');
  return `O:${root}${yy}${m}${d}${cp}${strikeStr}`;
}

type EarnEvent = { ticker: string; date: string; time: string };

async function getEarnings(ticker: string): Promise<EarnEvent[]> {
  const out: EarnEvent[] = [];
  let url: string | null =
    `https://api.polygon.io/benzinga/v1/earnings?ticker=${ticker}&date.gte=${FROM}&date.lte=${TO}&order=asc&sort=date&limit=100`;
  for (let page = 0; page < 4 && url; page++) {
    const j = await fetchJson(url);
    if (!j?.results) break;
    for (const r of j.results) {
      if (r.date_status === 'projected') continue; // only confirmed/reported, past events
      if (!r.time) continue;
      out.push({ ticker, date: r.date, time: r.time });
    }
    url = j.next_url || null;
  }
  return out;
}

type DailyBar = { date: string; o: number; h: number; l: number; c: number; v: number };
async function getDaily(ticker: string, from: string, to: string): Promise<DailyBar[]> {
  const j = await fetchJson(
    `https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000`
  );
  if (!j?.results) return [];
  return j.results.map((b: any) => ({ date: etParts(b.t).date, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
}

// list strikes available for an underlying within an expiration window (expired chains included)
async function getChain(ticker: string, expFrom: string, expTo: string): Promise<Map<string, number[]>> {
  // map expiration_date -> sorted strikes (union of call/put strikes)
  const byExp = new Map<string, Set<number>>();
  let url: string | null =
    `https://api.polygon.io/v3/reference/options/contracts?underlying_ticker=${ticker}` +
    `&expiration_date.gte=${expFrom}&expiration_date.lte=${expTo}&expired=true&limit=1000`;
  for (let page = 0; page < 4 && url; page++) {
    const j = await fetchJson(url);
    if (!j?.results) break;
    for (const c of j.results) {
      if (!byExp.has(c.expiration_date)) byExp.set(c.expiration_date, new Set());
      byExp.get(c.expiration_date)!.add(c.strike_price);
    }
    url = j.next_url || null;
  }
  const out = new Map<string, number[]>();
  for (const [k, s] of byExp) out.set(k, [...s].sort((a, b) => a - b));
  return out;
}

function candidateStrikes(arr: number[], x: number, n: number): number[] {
  return [...arr].sort((a, b) => Math.abs(a - x) - Math.abs(b - x)).slice(0, n);
}
function nearest(arr: number[], x: number): number {
  let best = arr[0];
  let bd = Infinity;
  for (const v of arr) {
    const d = Math.abs(v - x);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// price of an option at a target ET time on a given day, from 15m bars
async function optIntraday(opt: string, day: string): Promise<{ t1545: number | null; t0945: number | null }> {
  const j = await fetchJson(
    `https://api.polygon.io/v2/aggs/ticker/${opt}/range/15/minute/${day}/${day}?adjusted=true&sort=asc&limit=50000`
  );
  const bars = (j?.results || []).map((b: any) => ({ ...etParts(b.t), o: b.o, c: b.c })).filter((b: any) => b.date === day);
  if (bars.length === 0) return { t1545: null, t0945: null };
  // entry = price 15 min before close: 15:45 bar open, else latest bar <= 15:45
  let t1545: number | null = null;
  const exact1545 = bars.find((b: any) => b.hh === 15 && b.mm === 45);
  if (exact1545) t1545 = exact1545.o;
  else {
    const before = bars.filter((b: any) => b.hh * 60 + b.mm <= 15 * 60 + 45);
    if (before.length) t1545 = before[before.length - 1].c;
  }
  // exit = 15 min into session: 09:45 bar open, else 09:30 close, else first bar >= 09:45
  let t0945: number | null = null;
  const exact0945 = bars.find((b: any) => b.hh === 9 && b.mm === 45);
  if (exact0945) t0945 = exact0945.o;
  else {
    const b0930 = bars.find((b: any) => b.hh === 9 && b.mm === 30);
    if (b0930) t0945 = b0930.c;
    else {
      const after = bars.filter((b: any) => b.hh * 60 + b.mm >= 9 * 60 + 45);
      if (after.length) t0945 = after[0].o;
    }
  }
  return { t1545, t0945 };
}

function realizedVol30(bars: DailyBar[], beforeDate: string): number | null {
  const prior = bars.filter((b) => b.date < beforeDate).slice(-31);
  if (prior.length < 21) return null;
  const rets: number[] = [];
  for (let i = 1; i < prior.length; i++) rets.push(Math.log(prior[i].c / prior[i - 1].c));
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(varc) * Math.sqrt(252);
}
function avgVol30(bars: DailyBar[], beforeDate: string): number | null {
  const prior = bars.filter((b) => b.date < beforeDate).slice(-30);
  if (prior.length < 20) return null;
  return prior.reduce((a, b) => a + b.v, 0) / prior.length;
}

type Trade = {
  ticker: string; earnDate: string; amc: boolean; entryDay: string; exitDay: string;
  spot: number; strike: number; frontExp: string; backExp: string;
  dteFront: number; dteBack: number;
  ivFront: number; ivBack: number; iv30: number; rv30: number; ivrv: number;
  slope: number; avgVol: number;
  credit: number; exitVal: number; pnl$: number; retPct: number;
  calDebit: number | null; calRet: number | null; calPnl: number | null;
  volOk: boolean; ivrvOk: boolean; slopeOk: boolean;
  klass: 'Recommended' | 'Consider' | 'Avoid';
};

function classify(volOk: boolean, ivrvOk: boolean, slopeOk: boolean): Trade['klass'] {
  if (!slopeOk) return 'Avoid';
  if (volOk && ivrvOk) return 'Recommended';
  if (volOk || ivrvOk) return 'Consider';
  return 'Avoid'; // slope ok but both others fail
}

async function processEvent(ev: EarnEvent, daily: DailyBar[]): Promise<Trade | { skip: string }> {
  const hhmm = ev.time.slice(0, 5);
  const hour = parseInt(hhmm.slice(0, 2), 10);
  const amc = hour >= 16 || hour < 4; // after-close report (treat 16:00+ as AMC)
  const bmo = hour >= 4 && hour < 9.5;
  if (!amc && !bmo) {
    // intraday/unknown timing -> default treat as AMC (rare)
  }
  const tradingDays = daily.map((b) => b.date);
  const di = tradingDays.indexOf(ev.date);
  if (di < 0) return { skip: 'earnDate not a trading day in range' };

  let entryDay: string, exitDay: string;
  if (bmo) {
    if (di < 1) return { skip: 'no prior day' };
    entryDay = tradingDays[di - 1];
    exitDay = ev.date;
  } else {
    if (di + 1 >= tradingDays.length) return { skip: 'no next day' };
    entryDay = ev.date;
    exitDay = tradingDays[di + 1];
  }

  const entryBar = daily.find((b) => b.date === entryDay);
  if (!entryBar) return { skip: 'no entry bar' };
  const spot = entryBar.c;

  const rv30 = realizedVol30(daily, entryDay);
  const av30 = avgVol30(daily, entryDay);
  if (rv30 == null || av30 == null) return { skip: 'insufficient history for RV/vol' };

  // chains in [earnDate, earnDate+70d]
  const expTo = addDays(ev.date, 75);
  const chain = await getChain(ev.ticker, ev.date, expTo);
  if (chain.size === 0) return { skip: 'no chain' };
  // front = soonest expiry strictly after the announcement date
  const exps = [...chain.keys()].filter((e) => e > ev.date).sort();
  if (exps.length === 0) return { skip: 'no expiry after earnings' };
  const frontExp = exps[0];
  // back = expiry nearest entry+45d. Prefer 3rd-Friday MONTHLIES (always listed
  // & liquid ~45d out); far weeklies often aren't listed yet on entry day -> no data.
  const target45 = addDays(entryDay, 45);
  const afterFront = exps.filter((e) => e > frontExp);
  if (afterFront.length === 0) return { skip: 'no back expiry' };
  const monthlies = afterFront.filter(isThirdFriday);
  const pickFrom = monthlies.length ? monthlies : afterFront;
  let backExp = pickFrom[0];
  let bestd = Infinity;
  for (const e of pickFrom) {
    const d = Math.abs(daysBetween(e, target45));
    if (d < bestd) { bestd = d; backExp = e; }
  }

  const frontStrikes = chain.get(frontExp)!;
  const backStrikes = chain.get(backExp)!;

  const dteFront = daysBetween(entryDay, frontExp);
  const dteBack = daysBetween(entryDay, backExp);
  if (dteFront <= 0 || dteBack <= dteFront) return { skip: 'bad dte' };

  // front straddle: try the nearest strikes that have BOTH entry(15:45) and
  // exit(09:45) data for call+put (listed .5 strikes are often untraded).
  let kFront = 0, callEntry = 0, putEntry = 0, callExit = 0, putExit = 0;
  for (const k of candidateStrikes(frontStrikes, spot, 3)) {
    const fc = optTicker(ev.ticker, frontExp, 'C', k);
    const fp = optTicker(ev.ticker, frontExp, 'P', k);
    const [fcE, fpE, fcX, fpX] = await Promise.all([
      optIntraday(fc, entryDay), optIntraday(fp, entryDay),
      optIntraday(fc, exitDay), optIntraday(fp, exitDay),
    ]);
    if (fcE.t1545 && fpE.t1545 && fcX.t0945 && fpX.t0945) {
      kFront = k; callEntry = fcE.t1545; putEntry = fpE.t1545; callExit = fcX.t0945; putExit = fpX.t0945;
      break;
    }
  }
  if (!kFront) return { skip: 'missing front straddle px' };

  const credit = callEntry + putEntry;
  const exitVal = callExit + putExit;

  // back-month ATM for term-structure slope (same 15:45 entry instant as front)
  let kBack = 0, bcPx: number | null = null, bpPx: number | null = null;
  for (const k of candidateStrikes(backStrikes, spot, 3)) {
    const [bcI, bpI] = await Promise.all([
      optIntraday(optTicker(ev.ticker, backExp, 'C', k), entryDay),
      optIntraday(optTicker(ev.ticker, backExp, 'P', k), entryDay),
    ]);
    if (bcI.t1545 && bpI.t1545) { kBack = k; bcPx = bcI.t1545; bpPx = bpI.t1545; break; }
  }

  // IVs (avg of call & put ATM)
  const Tf = dteFront / 365;
  const Tb = dteBack / 365;
  const ivFc = impliedVolFromCall(callEntry, spot, kFront, Tf, RATE);
  const ivFp = impliedVolFromPut(putEntry, spot, kFront, Tf, RATE);
  if (ivFc == null || ivFp == null) return { skip: 'front IV inversion failed' };
  const ivFront = (ivFc + ivFp) / 2;

  let ivBack: number | null = null;
  if (bcPx && bpPx) {
    const ivBc = impliedVolFromCall(bcPx, spot, kBack, Tb, RATE);
    const ivBp = impliedVolFromPut(bpPx, spot, kBack, Tb, RATE);
    if (ivBc != null && ivBp != null) ivBack = (ivBc + ivBp) / 2;
  }
  if (ivBack == null) {
    if (process.env.DBG) console.error(`backfail ${ev.ticker} ${entryDay} bExp=${backExp} k=${kBack} bcPx=${bcPx} bpPx=${bpPx} dteB=${dteBack}`);
    return { skip: 'back IV inversion failed' };
  }

  // term-structure slope per day, IV in decimal
  const slope = (ivBack - ivFront) / (dteBack - dteFront);
  // IV30 = interpolate to 30 DTE between front & back
  const iv30 =
    dteFront === dteBack
      ? ivFront
      : ivFront + ((ivBack - ivFront) * (30 - dteFront)) / (dteBack - dteFront);
  const ivrv = iv30 / rv30;

  // short straddle P&L (1x each leg = 1 contract = 100 mult)
  const grossPnl = (credit - exitVal) * 100;
  const commission = COMMISSION_PER_CONTRACT * 4; // 2 legs open + 2 legs close
  const slip = SLIP_FRAC * (credit + exitVal) * 100; // cross half-spread entry+exit
  const pnl$ = grossPnl - commission - slip;
  const retPct = pnl$ / (credit * 100);

  const volOk = av30 >= TH_VOL;
  const ivrvOk = ivrv >= TH_IVRV;
  const slopeOk = slope <= TH_SLOPE;

  // ---- long CALL calendar (his preferred): sell front ATM call, buy back ATM
  // call, SAME strike (=kBack, the liquid back ATM). "jump" exit 09:45 next day.
  let calDebit: number | null = null, calRet: number | null = null, calPnl: number | null = null;
  {
    const fcK = optTicker(ev.ticker, frontExp, 'C', kBack);
    const bcK = optTicker(ev.ticker, backExp, 'C', kBack);
    const [fcKe, fcKx, bcKx] = await Promise.all([
      optIntraday(fcK, entryDay), optIntraday(fcK, exitDay), optIntraday(bcK, exitDay),
    ]);
    const frontCallEntry = fcKe.t1545, frontCallExit = fcKx.t0945, backCallExit = bcKx.t0945;
    const backCallEntry = bcPx; // back call @kBack @15:45 entry (already fetched)
    if (frontCallEntry && frontCallExit && backCallExit && backCallEntry) {
      const debit = backCallEntry - frontCallEntry;
      if (debit > 0.01) {
        const exitV = backCallExit - frontCallExit;
        const comm = COMMISSION_PER_CONTRACT * 4;
        const slip = SLIP_FRAC * (Math.abs(backCallEntry) + Math.abs(frontCallEntry) + Math.abs(backCallExit) + Math.abs(frontCallExit)) * 100 / 2;
        calDebit = debit;
        calPnl = (exitV - debit) * 100 - comm - slip;
        calRet = calPnl / (debit * 100);
      }
    }
  }

  return {
    ticker: ev.ticker, earnDate: ev.date, amc, entryDay, exitDay,
    spot, strike: kFront, frontExp, backExp, dteFront, dteBack,
    ivFront, ivBack, iv30, rv30, ivrv, slope, avgVol: av30,
    credit, exitVal, pnl$, retPct, calDebit, calRet, calPnl,
    volOk, ivrvOk, slopeOk, klass: classify(volOk, ivrvOk, slopeOk),
  };
}

function addDays(yyyymmdd: string, n: number): string {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function isThirdFriday(yyyymmdd: string): boolean {
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCDay() === 5 && d >= 15 && d <= 21;
}
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// ---------- stats ----------
function stats(rows: Trade[]) {
  if (rows.length === 0) return null;
  const rets = rows.map((r) => r.retPct);
  const n = rets.length;
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const sorted = [...rets].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const win = rets.filter((r) => r > 0).length / n;
  const totPnl = rows.reduce((a, b) => a + b.pnl$, 0);
  const avgPnl = totPnl / n;
  const p05 = sorted[Math.floor(0.05 * n)];
  const worst = sorted[0];
  return { n, mean, median, sd, win, avgPnl, totPnl, p05, worst };
}

function fmtPct(x: number) { return (x * 100).toFixed(2) + '%'; }
function row(label: string, s: ReturnType<typeof stats>) {
  if (!s) { console.log(`${label.padEnd(14)} | n=0`); return; }
  console.log(
    `${label.padEnd(14)} | n=${String(s.n).padStart(4)} | mean ${fmtPct(s.mean).padStart(8)} | median ${fmtPct(s.median).padStart(8)} | win ${fmtPct(s.win).padStart(7)} | sd ${fmtPct(s.sd).padStart(8)} | avg$ ${s.avgPnl.toFixed(0).padStart(6)} | p05 ${fmtPct(s.p05).padStart(8)} | worst ${fmtPct(s.worst).padStart(9)}`
  );
}

async function main() {
  console.error(`Universe: ${UNIVERSE.length} tickers | ${FROM}..${TO} | slip=${SLIP_FRAC} comm=${COMMISSION_PER_CONTRACT}`);
  console.error(`Filter: slope<=${TH_SLOPE} ivrv>=${TH_IVRV} vol>=${TH_VOL}`);

  // 1) earnings per ticker
  const earnByTicker = await mapLimit(UNIVERSE, CONC, async (t) => ({ t, evs: await getEarnings(t) }));
  const allEvents: EarnEvent[] = earnByTicker.flatMap((x) => x.evs);
  console.error(`Earnings events found: ${allEvents.length}`);

  // 2) daily bars per ticker (one pull each, covering full range + 60d lookback)
  const dailyMap = new Map<string, DailyBar[]>();
  await mapLimit(UNIVERSE, CONC, async (t) => {
    dailyMap.set(t, await getDaily(t, addDays(FROM, -70), TO));
  });

  // 3) process events
  let done = 0;
  const skips: Record<string, number> = {};
  const results = await mapLimit(allEvents, CONC, async (ev) => {
    const daily = dailyMap.get(ev.ticker) || [];
    let r: Trade | { skip: string };
    try { r = await processEvent(ev, daily); }
    catch (e: any) { r = { skip: 'exception:' + (e?.message || e) }; }
    done++;
    if (done % 25 === 0) console.error(`  processed ${done}/${allEvents.length}`);
    if ('skip' in r) skips[r.skip] = (skips[r.skip] || 0) + 1;
    return r;
  });

  const trades = results.filter((r): r is Trade => !('skip' in r));
  console.error(`\nUsable trades: ${trades.length} / ${allEvents.length}`);
  console.error('Skips:', JSON.stringify(skips, null, 0));

  // ---------- report ----------
  console.log('\n================ SHORT STRADDLE "JUMP" — earnings vol selling ================');
  console.log('(short ATM straddle, enter 15:45 ET day-before AMC, exit 09:45 ET day-after)');
  console.log('Return % = net P&L / straddle credit. Friction: $%s/contract + %s slip each side.\n',
    COMMISSION_PER_CONTRACT, SLIP_FRAC);

  const rec = trades.filter((t) => t.klass === 'Recommended');
  const con = trades.filter((t) => t.klass === 'Consider');
  const avo = trades.filter((t) => t.klass === 'Avoid');

  row('ALL (blind)', stats(trades));
  row('Recommended', stats(rec));
  row('Consider', stats(con));
  row('Avoid', stats(avo));

  // single-factor splits (does each factor sort returns the right way?)
  console.log('\n---- single-factor splits ----');
  row('slope PASS', stats(trades.filter((t) => t.slopeOk)));
  row('slope FAIL', stats(trades.filter((t) => !t.slopeOk)));
  row('ivrv PASS', stats(trades.filter((t) => t.ivrvOk)));
  row('ivrv FAIL', stats(trades.filter((t) => !t.ivrvOk)));
  row('vol PASS', stats(trades.filter((t) => t.volOk)));
  row('vol FAIL', stats(trades.filter((t) => !t.volOk)));

  // slope quintiles (their headline: more negative slope -> higher return)
  console.log('\n---- slope quintiles (Q1=most negative/backwardated) ----');
  const bySlope = [...trades].sort((a, b) => a.slope - b.slope);
  const q = Math.ceil(bySlope.length / 5);
  for (let i = 0; i < 5; i++) {
    const seg = bySlope.slice(i * q, (i + 1) * q);
    row(`slope Q${i + 1}`, stats(seg));
  }

  // ================= CALENDAR "JUMP" (his preferred structure) =================
  const cal = trades.filter((t) => t.calRet != null).map((t) => ({ ...t, retPct: t.calRet!, pnl$: t.calPnl! }));
  console.log('\n================ LONG CALL CALENDAR "JUMP" — his preferred structure ================');
  console.log(`(sell front ATM call / buy ~45d ATM call, same strike; bounded loss = debit)  n=${cal.length}\n`);
  row('ALL (blind)', stats(cal));
  row('Recommended', stats(cal.filter((t) => t.klass === 'Recommended')));
  row('Consider', stats(cal.filter((t) => t.klass === 'Consider')));
  row('Avoid', stats(cal.filter((t) => t.klass === 'Avoid')));
  console.log('\n---- calendar slope quintiles (Q1=most negative) ----');
  const calBySlope = [...cal].sort((a, b) => a.slope - b.slope);
  const cq = Math.ceil(calBySlope.length / 5);
  for (let i = 0; i < 5; i++) row(`slope Q${i + 1}`, stats(calBySlope.slice(i * cq, (i + 1) * cq)));
  console.log('\n---- calendar compounding (Recommended, chrono) ----');
  {
    const chrono = cal.filter((t) => t.klass === 'Recommended').sort((a, b) => (a.earnDate < b.earnDate ? -1 : 1));
    for (const frac of [0.06, 0.10, 0.18]) {
      let eq = 10000, peak = 10000, maxDD = 0;
      for (const t of chrono) { eq *= 1 + frac * t.retPct; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak); }
      console.log(`  frac ${(frac * 100).toFixed(0)}%/trade -> end $${eq.toFixed(0).padStart(10)} | maxDD ${fmtPct(maxDD)} over ${chrono.length} trades`);
    }
  }

  // ---------- equity-style compounding sanity (10% Kelly proxy, fixed-fraction) ----------
  console.log('\n---- straddle fixed-fraction compounding (Recommended, chrono) ----');
  if (rec.length > 0) {
    const chrono = [...rec].sort((a, b) => (a.earnDate < b.earnDate ? -1 : 1));
    for (const frac of [0.02, 0.06, 0.10]) {
      let eq = 10000;
      let peak = 10000, maxDD = 0;
      for (const t of chrono) {
        eq *= 1 + frac * t.retPct; // risk `frac` of equity per trade, scaled by trade return-on-premium
        peak = Math.max(peak, eq);
        maxDD = Math.max(maxDD, (peak - eq) / peak);
      }
      console.log(`  frac ${(frac * 100).toFixed(0)}%/trade -> end $${eq.toFixed(0).padStart(10)} | maxDD ${fmtPct(maxDD)} over ${chrono.length} trades`);
    }
  }

  // CSV dump
  const fs = await import('fs');
  const dir = 'scripts/diag/output';
  fs.mkdirSync(dir, { recursive: true });
  const csvPath = `${dir}/earnings-vol-sell-trades.csv`;
  const header = 'ticker,earnDate,amc,entryDay,exitDay,spot,strike,frontExp,backExp,dteFront,dteBack,ivFront,ivBack,iv30,rv30,ivrv,slope,avgVol,credit,exitVal,pnl$,retPct,volOk,ivrvOk,slopeOk,klass\n';
  const lines = trades.map((t) =>
    [t.ticker, t.earnDate, t.amc, t.entryDay, t.exitDay, t.spot, t.strike, t.frontExp, t.backExp, t.dteFront, t.dteBack,
     t.ivFront.toFixed(4), t.ivBack.toFixed(4), t.iv30.toFixed(4), t.rv30.toFixed(4), t.ivrv.toFixed(3), t.slope.toFixed(6), Math.round(t.avgVol),
     t.credit.toFixed(2), t.exitVal.toFixed(2), t.pnl$.toFixed(2), t.retPct.toFixed(4), t.volOk, t.ivrvOk, t.slopeOk, t.klass].join(',')
  );
  fs.writeFileSync(csvPath, header + lines.join('\n'));
  console.log(`\nPer-trade CSV: ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
