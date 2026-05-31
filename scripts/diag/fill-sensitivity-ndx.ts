/**
 * fill-sensitivity-ndx.ts — NDX OTM/ATM fill stress test, empirically grounded.
 *
 * Half-spread numbers come from real ThetaData NBBO (scripts/diag/ndx-spread-sample.ts,
 * 15 days, ~40k quote-minutes, RTH). Median half-spread per leg:
 *   ATM 0.70, 10pt-OTM 0.60, 20pt-OTM 0.60, 30pt-OTM 0.50 pts.
 *   p75 ~1.0-1.5; open/close (10:00 & 15:00) blow out to p75=6+ pts.
 *
 * Scenarios:
 *   A: model-baseline   flat hs=0.10/leg slip=$15           (what the sweep assumes)
 *   B: empirical-median moneyness hs (~0.6-0.7) slip=$15    (real midday spreads)
 *   C: empirical-ToD    moneyness hs × time-of-day blowout  (real spreads incl open/close tax)
 *
 * Both entry AND exit pay the half-spread (cross the book each way): entry credit
 * is reduced by hs/leg × 2 legs, exit trigger requires penetrating hs/leg × 2 legs.
 */
import * as dotenv from 'dotenv'; dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

const TARGET = resolveSymbolTarget(['', '', '--symbol', 'NDX']);
const SI = TARGET.strikeInterval;
const CUTOFF_OFFSET = 6 * 3600;
const SETTLE_OFFSET = 6 * 3600 + 900;
const MIN_ALIGN = 3;

// ── Empirical half-spread model (per leg, in points) ────────────────────────
// Keyed by |distance from spot| in points. Midday (median) baseline.
function empiricalHalfSpread(distPts: number): number {
  const d = Math.abs(distPts);
  if (d <= 5)  return 0.70;   // ATM
  if (d <= 15) return 0.60;   // ~10pt OTM
  if (d <= 25) return 0.60;   // ~20pt OTM
  return 0.50;                // 30pt+ OTM
}
// Time-of-day multiplier on the half-spread. Open (10:00) and close (15:00)
// hours showed p75 ~6pts vs ~0.7 midday → ~3× the median at the wings.
function todMultiplier(etHour: number): number {
  if (etHour === 10) return 2.5;  // open: wide, volatile
  if (etHour === 15) return 2.5;  // close: wide, volatile
  if (etHour === 14) return 1.3;  // pre-close drift wider
  return 1.0;                     // 11:00-13:00 midday: tightest
}
function etHourOf(ts: number, sess: number): number {
  // sess = 10:00 ET. Each 3600s = 1 hour.
  return 10 + Math.floor((ts - sess) / 3600);
}

function sessOpen(date: string): number {
  return Math.floor(new Date(`${date}T14:30:00Z`).getTime() / 1000);
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--)
    if (bars[i].ts <= ts) return bars[i].close > 0 ? bars[i].close : null;
  return null;
}
function findStrike(c1: any, letter: 'C'|'P', target: number): string | null {
  let best: string | null = null, bestDist = Infinity;
  for (const [sym, strike] of c1.contractStrikes as Map<string,number>) {
    if (!sym.includes(letter)) continue;
    const d = Math.abs(strike - target);
    if (d < bestDist) { bestDist = d; best = sym; }
  }
  return bestDist <= SI * 1.5 ? best : null;
}
function wma(arr: number[], p: number): number | null {
  if (arr.length < p) return null;
  const s = arr.slice(-p); let n = 0, d = 0;
  s.forEach((v, i) => { const w = i+1; n += v*w; d += w; });
  return n/d;
}
function hma(closes: number[], period: number): number | null {
  const half = Math.floor(period/2), sq = Math.floor(Math.sqrt(period));
  const raw: number[] = [];
  for (let i = closes.length - sq; i < closes.length; i++) {
    if (i < 0) return null;
    const sl = closes.slice(0, i+1);
    const a = wma(sl, half), b = wma(sl, period);
    if (a==null||b==null) return null;
    raw.push(2*a - b);
  }
  return wma(raw, sq);
}

interface Entry { ts: number; dir: 'bull'|'bear'; spot: number; }
function detectSignals(spxBars: any[], p1Bars: any[], sess: number): Entry[] {
  const FAST=3, SLOW=9, cutoff = sess + CUTOFF_OFFSET;
  const closes: number[] = (p1Bars ?? []).map((b: any) => b.close);
  let prevBull: boolean|null = null, bStreak=0, beStreak=0, bFired=false, beFired=false;
  const entries: Entry[] = [];
  for (const b of spxBars) {
    closes.push(b.close);
    const fa = hma(closes, FAST), sa = hma(closes, SLOW);
    if (fa==null||sa==null) continue;
    const bull = fa > sa;
    if (prevBull !== null && bull !== prevBull) { bStreak=0; beStreak=0; bFired=false; beFired=false; }
    bull ? (bStreak++, beStreak=0) : (beStreak++, bStreak=0);
    if (bull && bStreak>=MIN_ALIGN && !bFired) {
      bFired=true;
      const ts = b.ts+60; if (ts<cutoff) entries.push({ts, dir:'bull', spot:b.close});
    }
    if (!bull && beStreak>=MIN_ALIGN && !beFired) {
      beFired=true;
      const ts = b.ts+60; if (ts<cutoff) entries.push({ts, dir:'bear', spot:b.close});
    }
    prevBull = bull;
  }
  return entries;
}

