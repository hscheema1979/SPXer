/**
 * sweep-manager-job — tracked-job wrapper around sweep-manager.ts.
 *
 * Spawned (detached) by src/server/sweep-manager-routes.ts. Reads a spec file:
 *   { jobId, command, symbol, dte, days, forceSpx, overrides, dbPath }
 *
 * Runs `sweep-manager <command> --symbol S --dte N [--days K] [overrides]`,
 * tees the child's stdout/stderr to this process's stdout (→ the job log
 * file the route opened) AND mirrors progress into the shared replay_jobs
 * table via job-store so the Studio UI can poll structured status:
 *
 *   - phase           ← stage markers ([1/5] …, ── backfill/verify/execute ──)
 *   - currentDate     ← per-date backfill lines
 *   - completedDates  ← incremented per finished backfill date
 *   - log[]           ← notable lines (stages, ⚠, ✗) — capped in job-store
 *
 * Exit: code 0 → markCompleted; non-zero → markFailed (last stderr-ish line).
 * SIGTERM (cancel) → kill child, markCancelled.
 *
 * Run via tsx (server spawns `npx tsx scripts/diag/sweep-manager-job.ts spec`).
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import Database from 'better-sqlite3';
import { updateProgress, appendLog, markCompleted, markFailed, markCancelled } from '../../src/backfill/job-store';

interface Spec {
  jobId: string;
  command: 'onboard' | 'execute';
  symbol: string;
  dte: number;
  days: number | null;
  forceSpx: boolean;
  overrides: Record<string, string>;
  dbPath: string;
}

function readSpec(): Spec {
  const specPath = process.argv[2];
  if (!specPath || !fs.existsSync(specPath)) {
    console.error(`[sweep-manager-job] spec file not found: ${specPath}`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(specPath, 'utf8')) as Spec;
}

const spec = readSpec();
const db = new Database(spec.dbPath);

// Best-effort DB writes — a malformed/locked DB must not crash the actual run.
function safe(fn: () => void): void {
  try { fn(); } catch (e) { console.error(`[sweep-manager-job] db write failed: ${(e as Error).message}`); }
}

const cliArgs: string[] = [
  spec.command,
  '--symbol', spec.symbol,
  '--dte', String(spec.dte),
];
if (spec.days && spec.days > 0) cliArgs.push('--days', String(spec.days));
for (const [flag, val] of Object.entries(spec.overrides ?? {})) cliArgs.push(`--${flag}`, val);
if (spec.forceSpx) cliArgs.push('--force-spx');

console.log(`[sweep-manager-job] job=${spec.jobId} → sweep-manager ${cliArgs.join(' ')}`);
safe(() => updateProgress(db, spec.jobId, { phase: `${spec.command}:starting` }));
safe(() => appendLog(db, spec.jobId, 'info', `sweep-manager ${cliArgs.join(' ')}`));

const child: ChildProcess = spawn(
  'npx',
  ['tsx', path.resolve(__dirname, 'sweep-manager.ts'), ...cliArgs],
  { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } },
);

let completedDates = 0;
let lastErrLine = '';
let cancelled = false;

// Stage / progress detection — these strings are emitted by sweep-manager.ts.
function classify(line: string): void {
  const stage = (phase: string) => safe(() => updateProgress(db, spec.jobId, { phase }));
  if (/^── backfill /.test(line)) { stage('backfill'); }
  else if (/^── verify /.test(line)) { stage('verify'); }
  else if (/^── validate /.test(line)) { stage('validate'); }
  else if (/^── execute /.test(line)) { stage('execute'); }
  else {
    const m = /^\s*\[(\d)\/5\]\s+(.*)$/.exec(line);
    if (m) { stage(`execute ${m[1]}/5: ${m[2].trim()}`); }
  }
  // Per-date backfill line: "  $ tsx scripts/backfill/backfill-replay-options.ts 2026-05-06 --profile=..."
  const dm = /backfill-replay-options\.ts\s+(\d{4}-\d{2}-\d{2})/.exec(line);
  if (dm) {
    completedDates += 1;
    safe(() => updateProgress(db, spec.jobId, { currentDate: dm[1], completedDates }));
  }
  // Surface stage headers, discovery summary, warnings and failures to the
  // structured log (job-store caps it at 30 — keep it to the signal).
  if (/^──|^\s*\[\d\/5\]|discovered |registered |⚠|✗|RESULT:/.test(line)) {
    const level: 'info' | 'warn' | 'error' = /✗/.test(line) ? 'error' : /⚠/.test(line) ? 'warn' : 'info';
    safe(() => appendLog(db, spec.jobId, level, line.trim().slice(0, 300)));
  }
}

function pump(stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream, isErr: boolean): void {
  let buf = '';
  stream.on('data', (chunk: Buffer) => {
    sink.write(chunk);                       // tee → job log file
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (isErr && line.trim()) lastErrLine = line.trim();
      classify(line);
    }
  });
}

if (child.stdout) pump(child.stdout, process.stdout, false);
if (child.stderr) pump(child.stderr, process.stderr, true);

function onSignal(sig: NodeJS.Signals): void {
  cancelled = true;
  console.log(`[sweep-manager-job] received ${sig} — terminating child`);
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  safe(() => markCancelled(db, spec.jobId, `cancelled (${sig})`));
  // Give the child a moment, then hard-exit.
  setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } process.exit(143); }, 3000);
}
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

child.on('error', (err) => {
  console.error(`[sweep-manager-job] spawn error: ${err.message}`);
  safe(() => markFailed(db, spec.jobId, `spawn error: ${err.message}`));
  try { db.close(); } catch { /* noop */ }
  process.exit(1);
});

child.on('close', (code) => {
  if (cancelled) { try { db.close(); } catch { /* noop */ } return; }
  if (code === 0) {
    safe(() => updateProgress(db, spec.jobId, { phase: `${spec.command}:done` }));
    safe(() => markCompleted(db, spec.jobId));
    console.log(`[sweep-manager-job] job=${spec.jobId} completed`);
    try { db.close(); } catch { /* noop */ }
    process.exit(0);
  } else {
    const reason = lastErrLine || `sweep-manager exited with code ${code}`;
    safe(() => markFailed(db, spec.jobId, reason));
    console.error(`[sweep-manager-job] job=${spec.jobId} failed: ${reason}`);
    try { db.close(); } catch { /* noop */ }
    process.exit(code ?? 1);
  }
});
