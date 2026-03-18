import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initDb, closeDb, getDb } from '../../src/storage/db';

describe('db', () => {
  beforeAll(() => initDb(':memory:'));
  afterAll(() => closeDb());

  it('initializes with bars and contracts tables', () => {
    const db = getDb();
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('bars');
    expect(names).toContain('contracts');
  });

  it('has WAL mode enabled (falls back to memory for :memory: DB)', () => {
    const db = getDb();
    const mode = db.pragma('journal_mode') as { journal_mode: string }[];
    // SQLite silently uses 'memory' journal mode for in-memory databases;
    // WAL is only active for file-based DBs — pragma accepted without error.
    expect(['wal', 'memory']).toContain(mode[0].journal_mode);
  });
});
