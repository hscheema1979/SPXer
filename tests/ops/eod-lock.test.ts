/**
 * eod-lock.test.ts — FR-001
 *
 * The pipeline mutex must let a skipping process identify the CURRENT holder.
 * eod-pipeline.sh opens the lock fd then writes its own pid into the file:
 *
 *     exec 9>"$LOCK"      // ">" truncates
 *     flock -n 9 || log "... (holder pid $(cat "$LOCK"))"
 *     echo $$ > "$LOCK"
 *
 * With ">" the SECOND process truncates the file at open() — destroying the
 * holder pid it is about to read — so the skip line always logged an empty pid
 * and the live holder record was wiped while it was still running.
 * "<>" opens read-write WITHOUT truncating, which is the correct idiom.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Run a holder + a contender against one lock file using the given redirection op. */
function holderPidSeenByContender(redir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eodlock-'));
  const lock = path.join(dir, 'eod.lock');
  const script = path.join(dir, 't.sh');
  const body = [
    '#!/usr/bin/env bash',
    'LOCK="' + lock + '"',
    '( exec 9' + redir + '"$LOCK"; flock -n 9 || exit 9; echo $BASHPID > "$LOCK"; sleep 5 ) &',
    'sleep 0.6',
    'exec 8' + redir + '"$LOCK"',
    'if flock -n 8; then echo LOCK-NOT-HELD; else cat "$LOCK"; fi',
    '',
  ].join('\n');
  fs.writeFileSync(script, body);
  fs.chmodSync(script, 0o755);
  try {
    return execFileSync('bash', [script], { encoding: 'utf8', timeout: 20000 }).trim();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

describe('eod-pipeline lock holder pid (FR-001)', () => {
  it('">" truncates the lock file, losing the holder pid (the bug)', () => {
    expect(holderPidSeenByContender('>')).toBe('');
  });

  it('"<>" preserves the holder pid so the skip line can name it', () => {
    const seen = holderPidSeenByContender('<>');
    expect(seen).toMatch(/^\d+$/);
    expect(Number(seen)).toBeGreaterThan(0);
  });
});

describe('eod-pipeline.sh uses the non-truncating idiom', () => {
  it('opens the lock fd with <> and still logs the holder pid', () => {
    const sh = fs.readFileSync(
      path.join(__dirname, '..', '..', 'scripts', 'ops', 'eod-pipeline.sh'),
      'utf8',
    );
    expect(sh).toContain('exec 9<>"$LOCK"');
    expect(sh).not.toContain('exec 9>"$LOCK"');
    expect(sh).toContain('holder pid');
  });
});
