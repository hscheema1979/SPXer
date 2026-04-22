#!/usr/bin/env tsx
/**
 * Run all missing replay configs (200+ day configs) for recent dates.
 * Usage: npx tsx scripts/run-missing-replays.ts [--dry-run] [--concurrency=N] [--since=YYYY-MM-DD]
 */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '6', 10);
const since = args.find(a => a.startsWith('--since='))?.split('=')[1] ?? '2026-04-01';
const minDays = parseInt(args.find(a => a.startsWith('--min-days='))?.split('=')[1] ?? '200', 10);
const runAll = args.includes('--all');

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

function getMissingPairs(db: Database.Database): { date: string; configId: string }[] {
  const qualifier = runAll
    ? `SELECT id FROM replay_configs`
    : `SELECT rc.id FROM replay_configs rc
       LEFT JOIN replay_results rr ON rc.id = rr.configId
       GROUP BY rc.id
       HAVING COUNT(DISTINCT rr.date) >= ${minDays}`;
  const existingFilter = runAll ? '1=0' : 'e.configId IS NULL';
  const rows = db.prepare(`
    WITH qualifying_configs AS (${qualifier}),
    recent_dates AS (
      SELECT DISTINCT date FROM replay_results WHERE date >= ?
    ),
    all_combos AS (
      SELECT qc.id as configId, rd.date
      FROM qualifying_configs qc
      CROSS JOIN recent_dates rd
    ),
    existing AS (
      SELECT configId, date FROM replay_results WHERE date >= ?
    )
    SELECT ac.date, ac.configId
    FROM all_combos ac
    LEFT JOIN existing e ON ac.configId = e.configId AND ac.date = e.date
    WHERE ${runAll ? '1=1' : 'e.configId IS NULL'}
    ORDER BY ac.date, ac.configId
  `).all(since, since) as { date: string; configId: string }[];
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
      timeout: 120_000, // 2 min per replay
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
  console.log('=== Missing Replay Runner ===');
  console.log(`Min days: ${minDays} | Since: ${since} | Concurrency: ${concurrency} | Dry run: ${dryRun}`);
  console.log('');

  const db = new Database(DB_PATH, { readonly: true });
  const pairs = getMissingPairs(db);
  db.close();

  // Group by date for display
  const byDate = pairs.reduce((acc, p) => {
    acc[p.date] = (acc[p.date] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  console.log(`Total missing: ${pairs.length} pairs across ${Object.keys(byDate).length} dates`);
  for (const [date, count] of Object.entries(byDate).sort()) {
    console.log(`  ${date}: ${count} configs`);
  }
  console.log('');

  if (dryRun) {
    console.log('Dry run — not executing.');
    return;
  }

  let completed = 0;
  let failed = 0;
  const startTime = Date.now();

  await runWithConcurrency(pairs, async (pair, i) => {
    const ok = await runOne(pair.date, pair.configId);
    if (ok) {
      completed++;
      process.stdout.write(`\r  Progress: ${completed + failed}/${pairs.length} (${failed} failed)   `);
    } else {
      failed++;
      console.log(`\n  ✗ FAILED: ${pair.date} | ${pair.configId}`);
    }
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
