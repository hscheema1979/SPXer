/**
 * delta-condor-slot.ts
 *
 * Per-15min-slot 0DTE iron condor with DELTA-TARGETED strikes (not fixed point
 * offsets): short legs at ~SHORT_DELTA, long wings at ~SHORT_DELTA − GAP. Each
 * slot is a standalone hold-to-settle strategy, exactly like time-iron-slot-
 * study.ts, but strikes are chosen by Black-Scholes delta (IV inverted from the
 * option mid). Delta selection NORMALIZES across products — a 0.20Δ short means
 * the same probability of finishing ITM on NDX as on QQQ — so the two align even
 * though their strike grids and price levels differ. It also auto-handles skew
 * (the 0.20Δ put sits further out in points than the 0.20Δ call).
 *
 * Settlement / friction / assignment handling are identical to the offset study:
 *   - 16:00 ET cash settle (SPX/NDX/XSP) — real 0DTE expiry.
 *   - Structure-scaled entry friction (commission + half-spread % of premium).
 *   - SWEEP_ITM_CLOSE=1 → American assignment-avoidance close at 15:45 (QQQ/SPY).
 *
 * Run:
 *   SWEEP_DELTA_SHORTS=0.10,0.15,0.20,0.25,0.30 SWEEP_DELTA_GAPS=0.05 \
 *   SWEEP_SLOT_EMIT=1 npx tsx scripts/diag/delta-condor-slot.ts --symbol NDX
 *
 * Output: /tmp/dc-slot-{sym}.json (+ /tmp/dc-slot-trades-{sym}.csv if EMIT).
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx, applyExit, type Leg } from './flat-fly-study';
import { impliedVolFromPut, impliedVolFromCall, bsPutDelta, bsCallDelta } from './black-scholes';
import * as fs from 'fs';

const TARGET = resolveSymbolTarget(process.argv);
const RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

// ── Friction (identical to time-iron-slot-study) ────────────────────────────
const FLAT_SLIPPAGE = process.env.SWEEP_SLIPPAGE ? Number(process.env.SWEEP_SLIPPAGE) : null;
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
function entryFriction(grossPrem: number): number {
  if (FLAT_SLIPPAGE != null) return FLAT_SLIPPAGE;
  return Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
}
const SETTLE_HHMM = 6 * 3600 + 30 * 60;   // 16:00 ET
const CUTOFF_HHMM = 6 * 3600;             // 15:30 ET — last entry
const SLOT_SEC = 15 * 60;
const ITM_CLOSE = !!process.env.SWEEP_ITM_CLOSE;          // QQQ/SPY assignment-avoidance
const ITM_CLOSE_HHMM = 6 * 3600 + 15 * 60;               // 15:45 ET

// Delta targets. SHORT = short-leg |delta|; GAP = how much lower the long wing's
// |delta| is (0.20 short, 0.05 gap → 0.15 long).
const SHORT_DELTAS = (process.env.SWEEP_DELTA_SHORTS ?? '0.10,0.15,0.20,0.25,0.30')
  .split(',').map(s => parseFloat(s.trim())).filter(n => n > 0 && n < 1);
const GAPS = (process.env.SWEEP_DELTA_GAPS ?? '0.05')
  .split(',').map(s => parseFloat(s.trim())).filter(n => n > 0);

const EMIT = !!process.env.SWEEP_SLOT_EMIT;
const emitRows: string[] = [];

// Side selector: condor (default, both verticals) | call (bear-call SCS only) |
// put (bull-put PCS only). Single-side builds one 2-leg defined-risk credit
// spread, reusing the SAME BS strike selection, friction, and 16:00 settle/
// assignment math as the condor path — guarantees cross-structure parity.
const SIDE = (process.env.SWEEP_SIDE ?? 'condor').toLowerCase();   // condor | call | put
const FPREFIX = SIDE === 'call' ? 'scs-slot' : SIDE === 'put' ? 'pcs-slot' : 'dc-slot';

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
function slotLabel(slotSec: number): string {
  const mins = 9 * 60 + 30 + Math.round(slotSec / 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) { const sym = s as string; if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym); const d = Math.abs(k - targetK); if (d < bestD) { bestD = d; best = sym; } }
  return best;
}

interface Bucket { n: number; wins: number; pnl: number; pnlGross: number; creditSum: number; widthSum: number;
  winSum: number; lossSum: number; bestWin: number; worstLoss: number; cum: number; peak: number; maxDD: number;
  putDeltaSum: number; callDeltaSum: number; }
const stats = new Map<string, Bucket>();
function rec(k: string, pnlGross: number, friction: number, credit: number, maxWing: number, putD: number, callD: number) {
  let b = stats.get(k);
  if (!b) { b = { n: 0, wins: 0, pnl: 0, pnlGross: 0, creditSum: 0, widthSum: 0, winSum: 0, lossSum: 0, bestWin: 0, worstLoss: 0, cum: 0, peak: 0, maxDD: 0, putDeltaSum: 0, callDeltaSum: 0 }; stats.set(k, b); }
  const net = pnlGross - friction;
  b.n++; b.pnl += net; b.pnlGross += pnlGross; b.creditSum += credit; b.widthSum += maxWing; b.putDeltaSum += putD; b.callDeltaSum += callD;
  if (net > 0) { b.wins++; b.winSum += net; if (net > b.bestWin) b.bestWin = net; }
  else { b.lossSum += -net; if (net < b.worstLoss) b.worstLoss = net; }
  b.cum += net; if (b.cum > b.peak) b.peak = b.cum; if (b.peak - b.cum > b.maxDD) b.maxDD = b.peak - b.cum;
}
// Precomputed per-side (strike, delta) at a slot. Nearest-|delta| lookup is then cheap.
interface DK { strike: number; sym: string; px: number; delta: number; }
function nearest(list: DK[], targetAbs: number, exclude?: number): DK | null {
  let best: DK | null = null, bd = Infinity;
  for (const c of list) { if (exclude != null && c.strike === exclude) continue;
    const d = Math.abs(Math.abs(c.delta) - targetAbs); if (d < bd) { bd = d; best = c; } }
  return best;
}
// Nearest listed strike to a target STRIKE (for point-sized wings — on 0DTE a
// wide wing is many deltas out, so delta-gap can't express it; size in points).
function nearestStrikeK(list: DK[], targetK: number, exclude?: number): DK | null {
  let best: DK | null = null, bd = Infinity;
  for (const c of list) { if (exclude != null && c.strike === exclude) continue;
    const d = Math.abs(c.strike - targetK); if (d < bd) { bd = d; best = c; } }
  return best;
}
// Point-sized wings for single-side spreads (e.g. SWEEP_WING_PTS=10,25,50). When
// set, the long leg is short ± W points (nearest listed strike); GAPS is ignored.
const WING_PTS = (process.env.SWEEP_WING_PTS ?? '')
  .split(',').map(s => parseFloat(s.trim())).filter(n => n > 0);

const ALL = listDatesFor(TARGET);
const N = parseInt(process.env.SWEEP_DAYS || '0', 10);
const DATES = (Number.isFinite(N) && N > 0 && N < ALL.length) ? ALL.slice(-N) : ALL;
const SLOTS: number[] = [];
for (let t = 1800; t <= CUTOFF_HHMM; t += SLOT_SEC) SLOTS.push(t);
console.error(`[${TARGET.symbol}] DELTA slot study — SIDE=${SIDE}, shorts ${SHORT_DELTAS.join('/')}, gaps ${GAPS.join('/')}, ${SLOTS.length} slots, dates ${DATES.length}, ITM_CLOSE=${ITM_CLOSE}`);

let traded = 0;
for (let di = 0; di < DATES.length; di++) {
  const date = DATES[di];
  if (di % 20 === 0) console.error(`  ${di}/${DATES.length}  ${date}`);
  let c1: any; try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  const spxAtSettle = optPx(s1, settle); if (spxAtSettle == null) continue;
  const itmCloseTs = sess + ITM_CLOSE_HHMM;
  const spxAtItmClose = ITM_CLOSE ? optPx(s1, itmCloseTs) : null;
  // pre-split symbols by type once per day
  const putSyms: string[] = [], callSyms: string[] = [];
  for (const [s] of c1.contractBars) { const sym = s as string; (sym[sym.length - 9] === 'P' ? putSyms : callSyms).push(sym); }
  traded++;

  for (const slotSec of SLOTS) {
    const entryTs = sess + slotSec;
    const spot = optPx(s1, entryTs - 1); if (spot == null) continue;
    // calendar time to 16:00, clamped to >= 20 min for IV-inversion stability.
    const T = Math.max(settle - entryTs, 1200) / (365 * 24 * 3600);
    // precompute (strike, delta) for each side at this slot
    const putDK: DK[] = [], callDK: DK[] = [];
    for (const sym of putSyms) { const bars = c1.contractBars.get(sym) as any[]; const px = optPx(bars, entryTs - 1);
      if (px == null || px <= 0) continue; const k = c1.contractStrikes.get(sym) as number;
      const iv = impliedVolFromPut(px, spot, k, T, RATE); if (iv == null) continue;
      putDK.push({ strike: k, sym, px, delta: bsPutDelta(spot, k, T, iv, RATE) }); }
    for (const sym of callSyms) { const bars = c1.contractBars.get(sym) as any[]; const px = optPx(bars, entryTs - 1);
      if (px == null || px <= 0) continue; const k = c1.contractStrikes.get(sym) as number;
      const iv = impliedVolFromCall(px, spot, k, T, RATE); if (iv == null) continue;
      callDK.push({ strike: k, sym, px, delta: bsCallDelta(spot, k, T, iv, RATE) }); }
    if (putDK.length < 2 || callDK.length < 2) continue;

    for (const shortD of SHORT_DELTAS) {
      const sp = nearest(putDK, shortD), sc = nearest(callDK, shortD);
      if (SIDE === 'put' ? !sp : SIDE === 'call' ? !sc : (!sp || !sc)) continue;

      // ── single-side credit spread (bear-call SCS / bull-put PCS) ──────────
      if (SIDE !== 'condor') {
        const isPut = SIDE === 'put';
        const sh = (isPut ? sp : sc)!;
        // wing list: point-sized (preferred for 0DTE wide wings) else delta-gap.
        const wings: { lg: DK | null; tag: string }[] = WING_PTS.length
          ? WING_PTS.map(w => ({ lg: nearestStrikeK(isPut ? putDK : callDK, isPut ? sh.strike - w : sh.strike + w, sh.strike), tag: `w${w}` }))
          : GAPS.map(g => { const ld = shortD - g; return { lg: ld > 0 ? nearest(isPut ? putDK : callDK, ld, sh.strike) : null, tag: ld > 0 ? ld.toFixed(2) : 'x' }; });
        for (const { lg, tag } of wings) {
          if (!lg) continue;
          if (isPut ? lg.strike >= sh.strike : lg.strike <= sh.strike) continue;   // long must be further OTM
          const wing = Math.abs(sh.strike - lg.strike);
          const credit = sh.px - lg.px;
          if (credit <= 0.10 || credit >= wing * 0.95) continue;
          const sLegs: Leg[] = [
            { symbol: sh.sym, strike: sh.strike, sign: +1, bars: c1.contractBars.get(sh.sym) as any[] },
            { symbol: lg.sym, strike: lg.strike, sign: -1, bars: c1.contractBars.get(lg.sym) as any[] },
          ];
          const grossPrem = Math.abs(sh.px) + Math.abs(lg.px);
          const intrAt = (px: number) => isPut
            ? Math.max(0, sh.strike - px) - Math.max(0, lg.strike - px)
            : Math.max(0, px - sh.strike) - Math.max(0, px - lg.strike);
          let exitV = Math.max(0, intrAt(spxAtSettle as number)), exitFriction = 0;
          const shItm = ITM_CLOSE && spxAtItmClose != null && (isPut ? spxAtItmClose < sh.strike : spxAtItmClose > sh.strike);
          if (shItm) {
            const sm = optPx(sLegs[0].bars, itmCloseTs), lm = optPx(sLegs[1].bars, itmCloseTs);
            if (sm != null && lm != null) { exitV = Math.max(0, sm - lm); exitFriction = entryFriction(Math.abs(sm) + Math.abs(lm)); }
          }
          const pnlGross = (credit - exitV) * 100;
          const friction = entryFriction(grossPrem) + exitFriction;
          const k = `${slotSec}|${shortD}|${tag}`;
          rec(k, pnlGross, friction, credit, wing, isPut ? sh.delta : 0, isPut ? 0 : sh.delta);
          if (EMIT) {
            const pnlNet = pnlGross - friction;
            emitRows.push([date, slotLabel(slotSec), shortD, lg.delta.toFixed(3), tag, spot.toFixed(2),
              sh.strike, lg.strike, credit.toFixed(2), wing, grossPrem.toFixed(2),
              (spxAtSettle as number).toFixed(2), exitV.toFixed(2), Math.round(pnlGross),
              friction.toFixed(2), Math.round(pnlNet), pnlNet > 0 ? 1 : 0, sh.delta.toFixed(3)].join(','));
          }
        }
        continue;
      }

      for (const gap of GAPS) {
        const longD = shortD - gap; if (longD <= 0) continue;
        if (!sp || !sc) continue;   // condor needs both sides (narrows for TS)
        const lp = nearest(putDK, longD, sp.strike), lc = nearest(callDK, longD, sc.strike);
        if (!lp || !lc) continue;
        if (lp.strike >= sp.strike || lc.strike <= sc.strike) continue;   // long must be further OTM
        const legs: Leg[] = [
          { symbol: sp.sym, strike: sp.strike, sign: +1, bars: c1.contractBars.get(sp.sym) as any[] },
          { symbol: lp.sym, strike: lp.strike, sign: -1, bars: c1.contractBars.get(lp.sym) as any[] },
          { symbol: sc.sym, strike: sc.strike, sign: +1, bars: c1.contractBars.get(sc.sym) as any[] },
          { symbol: lc.sym, strike: lc.strike, sign: -1, bars: c1.contractBars.get(lc.sym) as any[] },
        ];
        const entriesPx = [sp.px, lp.px, sc.px, lc.px];
        const credit = sp.px - lp.px + sc.px - lc.px;
        const putWing = sp.strike - lp.strike, callWing = lc.strike - sc.strike, maxWing = Math.max(putWing, callWing);
        if (credit <= 0.10 || credit >= maxWing * 0.95) continue;
        const grossPrem = entriesPx.reduce((s, p) => s + Math.abs(p), 0);
        let exitV: number, exitFriction = 0;
        const shortItm = ITM_CLOSE && spxAtItmClose != null && (spxAtItmClose < sp.strike || spxAtItmClose > sc.strike);
        if (shortItm) {
          const marks = legs.map(lg => optPx(lg.bars, itmCloseTs));
          if (marks.some(m => m == null)) exitV = applyExit([], settle, settle, legs, credit, 0, spxAtSettle, maxWing, 0).exitV;
          else { exitV = Math.max(0, legs.reduce((s, lg, i) => s + lg.sign * (marks[i] as number), 0));
            exitFriction = entryFriction(marks.reduce((s, m) => s + Math.abs(m as number), 0)); }
        } else { exitV = applyExit([], settle, settle, legs, credit, 0, spxAtSettle, maxWing, 0).exitV; }
        const pnlGross = (credit - exitV) * 100;
        const friction = entryFriction(grossPrem) + exitFriction;
        const k = `${slotSec}|${shortD}|${longD}`;
        rec(k, pnlGross, friction, credit, maxWing, sp.delta, sc.delta);
        if (EMIT) {
          const pnlNet = pnlGross - friction;
          // Per-SIDE net P&L: each credit spread as its own 2-leg strategy (own
          // friction, own assignment-avoidance close) so the put and call sides
          // can be optimized independently and any pair recombined into a condor.
          const sideNet = (shortLeg: Leg, longLeg: Leg, isPut: boolean) => {
            const shortEntry = isPut ? sp.px : sc.px, longEntry = isPut ? lp.px : lc.px;
            const sideCredit = shortEntry - longEntry;
            const intrAt = (px: number) => isPut
              ? Math.max(0, shortLeg.strike - px) - Math.max(0, longLeg.strike - px)
              : Math.max(0, px - shortLeg.strike) - Math.max(0, px - longLeg.strike);
            let eV = Math.max(0, intrAt(spxAtSettle as number)), eFric = 0;
            const itm = ITM_CLOSE && spxAtItmClose != null && (isPut ? spxAtItmClose < shortLeg.strike : spxAtItmClose > shortLeg.strike);
            if (itm) { const sm = optPx(shortLeg.bars, itmCloseTs), lm = optPx(longLeg.bars, itmCloseTs);
              if (sm != null && lm != null) { eV = Math.max(0, sm - lm); eFric = entryFriction(Math.abs(sm) + Math.abs(lm)); } }
            const sideFric = entryFriction(Math.abs(shortEntry) + Math.abs(longEntry)) + eFric;
            return Math.round((sideCredit - eV) * 100 - sideFric);
          };
          const putNet = sideNet(legs[0], legs[1], true);
          const callNet = sideNet(legs[2], legs[3], false);
          const putCredit = (sp.px - lp.px), callCredit = (sc.px - lc.px);
          const putWing = sp.strike - lp.strike, callWing = lc.strike - sc.strike;
          emitRows.push([date, slotLabel(slotSec), shortD, longD, spot.toFixed(2), sp.strike, lp.strike, sc.strike, lc.strike,
            credit.toFixed(2), maxWing, grossPrem.toFixed(2), (spxAtSettle as number).toFixed(2), exitV.toFixed(2),
            Math.round(pnlGross), friction.toFixed(2), Math.round(pnlNet), pnlNet > 0 ? 1 : 0, putNet, callNet,
            putCredit.toFixed(2), callCredit.toFixed(2), putWing, callWing].join(','));
        }
      }
    }
  }
}
console.error(`  traded ${traded} days`);

// ── Output ──────────────────────────────────────────────────────────────────
const rows: any[] = [];
for (const [k, b] of stats) {
  const [slotSec, shortD, third] = k.split('|');
  const isPts = third.startsWith('w');
  const losses = b.n - b.wins;
  rows.push({
    slot: slotLabel(+slotSec), shortDelta: +shortD,
    longDelta: isPts ? null : +third, wingPts: isPts ? +third.slice(1) : null, n: b.n,
    wr: +(100 * b.wins / b.n).toFixed(1),
    avgPnl: +(b.pnl / b.n).toFixed(2), totalPnl: +b.pnl.toFixed(0),
    avgWin: +(b.wins ? b.winSum / b.wins : 0).toFixed(2),
    avgLoss: +(losses ? -b.lossSum / losses : 0).toFixed(2),
    profitFactor: b.lossSum > 0 ? +(b.winSum / b.lossSum).toFixed(2) : null,
    worstLoss: +b.worstLoss.toFixed(0), maxDD: +Math.round(b.maxDD),
    avgCredit: +(b.creditSum / b.n).toFixed(3), avgWing: +(b.widthSum / b.n).toFixed(1),
    avgShortPutDelta: +(b.putDeltaSum / b.n).toFixed(3), avgShortCallDelta: +(b.callDeltaSum / b.n).toFixed(3),
  });
}
const SYM = TARGET.symbol.toLowerCase();
fs.writeFileSync(`/tmp/${FPREFIX}-${SYM}.json`, JSON.stringify({
  symbol: TARGET.symbol, selection: 'delta', side: SIDE, days: DATES.length, dateRange: [DATES[0], DATES[DATES.length - 1]],
  shortDeltas: SHORT_DELTAS, gaps: GAPS, itmClose: ITM_CLOSE, rows,
}, null, 2));
console.log(`Wrote /tmp/${FPREFIX}-${SYM}.json (${rows.length} slot×delta rows).`);
if (EMIT) {
  const hdr = SIDE === 'condor'
    ? 'date,slot,short_delta,long_delta,spot,short_put_k,long_put_k,short_call_k,long_call_k,credit,max_wing,gross_premium,settle_spx,exit_value,pnl_gross,friction,pnl_net,win,put_net,call_net'
    : 'date,slot,short_delta,long_delta,wing_req,spot,short_k,long_k,credit,wing,gross_premium,settle_spx,exit_value,pnl_gross,friction,pnl_net,win,short_delta_bs';
  fs.writeFileSync(`/tmp/${FPREFIX}-trades-${SYM}.csv`, hdr + '\n' + emitRows.join('\n'));
  console.log(`Wrote /tmp/${FPREFIX}-trades-${SYM}.csv (${emitRows.length} rows).`);
}
