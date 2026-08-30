/**
 * sweep-process.ts — shared child-process lifecycle for sweep orchestration.
 *
 * Extracted from sweep-parallel.ts (FR-001) so the lifecycle guarantees are
 * unit-testable and every spawn site gets them:
 *
 *   • every child runs DETACHED (own process group) → the whole
 *     nice→npx→node→esbuild tree dies with one kill(-pgid, SIGKILL)
 *   • every child is bounded by a wall-clock timeout → a hung worker/merge
 *     can never block the wrapper forever. That hang is what leaked 37
 *     processes between 2026-07-31 and 2026-08-19: the wrapper awaited a
 *     merge child that never exited, and each weekday's cron fire stacked a
 *     new tree on top (see .termchat/specs/FR-001.md).
 *   • child STDOUT IS DRAINED. The old code piped stdout and never read it,
 *     so a chatty child (concurrent-distribution prints a per-variant
 *     report) hit the 64KB kernel pipe buffer and blocked forever on its
 *     next write — with all work already done and state already written.
 *   • SIGINT/SIGTERM on the wrapper kill every live child group first, so
 *     killing the orchestrator never strands grandchildren.
 */
import { spawn, type ChildProcess } from 'child_process';

/** Parse a SWEEP_*_TIMEOUT_S env knob; falls back to defSeconds when unset/garbage. */
export function parseTimeoutEnv(name: string, defSeconds: number): number {
  const raw = parseInt(process.env[name] || '', 10);
  return Number.isFinite(raw) && raw >= 1 ? raw : defSeconds;
}

const liveChildren = new Set<ChildProcess>();

/** SIGKILL a child's whole process group (detached children are group leaders). */
export function killGroup(ch: ChildProcess): void {
  if (ch.pid != null) {
    try { process.kill(-ch.pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  try { ch.kill('SIGKILL'); } catch { /* already dead */ }
}

/** Kill every live child's group. Idempotent; used on wrapper signal/exit. */
export function killAllChildren(): void {
  for (const ch of [...liveChildren]) killGroup(ch);
}

/**
 * Install wrapper-side signal cleanup. Call once at the top of an
 * orchestrator's main: on Ctrl-C / pm2 delete / `timeout` TERM, the wrapper
 * takes its whole child forest down instead of orphaning detached workers.
 */
export function installSignalCleanup(): void {
  const die = (code: number) => { killAllChildren(); process.exit(code); };
  process.on('SIGINT', () => die(130));
  process.on('SIGTERM', () => die(143));
}

export interface RunScriptOpts {
  cmd: string;                     // executable, e.g. 'nice'
  args: string[];                  // full argv (prefix + npx tsx <script> …)
  env?: NodeJS.ProcessEnv;         // merged over process.env
  cwd?: string;
  tag: string;                     // label used in failure/timeout errors
  timeoutS: number;                // wall-clock bound; group-SIGKILL on expiry
  onErrLine?: (s: string) => void; // stderr tap (caller's lastErr capture)
}

/** Spawn one bounded child; resolve on exit 0, reject otherwise. */
export function runScript(o: RunScriptOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const ch = spawn(o.cmd, o.args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → kill(-pid) reaps the whole tree
    });
    liveChildren.add(ch);
    let lastErr = '';
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      liveChildren.delete(ch);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      killGroup(ch);
      settle(new Error(`${o.tag} TIMED OUT after ${o.timeoutS}s (process group killed)`));
    }, o.timeoutS * 1000);
    // Drain stdout: piped-but-unread fills the 64KB kernel buffer and blocks
    // the child's next write forever — one of the mechanisms behind the
    // Jul-31 concurrent-distribution merge hang. Deliberately not forwarded:
    // the nightly log is the orchestrator's narrative, not per-date spam.
    ch.stdout!.on('data', () => {});
    ch.stderr!.on('data', d => {
      const s = d.toString();
      lastErr = s.trim().split('\n').pop() || lastErr;
      o.onErrLine?.(s);
    });
    ch.on('error', e => settle(new Error(`${o.tag} spawn error: ${e.message}`)));
    ch.on('close', code => code === 0
      ? settle()
      : settle(new Error(`${o.tag} exited ${code}: ${lastErr}`)));
  });
}
