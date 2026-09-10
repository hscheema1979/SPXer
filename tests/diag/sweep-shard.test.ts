/**
 * Sweep accumulator persistence must not depend on a single giant string.
 * The iron state hit 535,937,273 bytes (V8 MAX_STRING_LENGTH is 536,870,888)
 * on 2026-09-08 and every nightly iron merge failed from then on. These pin:
 * per-line layout, round-trip fidelity (nested Maps), the chunked reader on
 * files over the threshold, and backward compatibility with single-line files.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dumpResults, mergeStateFile, loadShardsInto, readStateEntries, knownDates, maxOf } from '../../scripts/diag/sweep-shard';

function sample(): Map<string, any> {
  const m = new Map<string, any>();
  m.set('HMA 1m 3x9|IB w50|TP5 only', {
    pnl: -12.5, n: 3, wins: 1, peakConcurrent: 4,
    daily: new Map([['2026-09-08', { pnl: -20, n: 2 }], ['2026-09-09', { pnl: 7.5, n: 1 }]]),
    perHour: new Map([['10', 1], ['11', 2]]),
    capNets: new Map([['c5', { pnl: 1 }]]),
  });
  m.set('HMA 2m 3x9|15ITM w10|hold-to-settle', { pnl: 3, n: 1, wins: 1, peakConcurrent: 1, daily: new Map([['2026-09-09', { pnl: 3, n: 1 }]]) });
  return m;
}

describe('sweep-shard state persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-shard-'));

  it('writes one top-level entry per line and the file is still one JSON object', () => {
    const f = path.join(dir, 'state.json');
    dumpResults(sample(), f);
    const text = fs.readFileSync(f, 'utf8');
    expect(text.startsWith('{\n')).toBe(true);
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toHaveLength(2);
    expect(text.split('\n').filter(l => l.startsWith('"')).length).toBe(2);
  });

  it('round-trips nested Maps through mergeStateFile (whole-file path)', () => {
    const f = path.join(dir, 'rt.json');
    dumpResults(sample(), f);
    const out = new Map<string, any>();
    expect(mergeStateFile(f, out)).toBe(true);
    const v = out.get('HMA 1m 3x9|IB w50|TP5 only');
    expect(v.daily).toBeInstanceOf(Map);
    expect(v.daily.get('2026-09-08')).toEqual({ pnl: -20, n: 2 });
    expect(v.perHour.get('11')).toBe(2);
    expect([...knownDates(out)].sort()).toEqual(['2026-09-08', '2026-09-09']);
  });

  it('chunked reader (forced by a tiny threshold) yields the same entries as the whole-file path', () => {
    const f = path.join(dir, 'big.json');
    dumpResults(sample(), f);
    const whole: Record<string, any> = {}, chunked: Record<string, any> = {};
    readStateEntries(f, (k, v) => { whole[k] = v; });
    readStateEntries(f, (k, v) => { chunked[k] = v; }, 1 /* every file is "big" */);
    expect(Object.keys(chunked)).toEqual(Object.keys(whole));
    expect(chunked['HMA 1m 3x9|IB w50|TP5 only'].daily.get('2026-09-09')).toEqual({ pnl: 7.5, n: 1 });
  });

  it('chunked reader survives an entry split across read buffers', () => {
    // A value long enough that the 8 MB buffer boundary can only be exercised
    // with a real multi-MB file; use a 9 MB filler string in one entry.
    const f = path.join(dir, 'split.json');
    const m = new Map<string, any>([['filler', { s: 'x'.repeat(9 * 1024 * 1024), n: 1 }], ['tail', { n: 2 }]]);
    dumpResults(m, f);
    const got: Record<string, any> = {};
    readStateEntries(f, (k, v) => { got[k] = v; }, 1);
    expect(got.filler.s.length).toBe(9 * 1024 * 1024);
    expect(got.tail).toEqual({ n: 2 });
  });

  it('still loads a legacy single-line state file and merges shard dumps additively', () => {
    const legacy = path.join(dir, 'legacy.json');
    fs.writeFileSync(legacy, JSON.stringify({ k: { pnl: 1, n: 1, daily: { __map__: [['2026-09-01', { pnl: 1, n: 1 }]] } } }));
    const out = new Map<string, any>();
    expect(mergeStateFile(legacy, out)).toBe(true);
    expect(out.get('k').daily.get('2026-09-01')).toEqual({ pnl: 1, n: 1 });
    const shards = path.join(dir, 'shards'); fs.mkdirSync(shards);
    dumpResults(new Map([['k', { pnl: 2, n: 1, peakConcurrent: 3, daily: new Map([['2026-09-02', { pnl: 2, n: 1 }]]) }]]), path.join(shards, 'shard_0.json'));
    dumpResults(new Map([['k', { pnl: 5, n: 2, peakConcurrent: 1, daily: new Map([['2026-09-03', { pnl: 5, n: 2 }]]) }]]), path.join(shards, 'shard_1.json'));
    const merged = new Map<string, any>();
    loadShardsInto(shards, merged);
    expect(merged.get('k').pnl).toBe(7);
    expect(merged.get('k').n).toBe(3);
    expect(merged.get('k').peakConcurrent).toBe(3);
    expect([...knownDates(merged)].sort()).toEqual(['2026-09-02', '2026-09-03']);
  });
});

describe('maxOf', () => {
  it('matches Math.max on small arrays and handles empty input', () => {
    expect(maxOf([3, 9, 2])).toBe(9);
    expect(maxOf([])).toBe(-Infinity);
  });
  it('does not overflow the stack on 400k elements (Math.max(...arr) does)', () => {
    const arr = new Array(400_000).fill(1); arr[123_456] = 7;
    expect(() => Math.max(...arr)).toThrow(RangeError);
    expect(maxOf(arr)).toBe(7);
  });
});
