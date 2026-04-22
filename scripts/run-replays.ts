#!/usr/bin/env tsx
/**
 * Run every config against every available date.
 * Same logic as run-missing-replays.ts (CLI wrapper + concurrency), just no filters.
 *
 * Usage: npx tsx scripts/run-replays.ts [--concurrency=N] [--dry-run]
 */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '6', 10);

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

function getAllPairs(db: Database.Database): { date: string; configId: string }[] {
  const rows = db.prepare(`
    WITH configs AS (SELECT id AS configId FROM replay_configs),
    dates AS (SELECT DISTINCT date FROM replay_results),
    all_combos AS (
      SELECT c.configId, d.date
      FROM configs c CROSS JOIN dates d
    ),
    existing AS (SELECT configId, date FROM replay_results)
    SELECT ac.date, ac.configId
    FROM all_combos ac
    LEFT JOIN existing e ON ac.configId = e.configId AND ac.date = e.date
    WHERE e.configId IS NULL
    ORDER BY ac.date, ac.configId
  `).all() as { date: string; configId: string }[];
  return rows;
}

async function runOne(date: string, configId: string): Promise<boolean> {
  try {
    await execFileAsync('npx', [
      'tsx', 'src/replay/cli.ts', 'run', date,
      `--config-id=${configId}`,
      '--no-scanners', '--no-judge',
    ], {
      cwd: process.cwd(),
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    return true;
  } catch {
    return false;
  }
}

async function runWithConcurrency<T>(
  items: T[],
  fn: (item: T, idx: number) => Promise<void>,
  limit: number,
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
}

async function main() {
  console.log('=== Run Replays (all configs × all dates) ===');
  console.log(`Concurrency: ${concurrency} | Dry run: ${dryRun}`);
  console.log('');

  const db = new Database(DB_PATH, { readonly: true });
  const configCount = (db.prepare('SELECT COUNT(*) AS n FROM replay_configs').get() as any).n;
  const dateCount = (db.prepare('SELECT COUNT(DISTINCT date) AS n FROM replay_results').get() as any).n;
  const pairs = getAllPairs(db);
  db.close();

  console.log(`Configs: ${configCount} | Dates: ${dateCount} | Total cells: ${configCount * dateCount}`);
  console.log(`Missing pairs to run: ${pairs.length}`);
  console.log('');

  if (dryRun) {
    console.log('Dry run — not executing.');
    return;
  }

  if (pairs.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  let completed = 0;
  let failed = 0;
  const startTime = Date.now();

  await runWithConcurrency(pairs, async (pair) => {
    const ok = await runOne(pair.date, pair.configId);
    if (ok) {
      completed++;
    } else {
      failed++;
      console.log(`\n  ✗ FAILED: ${pair.date} | ${pair.configId}`);
    }
    const done = completed + failed;
    const rate = done / ((Date.now() - startTime) / 1000);
    const eta = rate > 0 ? ((pairs.length - done) / rate / 60).toFixed(1) : '?';
    process.stdout.write(`\r  Progress: ${done}/${pairs.length} (${failed} failed) | ${rate.toFixed(1)}/s | ETA ${eta}m   `);
  }, concurrency);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n=== Done in ${elapsed}s ===`);
  console.log(`  Completed: ${completed}`);
  console.log(`  Failed:    ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
