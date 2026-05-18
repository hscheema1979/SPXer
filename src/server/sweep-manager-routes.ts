/**
 * sweep-manager-routes — REST surface for the ticker/backfill/sweep lifecycle
 * driven by scripts/diag/sweep-manager.ts. Powers the Studio "Tickers" page.
 *
 * Mounted at /replay/api/sweep-mgr/*  (the replay router already owns the
 * jobs infra + sweep viewer, so we live alongside it).
 *
 *   GET  /registry            registry + per-profile parquet/sweep status
 *   POST /discover            Polygon discovery preview (no writes)
 *   POST /onboard             spawn `sweep-manager onboard` (tracked job)
 *   POST /execute             spawn `sweep-manager execute` (tracked job)
 *   GET  /jobs                list sweep-manager jobs
 *   GET  /job/:jobId          job status + progress + log tail
 *   POST /job/:jobId/cancel   SIGTERM the worker, mark cancelled
 *
 * Long runs are tracked via the shared replay_jobs table (job-store.ts) and a
 * detached worker wrapper (scripts/diag/sweep-manager-job.ts) that mirrors
 * sweep-manager stdout into the job's progress/log. SPX-0dte is protected:
 * destructive ops (onboard/execute) refuse unless { forceSpx: true }.
 */

import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { REPLAY_META_DB } from '../storage/replay-db';
import { initReplayDb } from '../storage/replay-db';
import {
  createBackfillJob, attachPid, getJob, listJobs, markCancelled,
} from '../backfill/job-store';
import { discoverProfile, DiscoveryError } from '../instruments/discovery';

const META_DB_PATH = REPLAY_META_DB;
const ROOT = process.cwd();
const PARQUET_ROOT = path.resolve(ROOT, process.env.PARQUET_ROOT || 'data/parquet/bars');
const OUT_DIR = path.resolve(ROOT, 'scripts/autoresearch/output');
const REGISTRY = path.resolve(ROOT, 'scripts/diag/sweep-registry.json');
const JOB_DIR = path.resolve(ROOT, 'data', 'jobs');

const router = Router();

// One-time schema ensure (idempotent; full replay_jobs incl. kind/profile_id/
// progress_json so job-store inserts succeed even on a fresh DB).
let schemaReady = false;
function ensureSchema(): void {
  if (schemaReady) return;
  initReplayDb(META_DB_PATH);
  schemaReady = true;
}
function writeDb(): Database.Database { ensureSchema(); return new Database(META_DB_PATH); }
function readDb(): Database.Database { ensureSchema(); return new Database(META_DB_PATH, { readonly: true }); }

// ── Registry profile shape (mirrors scripts/diag/sweep-registry.json) ────────
interface RegProfile {
  symbol: string; dte: number;
  class?: 'index' | 'etf';
  strikeInterval?: number; optionPrefix?: string;
  underlyingPolygonTicker?: string; bandHalfWidthDollars?: number;
  protected?: boolean; note?: string;
}

function loadRegistry(): RegProfile[] {
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).profiles ?? []; }
  catch { return []; }
}

/** profileId + output-file suffix — MUST mirror sweep-symbol.ts exactly so the
 *  status we report matches what the CLI reads/writes. SPX-0dte keeps the
 *  legacy unsuffixed viewer file; everything else is namespaced. */
function profileId(symbol: string, dte: number): string {
  return `${symbol.toLowerCase()}-${dte}dte`;
}
function outSuffix(symbol: string, dte: number): string {
  const lower = symbol.toLowerCase();
  return (symbol.toUpperCase() === 'SPX' && dte === 0)
    ? ''
    : `-${lower}${dte === 0 ? '' : `-${dte}dte`}`;
}

/** SPX-0dte (unsuffixed) OR registry protected:true → destructive-op guard. */
function isProtected(symbol: string, dte: number): boolean {
  if (symbol.toUpperCase() === 'SPX' && dte === 0) return true;
  const r = loadRegistry().find(p => p.symbol.toUpperCase() === symbol.toUpperCase() && p.dte === dte);
  return !!(r && r.protected);
}

/** Weekday gaps between first and last available parquet date. */
function listMissingWeekdays(dates: string[]): string[] {
  if (dates.length < 2) return [];
  const have = new Set(dates);
  const miss: string[] = [];
  const d = new Date(dates[0] + 'T12:00:00Z');
  const end = new Date(dates[dates.length - 1] + 'T12:00:00Z');
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const s = d.toISOString().slice(0, 10);
      if (!have.has(s)) miss.push(s);
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return miss;
}

