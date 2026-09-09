/**
 * merge-spxhma-chunks.ts — append new SPXHMA sweep chunks into the existing
 * dashboard files WITHOUT overwriting existing rows. Atomic swap so the live
 * Studio Backtest UI never sees a half-written file.
 *
 * Background: hma3m-to-dashboard.ts rebuilds long-sweep-spxhma.json (and the
 * daily/hourly/risk companions) from a list of --in chunks. We don't have all
 * the original source chunks any more — they came from different runs over
 * months. So we keep the existing files as-is and only ADD rows from new
 * chunks. Dedup by configId for table rows, by variantKey for daily series.
 *
 * Usage:
 *   npx tsx scripts/diag/merge-spxhma-chunks.ts \
 *     --window 09:30-16:00 \
 *     --chunk scripts/autoresearch/output/full-sweep-spxhma/chunk-10-HMA-1m-itm-dense.json \
 *     --chunk scripts/autoresearch/output/full-sweep-spxhma/chunk-11-HMA-multitf-itm-dense.json
 *
 * Writes:
 *   scripts/autoresearch/output/long-sweep-spxhma.json   (rows merged)
 *   scripts/autoresearch/output/long-daily-spxhma.json   (series merged, dates unioned)
 *   scripts/autoresearch/output/etf-long-sweep-spxhma.json  (mirror of long-sweep)
 *
 * Skips long-hourly + risk-analysis — those are sparse/on-demand for longs
 * (only focused fixed-configs populate them; coarse cells use row.hourlyPnl
 * which is embedded directly on each row).
 */
import * as fs from 'fs';
import * as path from 'path';

function argAll(flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length - 1; i++) if (process.argv[i] === flag) out.push(process.argv[i + 1]);
  return out;
}
function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const CHUNKS = argAll('--chunk');
const WINDOW = argVal('--window', '09:30-16:00');
const TICKER = argVal('--ticker', 'spxhma');
const OUT_DIR = path.join(process.cwd(), 'scripts/autoresearch/output');

if (!CHUNKS.length) { console.error('usage: --chunk <path> [--chunk ...] [--window 09:30-16:00] [--ticker spxhma]'); process.exit(2); }

function moneynessTag(off: number): string {
  if (off === 0) return 'ATM';
  return off < 0 ? `${Math.abs(off)}ITM` : `${off}OTM`;
}
function maTypeFromSig(label: string): string { return /HMA/i.test(label) ? 'HMA' : 'HMA'; }
function tfClassFromSig(label: string): string { const m = label.match(/(\d+m)\b/); return m ? m[1] : '3m'; }
function fastSlowFromSig(label: string): string { const m = label.match(/(\d+)x(\d+)/); return m ? `${m[1]}x${m[2]}` : '?'; }

// ── Build rows from a single chunk (coarse-grid path only — these dense fills
// use the same coarse output shape; no mFixed/fixed[] rows).
// Each cell yields one row with embedded hourlyPnl + avgEntryPx + maxDrawdown,
// matching the schema the existing 9,512 SPXHMA rows already use.
interface Row {
  source: string; configId: string; symbol: string;
  signal: string; spread: string; exit: string;
  tp: number; sl: number; offset: number; moneyness: string; maType: string; tfClass: string;
  pnl: number; pnlPct: number; n: number; wins: number; losses: number; wr: number;
  dd: number; ratio: number; sharpe: number; profitFactor: number; expectancy: number;
  posDays: number; negDays: number; pos: number; worstDay: number; bestDay: number;
  avgCredit: number; avgMaxRisk: number; avgPnlPerTrade: number; avgDurMin: number;
  numActiveDays: number;
  hourlyPnl: { [bucket: string]: { pnl: number; n: number; wins: number } };
  avgEntryPx: number;
}

