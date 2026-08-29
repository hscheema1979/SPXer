/**
 * ev-finder.ts  —  0DTE positive-EV setup scanner with out-of-sample validation
 *
 * Mirrors the live "Option Alpha → find positive-EV positions → trade XSP" workflow
 * (XSP ≡ SPX economically). Sweeps the 0DTE credit-spread space:
 *
 *     side {put, call} × short-Δ × wing(pts) × entry-time(15m slots)
 *
 * and computes the HONEST hold-to-settle EV per setup (16:00 cash settle, no early
 * exit → no fill artifact; structure-scaled friction identical to delta-condor-slot).
 *
 * The trap this avoids: ranking a 500-cell grid by in-sample EV surfaces NOISE — the
 * top cell is whichever overfit the sample. So dates are split CHRONOLOGICALLY into
 * TRAIN (first TRAIN_FRAC) and TEST (held-out tail). Cells are ranked by TRAIN EV but
 * judged by TEST EV: a setup is only "real" if EV survives out-of-sample with the same
 * sign. Per cell we also report tail risk (5th-pct trade, worst) — positive EV with a
 * fat left tail is the video's "survive to the long run" hazard.
 *
 *   npx tsx scripts/diag/ev-finder.ts --symbol SPX --dte 0
 * Env: SIDES(put,call), DELTAS, WING_PTS(10,25,50), SLOT_SEC(900), TRAIN_FRAC(0.65),
 *      MINN(40), TOP(30), MAXDATES(0=all).
 */
import * as dotenv from 'dotenv';
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';
import { sessOpenTs } from './flat-file-reader';
import { impliedVolFromPut, impliedVolFromCall, bsPutDelta, bsCallDelta } from './black-scholes';
import * as fs from 'fs';
import * as path from 'path';
dotenv.config();

const TARGET = resolveSymbolTarget(process.argv.slice(2));
const SPX0 = { ...TARGET, dte: 0, profileId: `${TARGET.symbol.toLowerCase()}-0dte` } as any;
const RATE = Number(process.env.SWEEP_RISK_FREE_RATE ?? 0.04);

// Structure-scaled friction — identical to delta-condor-slot / time-iron-slot-study.
const FRIC_COMM = Number(process.env.SWEEP_COMM ?? 2.6);
const FRIC_HSFRAC = Number(process.env.SWEEP_HS_FRAC ?? 0.003);
const FRIC_FLOOR = Number(process.env.SWEEP_FRIC_FLOOR ?? 8);
const entryFriction = (grossPrem: number) => Math.max(FRIC_FLOOR, FRIC_COMM + FRIC_HSFRAC * grossPrem * 100);

const SETTLE_HHMM = 6 * 3600 + 30 * 60;   // 16:00 ET cash settle (the verified value — NOT 15:45)
const CUTOFF_HHMM = 6 * 3600;             // 15:30 ET last entry
const SLOT_SEC = Number(process.env.SLOT_SEC ?? 900);   // 15-min slots
const SIDES = (process.env.SIDES ?? 'put,call').split(',') as ('put' | 'call')[];
const DELTAS = (process.env.DELTAS ?? '0.10,0.15,0.20,0.25,0.30,0.40,0.50').split(',').map(Number);
const WING_PTS = (process.env.WING_PTS ?? '10,25,50').split(',').map(Number);
const TRAIN_FRAC = Number(process.env.TRAIN_FRAC ?? 0.65);
const MINN = Number(process.env.MINN ?? 40);     // min trades per cell (in BOTH train and test) to trust it
const TOP = Number(process.env.TOP ?? 30);
const MAXDATES = Number(process.env.MAXDATES ?? 0);

