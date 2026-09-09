/**
 * publish-scs-slots.ts — publish the bear-call (SCS) per-15min-slot study to the
 * :3700 spreads dashboard, APPEND-ONLY.
 *
 * Reads the per-trade CSV emitted by `delta-condor-slot.ts SWEEP_SIDE=call`
 * (/tmp/scs-slot-trades-{sym}.csv), aggregates each (slot × short-delta × wing)
 * into a dashboard sweep row + a daily P&L series aligned to the dashboard's
 * shared `dates` array, and merges into:
 *    scripts/autoresearch/output/spread-sweep.json   (table rows)
 *    scripts/autoresearch/output/spread-daily.json   (drill-down series)
 *
 * Namespace = signal === 'SCS TOD'. On republish only THIS namespace is dropped
 * and re-added — every other engine's rows (iron, HMA, etc.) are untouched. Both
 * files are written atomically (temp + rename) so the dashboard never blanks.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx tsx scripts/diag/publish-scs-slots.ts [--symbol SPX] [--dry]
 */
import * as fs from 'fs';
import * as path from 'path';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SYM = arg('symbol', 'SPX').toLowerCase();
const DRY = process.argv.includes('--dry');
const SIGNAL = 'SCS TOD';                 // namespace for de-dup
const EXIT = 'hold-settle';
const OUT = path.resolve(__dirname, '../autoresearch/output');
const CSV = `/tmp/scs-slot-trades-${SYM}.csv`;

const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n');
const hdr = lines[0].split(',');
const ci = (n: string) => { const i = hdr.indexOf(n); if (i < 0) throw new Error(`CSV missing column ${n}`); return i; };
const C = { date: ci('date'), slot: ci('slot'), sd: ci('short_delta'), wreq: ci('wing_req'),
  credit: ci('credit'), wing: ci('wing'), pnl: ci('pnl_net'), sdbs: ci('short_delta_bs') };

interface Agg { n: number; wins: number; pnl: number; creditSum: number; wingSum: number; sdSum: number;
  durSum: number; cum: number; peak: number; maxDD: number; days: Set<string>; daily: Map<string, number>; spread: string; }
const variants = new Map<string, Agg>();
const slotToDur = (slot: string) => { const [h, m] = slot.split(':').map(Number); return (16 * 60) - (h * 60 + m); };

for (const ln of lines.slice(1)) {
  if (!ln) continue;
  const c = ln.split(',');
  const slot = c[C.slot], sd = c[C.sd], wreq = c[C.wreq];
  const spread = `${slot} d${sd} ${wreq}`;
  const key = `${SIGNAL}|${spread}|${EXIT}`;
  let a = variants.get(key);
  if (!a) { a = { n: 0, wins: 0, pnl: 0, creditSum: 0, wingSum: 0, sdSum: 0, durSum: 0, cum: 0, peak: 0, maxDD: 0, days: new Set(), daily: new Map(), spread }; variants.set(key, a); }
  const pnl = +c[C.pnl];
  a.n++; if (pnl > 0) a.wins++;
  a.pnl += pnl; a.creditSum += +c[C.credit]; a.wingSum += +c[C.wing]; a.sdSum += +c[C.sdbs]; a.durSum += slotToDur(slot);
  a.days.add(c[C.date]); a.daily.set(c[C.date], (a.daily.get(c[C.date]) ?? 0) + pnl);
  a.cum += pnl; if (a.cum > a.peak) a.peak = a.cum; if (a.peak - a.cum > a.maxDD) a.maxDD = a.peak - a.cum;
}
console.log(`Parsed ${lines.length - 1} trades → ${variants.size} variants (signal="${SIGNAL}").`);

// ── build dashboard sweep rows ───────────────────────────────────────────────
const newRows: any[] = [];
for (const [key, a] of variants) {
  const avgCredit = a.creditSum / a.n, avgWing = a.wingSum / a.n;
  const dd = Math.round(a.maxDD);
  newRows.push({
    signal: SIGNAL, spread: a.spread, exit: EXIT,
    pnl: +a.pnl.toFixed(0), pnl_gross: +a.pnl.toFixed(0),
    n: a.n, wr: +(100 * a.wins / a.n).toFixed(2), dd,
    ratio: dd > 0 ? +(a.pnl / dd).toFixed(2) : null,
    pos: 1, avgCredit: +avgCredit.toFixed(3),
    avgMaxRisk: Math.round((avgWing - avgCredit) * 100),
    avgPnlPerTrade: +(a.pnl / a.n).toFixed(2),
    peakConcurrent: 1, evictions: 0, avgConcurrent: 1,
    numActiveDays: a.days.size, avgDurMin: +(a.durSum / a.n).toFixed(1),
    fillModel: 'delta-bs', fillHalfSpread: null, exitGate: 'none', entryStaleSec: 0,
  });
}
// summary: best time-of-day (aggregate across delta/wing per slot)
const bySlot = new Map<string, { pnl: number; n: number; wins: number }>();
for (const [, a] of variants) { const slot = a.spread.split(' ')[0];
  const s = bySlot.get(slot) ?? { pnl: 0, n: 0, wins: 0 }; s.pnl += a.pnl; s.n += a.n; s.wins += Math.round(a.wins); bySlot.set(slot, s); }
console.log('\n=== SCS by entry time-of-day (all deltas/wings pooled) ===');
console.log('  slot     n      WR%     totalPnl   avgPnl');
for (const [slot, s] of [...bySlot].sort((a, b) => a[0].localeCompare(b[0])))
  console.log(`  ${slot}  ${String(s.n).padStart(5)}  ${(100 * s.wins / s.n).toFixed(1).padStart(5)}  ${String(Math.round(s.pnl)).padStart(10)}  ${(s.pnl / s.n).toFixed(1).padStart(7)}`);

if (DRY) { console.log('\n[--dry] not writing dashboard files.'); process.exit(0); }

// ── atomic merge helper ──────────────────────────────────────────────────────
function atomicWrite(file: string, data: any) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);   // atomic on same filesystem — dashboard never sees a half-file
}

// merge sweep rows: drop only our namespace, then concat
const sweepFile = path.join(OUT, 'spread-sweep.json');
const sweep = JSON.parse(fs.readFileSync(sweepFile, 'utf8'));
const sweepKept = sweep.filter((r: any) => r.signal !== SIGNAL);
atomicWrite(sweepFile, sweepKept.concat(newRows));
console.log(`\nspread-sweep.json: ${sweep.length} → ${sweepKept.length + newRows.length} rows (dropped ${sweep.length - sweepKept.length} stale SCS, added ${newRows.length}).`);

// merge daily series: align each variant to the dashboard's shared dates array
const dailyFile = path.join(OUT, 'spread-daily.json');
const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
const dates: string[] = daily.dates || [];
const dateIdx = new Map(dates.map((d, i) => [d, i]));
for (const k of Object.keys(daily.series || {})) if (k.startsWith(`${SIGNAL}|`)) delete daily.series[k];
let aligned = 0, dropped = 0;
for (const [key, a] of variants) {
  const arr = new Array(dates.length).fill(0);
  for (const [d, pnl] of a.daily) { const i = dateIdx.get(d); if (i == null) { dropped++; continue; } arr[i] = +pnl.toFixed(0); }
  daily.series[key] = arr; aligned++;
}
atomicWrite(dailyFile, daily);
console.log(`spread-daily.json: added ${aligned} SCS series (aligned to ${dates.length} dates; ${dropped} off-calendar trade-days dropped).`);
console.log('\nDone. Dashboard signal filter: "SCS TOD".');
