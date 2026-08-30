/**
 * sweep-parallel.test.ts — FR-001 process-lifecycle guarantees.
 *
 * The 2026-07-31..08-19 leak: sweep-parallel awaited children that never
 * exited, with no timeout, no group-kill, and stdout piped-but-never-read
 * (a chatty child blocks forever once the 64KB kernel pipe buffer fills).
 * These tests pin the fixes: hung children die on time, their whole tree
 * dies with them (no orphans), and failed shard runs don't strand tmpfs.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { runScript, parseTimeoutEnv } from '../../scripts/diag/sweep-process';
import { withShardTmp } from '../../scripts/diag/sweep-parallel';

const isLinux = process.platform === 'linux';

function pgrepMatches(pattern: string): boolean {
  const r = spawnSync('pgrep', ['-f', pattern]);
  return r.status === 0; // 0 = ≥1 match, 1 = none
}

async function waitForGone(pattern: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pgrepMatches(pattern)) return;
    await new Promise(res => setTimeout(res, 200));
  }
  throw new Error(`processes still alive after timeout-kill: ${pattern}`);
}

// Marker argv0 planted on the hung tree; unique per test run so parallel
// suites never interfere.
const MARKER = `fr001-hung-marker-${process.pid}`;

describe('parseTimeoutEnv', () => {
  it('falls back to the default on unset / garbage / non-positive values', () => {
    delete process.env.SWEEP_TEST_TIMEOUT_S;
    expect(parseTimeoutEnv('SWEEP_TEST_TIMEOUT_S', 2700)).toBe(2700);
    process.env.SWEEP_TEST_TIMEOUT_S = 'banana';
    expect(parseTimeoutEnv('SWEEP_TEST_TIMEOUT_S', 2700)).toBe(2700);
    process.env.SWEEP_TEST_TIMEOUT_S = '0';
    expect(parseTimeoutEnv('SWEEP_TEST_TIMEOUT_S', 2700)).toBe(2700);
    delete process.env.SWEEP_TEST_TIMEOUT_S;
  });

  it('accepts a positive integer override', () => {
    process.env.SWEEP_TEST_TIMEOUT_S = '90';
    expect(parseTimeoutEnv('SWEEP_TEST_TIMEOUT_S', 2700)).toBe(90);
    delete process.env.SWEEP_TEST_TIMEOUT_S;
  });
});

describe('runScript lifecycle (FR-001)', () => {
  it('resolves on exit 0', async () => {
    await runScript({ cmd: 'true', args: [], tag: 'test#ok', timeoutS: 10 });
  });

  it('rejects with the exit code and tag on failure', async () => {
    await expect(runScript({
      cmd: 'bash', args: ['-c', 'echo boom >&2; exit 3'], tag: 'test#fail', timeoutS: 10,
    })).rejects.toThrow(/test#fail exited 3.*boom/);
  });

  it('kills a hung child after the timeout and rejects with TIMED OUT', async () => {
    const t0 = Date.now();
    await expect(runScript({
      cmd: 'bash', args: ['-c', `exec -a ${MARKER} sleep 60`], tag: 'test#hung', timeoutS: 1,
    })).rejects.toThrow(/test#hung TIMED OUT after 1s/);
    expect(Date.now() - t0).toBeLessThan(15_000);
    await waitForGone(MARKER);
  }, 20_000);

  it('group-kills the whole hung tree — grandchildren do not survive', async () => {
    // Outer bash (group leader after runScript's detached spawn) spawns an
    // inner process whose argv0 carries the marker. If only the leader were
    // killed (instead of the group), the inner sleep would survive and the
    // marker would still be visible in pgrep.
    await expect(runScript({
      cmd: 'bash',
      args: ['-c', `bash -c "exec -a ${MARKER} sleep 60" & wait`],
      tag: 'test#tree',
      timeoutS: 1,
    })).rejects.toThrow(/TIMED OUT/);
    await waitForGone(MARKER);
  }, 20_000);

  it('drains child stdout — a child writing >64KB to stdout still completes', async () => {
    // Before FR-001 the piped-but-unread stdout made exactly this block
    // forever once the kernel pipe buffer filled.
    await runScript({
      cmd: 'bash',
      args: ['-c', 'for i in $(seq 1 40); do head -c 8192 /dev/zero | tr "\\0" "x"; echo; done; echo ALL-FLUSHED'],
      tag: 'test#chatty',
      timeoutS: 15,
    });
  }, 20_000);
});

describe('withShardTmp cleanup (FR-001)', () => {
  it('removes the tmp dir on success', async () => {
    let seen: string | undefined;
    await withShardTmp('unittest-ok', async tmp => {
      expect(fs.existsSync(tmp)).toBe(true);
      fs.writeFileSync(`${tmp}/shard_0.json`, 'x');
      seen = tmp;
    });
    expect(seen).toBeDefined();
    expect(fs.existsSync(seen!)).toBe(false);
  });

  it('removes the tmp dir on failure too (no stranded tmpfs)', async () => {
    let seen: string | undefined;
    await expect(withShardTmp('unittest-fail', async tmp => {
      seen = tmp;
      fs.writeFileSync(`${tmp}/shard_0.json`, 'x');
      throw new Error('shard exploded');
    })).rejects.toThrow('shard exploded');
    expect(seen).toBeDefined();
    expect(fs.existsSync(seen!)).toBe(false);
  });
});

afterAll(async () => {
  // Belt-and-braces: never leave a marker process behind, even if an
  // expectation threw before waitForGone ran.
  if (isLinux) spawnSync('pkill', ['-f', MARKER]);
});
