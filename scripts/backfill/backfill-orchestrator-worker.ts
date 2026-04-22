/**
 * backfill-orchestrator-worker — detached, server-spawned backfill runner.
 *
 * This is the long-running counterpart to `orchestrate-backfill.ts`. The
 * server's POST /api/backfill/orchestrate endpoint spawns this script
 * detached; the worker then updates `replay_jobs` (via job-store) so the
 * UI can poll progress.
 *
 * Lifecycle:
 *   1. Read job spec (JSON from argv[2]): { jobId, profileId, start?, end?, onlyMtf? }
 *   2. Load the profile from instrument_profiles.
 *   3. findMissingDates() → build date queue.
 *   4. For each "raw missing" date: spawn backfill-worker.ts, wait for exit.
 *   5. For each "MTF missing" date: buildMtfForSymbol in-process.
 *   6. Update progress on every transition; attach pid up front.
 *
 * Cancellation: the server writes status='cancelled' to replay_jobs when
 * the user requests it. We poll this every iteration and bail cleanly.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-orchestrator-worker.ts <spec.json>
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';

// Live DB — instrument_profiles only.
const LIVE_DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
import { loadProfile } from '../../src/instruments/profile-store';
import { findMissingDates, hasWorkPending, type CoverageGap } from '../../src/backfill/missing-dates';
import {
  buildMtfForSymbol,
  listSymbolsForDate,
  SUPPORTED_TIMEFRAMES,
} from '../../src/pipeline/mtf-builder';
import {
  attachPid,
  appendLog,
  getJob,
  markCancelled,
  markCompleted,
  markFailed,
  updateProgress,
  type BackfillProgress,
} from '../../src/backfill/job-store';
import type { StoredInstrumentProfile } from '../../src/instruments/profile-store';
import type { Database as DB } from 'better-sqlite3';

// ── Spec ─────────────────────────────────────────────────────────────────────

interface OrchestratorSpec {
  jobId: string;
  profileId: string;
  start?: string;
  end?: string;
  onlyMtf?: boolean;
  dbPath: string;
}

const specFile = process.argv[2];
if (!specFile || !fs.existsSync(specFile)) {
  console.error('[orchestrator-worker] missing or invalid spec file:', specFile);
  process.exit(1);
}
const spec: OrchestratorSpec = JSON.parse(fs.readFileSync(specFile, 'utf-8'));

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Live DB: instrument_profiles only (read-only)
  const liveDb = new Database(LIVE_DB_PATH, { readonly: true }) as unknown as DB;
  // Replay DB: replay_bars, replay_jobs, replay_configs (read-write)
  const replayDb = new Database(spec.dbPath) as unknown as DB;
  (replayDb as any).pragma('journal_mode = WAL');
  (replayDb as any).pragma('busy_timeout = 10000');
  const db = replayDb;

  attachPid(db, spec.jobId, process.pid);
  appendLog(db, spec.jobId, 'info', `orchestrator-worker started pid=${process.pid}`);

  let profile: StoredInstrumentProfile | null;
  try {
    profile = loadProfile(liveDb, spec.profileId);
  } catch (e: unknown) {
    fail(db, `profile lookup failed: ${(e as Error).message}`);
    return;
  }
  if (!profile) {
    fail(db, `profile '${spec.profileId}' not found`);
    return;
  }

  // ── Plan ─────────────────────────────────────────────────────────────────
  let gaps: CoverageGap[];
  try {
    gaps = findMissingDates(db, profile.underlyingSymbol, {
      start: spec.start,
      end: spec.end,
      anchorSymbol: 'SPX',
    });
  } catch (e: unknown) {
    fail(db, `findMissingDates failed: ${(e as Error).message}`);
    return;
  }

  const pending = gaps.filter(hasWorkPending);
  const rawMissing = pending.filter(g => g.missingRaw);
  const mtfMissing = pending.filter(g => !g.missingRaw);

  const initialPatch: Partial<BackfillProgress> = {
    phase: 'planning',
    totalDates: pending.length,
    rawMissingCount: rawMissing.length,
    mtfMissingCount: mtfMissing.length,
  };
  updateProgress(db, spec.jobId, initialPatch);
  appendLog(
    db, spec.jobId, 'info',
    `plan: ${pending.length} pending (${rawMissing.length} raw, ${mtfMissing.length} mtf)`,
  );

  if (pending.length === 0) {
    updateProgress(db, spec.jobId, { phase: 'up-to-date' });
    markCompleted(db, spec.jobId);
    appendLog(db, spec.jobId, 'info', 'nothing to do — coverage already complete');
    closeDb();
    return;
  }

  // ── Phase A: Raw fetches ─────────────────────────────────────────────────
  const dateResults: BackfillProgress['dateResults'] = [];
  let completedDates = 0;
  let barsWritten = 0;

  if (!spec.onlyMtf) {
    // Close replay DB so child backfill-worker can write
    (replayDb as any).close();

    for (let i = 0; i < rawMissing.length; i++) {
      // Re-open briefly to check for cancellation
      const checkDb = new Database(spec.dbPath) as unknown as DB;
      const job = getJob(checkDb, spec.jobId);
      if (job?.status === 'cancelled') {
        appendLog(checkDb, spec.jobId, 'warn', 'cancelled before raw phase complete');
        (checkDb as any).close();
        return;
      }
      updateProgress(checkDb, spec.jobId, {
        phase: `raw-fetch ${i + 1}/${rawMissing.length}`,
        currentDate: rawMissing[i].date,
        completedDates,
        barsWritten,
        dateResults,
      });
      (checkDb as any).close();

      const g = rawMissing[i];
      let ok = true;
      let error: string | undefined;
      try {
        await runRawBackfill(g.date, profile.id, spec.dbPath);
      } catch (e: unknown) {
        ok = false;
        error = (e as Error).message;
      }

      const upDb = new Database(spec.dbPath) as unknown as DB;
      const dr = { date: g.date, ok, barsWritten: 0, error };
      dateResults.push(dr);
      completedDates++;
      appendLog(upDb, spec.jobId, ok ? 'info' : 'error', `raw ${g.date}: ${ok ? 'ok' : error}`);
      updateProgress(upDb, spec.jobId, { completedDates, dateResults });
      (upDb as any).close();
    }
  }

  // ── Phase B: MTF rebuild ─────────────────────────────────────────────────
  const dbB = new Database(spec.dbPath) as unknown as DB;
  (dbB as any).pragma('journal_mode = WAL');
  (dbB as any).pragma('busy_timeout = 10000');
  for (let i = 0; i < mtfMissing.length; i++) {
    const job = getJob(dbB, spec.jobId);
    if (job?.status === 'cancelled') {
      appendLog(dbB, spec.jobId, 'warn', 'cancelled mid-MTF phase');
      closeDb();
      return;
    }
    const g = mtfMissing[i];

    updateProgress(dbB, spec.jobId, {
      phase: `mtf-rebuild ${i + 1}/${mtfMissing.length}`,
      currentDate: g.date,
      completedDates,
      barsWritten,
      dateResults,
    });

    const priorDate = priorTradingDate(dbB, profile.underlyingSymbol, g.date);
    const symbols = symbolsForProfile(dbB, g.date, profile);
    let writtenThisDate = 0;
    let ok = true;
    let error: string | undefined;
    for (const symbol of symbols) {
      const tier: 1 | 2 = symbol === profile.underlyingSymbol ? profile.tier : 1;
      try {
        const r = buildMtfForSymbol({
          db: dbB, symbol, tier, date: g.date, priorDate,
          timeframes: SUPPORTED_TIMEFRAMES, recompute1m: true,
        });
        writtenThisDate += r.barsWritten;
      } catch (e: unknown) {
        ok = false;
        error = (e as Error).message;
        appendLog(dbB, spec.jobId, 'error', `mtf ${g.date}/${symbol}: ${error}`);
      }
    }
    barsWritten += writtenThisDate;
    completedDates++;
    dateResults.push({ date: g.date, ok, barsWritten: writtenThisDate, error });
    appendLog(
      dbB, spec.jobId, ok ? 'info' : 'warn',
      `mtf ${g.date}: ${symbols.length} symbols, ${writtenThisDate} bars`,
    );
    updateProgress(dbB, spec.jobId, {
      completedDates,
      barsWritten,
      dateResults,
    });
  }

  updateProgress(dbB, spec.jobId, { phase: 'done', currentDate: null });
  markCompleted(dbB, spec.jobId);
  appendLog(dbB, spec.jobId, 'info', 'orchestrator-worker finished');
  (dbB as any).close();
  (liveDb as any).close();

  // Clean up spec file — best-effort
  try { fs.unlinkSync(specFile); } catch { /* ignore */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fail(db: DB, msg: string): void {
  console.error(`[orchestrator-worker] ${msg}`);
  try {
    appendLog(db, spec.jobId, 'error', msg);
    markFailed(db, spec.jobId, msg);
  } catch { /* ignore */ }
  process.exit(1);
}