const optPx = (bars: any[], ts: number): number | null => { for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close; return null; };
const slotLabel = (s: number) => { const m = 9 * 60 + 30 + Math.round(s / 60); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

interface DK { strike: number; sym: string; px: number; delta: number; }
function nearestDelta(list: DK[], target: number, exclude?: number): DK | null {
  let best: DK | null = null, bd = Infinity;
  for (const c of list) { if (exclude != null && c.strike === exclude) continue; const d = Math.abs(Math.abs(c.delta) - target); if (d < bd) { bd = d; best = c; } }
  return best;
}
function nearestStrike(list: DK[], targetK: number, exclude?: number): DK | null {
  let best: DK | null = null, bd = Infinity;
  for (const c of list) { if (exclude != null && c.strike === exclude) continue; const d = Math.abs(c.strike - targetK); if (d < bd) { bd = d; best = c; } }
  return best;
}

// Per-cell store: each trade keeps its date-index so train/test split is chronological.
type Pt = { di: number; pnl: number };
const cells = new Map<string, Pt[]>();

async function main() {
  const all = listDatesFor(SPX0);
  const dates = MAXDATES > 0 ? all.slice(-MAXDATES) : all;
  const splitIdx = Math.floor(dates.length * TRAIN_FRAC);
  console.error(`[ev] ${TARGET.symbol} 0DTE | sides ${SIDES.join('/')} | Δ ${DELTAS.join('/')} | wings ${WING_PTS.join('/')}pt | slots/${SLOT_SEC / 60}m | ${dates.length} dates (train ${splitIdx} / test ${dates.length - splitIdx})`);

  const SLOTS: number[] = [];
  for (let t = 1800; t <= CUTOFF_HHMM; t += SLOT_SEC) SLOTS.push(t);   // 10:00 → 15:30

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    if (di % 25 === 0) console.error(`  ${di}/${dates.length}  ${date}`);
    let c1: any; try { c1 = loadDay(SPX0, date, '1m') as any; } catch { continue; }
    if (!c1?.spxBars?.length) continue;
    const s1: any[] = c1.spxBars;
    const sess = sessOpenTs(date), settle = sess + SETTLE_HHMM;
    const spxAtSettle = optPx(s1, settle); if (spxAtSettle == null) continue;
    const putSyms: string[] = [], callSyms: string[] = [];
    for (const [s] of c1.contractBars) { const sym = s as string; (sym[sym.length - 9] === 'P' ? putSyms : callSyms).push(sym); }

    for (const slotSec of SLOTS) {
      const entryTs = sess + slotSec;
      const spot = optPx(s1, entryTs - 1); if (spot == null) continue;
      const T = Math.max(settle - entryTs, 1200) / (365 * 24 * 3600);   // calendar yrs to 16:00, clamp 20m

      for (const side of SIDES) {
        const isPut = side === 'put';
        const dk: DK[] = [];
        for (const sym of (isPut ? putSyms : callSyms)) {
          const bars = c1.contractBars.get(sym) as any[]; const px = optPx(bars, entryTs - 1);
          if (px == null || px <= 0) continue; const k = c1.contractStrikes.get(sym) as number;
          const iv = isPut ? impliedVolFromPut(px, spot, k, T, RATE) : impliedVolFromCall(px, spot, k, T, RATE);
          if (iv == null) continue;
          dk.push({ strike: k, sym, px, delta: isPut ? bsPutDelta(spot, k, T, iv, RATE) : bsCallDelta(spot, k, T, iv, RATE) });
        }
        if (dk.length < 2) continue;

        for (const shortD of DELTAS) {
          const sh = nearestDelta(dk, shortD); if (!sh) continue;
          for (const w of WING_PTS) {
            const lg = nearestStrike(dk, isPut ? sh.strike - w : sh.strike + w, sh.strike); if (!lg) continue;
            if (isPut ? lg.strike >= sh.strike : lg.strike <= sh.strike) continue;
            const wing = Math.abs(sh.strike - lg.strike);
            const credit = sh.px - lg.px;
            if (credit <= 0.10 || credit >= wing * 0.95) continue;
            const intr = isPut
              ? Math.max(0, sh.strike - spxAtSettle) - Math.max(0, lg.strike - spxAtSettle)
              : Math.max(0, spxAtSettle - sh.strike) - Math.max(0, spxAtSettle - lg.strike);
            const friction = entryFriction(Math.abs(sh.px) + Math.abs(lg.px));   // hold-to-settle: cash settled, no exit leg
            const pnl = (credit - Math.max(0, intr)) * 100 - friction;
            const k = `${side}|${shortD.toFixed(2)}d|w${w}|${slotLabel(slotSec)}`;
            let arr = cells.get(k); if (!arr) { arr = []; cells.set(k, arr); }
            arr.push({ di, pnl });
          }
        }
      }
    }
  }

  // ── stats ──
  function stat(pnls: number[]) {
    const n = pnls.length; if (!n) return null;
    const wins = pnls.filter(p => p > 0).length, net = pnls.reduce((a, b) => a + b, 0), mean = net / n;
    const sd = Math.sqrt(pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
    const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
    let peak = 0, cum = 0, dd = 0; for (const p of pnls) { cum += p; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
    const sorted = [...pnls].sort((a, b) => a - b);
    const p5 = sorted[Math.floor(0.05 * n)];
    return { n, wr: 100 * wins / n, ev: mean, net, sharpe, dd, p5, worst: sorted[0] };
  }

  type Row = { cell: string; train: ReturnType<typeof stat>; test: ReturnType<typeof stat>; full: ReturnType<typeof stat> };
  const rows: Row[] = [];
  for (const [cell, pts] of cells) {
    const train = stat(pts.filter(p => p.di < splitIdx).map(p => p.pnl));
    const test = stat(pts.filter(p => p.di >= splitIdx).map(p => p.pnl));
    const full = stat(pts.map(p => p.pnl));
    if (!train || !test || train.n < MINN || test.n < MINN) continue;
    rows.push({ cell, train, test, full });
  }

  // Rank by TRAIN EV (the honest "what would I have picked"), then look at TEST.
  rows.sort((a, b) => b.train!.ev - a.train!.ev);
  const survivors = rows.filter(r => r.train!.ev > 0 && r.test!.ev > 0);

  console.log(`\n=== 0DTE EV FINDER — ${TARGET.symbol} | hold-to-settle | ranked by TRAIN EV, validated on TEST ===`);
  console.log(`(${rows.length} cells with ≥${MINN} trades both halves · ${survivors.length} keep positive EV out-of-sample)\n`);
  const H = ['cell'.padEnd(26), 'trEV'.padStart(6), 'trWR'.padStart(5), 'trShp'.padStart(6), '|', 'teEV'.padStart(6), 'teWR'.padStart(5), 'teShp'.padStart(6), 'teP5'.padStart(7), 'teDD'.padStart(8), 'OOS'].join(' ');
  console.log(H); console.log('-'.repeat(H.length));
  for (const r of rows.slice(0, TOP)) {
    const t = r.train!, e = r.test!;
    const oos = t.ev > 0 && e.ev > 0 ? '✅' : e.ev > 0 ? '~' : '❌';
    console.log([r.cell.padEnd(26), ('$' + Math.round(t.ev)).padStart(6), t.wr.toFixed(0).padStart(5), t.sharpe.toFixed(2).padStart(6), '|',
      ('$' + Math.round(e.ev)).padStart(6), e.wr.toFixed(0).padStart(5), e.sharpe.toFixed(2).padStart(6), ('$' + Math.round(e.p5)).padStart(7), ('$' + Math.round(e.dd)).padStart(8), oos].join(' '));
  }

  console.log(`\n── Survivors (positive EV in BOTH halves), best test Sharpe first ──`);
  const bySharpe = [...survivors].sort((a, b) => b.test!.sharpe - a.test!.sharpe).slice(0, 15);
  for (const r of bySharpe) {
    const e = r.test!, f = r.full!;
    console.log(`  ${r.cell.padEnd(26)}  test EV $${Math.round(e.ev)} (Shp ${e.sharpe.toFixed(2)}, WR ${e.wr.toFixed(0)}%, p5 $${Math.round(e.p5)}, worst $${Math.round(e.worst)})  full EV $${Math.round(f.ev)}/${f.n}`);
  }
  if (!survivors.length) console.log('  (none — no 0DTE setup holds positive EV out-of-sample at this friction)');

  const dir = path.join(process.cwd(), 'scripts/autoresearch/output/STUDY-ev-finder');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `ev-${TARGET.symbol.toLowerCase()}-0dte-train${TRAIN_FRAC}.json`);
  fs.writeFileSync(fp, JSON.stringify({ config: { symbol: TARGET.symbol, sides: SIDES, deltas: DELTAS, wings: WING_PTS, slotMin: SLOT_SEC / 60, trainFrac: TRAIN_FRAC, minN: MINN, nDates: dates.length, splitIdx }, rows }, null, 2));
  console.log(`\n→ ${fp}`);
}
main().catch(e => { console.error(e); process.exit(1); });
