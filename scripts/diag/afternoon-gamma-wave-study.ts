/**
 * afternoon-gamma-wave-study.ts — what the afternoon actually looks like for
 * SPX and its ATM 0DTE contracts, minute by minute.
 *
 * The question this answers: into the close, theta drains an ATM 0DTE option
 * every minute while gamma makes it ever more responsive to SPX. Which side
 * wins, and at what time of day? Concretely, per 30-minute bucket:
 *
 *   WAVES   how far SPX actually travels — median |move| over 5/10/15 min,
 *           and a 5-point zigzag's leg size and duration (the "wave").
 *   GAMMA   median % change in the ATM straddle legs per 1 SPX point moved,
 *           measured only on windows where SPX actually moved (>= 2 pts).
 *   THETA   median % change in the same options over windows where SPX was
 *           FLAT (<= 1 pt) — pure decay, no directional contamination.
 *   B/E     points of SPX needed inside the window to offset that decay,
 *           = |theta%| / (gamma% per point). Compare to the WAVES column:
 *           if the typical move is smaller than break-even, the wave is not
 *           rideable with a long ATM option in that bucket.
 *
 * Everything is measured from the same 1m parquet the backtests use; no model,
 * no greeks — the option's own traded price is the evidence.
 *
 * Usage:
 *   npx tsx scripts/diag/afternoon-gamma-wave-study.ts [--days 60] [--symbol SPX]
 *                                                      [--from 12:00] [--horizons 5,10,15]
 */
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const TARGET = resolveSymbolTarget(process.argv);
const DAYS = parseInt(argVal('--days', '60'), 10);
const FROM = argVal('--from', '12:00');
const HORIZONS = argVal('--horizons', '5,10,15').split(',').map(s => parseInt(s, 10));
const ZIGZAG_PTS = parseFloat(argVal('--zigzag', '5'));
const FLAT_PTS = parseFloat(argVal('--flat', '1'));      // "SPX did not move"
const MOVED_PTS = parseFloat(argVal('--moved', '2'));    // "SPX moved enough to measure"

function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }), 10);
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}
const hhmmToMin = (s: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s)!; return +m[1] * 60 + +m[2]; };
const bucketOf = (minsFromOpen: number) => {
  const et = 9 * 60 + 30 + minsFromOpen;
  const h = Math.floor(et / 60), m = et % 60 < 30 ? '00' : '30';
  return `${String(h).padStart(2, '0')}:${m}`;
};
const med = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = s.length >> 1;
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2;
};

interface Acc {
  absMove: Record<number, number[]>;      // horizon -> |ΔSPX| pts
  gammaPct: Record<number, number[]>;     // horizon -> % option move per SPX point
  thetaPct: Record<number, number[]>;     // horizon -> % option move while flat
  legPts: number[];                       // zigzag leg size (pts)
  legMin: number[];                       // zigzag leg duration (min)
}
const buckets = new Map<string, Acc>();
const accFor = (b: string): Acc => {
  let a = buckets.get(b);
  if (!a) {
    a = { absMove: {}, gammaPct: {}, thetaPct: {}, legPts: [], legMin: [] };
    for (const h of HORIZONS) { a.absMove[h] = []; a.gammaPct[h] = []; a.thetaPct[h] = []; }
    buckets.set(b, a);
  }
  return a;
};

const dates = listDatesFor(TARGET).slice(-DAYS);
const fromMin = hhmmToMin(FROM) - (9 * 60 + 30);
let used = 0;

