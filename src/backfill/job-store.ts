/**
 * job-store — typed API on top of the `replay_jobs` table.
 *
 * The table was originally used for replay batch runs. UNIVERSAL-BACKFILL
 * Phase 3 extended it with three columns so backfill jobs share the same
 * durable store:
 *
 *   - `kind`          : 'replay' (legacy default) | 'backfill'
 *   - `profile_id`    : instrument_profiles.id the job targets
 *   - `progress_json` : free-form JSON the worker writes on each step
 *
 * We deliberately did NOT split into a new table — the existing reaper in
 * src/server/replay-routes.ts already handles dead-PID cleanup, and the UI
 * already polls /api/jobs for a consolidated view.
 *
 * All timestamps are Unix ms. Each call opens + closes its own prepared
 * statements on the passed-in DB handle; callers may pool those with a
 * WeakMap if they need to.
 */

import type { Database as DB } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type JobKind = 'replay' | 'backfill';
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Backfill-specific progress shape stored in progress_json. Replay jobs
 * retain their own legacy shape (see replay-routes.ts — `results_json`
 * + `currentDate`).
 */
export interface BackfillProgress {
  phase: string;
  /** Total trading dates in the requested range. */
  totalDates: number;
  /** Dates the orchestrator considered "raw missing" upfront. */
  rawMissingCount: number;
  /** Dates the orchestrator considered "MTF missing" upfront. */
  mtfMissingCount: number;
  /** Count of dates the worker has finished (either kind). */
  completedDates: number;
  /** Currently processing date, if any. */
  currentDate: string | null;
  /** Human-readable recent log entries (cap ~20 to keep the row small). */
  log: Array<{ ts: number; level: 'info' | 'warn' | 'error'; msg: string }>;
  /** Sum of bars written across all finished dates. */
  barsWritten: number;
  /** Per-date outcome so the UI can render a strip of green/red cells. */
  dateResults: Array<{ date: string; ok: boolean; error?: string; barsWritten: number }>;
}

export interface JobRow {
  id: string;
  kind: JobKind;
  profileId: string | null;
  status: JobStatus;
  pid: number | null;
  startedAt: number;
  completedAt: number | null;
  error: string | null;
  progress: unknown;
  /** Legacy replay columns surfaced for compatibility. */
  configId: string | null;
  configName: string | null;
  total: number;
  completed: number;
  currentDate: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rowToJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    kind: ((r.kind as string) ?? 'replay') as JobKind,
    profileId: (r.profile_id as string) ?? null,
    status: (r.status as JobStatus) ?? 'pending',
    pid: r.pid != null ? Number(r.pid) : null,
    startedAt: Number(r.startedAt),
    completedAt: r.completedAt != null ? Number(r.completedAt) : null,
    error: (r.error as string) ?? null,
    progress: parseJson(r.progress_json),
    configId: (r.configId as string) ?? null,
    configName: (r.configName as string) ?? null,
    total: Number(r.total ?? 0),
    completed: Number(r.completed ?? 0),
    currentDate: (r.currentDate as string) ?? null,
  };
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string' || v.length === 0) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// ── Create ───────────────────────────────────────────────────────────────────

export interface CreateBackfillJobOptions {
  profileId: string;
  totalDates: number;
  initialProgress?: Partial<BackfillProgress>;
  /** Optional pre-assigned id; defaults to randomUUID(). */
  id?: string;
}

/**
 * Insert a new backfill job row. Leaves `pid` null — caller fills it in
 * after the child process spawns via `attachPid()`.
 */
export function createBackfillJob(db: DB, opts: CreateBackfillJobOptions): string {
  const id = opts.id ?? randomUUID();
  const progress: BackfillProgress = {
    phase: 'pending',
    totalDates: opts.totalDates,
    rawMissingCount: 0,
    mtfMissingCount: 0,
    completedDates: 0,
    currentDate: null,
    log: [],
    barsWritten: 0,
    dateResults: [],
    ...opts.initialProgress,
  };

  db.prepare(`
    INSERT INTO replay_jobs (
      id, configId, configName, dates_json, status, completed, total, currentDate,
      startedAt, kind, profile_id, progress_json
    )
    VALUES (?, '', '', '[]', 'pending', 0, ?, NULL, ?, 'backfill', ?, ?)
  `).run(id, opts.totalDates, Date.now(), opts.profileId, JSON.stringify(progress));

  return id;
}