interface TrajPt { ts: number; V: number; }
function buildTraj(shortBars: any[], longBars: any[], entryTs: number, settle: number): TrajPt[] {
  const pts: TrajPt[] = [];
  for (const b of shortBars) {
    if (b.ts < entryTs || b.ts > settle) continue;
    if (!b.close || b.close<=0) continue;
    const lp = optPx(longBars, b.ts); if (lp==null) continue;
    pts.push({ts: b.ts, V: b.close - lp});
  }
  return pts;
}

// Returns gross P&L (per contract ×100) and the exit timestamp.
// halfSpreadFn(ts) gives the per-leg half-spread (pts) at that bar's time —
// lets scenario C vary it by hour. tpV is on the MID trajectory; to fill the
// close we must penetrate by 2×hs (cross the book on both legs).
function applyExit(traj: TrajPt[], settle: number, credit: number, tpFrac: number,
                   halfSpreadFn: (ts: number) => number, spxSettle: number|null,
                   isCall: boolean, sK: number, lK: number): { pnl: number; exitTs: number } {
  const tpV = (1-tpFrac)*credit;
  for (const p of traj) {
    if (p.ts > settle) break;
    const pen = 2*halfSpreadFn(p.ts);
    if (tpFrac>0 && p.V <= tpV - pen) return { pnl: (credit - tpV) * 100, exitTs: p.ts };
  }
  // Settle: 0DTE intrinsic is cash-settled (no spread to cross). Non-settle
  // fallback pays the closing spread.
  let exitV = 0;
  const last = traj[traj.length-1];
  if (spxSettle != null) {
    exitV = isCall
      ? Math.max(0, spxSettle-sK) - Math.max(0, spxSettle-lK)
      : Math.max(0, sK-spxSettle) - Math.max(0, lK-spxSettle);
  } else {
    const pen = last ? 2*halfSpreadFn(last.ts) : 0;
    exitV = last ? last.V + pen : credit;
  }
  return { pnl: (credit - Math.max(0, exitV)) * 100, exitTs: last ? last.ts : settle };
}

const SPREADS = [
  {label:'ATM w10',   soS:0,wS:1},{label:'10OTM w10', soS:1,wS:1},
  {label:'20OTM w10', soS:2,wS:1},{label:'30OTM w10', soS:3,wS:1},
  {label:'ATM w20',   soS:0,wS:2},{label:'10OTM w20', soS:1,wS:2},
  {label:'20OTM w20', soS:2,wS:2},
];
const EXITS = [
  {label:'TP10',tpFrac:0.10},{label:'TP25',tpFrac:0.25},
  {label:'TP50',tpFrac:0.50},{label:'TP75',tpFrac:0.75},
];
// mode: 'flat' uses a constant per-leg hs; 'emp' uses moneyness hs; 'emp-tod' adds ToD blowup.
// entryCross: whether the entry credit is reduced by paying the half-spread on the way in.
const SCENARIOS = [
  {tag:'A', mode:'flat',    flatHs:0.10, slip:15, entryCross:false},
  {tag:'B', mode:'emp',     flatHs:0,    slip:15, entryCross:true },
  {tag:'C', mode:'emp-tod', flatHs:0,    slip:15, entryCross:true },
] as const;

interface Acc { n:number; wins:number; cumPnl:number; peak:number; maxDD:number; }
const R: Record<string,Record<string,Acc>> = {};
const vk = (s:string,e:string) => `${s}|${e}`;
for (const sp of SPREADS) for (const ex of EXITS) {
  R[vk(sp.label,ex.label)] = {};
  for (const sc of SCENARIOS) R[vk(sp.label,ex.label)][sc.tag] = {n:0,wins:0,cumPnl:0,peak:0,maxDD:0};
}

