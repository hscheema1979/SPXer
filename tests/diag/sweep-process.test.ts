/**
 * A failing child must surface its trailing stderr, not just the final line.
 * Every nightly iron/concdist merge failure from 2026-09-04 to 09-10 was
 * logged as "exited 1: Node.js v22.22.1" — the last line of a V8 fatal —
 * which hid the RangeError above it for a week.
 */
import { describe, it, expect } from 'vitest';
import { runScript, ERR_TAIL_LINES } from '../../scripts/diag/sweep-process';

const nodeErr = (js: string, code: number) => runScript({
  cmd: process.execPath, args: ['-e', `${js}; process.exit(${code})`], tag: 't', timeoutS: 20,
});

describe('runScript stderr tail', () => {
  it('carries the last stderr lines into the failure message, in order', async () => {
    await expect(nodeErr("console.error('FATAL ERROR: heap'); console.error('RangeError: Invalid string length'); console.error('Node.js v22')", 1))
      .rejects.toThrow(/exited 1: FATAL ERROR: heap \| RangeError: Invalid string length \| Node\.js v22/);
  });

  it(`keeps only the last ${ERR_TAIL_LINES} non-empty lines`, async () => {
    const js = `for (let i = 1; i <= ${ERR_TAIL_LINES + 5}; i++) console.error(i % 7 === 0 ? '' : 'line' + i)`;
    let msg = '';
    try { await nodeErr(js, 2); } catch (e: any) { msg = e.message; }
    const lines = msg.replace(/^t exited 2: /, '').split(' | ');
    expect(lines.length).toBe(ERR_TAIL_LINES);
    expect(lines.at(-1)).toBe(`line${ERR_TAIL_LINES + 5}`);
    expect(lines.every(l => l.length > 0)).toBe(true);
  });

  it('resolves on exit 0 regardless of stderr noise', async () => {
    await expect(nodeErr("console.error('warning only')", 0)).resolves.toBeUndefined();
  });
});
