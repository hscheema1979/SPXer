/**
 * sweep-shard.ts — date-shard + accumulator-merge for parallel sweeps.
 *
 * Contains ZERO trading logic. It only (a) partitions the date list across
 * worker shards and (b) reduces each shard's `results` Stat-map back into one.
 *
 * Why this is provably identical to a serial run:
 *   The sweep date loop has NO cross-date state — each date independently
 *   loads its own bars, detects signals (entry = signal-bar+60s, look-ahead
 *   protected), and calls rec(). `results` is a pure reducer:
 *     - pnl, pnl_gross, n, wins, creditSum, widthSum, durationSumSec,
 *       evictions  → SUM across dates  → SUM across shards
 *     - daily (Map<date,number>)       → per-date keys are DISJOINT across
 *                                        shards (modulo partition) → union
 *     - perHour (iron, Map<hr,bucket>) → field-wise SUM
 *     - peakConcurrent → per-DAY max already (overlapMap cleared each day),
 *                        so the global value is MAX over days = MAX over
 *                        shard maxes.
 *   Therefore summing/maxing the shard partials yields the exact same
 *   `results` the serial loop would have produced (modulo float-add order,
 *   which only perturbs pnl at ~1e-9; integer fields are exact). Sharding
 *   keeps each date's FULL intraday bar history intact, so it cannot
 *   introduce look-ahead and does not touch candle volume handling.
 *
 * Modes (env, read by the engines):
 *   SWEEP_SHARD="i/n"     run only dates where dateIndex % n === i
 *   SWEEP_SHARD_OUT=path  after the loop, dump `results` to path and exit
 *                         (do NOT run the dashboard-merge/report finalize)
 *   SWEEP_MERGE=dir       skip the date loop; load every shard dump in dir
 *                         into `results`, then run the normal finalize once
 */
import * as fs from 'fs';
import * as path from 'path';

/** Partition dates for this worker. No env → unchanged (serial). */
export function shardDates(dates: string[]): string[] {
  const s = process.env.SWEEP_SHARD;
  if (!s) return dates;
  const [iRaw, nRaw] = s.split('/');
  const i = Number(iRaw), n = Number(nRaw);
  if (!Number.isInteger(i) || !Number.isInteger(n) || n <= 0 || i < 0 || i >= n) {
    throw new Error(`[sweep-shard] bad SWEEP_SHARD="${s}" (expected "i/n", 0<=i<n)`);
  }
  return dates.filter((_, idx) => idx % n === i);
}

// ── (de)serialize a Stat-map containing nested Maps ─────────────────────────
// Map → { __map__: [[k,v],...] } recursively, so daily/perHour survive JSON.
function encode(v: any): any {
  if (v instanceof Map) return { __map__: [...v.entries()].map(([k, val]) => [k, encode(val)]) };
  if (v && typeof v === 'object') { const o: any = {}; for (const k of Object.keys(v)) o[k] = encode(v[k]); return o; }
  return v;
}
function decode(v: any): any {
  if (v && typeof v === 'object' && Array.isArray(v.__map__)) {
    const m = new Map(); for (const [k, val] of v.__map__) m.set(k, decode(val)); return m;
  }
  if (v && typeof v === 'object') { const o: any = {}; for (const k of Object.keys(v)) o[k] = decode(v[k]); return o; }
  return v;
}

/**
 * Worker / finalize: serialize the whole Stat-map to a file.
 *
 * Written ONE TOP-LEVEL ENTRY PER LINE, never as a single JSON.stringify of
 * the whole map. The iron accumulators reached 535,937,273 bytes on
 * 2026-09-08 — within 1 MB of V8's MAX_STRING_LENGTH (536,870,888) — and
 * `JSON.stringify(obj)` threw RangeError in every nightly merge from then on
 * ("iron#merge exited 1"), even on a clean bootstrap. The output is still one
 * valid JSON object (`{` … `"k":v,` … `"k":v` … `}`), so small files stay
 * readable by a plain JSON.parse; readStateEntries() streams the big ones.
 */
