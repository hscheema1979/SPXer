/**
 * annotate-sweep-params — one-off backfill (FR-002 / OA Phase 0).
 *
 * Stamps existing sweep-output JSONs with the structured `params` object and
 * `pf` the engines now emit on fresh runs:
 *   - params: parsed from the row's (signal, spread, exit) labels via the same
 *     grammar as scripts/diag/sweep-params.ts. Rows whose labels don't parse
 *     are left without `params` (promote falls back / refuses, as before).
 *   - pf: recomputed from per-trade files (output/{spread,iron}-trades/{slug}/)
 *     where they exist; null otherwise (per-trade emission was env-gated, so
 *     only some variants have trade files). Fresh sweeps compute pf for every
 *     row natively.
 *
 * Idempotent: re-running re-derives the same values. Row order and all
 * existing keys are preserved; only `params` and `pf` are touched.
 *
 * Usage:
 *   npx tsx scripts/diag/annotate-sweep-params.ts            # write in place
 *   npx tsx scripts/diag/annotate-sweep-params.ts --dry-run  # report only
 *   ANNOTATE_OUT_DIR=/tmp/x npx tsx scripts/diag/annotate-sweep-params.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseSweepRowParams, profitFactor } from './sweep-params';

const DRY_RUN = process.argv.includes('--dry-run');
const OUT_DIR = process.env.ANNOTATE_OUT_DIR
  || path.join(process.cwd(), 'scripts/autoresearch/output');

// sweep file prefix → per-trade dir (same layout the engines' EMIT_DIR uses)
const TRADES_DIR_BY_PREFIX: Record<string, string> = {
  spread: 'spread-trades',
  iron: 'iron-trades',
};

function slugify(k: string): string {
  return k.replace(/[|]/g, '__').replace(/\s+/g, '_');
}

interface PfTotals { gw: number; gl: number; }

/** Sum net P&L of every trade file under a variant's slug dir. */
function pfFromTradeFiles(tradesDir: string, row: any): number | null {
  const key = `${row.signal}|${row.spread}|${row.exit}`;
  const dir = path.join(tradesDir, slugify(key));
  let files: string[];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return null; }
  if (files.length === 0) return null;
  const t: PfTotals = { gw: 0, gl: 0 };
  let trades = 0;
  for (const f of files) {
    try {
      const day = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const tr of day.trades ?? []) {
        const pnl = Number(tr.pnlNet);
        if (!Number.isFinite(pnl)) continue;
        trades++;
        if (pnl > 0) t.gw += pnl;
        else if (pnl < 0) t.gl += -pnl;
      }
    } catch { /* skip unreadable day file */ }
  }
  if (trades === 0) return null;
  // Trade files cover only the dates that were emitted — a pf over a subset is
  // still directionally honest, but flag the coverage in the row.
  return profitFactor(t.gw, t.gl);
}

function annotateFile(file: string): void {
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  const rows: any[] = Array.isArray(json) ? json : Array.isArray(json?.rows) ? json.rows : null;
  if (!rows) { console.log(`  ✗ ${path.basename(file)}: no top-level/rows array — skipped`); return; }

  const prefix = Object.keys(TRADES_DIR_BY_PREFIX).find((p) => path.basename(file).startsWith(p));
  const tradesDir = prefix ? path.join(OUT_DIR, TRADES_DIR_BY_PREFIX[prefix]) : null;

  let withParams = 0, withPf = 0, unparsed: string[] = [];
  for (const r of rows) {
    if (typeof r?.signal !== 'string' || typeof r?.spread !== 'string' || typeof r?.exit !== 'string') continue;
    const params = parseSweepRowParams(r.signal, r.spread, r.exit);
    if (params) { r.params = params; withParams++; }
    else if (unparsed.length < 5) unparsed.push(`${r.signal}|${r.spread}|${r.exit}`);
    const pf = tradesDir ? pfFromTradeFiles(tradesDir, r) : null;
    r.pf = pf; // null when no trade files — fresh sweeps fill it natively
    if (pf != null) withPf++;
  }
  const verb = DRY_RUN ? 'would stamp' : 'stamped';
  console.log(`  ${DRY_RUN ? '∼' : '✓'} ${path.basename(file)}: ${verb} params on ${withParams}/${rows.length}, pf on ${withPf}/${rows.length}`);
  for (const u of unparsed) console.log(`      (unparsed: ${u})`);

  if (!DRY_RUN) {
    const out = Array.isArray(json) ? rows : { ...json, rows };
    // Engines write the studio copies compact — preserve that convention.
    const pretty = raw.includes('\n  "');
    fs.writeFileSync(file, pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out));
  }
}

// ── main ────────────────────────────────────────────────────────────────────
console.log(`annotate-sweep-params — ${DRY_RUN ? 'DRY RUN' : 'writing'} to ${OUT_DIR}`);
let files: string[] = [];
try { files = fs.readdirSync(OUT_DIR).filter((f) => /^(spread|iron)-sweep.*\.json$/.test(f)); } catch {
  console.error(`output dir not found: ${OUT_DIR}`);
  process.exit(1);
}
if (files.length === 0) { console.log('  (no *-sweep*.json files found)'); process.exit(0); }
for (const f of files) annotateFile(path.join(OUT_DIR, f));
console.log(`done: ${files.length} file(s)${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
