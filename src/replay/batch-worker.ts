/**
 * Batch replay worker — runs as a detached child process.
 *
 * Receives job config via argv (JSON file path), runs replays sequentially,
 * and writes progress/results to SQLite so the viewer can poll them.
 *
 * Survives viewer restarts. Exits when done.
 *
 * Usage: node/tsx src/replay/batch-worker.ts <job-file.json>
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runReplay } from './machine';
import type { Config } from '../config/types';

interface JobSpec {
  jobId: string;
  configId: string;
  configName: string;
  dates: string[];
  config: Config;
  dbPath: string;
  noJudge: boolean;
}

const jobFile = process.argv[2];
if (!jobFile || !fs.existsSync(jobFile)) {
  console.error('[batch-worker] Missing or invalid job file:', jobFile);
  process.exit(1);
}

const spec: JobSpec = JSON.parse(fs.readFileSync(jobFile, 'utf-8'));
const { jobId, configId, configName, dates, config, dbPath, noJudge } = spec;

function getDb(): Database.Database {
  return new Database(dbPath);
}

function updateJob(fields: Record<string, any>) {
  const db = getDb();
  try {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE replay_jobs SET ${sets} WHERE id = ?`)
      .run(...Object.values(fields), jobId);
  } finally {
    db.close();
  }
}

async function main() {
  console.log(`[batch-worker] Starting job ${jobId}: ${dates.length} dates for config ${configName}`);

  // Mark as running with our PID
  updateJob({ status: 'running', pid: process.pid, currentDate: dates[0] });

  const results: { date: string; trades: number; wins: number; totalPnl: number }[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    updateJob({ currentDate: date, completed: i });

    try {
      const result = await runReplay(config, date, {
        dataDbPath: dbPath,
        storeDbPath: dbPath,
        verbose: false,
        noJudge,
      });
      results.push({
        date,
        trades: result.trades,
        wins: result.wins,
        totalPnl: result.totalPnl,
      });
    } catch (err: any) {
      console.error(`[batch-worker] ${date} error: ${err.message}`);
      results.push({ date, trades: 0, wins: 0, totalPnl: 0 });
    }

    // Persist partial results after each day
    updateJob({
      completed: i + 1,
      results_json: JSON.stringify(results),
    });
  }

  // Mark complete
  const totalTrades = results.reduce((s, r) => s + r.trades, 0);
  const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
  updateJob({
    status: 'completed',
    completedAt: Date.now(),
    completed: dates.length,
    results_json: JSON.stringify(results),
  });

  console.log(`[batch-worker] Job ${jobId} completed: ${dates.length} days, ${totalTrades} trades, $${totalPnl.toFixed(0)} P&L`);

  // Clean up job file
  try { fs.unlinkSync(jobFile); } catch {}

  process.exit(0);
}

main().catch(err => {
  console.error(`[batch-worker] Fatal error: ${err.message}`);
  try {
    updateJob({ status: 'failed', error: err.message, completedAt: Date.now() });
  } catch {}
  try { fs.unlinkSync(jobFile); } catch {}
  process.exit(1);
});