export function dumpResults(results: Map<string, any>, outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fd = fs.openSync(outPath, 'w');
  try {
    fs.writeSync(fd, '{\n');
    let first = true;
    for (const [k, v] of results) {
      fs.writeSync(fd, (first ? '' : ',\n') + JSON.stringify(k) + ':' + JSON.stringify(encode(v)));
      first = false;
    }
    fs.writeSync(fd, '\n}\n');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Files at or above this size cannot be read into one JS string
 * (fs.readFileSync(file,'utf8') throws past MAX_STRING_LENGTH), so they are
 * parsed line by line. Anything smaller takes the whole-file fast path, which
 * also keeps pre-2026-09-10 single-line state/shard files loadable.
 */
export const WHOLE_FILE_MAX_BYTES = 256 * 1024 * 1024;

/** Iterate top-level (key, decoded value) entries of a state/shard file. */
export function readStateEntries(
  file: string,
  onEntry: (key: string, decoded: any) => void,
  wholeFileMaxBytes: number = WHOLE_FILE_MAX_BYTES,
): void {
  if (fs.statSync(file).size < wholeFileMaxBytes) {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const k of Object.keys(obj)) onEntry(k, decode(obj[k]));
    return;
  }
  // Large file: must be the one-entry-per-line layout dumpResults() writes.
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  let carry = '';
  const handleLine = (line: string) => {
    let t = line.trim();
    if (t === '' || t === '{' || t === '}') return;
    if (t.endsWith(',')) t = t.slice(0, -1);
    const one = JSON.parse('{' + t + '}');
    for (const k of Object.keys(one)) onEntry(k, decode(one[k]));
  };
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      carry += buf.toString('utf8', 0, n);
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        handleLine(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
      }
    }
    if (carry.length) handleLine(carry);
  } finally {
    fs.closeSync(fd);
  }
}

// Reduce `src` into `dst` with the field rules above. `peakConcurrent` is the
// ONLY max-field; every other finite number sums; Maps merge by key (numbers
// sum, objects recurse).
function reduceInto(dst: any, src: any): any {
  if (dst === undefined) return src;
  if (src instanceof Map) {
    for (const [k, sv] of src) dst.set(k, reduceInto(dst.get(k), sv));
    return dst;
  }
  if (src && typeof src === 'object') {
    for (const k of Object.keys(src)) {
      if (k === 'peakConcurrent') dst[k] = Math.max(dst[k] ?? 0, src[k] ?? 0);
      else dst[k] = reduceInto(dst[k], src[k]);
    }
    return dst;
  }
  if (typeof src === 'number' && typeof dst === 'number') return dst + src;
  return src; // strings (signal/spread/exit labels): identical across shards
}

/** Merge-finalize: load every *.json shard dump in `dir` into `results`. */
export function loadShardsInto(dir: string, results: Map<string, any>): void {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`[sweep-shard] no shard dumps in ${dir}`);
  for (const f of files) {
    readStateEntries(path.join(dir, f), (k, decoded) => {
      results.set(k, results.has(k) ? reduceInto(results.get(k), decoded) : decoded);
    });
  }
}

/**
 * INCREMENTAL: merge a single persisted accumulator state file into `results`
 * (same additive reduce as the shard merge — parity-proven). Returns true if
 * the state file existed (so the caller knows to replay only NEW dates),
 * false on first/bootstrap run. dumpResults() writes this same file shape.
 */
export function mergeStateFile(file: string, results: Map<string, any>): boolean {
  if (!fs.existsSync(file)) return false;
  readStateEntries(file, (k, decoded) => {
    results.set(k, results.has(k) ? reduceInto(results.get(k), decoded) : decoded);
  });
  return true;
}

/** Union of all dates already present in the accumulator's per-date `daily`
 *  maps — i.e. dates that must NOT be replayed again (idempotent by date). */
export function knownDates(results: Map<string, any>): Set<string> {
  const s = new Set<string>();
  for (const v of results.values()) {
    if (v && v.daily instanceof Map) for (const d of v.daily.keys()) s.add(d);
  }
  return s;
}