function rowsFromChunk(chunkPath: string, window: string): { rows: Row[]; dailyByVariant: Map<string, Map<string, number>>; allDates: Set<string> } {
  const j = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
  const rows: Row[] = [];
  const dailyByVariant = new Map<string, Map<string, number>>();
  const allDates = new Set<string>();

  for (const [_sym, sd] of Object.entries<any>(j.symbols || {})) {
    const dates: string[] = sd.dates || [];
    dates.forEach((d: string) => allDates.add(d));
    for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
      const mGrid = label.match(/^(HMA \d+m \d+x\d+|HMA 2\+3 \d+x\d+|HMA 2\+3\+5 \d+x\d+)\s+@\s+(\d+(?:ITM|OTM)|ATM)$/);
      if (!mGrid) { console.warn(`skip unrecognized label: ${label}`); continue; }
      const sigBase = mGrid[1];
      const money = mGrid[2];
      const offset = money === 'ATM' ? 0 : money.endsWith('ITM') ? -parseInt(money) : parseInt(money);
      const dashSignal = `${sigBase} ${window}`;
      const tag = window.replace(/[^0-9]/g, '');

      for (const cell of (sig.coarse || [])) {
        if (!cell.trades || cell.trades === 0) continue;
        const n = cell.trades, wins = cell.wins;
        const losses = n - wins;
        const winRate = typeof cell.winRate === 'number' ? cell.winRate : (n > 0 ? wins / n : 0);
        const wr = +(winRate * 100).toFixed(2);
        const pnl = cell.pnl;
        const avgPnl = typeof cell.avgPnl === 'number' ? cell.avgPnl : (n > 0 ? pnl / n : 0);
        const daysWithTrade = cell.daysWithTrade;
        const profitDays = cell.profitDays;
        const negDays = daysWithTrade - profitDays;
        const dd = +(cell.maxDrawdown ?? 0).toFixed(2);
        const ddRatio = dd > 0 ? +(pnl / dd).toFixed(2) : 0;
        const configId = `hma3m-spx-${fastSlowFromSig(sigBase).toLowerCase()}-${money.toLowerCase()}-tp${cell.tp}-sl${cell.sl}-w${tag}`;

        rows.push({
          source: 'long', configId, symbol: 'SPX',
          signal: dashSignal,
          spread: `long ${money}`,
          exit: `TP${cell.tp}/SL${cell.sl}`,
          tp: cell.tp, sl: cell.sl, offset,
          moneyness: money,
          maType: maTypeFromSig(sigBase),
          tfClass: tfClassFromSig(sigBase),
          pnl: +pnl.toFixed(2),
          pnlPct: 0,
          n, wins, losses, wr, dd,
          ratio: ddRatio,
          sharpe: 0,
          profitFactor: losses > 0 ? +(wins / losses).toFixed(3) : 0,
          expectancy: +avgPnl.toFixed(3),
          posDays: profitDays, negDays,
          pos: profitDays,
          worstDay: 0, bestDay: 0,
          avgCredit: 0, avgMaxRisk: 0,
          avgPnlPerTrade: +avgPnl.toFixed(2),
          avgDurMin: 0,
          numActiveDays: daysWithTrade,
          hourlyPnl: cell.hourlyPnl || {},
          avgEntryPx: +(cell.avgEntryPx ?? 0).toFixed(2),
        });

        // Daily series key matches Studio variantKey() for source="long".
        if (cell.dailyPnl) {
          const key = `long::${dashSignal}::${money}::TP${cell.tp}/SL${cell.sl}`;
          const dayMap = dailyByVariant.get(key) || new Map<string, number>();
          for (const [d, v] of Object.entries<number>(cell.dailyPnl)) {
            dayMap.set(d, (dayMap.get(d) || 0) + (v as number));
          }
          dailyByVariant.set(key, dayMap);
        }
      }
    }
  }
  return { rows, dailyByVariant, allDates };
}

