/**
 * leg-stop-study.ts
 *
 * Does STOPPING OUT a losing 0DTE credit spread beat HOLDING it to settle?
 *
 * Takes the recommended asymmetric condor's two sides (put spread + call spread)
 * as STANDALONE credit spreads and, for each, walks the real intraday option
 * marks (optPx on actual contract bars — no BS re-pricing) from entry to 16:00.
 * Under each stop policy it closes the spread the instant its open loss crosses
 * the threshold, books that loss + an exit friction, and never re-enters. The
 * baseline policy is hold-to-settle (identical to delta-condor-slot).
 *
 * Stop policies swept per side:
 *   hold            — hold to 16:00 cash settle (baseline)
 *   loss=1x/2x/3x   — close when open loss >= N x credit collected
 *   short-ITM       — close the bar the underlying crosses the short strike
 *
 * The two sides are independent: the call spread can stop while the put spread
 * rides to settle (exactly the "drop the losing spread, keep the winner" idea).
 *
 * Run:
 *   SWEEP_PUT_DELTA=0.10 SWEEP_CALL_DELTA=0.07 SWEEP_GAP=0.05 \
 *   npx tsx scripts/diag/leg-stop-study.ts --symbol SPX
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx } from './flat-fly-study';
import { impliedVolFromPut, impliedVolFromCall, bsPutDelta, bsCallDelta } from './black-scholes';

const TARGET = resolveSymbolTarget(process.argv);
const RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
function entryFriction(grossPrem: number): number {
  return Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
}
const SETTLE_HHMM = 6 * 3600 + 30 * 60;   // 16:00 ET
const PUT_DELTA = Number(process.env.SWEEP_PUT_DELTA ?? 0.10);
const CALL_DELTA = Number(process.env.SWEEP_CALL_DELTA ?? 0.07);
const GAP = Number(process.env.SWEEP_GAP ?? 0.05);
const AM_SLOTS = [30 * 60, 60 * 60, 90 * 60, 120 * 60];  // 10:00 10:30 11:00 11:30 (sec after 9:30)
const STEP = 60;                                          // 1-minute mark cadence

// loss multiples of credit at which to stop; plus hold + short-ITM handled separately
const LOSS_MULTS = [1, 2, 3];
const POLICIES = ['hold', 'loss1x', 'loss2x', 'loss3x', 'shortITM'] as const;
type Policy = typeof POLICIES[number];

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
interface DK { strike: number; sym: string; px: number; delta: number; bars: any[]; }
function nearest(list: DK[], targetAbs: number, exclude?: number): DK | null {
  let best: DK | null = null, bd = Infinity;
  for (const c of list) { if (exclude != null && c.strike === exclude) continue;
    const d = Math.abs(Math.abs(c.delta) - targetAbs); if (d < bd) { bd = d; best = c; } }
  return best;
}

// Evaluate one credit spread under one policy. Returns net P&L (dollars).
// short/long: DK at entry. isPut: side. credit = shortEntry-longEntry (per share).
function evalSide(short: DK, long: DK, isPut: boolean, credit: number, entryFric: number,
                  entryTs: number, settle: number, s1: any[], spxSettle: number, policy: Policy): number {
  const intrAt = (px: number) => isPut
    ? Math.max(0, short.strike - px) - Math.max(0, long.strike - px)
    : Math.max(0, px - short.strike) - Math.max(0, px - long.strike);
  // hold-to-settle: exit = intrinsic at settle
  if (policy === 'hold') {
    const eV = Math.max(0, intrAt(spxSettle));
    return (credit - eV) * 100 - entryFric;
  }
  // walk intraday marks
  const lossMult = policy === 'loss1x' ? 1 : policy === 'loss2x' ? 2 : policy === 'loss3x' ? 3 : null;
  for (let ts = entryTs + STEP; ts < settle; ts += STEP) {
    if (policy === 'shortITM') {
      const spot = optPx(s1, ts); if (spot == null) continue;
      const crossed = isPut ? spot < short.strike : spot > short.strike;
      if (!crossed) continue;
      const sm = optPx(short.bars, ts), lm = optPx(long.bars, ts);
      if (sm == null || lm == null) continue;
      const closeVal = Math.max(0, sm - lm);
      const exitFric = entryFriction(Math.abs(sm) + Math.abs(lm));
      return (credit - closeVal) * 100 - entryFric - exitFric;
    } else if (lossMult != null) {
      const sm = optPx(short.bars, ts), lm = optPx(long.bars, ts);
      if (sm == null || lm == null) continue;
      const closeVal = Math.max(0, sm - lm);                 // debit to close now
      if (closeVal - credit >= lossMult * credit) {          // open loss >= N x credit
        const exitFric = entryFriction(Math.abs(sm) + Math.abs(lm));
        return (credit - closeVal) * 100 - entryFric - exitFric;
      }
    }
  }
  // never triggered -> hold to settle
  const eV = Math.max(0, intrAt(spxSettle));
  return (credit - eV) * 100 - entryFric;
}

function stat(ds: number[]) {
  const n = ds.length, t = ds.reduce((a, b) => a + b, 0), m = t / n;
  const sd = Math.sqrt(ds.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  let c = 0, pk = 0, mdd = 0;
  for (const x of ds) { c += x; pk = Math.max(pk, c); mdd = Math.max(mdd, pk - c); }
  return { dw: +(100 * ds.filter(x => x > 0).length / n).toFixed(1), tot: Math.round(t), pd: Math.round(m),
    mdd: Math.round(mdd), worst: Math.round(Math.min(...ds)), sh: +((m / sd) * Math.sqrt(252)).toFixed(2),
    cal: mdd ? +(t / mdd).toFixed(1) : 0 };
}

const DATES = listDatesFor(TARGET);
console.error(`[${TARGET.symbol}] leg-stop study — put ${PUT_DELTA}d / call ${CALL_DELTA}d / gap ${GAP}, ${DATES.length} dates`);

// per-policy daily series for put side, call side
const putDaily: Record<Policy, Record<string, number>> = Object.fromEntries(POLICIES.map(p => [p, {}])) as any;
const callDaily: Record<Policy, Record<string, number>> = Object.fromEntries(POLICIES.map(p => [p, {}])) as any;
const dayList: string[] = [];

for (let di = 0; di < DATES.length; di++) {
  const date = DATES[di];
  if (di % 30 === 0) console.error(`  ${di}/${DATES.length} ${date}`);
  let c1: any; try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  const spxSettle = optPx(s1, settle); if (spxSettle == null) continue;
  const putSyms: string[] = [], callSyms: string[] = [];
  for (const [s] of c1.contractBars) { const sym = s as string; (sym[sym.length - 9] === 'P' ? putSyms : callSyms).push(sym); }
  dayList.push(date);
  const putAcc: Record<Policy, number> = Object.fromEntries(POLICIES.map(p => [p, 0])) as any;
  const callAcc: Record<Policy, number> = Object.fromEntries(POLICIES.map(p => [p, 0])) as any;

  for (const slotSec of AM_SLOTS) {
    const entryTs = sess + slotSec;
    const spot = optPx(s1, entryTs - 1); if (spot == null) continue;
    const T = Math.max(settle - entryTs, 1200) / (365 * 24 * 3600);
    const putDK: DK[] = [], callDK: DK[] = [];
    for (const sym of putSyms) { const bars = c1.contractBars.get(sym) as any[]; const px = optPx(bars, entryTs - 1);
      if (px == null || px <= 0) continue; const k = c1.contractStrikes.get(sym) as number;
      const iv = impliedVolFromPut(px, spot, k, T, RATE); if (iv == null) continue;
      putDK.push({ strike: k, sym, px, delta: bsPutDelta(spot, k, T, iv, RATE), bars }); }
    for (const sym of callSyms) { const bars = c1.contractBars.get(sym) as any[]; const px = optPx(bars, entryTs - 1);
      if (px == null || px <= 0) continue; const k = c1.contractStrikes.get(sym) as number;
      const iv = impliedVolFromCall(px, spot, k, T, RATE); if (iv == null) continue;
      callDK.push({ strike: k, sym, px, delta: bsCallDelta(spot, k, T, iv, RATE), bars }); }
    if (putDK.length < 2 || callDK.length < 2) continue;

    // Select BOTH sides and only place when the whole condor is valid — matches
    // delta-condor-slot's filter exactly, so the population (and the hold baseline)
    // equals the deployed condor, not a contaminated standalone-side set.
    const sp = nearest(putDK, PUT_DELTA);
    const sc = nearest(callDK, CALL_DELTA);
    if (!sp || !sc) continue;
    const lp = nearest(putDK, PUT_DELTA - GAP, sp.strike);
    const lc = nearest(callDK, CALL_DELTA - GAP, sc.strike);
    if (!lp || !lc) continue;
    if (lp.strike >= sp.strike || lc.strike <= sc.strike) continue;
    const putWing = sp.strike - lp.strike, callWing = lc.strike - sc.strike, maxWing = Math.max(putWing, callWing);
    const condorCredit = sp.px - lp.px + sc.px - lc.px;
    if (condorCredit <= 0.10 || condorCredit >= maxWing * 0.95) continue;
    const putCredit = sp.px - lp.px, callCredit = sc.px - lc.px;
    const putFric = entryFriction(Math.abs(sp.px) + Math.abs(lp.px));
    const callFric = entryFriction(Math.abs(sc.px) + Math.abs(lc.px));
    for (const p of POLICIES) {
      putAcc[p] += evalSide(sp, lp, true, putCredit, putFric, entryTs, settle, s1, spxSettle, p);
      callAcc[p] += evalSide(sc, lc, false, callCredit, callFric, entryTs, settle, s1, spxSettle, p);
    }
  }
  for (const p of POLICIES) { putDaily[p][date] = putAcc[p]; callDaily[p][date] = callAcc[p]; }
}

const days = dayList;
const series = (m: Record<string, number>) => days.map(d => m[d] ?? 0);
console.log(`\n===== ${TARGET.symbol}  put ${PUT_DELTA}d / call ${CALL_DELTA}d  (morning 4-spread, ${days.length} days) =====`);
const header = 'policy        side    dayW%  $/day   total    maxDD   worst  Sharpe Calmar';
console.log(header);
const line = (lbl: string, sideLbl: string, ds: number[]) => {
  const s = stat(ds);
  console.log(lbl.padEnd(13), sideLbl.padEnd(7), String(s.dw).padStart(5), String(s.pd).padStart(6),
    String(s.tot).padStart(8), String(s.mdd).padStart(8), String(s.worst).padStart(7), String(s.sh).padStart(6), String(s.cal).padStart(6));
};
for (const p of POLICIES) line(p, 'PUT', series(putDaily[p]));
console.log('');
for (const p of POLICIES) line(p, 'CALL', series(callDaily[p]));
console.log('');
// condor = put + call under same policy on each side
for (const p of POLICIES) line(p, 'CONDOR', days.map((d, i) => series(putDaily[p])[i] + series(callDaily[p])[i]));