// ── Update ───────────────────────────────────────────────────────────────────

export function attachPid(db: DB, jobId: string, pid: number): void {
  db.prepare(`UPDATE replay_jobs SET pid = ?, status = 'running' WHERE id = ?`).run(pid, jobId);
}

/**
 * Merge-update a job's progress_json. Reads the current JSON, merges the
 * patch, writes back. Done in a single transaction so two workers writing
 * progress concurrently don't lose data.
 */
export function updateProgress(db: DB, jobId: string, patch: Partial<BackfillProgress>): void {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT progress_json FROM replay_jobs WHERE id = ?`).get(jobId) as
      | { progress_json: string }
      | undefined;
    if (!row) return;
    const current = parseJson(row.progress_json) as BackfillProgress | null;
    const merged: BackfillProgress = { ...defaultProgress(), ...current, ...patch };
    db.prepare(`UPDATE replay_jobs SET progress_json = ?, completed = ? WHERE id = ?`).run(
      JSON.stringify(merged),
      merged.completedDates,
      jobId,
    );
  });
  tx();
}

export function appendLog(
  db: DB,
  jobId: string,
  level: 'info' | 'warn' | 'error',
  msg: string,
): void {
  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT progress_json FROM replay_jobs WHERE id = ?`).get(jobId) as
      | { progress_json: string }
      | undefined;
    if (!row) return;
    const cur = (parseJson(row.progress_json) as BackfillProgress | null) ?? defaultProgress();
    const log = [...(cur.log ?? []), { ts: Date.now(), level, msg }].slice(-30);
    const merged: BackfillProgress = { ...cur, log };
    db.prepare(`UPDATE replay_jobs SET progress_json = ? WHERE id = ?`).run(
      JSON.stringify(merged),
      jobId,
    );
  });
  tx();
}

export function markCompleted(db: DB, jobId: string): void {
  db.prepare(`
    UPDATE replay_jobs SET status = 'completed', completedAt = ? WHERE id = ?
  `).run(Date.now(), jobId);
}

export function markFailed(db: DB, jobId: string, error: string): void {
  db.prepare(`
    UPDATE replay_jobs SET status = 'failed', completedAt = ?, error = ? WHERE id = ?
  `).run(Date.now(), error, jobId);
}

export function markCancelled(db: DB, jobId: string, reason = 'cancelled by user'): void {
  db.prepare(`
    UPDATE replay_jobs SET status = 'cancelled', completedAt = ?, error = ? WHERE id = ?
  `).run(Date.now(), reason, jobId);
}

// ── Read ─────────────────────────────────────────────────────────────────────

export function getJob(db: DB, jobId: string): JobRow | null {
  const row = db.prepare(`SELECT * FROM replay_jobs WHERE id = ?`).get(jobId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToJob(row) : null;
}

export interface ListJobsFilters {
  kind?: JobKind;
  profileId?: string;
  status?: JobStatus;
  limit?: number;
}

export function listJobs(db: DB, filters: ListJobsFilters = {}): JobRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.kind) { where.push('kind = ?'); params.push(filters.kind); }
  if (filters.profileId) { where.push('profile_id = ?'); params.push(filters.profileId); }
  if (filters.status) { where.push('status = ?'); params.push(filters.status); }

  const sql = `
    SELECT * FROM replay_jobs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY startedAt DESC
    LIMIT ?
  `;
  params.push(filters.limit ?? 50);
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

// ── Internal defaults ────────────────────────────────────────────────────────

function defaultProgress(): BackfillProgress {
  return {
    phase: 'pending',
    totalDates: 0,
    rawMissingCount: 0,
    mtfMissingCount: 0,
    completedDates: 0,
    currentDate: null,
    log: [],
    barsWritten: 0,
    dateResults: [],
  };
}
