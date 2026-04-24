/**
 * orchestrate-backfill.ts — Universal, symbol-agnostic backfill CLI.
 *
 * For a given profile + date range:
 *   1. Find coverage gaps via src/backfill/missing-dates.
 *   2. For each gap:
 *      a. If raw 1m is missing → spawn backfill-worker.ts for that date.
 *      b. Else if MTFs/indicators are missing → run build-mtf-bars
 *         in-process for that date.
 *   3. Report per-date progress.
 *
 * This is the Phase 2 interactive CLI face of the orchestrator. Phase 3
 * ships a detached worker variant (backfill-orchestrator-worker.ts) that
 * the server can spawn and report progress via replay_jobs.
 *
 * Usage:
 *   npx tsx scripts/backfill/orchestrate-backfill.ts --profile=ndx-0dte
 *   npx tsx scripts/backfill/orchestrate-backfill.ts --profile=spx-0dte --start=2026-02-20 --end=2026-03-20
 *   npx tsx scripts/backfill/orchestrate-backfill.ts --profile=ndx-0dte --only-mtf   # skip raw fetch
 *   npx tsx scripts/backfill/orchestrate-backfill.ts --profile=ndx-0dte --dry-run    # just print the plan
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { loadProfile } from '../../src/instruments/profile-store';
import { findMissingDates, hasWorkPending } from '../../src/backfill/missing-dates';
import {
  buildMtfForSymbol,
  SUPPORTED_TIMEFRAMES,
  listSymbolsForDate,
} from '../../src/pipeline/mtf-builder';
import type { Database as DB } from 'better-sqlite3';
import type { StoredInstrumentProfile } from '../../src/instruments/profile-store';

const LIVE_DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const DB_PATH = path.resolve(process.env.DB_PATH || process.env.REPLAY_DB_PATH || path.resolve(__dirname, '../../data/replay.db'));

// ── CLI args ─────────────────────────────────────────────────────────────────

interface Args {
  profile: string;
  start?: string;
  end?: string;
  onlyMtf: boolean;
  dryRun: boolean;
}

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const a = raw.find(x => x.startsWith(`--${name}=`));
    return a ? a.split('=').slice(1).join('=') : undefined;
  };
  const has = (name: string): boolean => raw.includes(`--${name}`);
  const profile = get('profile');
  if (!profile) {
    console.error('Usage: --profile=<id> [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] [--only-mtf] [--dry-run]');
    process.exit(1);
  }
  return {
    profile,
    start: get('start'),
    end: get('end'),
    onlyMtf: has('only-mtf'),
    dryRun: has('dry-run'),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Spawn backfill-worker.ts as a detached child and wait for it to finish.
 * Reuses the existing worker so we don't duplicate Polygon/Theta fetch logic.
 */