function runRawBackfill(date: string, profileId: string, dbPath: string): Promise<void> {
  const jobId = `orch-${date}-${Date.now()}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-backfill-'));
  const jobFile = path.join(tmpDir, 'job.json');
  const statusFile = path.join(tmpDir, 'status.json');
  fs.writeFileSync(jobFile, JSON.stringify({ jobId, date, dbPath, statusFile, profileId }));

  return new Promise((resolve, reject) => {
    const workerScript = path.resolve(__dirname, 'backfill-worker.ts');
    const logFile = fs.openSync(path.join(tmpDir, 'worker.log'), 'a');
    const child = spawn('npx', ['tsx', workerScript, jobFile], {
      stdio: ['ignore', logFile, logFile],
      env: { ...process.env },
    });
    child.on('exit', (code) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      if (code === 0) resolve();
      else reject(new Error(`backfill-worker exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function symbolsForProfile(db: DB, date: string, profile: StoredInstrumentProfile): string[] {
  const all = listSymbolsForDate(db, date);
  const prefix = profile.optionPrefix;
  const underlying = profile.underlyingSymbol;
  return all.filter(s => s === underlying || s.startsWith(prefix));
}

function priorTradingDate(db: DB, underlying: string, date: string): string | null {
  const row = db.prepare(`
    SELECT date(ts, 'unixepoch') AS d
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m' AND date(ts, 'unixepoch') < ?
    ORDER BY ts DESC LIMIT 1
  `).get(underlying, date) as { d: string } | undefined;
  return row?.d ?? null;
}

// ── Kick-off ─────────────────────────────────────────────────────────────────

main().catch((e: unknown) => {
  console.error('[orchestrator-worker] fatal:', e);
  try {
    initDb(LIVE_DB_PATH);
    const db = getDb() as unknown as DB;
    markFailed(db, spec.jobId, (e as Error).message);
    closeDb();
  } catch { /* ignore */ }
  process.exit(1);
});

// Handle cancellation via SIGTERM (server sends this on user-initiated cancel)
process.on('SIGTERM', () => {
  try {
    initDb(LIVE_DB_PATH);
    const db = getDb() as unknown as DB;
    markCancelled(db, spec.jobId, 'SIGTERM received');
    closeDb();
  } catch { /* ignore */ }
  process.exit(143);
});