function parquetDates(pid: string): string[] {
  const dir = path.join(PARQUET_ROOT, pid);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map(f => f.slice(0, 10))
    .sort();
}

function sweepStatus(symbol: string, dte: number) {
  const sfx = outSuffix(symbol, dte);
  const sweepFile = path.join(OUT_DIR, `spread-sweep${sfx}.json`);
  const riskFile = path.join(OUT_DIR, `risk-analysis${sfx}.json`);
  let rows = 0, iron = 0, credit = 0, risk = 0;
  if (fs.existsSync(sweepFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(sweepFile, 'utf8'));
      rows = arr.length;
      iron = arr.filter((r: { spread?: string }) => /^I[BC]/.test(r.spread || '')).length;
      credit = rows - iron;
    } catch { /* corrupt/partial — report zero */ }
  }
  if (fs.existsSync(riskFile)) {
    try { risk = Object.keys(JSON.parse(fs.readFileSync(riskFile, 'utf8'))).length; } catch { /* ignore */ }
  }
  return { hasSweep: rows > 0, rows, iron, credit, risk };
}

// ── GET /registry — registry + per-profile coverage & sweep status ───────────
router.get('/registry', (_req: Request, res: Response) => {
  try {
    const profiles = loadRegistry().map(p => {
      const pid = profileId(p.symbol, p.dte);
      const dates = parquetDates(pid);
      const gaps = listMissingWeekdays(dates);
      return {
        symbol: p.symbol,
        dte: p.dte,
        profileId: pid,
        class: p.class ?? null,
        strikeInterval: p.strikeInterval ?? null,
        optionPrefix: p.optionPrefix ?? null,
        underlyingPolygonTicker: p.underlyingPolygonTicker ?? null,
        bandHalfWidthDollars: p.bandHalfWidthDollars ?? null,
        protected: isProtected(p.symbol, p.dte),
        note: p.note ?? null,
        bars: {
          count: dates.length,
          first: dates[0] ?? null,
          last: dates[dates.length - 1] ?? null,
          gaps: gaps.length,
        },
        sweep: sweepStatus(p.symbol, p.dte),
      };
    });
    res.json({ profiles });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── POST /discover — Polygon discovery preview (no writes) ───────────────────
router.post('/discover', async (req: Request, res: Response) => {
  const symbol = String(req.body?.symbol ?? '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol is required' });
  try {
    const d = await discoverProfile(symbol);
    // Tradeable-horizon hint: daily-expiry chain → 0DTE; weekly/monthly-only
    // (single stocks / physically-settled ETFs) → 1DTE. Mirrors the CLI.
    const suggestedDte = d.expiryCadences.includes('daily') ? 0 : 1;
    // RegProfile.class is index|etf — equity shares the etf width caps.
    const registryClass: 'index' | 'etf' = d.assetClass === 'index' ? 'index' : 'etf';
    res.json({
      symbol,
      discovered: d,
      suggestedDte,
      registryClass,
      alreadyRegistered: loadRegistry().some(
        p => p.symbol.toUpperCase() === symbol && p.dte === suggestedDte,
      ),
    });
  } catch (e) {
    if (e instanceof DiscoveryError) {
      const code = e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_API_KEY' ? 503 : 502;
      return res.status(code).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: (e as Error).message });
  }
});

// ── Job spawn helper (shared by /onboard + /execute) ─────────────────────────
type SweepCmd = 'onboard' | 'execute';

function spawnSweepJob(
  res: Response,
  command: SweepCmd,
  opts: { symbol: string; dte: number; days?: number; forceSpx?: boolean; overrides?: Record<string, string> },
): void {
  const symbol = opts.symbol.toUpperCase();
  const { dte } = opts;
  if (!symbol || !Number.isFinite(dte) || dte < 0) {
    res.status(400).json({ error: 'symbol and a non-negative integer dte are required' });
    return;
  }
  if (command === 'onboard' && (!opts.days || opts.days < 1)) {
    res.status(400).json({ error: 'onboard requires days >= 1' });
    return;
  }
  // SPX protection — mirrors sweep-manager --force-spx gate.
  if (isProtected(symbol, dte) && !opts.forceSpx) {
    res.status(403).json({
      error: `${symbol}-${dte}dte is protected. Re-send with { "forceSpx": true } to override.`,
      protected: true,
    });
    return;
  }

  const jobId = randomUUID();
  const pid = profileId(symbol, dte);
  const db = writeDb();
  try {
    createBackfillJob(db, {
      id: jobId,
      profileId: pid,
      totalDates: opts.days ?? 0,
      initialProgress: { phase: `${command}:queued` },
    });

    if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });
    const specFile = path.join(JOB_DIR, `sweepmgr-${jobId}.json`);
    fs.writeFileSync(specFile, JSON.stringify({
      jobId, command, symbol, dte,
      days: opts.days ?? null,
      forceSpx: !!opts.forceSpx,
      overrides: opts.overrides ?? {},
      dbPath: META_DB_PATH,
    }));

    const worker = path.resolve(ROOT, 'scripts/diag/sweep-manager-job.ts');
    const logFd = fs.openSync(path.join(JOB_DIR, `sweepmgr-${jobId}.log`), 'a');
    const child = spawn('npx', ['tsx', worker, specFile], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    if (child.pid) attachPid(db, jobId, child.pid);

    res.json({ jobId, command, symbol, dte, profileId: pid, pid: child.pid ?? null });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    db.close();
  }
}

