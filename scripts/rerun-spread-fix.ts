#!/usr/bin/env tsx
/**
 * Rerun all basket configs + top 200 leaderboard configs after spread fix.
 *
 * 1. Identifies target configs (basket-enabled + top 200 by composite score)
 * 2. Deletes their existing replay_results and replay_runs
 * 3. Reruns all (configId, date) pairs with concurrency
 *
 * Usage:
 *   npx tsx scripts/rerun-spread-fix.ts [--concurrency=6] [--dry-run]
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

function getTargetConfigIds(db: Database.Database): string[] {
  const rows = db.prepare(`
    WITH basket_parents AS (
      SELECT id FROM replay_configs
      WHERE json_extract(config_json, '$.basket.enabled') = 1
    ),
    basket_configs AS (
      SELECT id FROM basket_parents
      UNION
      SELECT rc.id FROM replay_configs rc, basket_parents bp
      WHERE rc.id LIKE bp.id || ':%'
    ),
    leaderboard_top200 AS (
      SELECT r.configId AS id
      FROM replay_results r
      GROUP BY r.configId
      HAVING COUNT(DISTINCT r.date) >= 2
      ORDER BY (
        (CASE WHEN SUM(r.trades) > 0 THEN CAST(SUM(r.wins) AS REAL) / SUM(r.trades) ELSE 0 END) * 40 +
        (MIN(MAX(AVG(r.sharpeRatio), 0), 1)) * 30 +
        (CASE WHEN AVG(r.totalPnl) > 0 THEN 20 ELSE 0 END) +
        (CASE WHEN MIN(r.totalPnl) > -500 THEN 10 ELSE 0 END)
      ) DESC
      LIMIT 200
    ),
    all_targets AS (
      SELECT id FROM basket_configs
      UNION
      SELECT id FROM leaderboard_top200
    )
    SELECT id FROM all_targets ORDER BY id
  `).all() as { id: string }[];
  return rows.map(r => r.id);
}

function getAllDates(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT date FROM replay_results ORDER BY date
  `).all() as { date: string }[];
  return rows.map(r => r.date);
}

function deleteOldResults(db: Database.Database, configIds: string[]): { deletedResults: number; deletedRuns: number } {
  const placeholders = configIds.map(() => '?').join(',');

  // Temporarily disable FK checks — results FK→runs, and we're deleting both
  db.pragma('foreign_keys = OFF');

  const delResults = db.prepare(`
    DELETE FROM replay_results WHERE configId IN (${placeholders})
  `).run(...configIds);

  const delRuns = db.prepare(`
    DELETE FROM replay_runs WHERE configId IN (${placeholders})
  `).run(...configIds);

  db.pragma('foreign_keys = ON');

  return {
    deletedResults: delResults.changes,
    deletedRuns: delRuns.changes,
  };
}

async function runOne(date: string, configId: string): Promise<boolean> {
  try {
    await execFileAsync('npx', [
      'tsx', 'src/replay/cli.ts', 'run', date,
      `--config-id=${configId}`,
      '--no-scanners', '--no-judge',
    ], {
      cwd: process.cwd(),
      timeout: 180_000,
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
  console.log('=== Rerun Spread Fix: Baskets + Top 200 Leaderboard ===');
  console.log(`Concurrency: ${concurrency} | Dry run: ${dryRun}`);
  console.log('');

  const db = new Database(DB_PATH);

  // Step 1: Identify targets
  const configIds = getTargetConfigIds(db);
  const dates = getAllDates(db);
  console.log(`Target configs: ${configIds.length}`);
  console.log(`Replay dates:   ${dates.length}`);
  console.log(`Total runs:     ${configIds.length * dates.length}`);
  console.log('');

  // Count basket vs leaderboard
  const basketCount = configIds.filter(id => {
    const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(id) as { config_json: string } | undefined;
    if (!row) return false;
    try { return JSON.parse(row.config_json)?.basket?.enabled === true; } catch { return false; }
  }).length;
  console.log(`  Basket configs:      ${basketCount}`);
  console.log(`  Leaderboard configs: ${configIds.length - basketCount} (non-basket)`);
  console.log('');

  if (dryRun) {
    console.log('Config IDs to rerun:');
    for (const id of configIds) {
      console.log(`  ${id}`);
    }
    console.log('\nDry run — not executing.');
    db.close();
    return;
  }

  // Step 2: Delete old results (skip if --resume)
  const resume = args.includes('--resume');
  if (resume) {
    console.log('Resume mode — skipping delete, only running missing pairs.');
  } else {
    console.log('Deleting old results...');
    const { deletedResults, deletedRuns } = deleteOldResults(db, configIds);
    console.log(`  Deleted ${deletedResults} result rows, ${deletedRuns} run rows`);
  }
  console.log('');

  // Step 3: Build (config, date) pairs, skipping already-completed ones
  const existingSet = new Set<string>();
  if (resume) {
    const existing = db.prepare(`
      SELECT configId, date FROM replay_results
      WHERE configId IN (${configIds.map(() => '?').join(',')})
    `).all(...configIds) as { configId: string; date: string }[];
    for (const e of existing) existingSet.add(`${e.configId}|${e.date}`);
    console.log(`  Already completed: ${existingSet.size} pairs`);
  }

  db.close();

  const pairs: { date: string; configId: string }[] = [];
  for (const configId of configIds) {
    for (const date of dates) {
      if (!existingSet.has(`${configId}|${date}`)) {
        pairs.push({ date, configId });
      }
    }
  }

  // Shuffle to spread load across dates (avoids all workers hitting same date's parquet)
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }

  console.log(`Starting ${pairs.length} replay runs with concurrency ${concurrency}...`);
  console.log('');

  let completed = 0;
  let failed = 0;
  const failedPairs: { date: string; configId: string }[] = [];
  const startTime = Date.now();

  await runWithConcurrency(pairs, async (pair) => {
    const ok = await runOne(pair.date, pair.configId);
    if (ok) {
      completed++;
    } else {
      failed++;
      failedPairs.push(pair);
    }
    const done = completed + failed;
    const rate = done / ((Date.now() - startTime) / 1000);
    const eta = rate > 0 ? ((pairs.length - done) / rate / 60).toFixed(1) : '?';
    process.stdout.write(
      `\r  Progress: ${done}/${pairs.length} (${completed} ok, ${failed} fail) | ${rate.toFixed(1)}/s | ETA ${eta}m   `
    );
  }, concurrency);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n\n=== Done in ${elapsed} minutes ===`);
  console.log(`  Completed: ${completed}`);
  console.log(`  Failed:    ${failed}`);

  if (failedPairs.length > 0 && failedPairs.length <= 50) {
    console.log('\nFailed pairs:');
    for (const p of failedPairs) {
      console.log(`  ${p.date} | ${p.configId}`);
    }
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