for (const date of dates) {
  const day = loadDay(TARGET, date, '1m');
  if (!day?.spxBars?.length || !day.contractBars?.size) continue;
  const sess = sessOpenTs(date);
  const eod = sess + Math.round(6.5 * 60) * 60;

  // SPX close by timestamp, afternoon only.
  const spx = new Map<number, number>();
  for (const b of day.spxBars as Array<{ ts: number; close: number }>) {
    if (b.ts >= sess + fromMin * 60 && b.ts <= eod) spx.set(b.ts, b.close);
  }
  const ts = [...spx.keys()].sort((a, b) => a - b);
  if (ts.length < 30) continue;

  // Contract price lookup: symbol -> ts -> close.
  const px = new Map<string, Map<number, number>>();
  for (const [sym, bars] of day.contractBars as Map<string, Array<{ ts: number; close: number }>>) {
    const m = new Map<number, number>();
    for (const b of bars) if (b.ts >= sess && b.ts <= eod) m.set(b.ts, b.close);
    if (m.size) px.set(sym, m);
  }
  const strikeOf = day.contractStrikes as Map<string, number>;

  // ATM contract at time t = the listed strike nearest spot, per side.
  function atmSym(t: number, type: 'C' | 'P'): string | null {
    const spot = spx.get(t);
    if (spot == null) return null;
    let best: string | null = null, bestD = Infinity;
    for (const sym of px.keys()) {
      if (sym[10] !== type) continue;
      const k = strikeOf.get(sym);
      if (k == null) continue;
      const d = Math.abs(k - spot);
      if (d < bestD) { bestD = d; best = sym; }
    }
    return bestD <= 10 ? best : null; // within 2 SPX strikes of spot
  }

  for (const t of ts) {
    const minsFromOpen = Math.round((t - sess) / 60);
    const b = accFor(bucketOf(minsFromOpen));
    const s0 = spx.get(t)!;
    for (const h of HORIZONS) {
      const t1 = t + h * 60;
      const s1 = spx.get(t1);
      if (s1 == null) continue;
      const dSpx = s1 - s0;
      b.absMove[h].push(Math.abs(dSpx));

      // Use the side the move favours: calls on up moves, puts on down moves.
      const type: 'C' | 'P' = dSpx >= 0 ? 'C' : 'P';
      const sym = atmSym(t, type);
      if (!sym) continue;
      const p0 = px.get(sym)!.get(t), p1 = px.get(sym)!.get(t1);
      if (p0 == null || p1 == null || p0 < 0.20) continue;
      const pct = ((p1 - p0) / p0) * 100;
      if (Math.abs(dSpx) <= FLAT_PTS) b.thetaPct[h].push(pct);
      else if (Math.abs(dSpx) >= MOVED_PTS) b.gammaPct[h].push(pct / Math.abs(dSpx));
    }
  }

  // Zigzag legs on SPX (the "wave"), afternoon only.
  //
  // Track the high AND low since the last pivot separately. A single shared
  // "extreme" is wrong before the first leg fixes a direction: with dir=0 both
  // update branches fire, the extreme tracks price itself, the retrace is
  // always ~0 and no leg is ever recorded.
  {
    let pivotTs = ts[0], pivotPx = spx.get(ts[0])!;
    let hiTs = pivotTs, hiPx = pivotPx, loTs = pivotTs, loPx = pivotPx;
    let dir = 0; // 0 = undecided, +1 = last leg was up, -1 = down
    for (const t of ts) {
      const p = spx.get(t)!;
      if (p > hiPx) { hiPx = p; hiTs = t; }
      if (p < loPx) { loPx = p; loTs = t; }
      const upLegDone = dir >= 0 && hiPx - pivotPx >= ZIGZAG_PTS && hiPx - p >= ZIGZAG_PTS;
      const dnLegDone = dir <= 0 && pivotPx - loPx >= ZIGZAG_PTS && p - loPx >= ZIGZAG_PTS;
      if (upLegDone || dnLegDone) {
        const endTs = upLegDone ? hiTs : loTs;
        const endPx = upLegDone ? hiPx : loPx;
        const a = accFor(bucketOf(Math.round((pivotTs - sess) / 60)));
        a.legPts.push(Math.abs(endPx - pivotPx));
        a.legMin.push(Math.max(1, Math.round((endTs - pivotTs) / 60)));
        pivotTs = endTs; pivotPx = endPx;
        dir = upLegDone ? -1 : 1;
        hiTs = loTs = t; hiPx = loPx = p;
      }
    }
  }
  used++;
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\nafternoon gamma/theta wave study — ${TARGET.profileId}, ${used} sessions, from ${FROM} ET`);
console.log(`zigzag=${ZIGZAG_PTS}pt  flat<=${FLAT_PTS}pt  moved>=${MOVED_PTS}pt\n`);
const order = [...buckets.keys()].sort();
for (const h of HORIZONS) {
  console.log(`── ${h}-minute horizon ` + '─'.repeat(52));
  console.log('bucket   medMove  p75Move   theta%/win   gamma%/pt   breakeven   medLeg  legMin   n');
  for (const b of order) {
    const a = buckets.get(b)!;
    const mm = med(a.absMove[h]);
    const p75 = (() => { const s = [...a.absMove[h]].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length * 0.75)] : NaN; })();
    const th = med(a.thetaPct[h]);
    const ga = med(a.gammaPct[h]);
    const be = Number.isFinite(th) && Number.isFinite(ga) && ga > 0 ? Math.abs(th) / ga : NaN;
    const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '   -');
    console.log(
      `${b}   ${f(mm, 2).padStart(6)}  ${f(p75, 2).padStart(6)}   ${f(th, 2).padStart(8)}%   ${f(ga, 2).padStart(7)}%   ` +
      `${f(be, 2).padStart(7)}pt   ${f(med(a.legPts), 1).padStart(5)}  ${f(med(a.legMin), 0).padStart(5)}   ${String(a.absMove[h].length).padStart(5)}`,
    );
  }
  console.log('');
}