// Whitelisted discovery overrides → sweep-manager CLI flags.
function pickOverrides(body: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {
    class: 'class', strikeInterval: 'strike-interval', optionPrefix: 'option-prefix',
    underlyingTicker: 'underlying-ticker', band: 'band',
  };
  const out: Record<string, string> = {};
  for (const [k, flag] of Object.entries(map)) {
    if (body[k] != null && body[k] !== '') out[flag] = String(body[k]);
  }
  return out;
}

// ── POST /onboard — discover+register → backfill → verify → execute ──────────
router.post('/onboard', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  spawnSweepJob(res, 'onboard', {
    symbol: String(b.symbol ?? ''),
    dte: Number(b.dte),
    days: b.days != null ? Number(b.days) : undefined,
    forceSpx: b.forceSpx === true,
    overrides: pickOverrides(b),
  });
});

// ── POST /execute — clean regen of the sweeps (data already backfilled) ──────
router.post('/execute', (req: Request, res: Response) => {
  const b = (req.body ?? {}) as Record<string, unknown>;
  spawnSweepJob(res, 'execute', {
    symbol: String(b.symbol ?? ''),
    dte: Number(b.dte),
    days: b.days != null ? Number(b.days) : undefined,
    forceSpx: b.forceSpx === true,
  });
});

// ── GET /jobs — list sweep-manager jobs ──────────────────────────────────────
router.get('/jobs', (req: Request, res: Response) => {
  const db = readDb();
  try {
    const limit = req.query.limit ? Math.max(1, Math.min(200, Number(req.query.limit))) : 50;
    // sweep-manager jobs are stored as kind='backfill'; filter to ours by the
    // sweepmgr- spec file convention is unnecessary — profileId scoping +
    // recency is enough for the UI. Return the recent backfill-kind jobs.
    const jobs = listJobs(db, { kind: 'backfill', limit });
    res.json({ jobs });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    db.close();
  }
});

// ── GET /job/:jobId — status + progress + log tail ───────────────────────────
router.get('/job/:jobId', (req: Request, res: Response) => {
  const db = readDb();
  try {
    const job = getJob(db, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    let logTail: string[] = [];
    const logPath = path.join(JOB_DIR, `sweepmgr-${req.params.jobId}.log`);
    try {
      const lines = parseInt(String(req.query.lines ?? '120'), 10) || 120;
      logTail = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).slice(-lines);
    } catch { /* no log yet */ }
    res.json({ job, logTail });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    db.close();
  }
});

// ── POST /job/:jobId/cancel — SIGTERM worker, mark cancelled ─────────────────
router.post('/job/:jobId/cancel', (req: Request, res: Response) => {
  const db = writeDb();
  try {
    const job = getJob(db, req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'running' && job.status !== 'pending') {
      return res.status(409).json({ error: `Job already ${job.status}` });
    }
    markCancelled(db, req.params.jobId, 'cancelled via API');
    if (job.pid) { try { process.kill(job.pid, 'SIGTERM'); } catch { /* already gone */ } }
    res.json({ ok: true, jobId: req.params.jobId });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  } finally {
    db.close();
  }
});

export function createSweepManagerRoutes(): Router {
  return router;
}