const dates = listDatesFor(TARGET);
console.error(`Processing ${dates.length} NDX dates...`);
for (let di=0; di<dates.length; di++) {
  const date = dates[di];
  if (di%50===0) console.error(`  ${di}/${dates.length}  ${date}`);
  const c1 = loadDay(TARGET, date, '1m') as any;
  if (!c1?.spxBars?.length) continue;
  const p1 = loadDay(TARGET, dates[di-1] ?? date, '1m') as any;
  const sess = sessOpen(date);
  const settle = sess + SETTLE_OFFSET;
  const spxSettle = optPx(c1.spxBars, settle);
  const entries = detectSignals(c1.spxBars, p1?.spxBars ?? [], sess);

  for (const ev of entries) {
    const isCall = ev.dir === 'bear';
    const letter: 'C'|'P' = isCall ? 'C' : 'P';
    for (const sp of SPREADS) {
      const so=sp.soS*SI, w=sp.wS*SI;
      const sT = isCall ? ev.spot+so : ev.spot-so;
      const lT = isCall ? sT+w : sT-w;
      const sSym = findStrike(c1, letter, sT);
      const lSym = findStrike(c1, letter, lT);
      if (!sSym||!lSym||sSym===lSym) continue;
      const sBars = c1.contractBars.get(sSym) as any[];
      const lBars = c1.contractBars.get(lSym) as any[];
      if (!sBars||!lBars) continue;
      const sE = optPx(sBars, ev.ts-1), lE = optPx(lBars, ev.ts-1);
      if (sE==null||lE==null) continue;
      const credit = sE - lE;          // mid credit (what the model books)
      if (credit<=0.05||credit>=w*0.95) continue;
      const sK = (c1.contractStrikes as Map<string,number>).get(sSym)!;
      const lK = (c1.contractStrikes as Map<string,number>).get(lSym)!;
      const traj = buildTraj(sBars, lBars, ev.ts, settle);
      if (!traj.length) continue;

      // Per-leg distances from spot (for moneyness-based half-spread)
      const sDist = Math.abs(sK - ev.spot);
      const lDist = Math.abs(lK - ev.spot);
      const entryHour = etHourOf(ev.ts, sess);

      for (const ex of EXITS) {
        for (const sc of SCENARIOS) {
          // Build the per-bar half-spread function for this scenario.
          // For a 2-leg spread the round-trip pays hs on the short + hs on the long.
          const hsFn = (ts: number): number => {
            if (sc.mode === 'flat') return sc.flatHs;
            const baseS = empiricalHalfSpread(sDist);
            const baseL = empiricalHalfSpread(lDist);
            const tod = sc.mode === 'emp-tod' ? todMultiplier(etHourOf(ts, sess)) : 1.0;
            // average the two legs' half-spread (applyExit multiplies by 2 legs)
            return ((baseS + baseL) / 2) * tod;
          };

          const { pnl: pg } = applyExit(traj, settle, credit, ex.tpFrac, hsFn, spxSettle, isCall, sK, lK);

          // Entry-side cost: to OPEN a short credit spread you sell the short
          // (hit the bid) and buy the long (lift the ask) → you collect LESS
          // than mid by hs on each leg.
          let entryCost = 0;
          if (sc.entryCross) {
            const hsS = sc.mode === 'emp-tod' ? empiricalHalfSpread(sDist)*todMultiplier(entryHour) : empiricalHalfSpread(sDist);
            const hsL = sc.mode === 'emp-tod' ? empiricalHalfSpread(lDist)*todMultiplier(entryHour) : empiricalHalfSpread(lDist);
            entryCost = (hsS + hsL) * 100;
          }

          const pnl = pg - sc.slip - entryCost;
          const a = R[vk(sp.label,ex.label)][sc.tag];
          a.n++; if (pnl>0) a.wins++; a.cumPnl+=pnl;
          a.peak = Math.max(a.peak, a.cumPnl);
          a.maxDD = Math.max(a.maxDD, a.peak - a.cumPnl);
        }
      }
    }
  }
}

const D = dates.length;
console.log('\n=== NDX FILL SENSITIVITY — HMA 1m 3x9 (' + D + ' days) ===');
console.log('Half-spreads from real ThetaData NBBO (15-day sample, RTH).');
console.log('A = model      flat hs=$0.10/leg, no entry cross   (what the sweep assumes)');
console.log('B = empirical  moneyness hs (ATM 0.70/OTM 0.60), entry+exit cross');
console.log('C = emp + ToD  same hs × open/close blowup (10:00 & 15:00 = 2.5×, 14:00 = 1.3×)');
console.log('');

for (const sp of SPREADS) {
  console.log(`── ${sp.label} (width=${sp.wS*SI}pts = $${sp.wS*SI*100}/contract) ──`);
  console.log('  exit    sc       n     wr%    dpnl    ppt      dd');
  for (const ex of EXITS) {
    for (const sc of SCENARIOS) {
      const a = R[vk(sp.label,ex.label)][sc.tag];
      const wr   = a.n ? (a.wins/a.n*100).toFixed(1) : '-';
      const dpnl = '$'+(a.cumPnl/D).toFixed(0);
      const ppt  = '$'+(a.n ? a.cumPnl/a.n : 0).toFixed(0);
      const dd   = '$'+a.maxDD.toFixed(0);
      console.log(`  ${ex.label}    ${sc.tag}  ${String(a.n).padStart(6)}  ${wr.padStart(5)}%  ${dpnl.padStart(7)}  ${ppt.padStart(5)}  ${dd.padStart(8)}`);
    }
    console.log('');
  }
}
