/**
 * Account Lock — prevents multiple agents from trading the same broker account.
 *
 * File-based lock: data/account-{accountId}.lock
 * Contains JSON: { pid, agentId, startedAt, configId }
 *
 * On acquire:
 *   1. If no lock file exists → create it, return true.
 *   2. If lock file exists and the PID is still running → refuse (return false).
 *   3. If lock file exists but the PID is dead → steal the lock (stale), return true.
 *
 * On release (SIGTERM/SIGINT/exit):
 *   Delete the lock file if it belongs to this process.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface LockInfo {
  pid: number;
  agentId: string;
  configId: string;
  startedAt: string;
}

const LOCK_DIR = path.resolve(__dirname, '../../data');

function lockPath(accountId: string): string {
  return path.join(LOCK_DIR, `account-${accountId}.lock`);
}

/** Check if a process with the given PID is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 doesn't kill — just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read lock file contents, or null if missing/corrupt. */
export function readLock(accountId: string): LockInfo | null {
  const p = lockPath(accountId);
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    return JSON.parse(raw) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Attempt to acquire the account lock.
 * Returns true if this agent now holds the lock.
 * Returns false if another live agent already holds it (logs the conflict).
 */
export function acquireAccountLock(accountId: string, agentId: string, configId: string): boolean {
  // Ensure data directory exists
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
  }

  const existing = readLock(accountId);

  if (existing) {
    // Lock file exists — is the owner still alive?
    if (isProcessAlive(existing.pid)) {
      // Another agent is alive and holds this account
      if (existing.pid === process.pid) {
        // We already hold it (re-entrant call) — fine
        return true;
      }
      console.error(`[account-lock] BLOCKED: account ${accountId} is already locked by agent "${existing.agentId}" (PID ${existing.pid}, config: ${existing.configId}, started: ${existing.startedAt})`);
      console.error(`[account-lock] This agent "${agentId}" (PID ${process.pid}) cannot trade on the same account.`);
      console.error(`[account-lock] To fix: stop the other agent first, or remove ${lockPath(accountId)}`);
      return false;
    }

    // Stale lock — previous agent died without cleanup
    console.warn(`[account-lock] Stale lock found for account ${accountId} (PID ${existing.pid} is dead). Stealing lock.`);
  }

  // Write our lock
  const info: LockInfo = {
    pid: process.pid,
    agentId,
    configId,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(lockPath(accountId), JSON.stringify(info, null, 2));
  console.log(`[account-lock] Acquired lock on account ${accountId} (agent="${agentId}", PID=${process.pid})`);
  return true;
}

/**
 * Release the account lock — only if this process owns it.
 * Safe to call multiple times.
 */
export function releaseAccountLock(accountId: string): void {
  const p = lockPath(accountId);
  const existing = readLock(accountId);

  if (existing && existing.pid === process.pid) {
    try {
      fs.unlinkSync(p);
      console.log(`[account-lock] Released lock on account ${accountId}`);
    } catch {
      // Already gone — fine
    }
  }
}

/**
 * Install shutdown handlers to auto-release the lock on exit.
 * Call once after acquiring the lock.
 */
export function installLockCleanup(accountId: string): void {
  const cleanup = () => releaseAccountLock(accountId);

  process.on('exit', cleanup);
  process.on('SIGTERM', () => { cleanup(); });
  process.on('SIGINT', () => { cleanup(); });
  // Also handle uncaught exceptions so lock doesn't go stale
  process.on('uncaughtException', (err) => {
    console.error('[account-lock] Uncaught exception — releasing lock:', err);
    cleanup();
  });
}
