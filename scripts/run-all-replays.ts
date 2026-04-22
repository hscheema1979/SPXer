#!/usr/bin/env tsx
/**
 * Run EVERY replay config against EVERY available date.
 *
 * Modeled on run-missing-replays.ts but does full cross-product instead of
 * only missing pairs. Persists via replay_results table (the CLI handles that).
 *
 * Usage:
 *   npx tsx scripts/run-all-replays.ts [--concurrency=N] [--timeout-ms=N] [--dry-run]
 */

import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const concurrency = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '8', 10);
const timeoutMs = parseInt(args.find(a => a.startsWith('--timeout-ms='))?.split('=')[1] ?? '60000', 10);
const skipExisting = args.includes('--skip-existing');

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

function getPairs(db: Database.Database): { date: string; configId: string }[] {
  const configs = db.prepare('SELECT id FROM replay_configs ORDER BY id').all() as { id: string }[];
  const dates = db.prepare('SELECT DISTINCT date FROM replay_results ORDER BY date').all() as { date: string }[];

  let existing = new Set<string>();
  if (skipExisting) {
    const rows = db.prepare('SELECT configId, date FROM replay_results').all() as { configId: string; date: string }[];
    existing = new Set(rows.map(r => `${r.configId}|${r.date}`));
  }

  const pairs: { date: string; configId: string }[] = [];
  for (const d of dates) {
    for (const c of configs) {
      if (skipExisting && existing.has(`${c.id}|${d.date}`)) continue;
      pairs.push({ date: d.date, configId: c.id });
    }
  }
  return pairs;
}

async function runOne(date: string, configId: string): Promise<{ ok: boolean; err?: string }> {
  try {
    await execFileAsync('npx', [
      'tsx', 'src/replay/cli.ts', 'run', date,
      `--config-id=${configId}`,
      '--no-scanners', '--no-judge', '--quiet',
    ], {
      cwd: process.cwd(),
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, err: err.code === 'ETIMEDOUT' ? 'timeout' : (err.message?.split('\n')[0] ?? 'unknown') };
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
  console.log('=== Full Replay Sweep ===');
  console.log(`Concurrency: ${concurrency} | Timeout: ${timeoutMs}ms | Skip existing: ${skipExisting} | Dry run: ${dryRun}`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log('');

  const db = new Database(DB_PATH, { readonly: true });
  const pairs = getPairs(db);
  const configCount = db.prepare('SELECT COUNT(*) as n FROM replay_configs').get() as { n: number };
  const dateCount = db.prepare('SELECT COUNT(DISTINCT date) as n FROM replay_results').get() as { n: number };
  db.close();

  console.log(`Configs: ${configCount.n} | Dates: ${dateCount.n} | Total pairs: ${pairs.length}`);
  console.log('');

  if (dryRun) {
    console.log('Dry run — not executing.');
    return;
  }

  let completed = 0;
  let failed = 0;
  let timedOut = 0;
  const failureSamples: string[] = [];
  const startTime = Date.now();
  let lastReportAt = startTime;

  await runWithConcurrency(pairs, async (pair) => {
    const res = await runOne(pair.date, pair.configId);
    if (res.ok) {
      completed++;
    } else {
      failed++;
      if (res.err === 'timeout') timedOut++;
      if (failureSamples.length < 20) {
        failureSamples.push(`${pair.date} ${pair.configId}: ${res.err}`);
      }
    }

    const done = completed + failed;
    const now = Date.now();
    // Report every 25 pairs or every 30s, whichever comes first
    if (done % 25 === 0 || now - lastReportAt > 30_000) {
      lastReportAt = now;
      const elapsedSec = (now - startTime) / 1000;
      const rate = done / elapsedSec;
      const remaining = pairs.length - done;
      const etaSec = rate > 0 ? remaining / rate : 0;
      const etaMin = (etaSec / 60).toFixed(1);
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ` +
        `${done}/${pairs.length} (${((done / pairs.length) * 100).toFixed(1)}%) | ` +
        `ok=${completed} fail=${failed} timeout=${timedOut} | ` +
        `rate=${rate.toFixed(2)}/s | eta=${etaMin}min`
      );
    }
  }, concurrency);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log(`=== Done in ${elapsed}s (${(parseFloat(elapsed) / 60).toFixed(1)}min) ===`);
  console.log(`  Completed: ${completed}`);
  console.log(`  Failed:    ${failed} (of which ${timedOut} timeouts)`);

  if (failureSamples.length) {
    console.log('');
    console.log('Failure samples:');
    for (const s of failureSamples) console.log(`  - ${s}`);
  }

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('[run-all-replays] Fatal:', err);
  process.exit(1);
});