function runRawBackfill(date: string, profileId: string): Promise<void> {
  const jobId = `orch-${date}-${Date.now()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backfill-'));
  const jobFile = path.join(tmpDir, 'job.json');
  const statusFile = path.join(tmpDir, 'status.json');
  const spec = { jobId, date, dbPath: DB_PATH, statusFile, profileId };
  fs.writeFileSync(jobFile, JSON.stringify(spec));

  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['tsx', path.join(__dirname, 'backfill-worker.ts'), jobFile],
      { stdio: 'inherit' },
    );
    child.on('exit', (code) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (code === 0) resolve();
      else reject(new Error(`backfill-worker exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

/**
 * Filter the per-date symbol list to ones that belong to this profile:
 * underlying + any options matching the profile's OCC root prefix.
 */
function symbolsForProfile(db: DB, date: string, profile: StoredInstrumentProfile): string[] {
  const all = listSymbolsForDate(db, date);
  const prefix = profile.optionPrefix;
  const underlying = profile.underlyingSymbol;
  return all.filter(s => s === underlying || s.startsWith(prefix));
}

/**
 * Prior trading-day for the profile's underlying. Used to seed indicator
 * state for cross-day continuity.
 */
function priorTradingDate(db: DB, underlying: string, date: string): string | null {
  const row = db.prepare(`
    SELECT date(ts, 'unixepoch') AS d
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m' AND date(ts, 'unixepoch') < ?
    ORDER BY ts DESC LIMIT 1
  `).get(underlying, date) as { d: string } | undefined;
  return row?.d ?? null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();
  // Live DB: instrument_profiles (read-only)
  const liveDb = new Database(LIVE_DB_PATH, { readonly: true }) as unknown as DB;
  // Replay DB: replay_bars (read-write)
  const replayDb = new Database(DB_PATH) as unknown as DB;
  (replayDb as any).pragma('journal_mode = WAL');
  (replayDb as any).pragma('busy_timeout = 10000');

  try {
    const profile = loadProfile(liveDb, args.profile);
    if (!profile) {
      console.error(`[orchestrate] Profile '${args.profile}' not found`);
      process.exit(1);
    }

    // Trading-day universe: anchor on SPX coverage so we share a calendar
    // across profiles. A brand-new ticker with zero coverage still resolves
    // the right calendar this way.
    const gaps = findMissingDates(replayDb, profile.underlyingSymbol, {
      start: args.start,
      end: args.end,
      anchorSymbol: 'SPX',
    });

    const pending = gaps.filter(hasWorkPending);
    const rawMissing = pending.filter(g => g.missingRaw);
    const mtfMissing = pending.filter(g => !g.missingRaw);

    console.log(`\n━━━ orchestrate-backfill ━━━`);
    console.log(`  profile       : ${profile.id} (${profile.displayName})`);
    console.log(`  underlying    : ${profile.underlyingSymbol}`);
    console.log(`  range         : ${args.start ?? 'beginning'} → ${args.end ?? 'end'}`);
    console.log(`  trading dates : ${gaps.length}`);
    console.log(`  fully covered : ${gaps.length - pending.length}`);
    console.log(`  need raw fetch: ${rawMissing.length}`);
    console.log(`  need MTF rbuild: ${mtfMissing.length}`);
    if (args.onlyMtf && rawMissing.length > 0) {
      console.log(`  (--only-mtf set — skipping ${rawMissing.length} raw-fetch dates)`);
    }
    if (args.dryRun) {
      console.log('\n  Plan:');
      for (const g of pending.slice(0, 20)) {
        console.log(`    ${g.date}  raw=${g.missingRaw ? 'MISSING' : 'ok'}  mtfs=[${g.missingMtfs.join(',')}]  inds=[${g.missingIndicators.join(',')}]`);
      }
      if (pending.length > 20) console.log(`    ... and ${pending.length - 20} more`);
      console.log('\n  Dry run — no changes made.');
      return;
    }

    // Phase A: raw fetches serially. We run backfill-worker as a child so
    // its existing flock-free Polygon/Theta clients don't stomp this
    // process's SQLite handle.
    if (!args.onlyMtf) {
      (replayDb as any).close(); // release connection before spawning child
      for (let i = 0; i < rawMissing.length; i++) {
        const g = rawMissing[i];
        console.log(`\n[${i + 1}/${rawMissing.length}] raw backfill: ${g.date}`);
        try {
          await runRawBackfill(g.date, profile.id);
        } catch (e: any) {
          console.error(`  ✗ ${g.date}: ${e.message}`);
        }
      }
    }

    // Phase B: MTF + indicator rebuild for dates where raw is present but
    // MTFs or denormalized columns are incomplete. This is in-process
    // because mtf-builder is fast and doesn't touch the network.
    const dbB = new Database(DB_PATH) as unknown as DB;
    (dbB as any).pragma('journal_mode = WAL');
    (dbB as any).pragma('busy_timeout = 10000');
    if (mtfMissing.length > 0) {
      console.log(`\n━━━ Phase B: MTF + indicator rebuild ━━━`);
      for (let i = 0; i < mtfMissing.length; i++) {
        const g = mtfMissing[i];
        const priorDate = priorTradingDate(dbB, profile.underlyingSymbol, g.date);
        const syms = symbolsForProfile(dbB, g.date, profile);
        let written = 0;
        for (const symbol of syms) {
          const tier: 1 | 2 = symbol === profile.underlyingSymbol ? profile.tier : 1;
          try {
            const r = buildMtfForSymbol({
              db: dbB, symbol, tier, date: g.date, priorDate,
              timeframes: SUPPORTED_TIMEFRAMES, recompute1m: true,
            });
            written += r.barsWritten;
          } catch (e: any) {
            console.error(`  ✗ ${g.date} ${symbol}: ${e.message}`);
          }
        }
        console.log(`  [${i + 1}/${mtfMissing.length}] ${g.date}: ${syms.length} symbols, ${written} bars written`);
      }
    }
    try { (dbB as any).close(); } catch {}

    console.log(`\n✓ orchestrate-backfill complete for ${profile.id}`);
  } finally {
    try { (liveDb as any).close(); } catch {}
  }
}

main().catch(e => {
  console.error('[orchestrate-backfill] Fatal:', e);
  process.exit(1);
});
