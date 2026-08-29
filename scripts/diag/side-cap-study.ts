/**
 * side-cap-study.ts
 *
 * Backtests PER-SIDE position caps on a directional credit-spread strategy by
 * replaying the proven sweep's emitted per-trade stream under different cap
 * policies. No re-pricing: each defined-risk spread's P&L depends only on market
 * prices (not on what else is open), so skipping one trade never changes another's
 * outcome — replaying the fixed trade stream with take/skip decisions is an EXACT
 * simulation of drop-and-wait, and the shadow book is just the sum of the skips.
 *
 * Input: emitted trades from credit-spread-sweep (SWEEP_EMIT_TRADES_KEYS), under
 *   scripts/autoresearch/output/spread-trades/{slug}/{date}.json
 *
 * Two cap families (call-side vs put-side tracked independently):
 *   A) Independent  — open iff openSameSide < M.                       (no balance)
 *   B) Balanced     — open iff openSameSide < min(M, max(base, openOther + L)).
 *        base = ceil(M/2) ("50% of max cap" free floor; avoids start deadlock)
 *        L = 0      → strict: past the floor a side may only match the other side
 *        L = ceil(M/2) → loose: a side may lead the other by half the cap
 *        L = ∞      → reduces to Independent
 *
 * Skip handling: DROP-AND-WAIT (a capped signal is gone; the side resumes on the
 * next fresh signal once back under cap). Skipped trades go to a SHADOW book so we
 * can see what the cap cost or saved.
 *
 * Run:
 *   npx tsx scripts/diag/side-cap-study.ts
 *   CAP_CONFIG=HMA_2m_3x12__15ITM_w10__TP10_only npx tsx scripts/diag/side-cap-study.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const SLUG = process.env.CAP_CONFIG || 'HMA_2m_3x12__15ITM_w10__TP10_only';
// Emitted-trades root: credit spreads → spread-trades, iron flies → iron-trades.
const ROOT = process.env.CAP_DIR || 'scripts/autoresearch/output/spread-trades';
const DIR = path.join(process.cwd(), ROOT, SLUG);
const Ms = (process.env.CAP_M ?? '2,3,5').split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);

// The two "sides" are call-credit/put-credit (credit spreads) or bull/bear body
// (directional iron flies). Map both to generic A/B with the right display labels.
interface T { entryTs: number; exitTs: number; side: 'A' | 'B'; pnl: number; }
const byDate = new Map<string, T[]>();
if (!fs.existsSync(DIR)) { console.error(`No emitted trades at ${DIR}. Emit them first (SWEEP_EMIT_TRADES_KEYS + SWEEP_EMIT_ONLY).`); process.exit(1); }
let LA = 'A', LB = 'B';   // display labels, set from the first trade's fields
let labelsSet = false;
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
  const day = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const arr: T[] = (day.trades || []).map((tr: any) => {
    if (!labelsSet && (tr.side || tr.dir)) { labelsSet = true; if (tr.side) { LA = 'call'; LB = 'put'; } else { LA = 'bull'; LB = 'bear'; } }
    const isA = tr.side ? tr.side === 'call-credit' : tr.dir === 'bull';
    return { entryTs: tr.entryTs, exitTs: tr.exitTs, side: (isA ? 'A' : 'B') as 'A' | 'B', pnl: tr.pnlNet };
  });
  arr.sort((a, b) => a.entryTs - b.entryTs);
  byDate.set(day.date, arr);
}
const dates = [...byDate.keys()].sort();
// Column initials — fall back to 2 chars when they'd collide (bull/bear → bu/be).
const _same = LA[0].toUpperCase() === LB[0].toUpperCase();
const Ai = _same ? LA.slice(0, 2) : LA[0].toUpperCase();
const Bi = _same ? LB.slice(0, 2) : LB[0].toUpperCase();

interface Res {
  label: string;
  takenC: number; takenP: number; skipC: number; skipP: number;
  pnl: number; pnlC: number; pnlP: number;
  shadow: number; shadowC: number; shadowP: number;
  wins: number; taken: number;
  peakC: number; peakP: number; peakTot: number;
  daily: Map<string, number>;
}

function sim(Mc: number, Mp: number, L: number, base: number, label: string): Res {
  const r: Res = { label, takenC: 0, takenP: 0, skipC: 0, skipP: 0, pnl: 0, pnlC: 0, pnlP: 0,
    shadow: 0, shadowC: 0, shadowP: 0, wins: 0, taken: 0, peakC: 0, peakP: 0, peakTot: 0, daily: new Map() };
  for (const date of dates) {
    const trades = byDate.get(date)!;
    const openC: number[] = [], openP: number[] = [];   // exitTs of currently-open positions per side
    for (const t of trades) {
      // Free slots for positions that have closed at/before this entry.
      for (let i = openC.length - 1; i >= 0; i--) if (openC[i] <= t.entryTs) openC.splice(i, 1);
      for (let i = openP.length - 1; i >= 0; i--) if (openP[i] <= t.entryTs) openP.splice(i, 1);
      const same = t.side === 'A' ? openC : openP;
      const other = t.side === 'A' ? openP : openC;
      const sideM = t.side === 'A' ? Mc : Mp;
      const effCap = Math.min(sideM, Math.max(base, other.length + L));
      if (same.length < effCap) {
        same.push(t.exitTs);
        r.pnl += t.pnl; r.taken++; if (t.pnl > 0) r.wins++;
        if (t.side === 'A') { r.takenC++; r.pnlC += t.pnl; } else { r.takenP++; r.pnlP += t.pnl; }
        r.daily.set(date, (r.daily.get(date) ?? 0) + t.pnl);
        r.peakC = Math.max(r.peakC, openC.length);
        r.peakP = Math.max(r.peakP, openP.length);
        r.peakTot = Math.max(r.peakTot, openC.length + openP.length);
      } else {
        r.shadow += t.pnl;
        if (t.side === 'A') { r.skipC++; r.shadowC += t.pnl; } else { r.skipP++; r.shadowP += t.pnl; }
      }
    }
  }
  return r;
}

function maxDD(daily: Map<string, number>): number {
  let cum = 0, peak = 0, dd = 0;
  for (const d of [...daily.keys()].sort()) { cum += daily.get(d)!; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

const BIG = 99999;
const scenarios: Res[] = [sim(BIG, BIG, BIG, 0, 'uncapped (baseline)')];
for (const M of Ms) {
  const half = Math.ceil(M / 2);
  scenarios.push(sim(M, M, BIG, 0, `A indep  M=${M}`));
  scenarios.push(sim(M, M, half, half, `B bal    M=${M} L=${half}`));
  scenarios.push(sim(M, M, 0, half, `B strict M=${M} L=0`));
}
// Asymmetric independent caps — cap one side, leave the other loose (both directions).
scenarios.push(sim(2, BIG, BIG, 0, `A ${LA}=2 ${LB}=inf`));
scenarios.push(sim(3, BIG, BIG, 0, `A ${LA}=3 ${LB}=inf`));
scenarios.push(sim(4, BIG, BIG, 0, `A ${LA}=4 ${LB}=inf`));
scenarios.push(sim(BIG, 2, BIG, 0, `A ${LA}=inf ${LB}=2`));
scenarios.push(sim(BIG, 3, BIG, 0, `A ${LA}=inf ${LB}=3`));
scenarios.push(sim(BIG, 4, BIG, 0, `A ${LA}=inf ${LB}=4`));

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nPER-SIDE CAP STUDY — ${SLUG}  (sides: ${LA}=col-${Ai}, ${LB}=col-${Bi})`);
console.log(`${dates.length} days (${dates[0]} → ${dates[dates.length - 1]}), drop-and-wait, shadow book on\n`);

const base = scenarios[0];
console.log(`Baseline asymmetry — ${LA.toUpperCase()} side: ${base.takenC} trades, $${Math.round(base.pnlC).toLocaleString()} | ${LB.toUpperCase()} side: ${base.takenP} trades, $${Math.round(base.pnlP).toLocaleString()}`);
console.log(`Baseline peak concurrency — ${LA} ${base.peakC}, ${LB} ${base.peakP}, total ${base.peakTot}\n`);

console.log('scenario'.padEnd(20), 'taken'.padStart(6), `${Ai}/${Bi}`.padStart(9), '$net'.padStart(10), '$/tr'.padStart(6), 'WR%'.padStart(5),
  `skip ${Ai}/${Bi}`.padStart(10), 'shadow$'.padStart(10), `pk${Ai}/pk${Bi}`.padStart(8), 'maxDD'.padStart(9));
console.log('-'.repeat(108));
for (const r of scenarios) {
  const dd = maxDD(r.daily);
  console.log(
    r.label.padEnd(20),
    String(r.taken).padStart(6),
    `${r.takenC}/${r.takenP}`.padStart(9),
    Math.round(r.pnl).toLocaleString().padStart(10),
    Math.round(r.taken ? r.pnl / r.taken : 0).toString().padStart(6),
    (r.taken ? 100 * r.wins / r.taken : 0).toFixed(1).padStart(5),
    `${r.skipC}/${r.skipP}`.padStart(10),
    Math.round(r.shadow).toLocaleString().padStart(10),
    `${r.peakC}/${r.peakP}`.padStart(8),
    Math.round(-dd).toLocaleString().padStart(9),
  );
}
console.log('\nshadow$ = net P&L of the SKIPPED trades (what the cap forwent). Very negative = cap dodged losers (good); positive = cap skipped winners (bad).');

// ── Full call × put grid (independent caps) ──────────────────────────────────
const axis = [1, 2, 3, 4, 5, 6, BIG];
const lab = (n: number) => (n === BIG ? 'inf' : String(n));
const grid: Record<string, Record<string, Res>> = {};
for (const mc of axis) { grid[lab(mc)] = {}; for (const mp of axis) grid[lab(mc)][lab(mp)] = sim(mc, mp, BIG, 0, `c${lab(mc)}/p${lab(mp)}`); }

function printGrid(title: string, val: (r: Res) => number) {
  console.log(`\n${title}   (rows = ${LA.toUpperCase()} cap, cols = ${LB.toUpperCase()} cap)`);
  console.log(`${LA}\\${LB}`.padEnd(8), axis.map(a => lab(a).padStart(8)).join(''));
  console.log('-'.repeat(8 + axis.length * 8));
  for (const mc of axis) {
    let line = lab(mc).padEnd(8);
    for (const mp of axis) line += Math.round(val(grid[lab(mc)][lab(mp)])).toLocaleString().padStart(8);
    console.log(line);
  }
}
printGrid('$NET P&L', r => r.pnl);
printGrid('maxDD ($)', r => -maxDD(r.daily));

// Best cell by net
let best: Res | null = null;
for (const mc of axis) for (const mp of axis) { const r = grid[lab(mc)][lab(mp)]; if (!best || r.pnl > best.pnl) best = r; }
console.log(`\nBest by $net: ${best!.label}  →  $${Math.round(best!.pnl).toLocaleString()} net, ${best!.taken} trades, ${(100 * best!.wins / best!.taken).toFixed(1)}% WR, peak ${best!.peakC}/${best!.peakP}, maxDD $${Math.round(-maxDD(best!.daily)).toLocaleString()}`);

const out = { slug: SLUG, days: dates.length, dateRange: [dates[0], dates[dates.length - 1]],
  scenarios: scenarios.map(r => ({ ...r, daily: undefined, maxDD: Math.round(maxDD(r.daily)) })),
  grid: Object.fromEntries(axis.map(mc => [lab(mc), Object.fromEntries(axis.map(mp => {
    const r = grid[lab(mc)][lab(mp)]; return [lab(mp), { pnl: Math.round(r.pnl), taken: r.taken, wr: +(100 * r.wins / r.taken).toFixed(1), peakC: r.peakC, peakP: r.peakP, maxDD: Math.round(maxDD(r.daily)) }];
  }))])) };
fs.writeFileSync('/tmp/side-cap-study.json', JSON.stringify(out, null, 2));
console.log('\nWrote /tmp/side-cap-study.json');