// ── Atomic write: write to .tmp then rename, so the dashboard never sees a
// partial file. Per [[feedback_never_purge_live_dashboard_data]] — never leave
// the live :3700 dashboard with a missing/half-written file.
function writeAtomic(filePath: string, content: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ── Step 1: gather new rows from all chunks.
const newRows: Row[] = [];
const newDaily = new Map<string, Map<string, number>>();
const newDates = new Set<string>();
for (const chunk of CHUNKS) {
  const abs = path.isAbsolute(chunk) ? chunk : path.join(process.cwd(), chunk);
  if (!fs.existsSync(abs)) { console.error(`chunk not found: ${abs}`); process.exit(2); }
  console.log(`reading ${chunk} …`);
  const { rows, dailyByVariant, allDates } = rowsFromChunk(abs, WINDOW);
  console.log(`  ${rows.length} rows, ${dailyByVariant.size} daily series, ${allDates.size} dates`);
  newRows.push(...rows);
  for (const [k, m] of dailyByVariant) {
    const existing = newDaily.get(k) || new Map<string, number>();
    for (const [d, v] of m) existing.set(d, (existing.get(d) || 0) + v);
    newDaily.set(k, existing);
  }
  for (const d of allDates) newDates.add(d);
}
console.log(`\nTotal new: ${newRows.length} rows, ${newDaily.size} daily series, ${newDates.size} dates\n`);

// ── Step 2: merge into long-sweep-spxhma.json
const sweepPath = path.join(OUT_DIR, `long-sweep-${TICKER}.json`);
const etfPath = path.join(OUT_DIR, `etf-long-sweep-${TICKER}.json`);
const dailyPath = path.join(OUT_DIR, `long-daily-${TICKER}.json`);

const existingSweep: Row[] = fs.existsSync(sweepPath) ? JSON.parse(fs.readFileSync(sweepPath, 'utf8')) : [];
console.log(`existing sweep: ${existingSweep.length} rows`);

// Dedup by configId — if a row with the same configId already exists, the new
// row wins (we just re-ran it). Otherwise append.
const byConfigId = new Map<string, Row>();
for (const r of existingSweep) byConfigId.set(r.configId, r);
let added = 0, replaced = 0;
for (const r of newRows) {
  if (byConfigId.has(r.configId)) replaced++; else added++;
  byConfigId.set(r.configId, r);
}
const mergedRows = [...byConfigId.values()];
console.log(`  added ${added}, replaced ${replaced} → ${mergedRows.length} total`);

writeAtomic(sweepPath, JSON.stringify(mergedRows, null, 2));
console.log(`✓ wrote ${sweepPath}`);
writeAtomic(etfPath, JSON.stringify(mergedRows, null, 2));
console.log(`✓ wrote ${etfPath}`);

// ── Step 3: merge into long-daily-spxhma.json
//   Shape: { dates: string[], series: { variantKey: number[] } }
//   Union dates with existing; rebuild each series aligned to the new union.
const existingDaily: { dates: string[]; series: { [k: string]: number[] } } =
  fs.existsSync(dailyPath) ? JSON.parse(fs.readFileSync(dailyPath, 'utf8')) : { dates: [], series: {} };
console.log(`\nexisting daily: ${existingDaily.dates.length} dates, ${Object.keys(existingDaily.series).length} series`);

// Build a per-variant {date -> pnl} map from BOTH existing and new.
const allVariantMaps = new Map<string, Map<string, number>>();
for (const [key, arr] of Object.entries(existingDaily.series)) {
  const m = new Map<string, number>();
  existingDaily.dates.forEach((d, i) => { if (arr[i] !== 0 || true) m.set(d, arr[i]); });
  allVariantMaps.set(key, m);
}
for (const [key, m] of newDaily) {
  if (allVariantMaps.has(key)) {
    // Replace: new sweep overrides this variant entirely (it's the fresh data).
    allVariantMaps.set(key, m);
  } else {
    allVariantMaps.set(key, m);
  }
}

// Union the date list.
const datesSet = new Set<string>(existingDaily.dates);
for (const d of newDates) datesSet.add(d);
const sortedDates = [...datesSet].sort();

// Realign each series to the unioned date list. Missing dates become 0.
const mergedSeries: { [k: string]: number[] } = {};
for (const [key, m] of allVariantMaps) {
  mergedSeries[key] = sortedDates.map(d => +(m.get(d) ?? 0).toFixed(2));
}
console.log(`merged daily: ${sortedDates.length} dates, ${Object.keys(mergedSeries).length} series`);

writeAtomic(dailyPath, JSON.stringify({ dates: sortedDates, series: mergedSeries }, null, 2));
console.log(`✓ wrote ${dailyPath}`);

console.log(`\nDone. Refresh Studio Backtest page (profile SPXHMA) to see new rows.`);
