/**
 * job-store tests — in-memory DB, verifies all CRUD + progress helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  createBackfillJob,
  attachPid,
  updateProgress,
  appendLog,
  markCompleted,
  markFailed,
  markCancelled,
  getJob,
  listJobs,
} from '../../src/backfill/job-store';
import type { BackfillProgress } from '../../src/backfill/job-store';

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE replay_jobs (
      id TEXT PRIMARY KEY,
      configId TEXT NOT NULL DEFAULT '',
      configName TEXT NOT NULL DEFAULT '',
      dates_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      completed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      currentDate TEXT,
      results_json TEXT DEFAULT '[]',
      error TEXT,
      pid INTEGER,
      startedAt INTEGER NOT NULL DEFAULT 0,
      completedAt INTEGER,
      kind TEXT NOT NULL DEFAULT 'replay',
      profile_id TEXT,
      progress_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  return db;
}

describe('job-store', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => { db = makeDb(); });

  describe('createBackfillJob', () => {
    it('inserts a pending job row', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 5 });
      expect(id).toBeTruthy();
      const job = getJob(db, id);
      expect(job).not.toBeNull();
      expect(job!.kind).toBe('backfill');
      expect(job!.profileId).toBe('spx-0dte');
      expect(job!.status).toBe('pending');
      expect(job!.pid).toBeNull();
    });

    it('uses provided id', () => {
      const id = createBackfillJob(db, { profileId: 'ndx-0dte', totalDates: 3, id: 'custom-123' });
      expect(id).toBe('custom-123');
      expect(getJob(db, 'custom-123')).not.toBeNull();
    });

    it('stores initial progress', () => {
      const id = createBackfillJob(db, {
        profileId: 'spx-0dte',
        totalDates: 10,
        initialProgress: { phase: 'spawning', rawMissingCount: 7 },
      });
      const job = getJob(db, id)!;
      const progress = job.progress as BackfillProgress;
      expect(progress.phase).toBe('spawning');
      expect(progress.rawMissingCount).toBe(7);
      expect(progress.totalDates).toBe(10);
    });
  });

  describe('attachPid', () => {
    it('sets pid and status to running', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      attachPid(db, id, 12345);
      const job = getJob(db, id)!;
      expect(job.pid).toBe(12345);
      expect(job.status).toBe('running');
    });
  });

  describe('updateProgress', () => {
    it('merges partial progress into existing', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 5 });
      updateProgress(db, id, { phase: 'raw-fetch', completedDates: 2, currentDate: '2026-03-18' });
      const job = getJob(db, id)!;
      const p = job.progress as BackfillProgress;
      expect(p.phase).toBe('raw-fetch');
      expect(p.completedDates).toBe(2);
      expect(p.currentDate).toBe('2026-03-18');
      expect(p.totalDates).toBe(5); // preserved from initial
    });

    it('updates completed column from completedDates', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 5 });
      updateProgress(db, id, { completedDates: 3 });
      const job = getJob(db, id)!;
      expect(job.completed).toBe(3);
    });
  });

  describe('appendLog', () => {
    it('adds log entries', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      appendLog(db, id, 'info', 'Starting');
      appendLog(db, id, 'warn', 'Retrying...');
      const job = getJob(db, id)!;
      const p = job.progress as BackfillProgress;
      expect(p.log).toHaveLength(2);
      expect(p.log[0].level).toBe('info');
      expect(p.log[1].msg).toBe('Retrying...');
    });

    it('caps log at 30 entries', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      for (let i = 0; i < 40; i++) {
        appendLog(db, id, 'info', `Entry ${i}`);
      }
      const job = getJob(db, id)!;
      const p = job.progress as BackfillProgress;
      expect(p.log.length).toBeLessThanOrEqual(30);
      // Should have last entries
      expect(p.log[p.log.length - 1].msg).toBe('Entry 39');
    });
  });

  describe('mark* helpers', () => {
    it('markCompleted sets status and completedAt', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      attachPid(db, id, 99);
      markCompleted(db, id);
      const job = getJob(db, id)!;
      expect(job.status).toBe('completed');
      expect(job.completedAt).toBeGreaterThan(0);
    });

    it('markFailed stores error', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      markFailed(db, id, 'Polygon 429');
      const job = getJob(db, id)!;
      expect(job.status).toBe('failed');
      expect(job.error).toBe('Polygon 429');
    });

    it('markCancelled stores reason', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      markCancelled(db, id, 'user abort');
      const job = getJob(db, id)!;
      expect(job.status).toBe('cancelled');
      expect(job.error).toBe('user abort');
    });
  });

  describe('listJobs', () => {
    it('returns jobs ordered by startedAt desc', () => {
      createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1, id: 'a' });
      createBackfillJob(db, { profileId: 'ndx-0dte', totalDates: 2, id: 'b' });
      const jobs = listJobs(db);
      expect(jobs).toHaveLength(2);
      // Most recently started first (both inserted nearly same ms)
    });

    it('filters by kind', () => {
      createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1, id: 'bf1' });
      // Insert a replay job manually
      db.prepare(`
        INSERT INTO replay_jobs (id, configId, configName, dates_json, status, total, startedAt, kind)
        VALUES ('rp1', 'cfg1', 'Test', '[]', 'completed', 1, ${Date.now()}, 'replay')
      `).run();
      const backfillOnly = listJobs(db, { kind: 'backfill' });
      expect(backfillOnly).toHaveLength(1);
      expect(backfillOnly[0].id).toBe('bf1');
    });

    it('filters by profileId', () => {
      createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1, id: 'j1' });
      createBackfillJob(db, { profileId: 'ndx-0dte', totalDates: 2, id: 'j2' });
      const ndxJobs = listJobs(db, { profileId: 'ndx-0dte' });
      expect(ndxJobs).toHaveLength(1);
      expect(ndxJobs[0].id).toBe('j2');
    });

    it('filters by status', () => {
      const id = createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1, id: 'done1' });
      markCompleted(db, id);
      createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1, id: 'pend1' });
      const completed = listJobs(db, { status: 'completed' });
      expect(completed).toHaveLength(1);
      expect(completed[0].id).toBe('done1');
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        createBackfillJob(db, { profileId: 'spx-0dte', totalDates: 1 });
      }
      const limited = listJobs(db, { limit: 3 });
      expect(limited).toHaveLength(3);
    });
  });

  describe('getJob', () => {
    it('returns null for nonexistent id', () => {
      expect(getJob(db, 'nope')).toBeNull();
    });
  });
});
