/**
 * iron-fly-15w-slot.ts
 *
 * Replicates the OptionOmega "SPX 0DTE 50-delta 15-wide iron fly" export so our
 * engine output can be spliced onto the real OO history (which ends 2025-10-20).
 *
 * Structure (matches OO legs exactly): ATM iron fly —
 *   - short put + short call at K0 = nearest listed strike to spot (≈50Δ),
 *   - long put at K0-15, long call at K0+15 (nearest listed strikes),
 *   - HOLD TO 16:00 ET cash settle (real 0DTE expiry). No flip, no TP/SL.
 *
 * Entry: every 5 min from 09:30 to 14:00 ET (covers OO's 5 hourly windows).
 * Friction: identical model to delta-condor-slot / time-iron-slot-study.
 *
 * Run:
 *   IFW_DATE_START=2025-03-27 IFW_DATE_END=2026-06-17 \
 *   npx tsx scripts/diag/iron-fly-15w-slot.ts --symbol SPX
 * Output: /tmp/iron-fly-15w-{sym}.csv  (date,slot,spot,short_k,credit,settle_spx,pnl_gross,friction,pnl_net,win)
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { optPx } from './flat-fly-study';
import * as fs from 'fs';

const TARGET = resolveSymbolTarget(process.argv);
const WING = Number(process.env.IFW_WING ?? 15);
const SLOT_SEC = Number(process.env.IFW_SLOT_SEC ?? 300);   // 5 min
const START_SEC = 0;                                        // 09:30
const END_SEC = Number(process.env.IFW_END_SEC ?? 4.5 * 3600); // 14:00

// Friction — identical to delta-condor-slot / time-iron-slot-study.
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
const FLAT_SLIPPAGE = process.env.SWEEP_SLIPPAGE ? Number(process.env.SWEEP_SLIPPAGE) : null;
function entryFriction(grossPrem: number): number {
  if (FLAT_SLIPPAGE != null) return FLAT_SLIPPAGE;
  return Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);
}
const SETTLE_HHMM = 6 * 3600 + 30 * 60;   // 16:00 ET

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

const DS = process.env.IFW_DATE_START ?? '0000-00-00';
const DE = process.env.IFW_DATE_END ?? '9999-99-99';
const DATES = listDatesFor(TARGET).filter(d => d >= DS && d <= DE);
const SLOTS: number[] = [];
for (let t = START_SEC; t <= END_SEC; t += SLOT_SEC) SLOTS.push(t);
console.error(`[${TARGET.symbol}] iron-fly ${WING}w — ${SLOTS.length} slots (${slotLabel(SLOTS[0])}-${slotLabel(SLOTS[SLOTS.length-1])}), dates ${DATES.length} (${DATES[0]}..${DATES[DATES.length-1]})`);

const rows: string[] = [];
let traded = 0;
for (let di = 0; di < DATES.length; di++) {
  const date = DATES[di];
  if (di % 20 === 0) console.error(`  ${di}/${DATES.length}  ${date}`);
  let c1: any; try { c1 = loadDay(TARGET, date, '1m') as any; } catch { continue; }
  if (!c1?.spxBars?.length) continue;
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
  const settleSpx = optPx(s1, settle); if (settleSpx == null) continue;

  // listed strikes per side
  const putK = new Map<number, string>(), callK = new Map<number, string>();
  for (const [s] of c1.contractBars) { const sym = s as string; const k = c1.contractStrikes.get(sym) as number;
    (sym[sym.length - 9] === 'P' ? putK : callK).set(k, sym); }
  const strikesP = [...putK.keys()].sort((a, b) => a - b);
  const strikesC = [...callK.keys()].sort((a, b) => a - b);
  if (!strikesP.length || !strikesC.length) continue;
  const nearestK = (arr: number[], t: number) => arr.reduce((b, k) => Math.abs(k - t) < Math.abs(b - t) ? k : b, arr[0]);
  traded++;

  for (const slotSec of SLOTS) {
    const entryTs = sess + slotSec;
    const spot = optPx(s1, entryTs - 1); if (spot == null) continue;
    // ATM short strike: nearest listed strike present on BOTH sides
    const k0p = nearestK(strikesP, spot), k0c = nearestK(strikesC, spot);
    const K0 = Math.abs(k0p - spot) <= Math.abs(k0c - spot) ? k0p : k0c;
    if (!putK.has(K0) || !callK.has(K0)) continue;          // need both shorts at K0
    const lpK = nearestK(strikesP, K0 - WING), lcK = nearestK(strikesC, K0 + WING);
    if (lpK >= K0 || lcK <= K0) continue;
    const spB = c1.contractBars.get(putK.get(K0)!) as any[];
    const scB = c1.contractBars.get(callK.get(K0)!) as any[];
    const lpB = c1.contractBars.get(putK.get(lpK)!) as any[];
    const lcB = c1.contractBars.get(callK.get(lcK)!) as any[];
    const sp = optPx(spB, entryTs - 1), sc = optPx(scB, entryTs - 1);
    const lp = optPx(lpB, entryTs - 1), lc = optPx(lcB, entryTs - 1);
    if (sp == null || sc == null || lp == null || lc == null) continue;
    if (sp <= 0 || sc <= 0) continue;
    const credit = sp + sc - lp - lc;
    const putWing = K0 - lpK, callWing = lcK - K0, maxWing = Math.max(putWing, callWing);
    if (credit <= 0.10 || credit >= maxWing * 0.95) continue;
    // settle intrinsic of the fly (what we pay to close): one side ITM, capped at wing
    const exitV = Math.max(0, settleSpx - K0) - Math.max(0, settleSpx - lcK)
                + Math.max(0, K0 - settleSpx) - Math.max(0, lpK - settleSpx);
    const grossPrem = Math.abs(sp) + Math.abs(sc) + Math.abs(lp) + Math.abs(lc);
    const pnlGross = (credit - Math.max(0, exitV)) * 100;
    const friction = entryFriction(grossPrem);
    const pnlNet = pnlGross - friction;
    rows.push([date, slotLabel(slotSec), spot.toFixed(2), K0, credit.toFixed(2),
      settleSpx.toFixed(2), Math.round(pnlGross), friction.toFixed(2), Math.round(pnlNet), pnlNet > 0 ? 1 : 0].join(','));
  }
}
console.error(`  traded ${traded} days, ${rows.length} trades`);
const SYM = TARGET.symbol.toLowerCase();
const out = `/tmp/iron-fly-15w-${SYM}.csv`;
fs.writeFileSync(out, 'date,slot,spot,short_k,credit,settle_spx,pnl_gross,friction,pnl_net,win\n' + rows.join('\n'));
console.log(`Wrote ${out} (${rows.length} rows).`);
