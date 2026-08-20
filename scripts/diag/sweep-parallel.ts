/**
 * sweep-parallel.ts — run a sweep engine across N CPU cores via date-sharding.
 *
 * Phase 1: spawn N workers, each SWEEP_SHARD="i/N" + SWEEP_SHARD_OUT=tmp/i.json
 *          → every worker processes a disjoint 1/N slice of the dates and
 *            dumps its partial accumulator (no dashboard write).
 * Phase 2: one SWEEP_MERGE=tmpdir run → folds all partials into `results` and
 *          runs the engine's normal finalize → the SAME dashboard JSON the
 *          serial run would produce (proven by scripts/diag/sweep-parity.ts).
 *
 * Correctness: the date loop has no cross-date state; `results` is a pure
 * reducer (sum / max peakConcurrent / union daily). Sharding keeps each date's
 * FULL intraday history, so it cannot introduce look-ahead and does not touch
 * candle-volume handling. See sweep-shard.ts.
 *
 * Usage:
 *   npx tsx scripts/diag/sweep-parallel.ts --symbol SPX [--engine both|credit|iron]
 *                                          [--shards 8] [--dte 0] [--no-post]
 *   engine=both runs credit THEN iron (they share the per-symbol dashboard
 *   JSON, so they must serialize; each is internally N-way parallel).
 *
 * Post-process (pipeline steps 4–5, mirrors sweep-manager.ts::cmdExecute):
 *   when --engine both, after the sweeps it AUTOMATICALLY runs
 *   curate-risk-targets.ts → concurrent-distribution.ts so the cap-variability
 *   [1,2,3,5,8,10,12,15,uncap] + risk distribution is always fresh for the
 *   dashboard. This is why a plain `--engine both` regen no longer leaves
 *   stale cap/risk data. `--no-post` skips it; partial engine runs (credit-
 *   or iron-only, e.g. sweep-parity) never trigger it (curate needs the
 *   combined credit+iron sweep JSON).
 *
 * Lifecycle (FR-001): every spawn is detached (own process group), bounded by
 * a wall-clock timeout, has its stdout drained, and dies with the wrapper on
 * SIGINT/SIGTERM — see sweep-process.ts. Layers above this file: eod-
 * pipeline.sh takes an flock and wraps each symbol in `timeout`; scripts/ops/
 * sweep-reaper.sh reaps anything that still escapes (>6h). No layer may hang
 * forever — the 2026-07-31..08-19 leak stacked ~4-6 orphaned processes/day.
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { runScript, installSignalCleanup, parseTimeoutEnv } from './sweep-process';

const ROOT = process.cwd();
const argv = process.argv.slice(2);

function flag(name: string, def?: string): string | undefined {
  const eq = argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}

const engineArg = (flag('engine', 'both') || 'both').toLowerCase();
// Default shards = quarter of the cores (min 1, cap 2) so a sweep leaves the bulk
// of the box for the live services + an in-flight build. 4 shards previously
// OOM-killed a Next build on this 8-core/22GB host. Explicit --shards overrides.
// A hard ceiling of (cores-1) prevents pegging every core even if asked for more.
const CORES = os.cpus().length;
const defaultShards = Math.max(1, Math.min(2, Math.floor(CORES / 4)));
const requestedShards = Math.max(1, parseInt(flag('shards', String(defaultShards)) || String(defaultShards), 10));
const shards = Math.min(requestedShards, Math.max(1, CORES - 1));
const noPost = argv.includes('--no-post');
// --state-dir <dir>: a sharded run becomes a BOOTSTRAP — its merge finalize
// also persists the per-(symbol,engine) accumulator so subsequent nightly
// runs can go incremental (replay only the new day). Omit = no state seeded.
const stateDir = flag('state-dir');
const SYM = (flag('symbol', 'SPX') || 'SPX').toUpperCase();
const stateFor = (eng: string) => stateDir ? path.join(stateDir, `${SYM}-${eng}.json`) : undefined;
// Pass-through args for the worker (strip orchestrator-only flags, keep --symbol/--dte/etc.)
const passthru: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--engine' || a === '--shards' || a === '--state-dir') { i++; continue; }
  if (a.startsWith('--engine=') || a.startsWith('--shards=') || a.startsWith('--state-dir=') || a === '--no-post') continue;
  passthru.push(a);
}

const ENGINES: Record<string, string> = {
  credit: 'scripts/diag/credit-spread-sweep.ts',
  iron:   'scripts/diag/iron-sweep.ts',
  'broken-wing-butterfly': 'scripts/diag/broken-wing-butterfly-sweep.ts',
  long:   'scripts/diag/long-config-sweep.ts',
  // Multi-DTE short-put-spread engine (delta-targeted, multi-session carry).
  // Separate from `credit` so the 0DTE iron/credit study is untouched.
  'multi-dte': 'scripts/diag/multi-dte-credit-sweep.ts',
  // LuxAlgo Trendlines-with-Breaks → bidirectional credit spreads (bull break
  // = short puts, bear break = short calls). Pins 0.50Δ × 4-wide; sweeps TLB
  // across 3m/5m/15m/30m/60m timeframes; reuses multi-dte loaders. Side-tagged
  // spread labels keep dashboard rows distinct from the put-only multi-dte run.
  'tlb-credit': 'scripts/diag/tlb-credit-sweep.ts',
  // NOTE: 'smc-credit' (SMC liquidity-sweep+BOS) was REMOVED 2026-06-16. Its
  // results were TP-fill artifacts and it overwrote the live dashboard. Do not
  // re-add without the BS pricing engine + user sign-off. See memory:
  // project_smc_credit_sweep (RETIRED), incident_2026_06_15_smc_3_5dte_overwrite.
};
const order = engineArg === 'both' ? ['credit', 'iron', 'broken-wing-butterfly'] : [engineArg];
for (const e of order) if (!ENGINES[e]) { console.error(`unknown --engine ${e} (credit|iron|broken-wing-butterfly|long|multi-dte|tlb-credit|both)`); process.exit(2); }

// Resource throttling so a sweep never starves the live services / a build on a
// shared box. Workers run at low CPU + IO priority and a capped V8 heap. Tunable
// without code changes:
//   SWEEP_NICE       nice level 0..19 (default 15 — yields to anything interactive)
//   SWEEP_IONICE     '1' to apply `ionice -c2 -n7` best-effort low IO (default on)
//   SWEEP_HEAP_MB    per-worker --max-old-space-size (default 2048)
//   SWEEP_MERGE_HEAP_MB  merge-step heap (default 2× worker — it holds every
//                        shard's accumulator at once, so it OOMs first)
const NICE = Math.min(19, Math.max(0, parseInt(process.env.SWEEP_NICE || '15', 10)));
const USE_IONICE = (process.env.SWEEP_IONICE ?? '1') !== '0';
const HEAP_MB = Math.max(512, parseInt(process.env.SWEEP_HEAP_MB || '2048', 10));
const MERGE_HEAP_MB = Math.max(HEAP_MB, parseInt(process.env.SWEEP_MERGE_HEAP_MB || String(HEAP_MB * 2), 10));
const HAS_IONICE = USE_IONICE && process.platform === 'linux';
// Wall-clock bounds per spawn (FR-001): a hung step can no longer block the
// wrapper forever. Defaults sized from eod-pipeline.log history — longest
// shard phase ever observed 1818s (iron), longest merge 64s — so these only
// trip on genuine hangs. Overridable like the other SWEEP_* knobs.
const WORKER_TIMEOUT_S = parseTimeoutEnv('SWEEP_WORKER_TIMEOUT_S', 2700);
const MERGE_TIMEOUT_S = parseTimeoutEnv('SWEEP_MERGE_TIMEOUT_S', 900);

function run(script: string, env: Record<string, string>, tag: string, heapMb: number = HEAP_MB,
            timeoutS: number = WORKER_TIMEOUT_S): Promise<void> {
  // Prefix: nice [ionice] npx tsx … — low CPU + IO priority. ionice only on
  // Linux (no-op elsewhere). Heap cap goes to the worker via NODE_OPTIONS.
  // Lifecycle (detached group, timeout kill, drained stdout, signal cleanup)
  // lives in sweep-process.ts.
  const prefix = ['nice', '-n', String(NICE),
    ...(HAS_IONICE ? ['ionice', '-c2', '-n7'] : [])];
  const workerNodeOpts = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--max-old-space-size=${heapMb}`;
  return runScript({
    cmd: prefix[0],
    args: [...prefix.slice(1), 'npx', 'tsx', path.join(ROOT, script), ...passthru],
    env: { ...env, NODE_OPTIONS: workerNodeOpts },
    cwd: ROOT,
    tag,
    timeoutS,
  });
}

// Date-shard a script across `shards` cores: N workers (SWEEP_SHARD/
// SWEEP_SHARD_OUT) in parallel, then one SWEEP_MERGE finalize. Used for the
// sweep engines AND concurrent-distribution (all date-additive reducers).
// Prune shard dirs left by crashed runs (cleanup only happens on success, so
// failures strand ~670MB of tmpfs each — which is RAM on this box). Anything
// older than 6h can't belong to a live run.
function pruneStaleShards(): void {
  const base = '/tmp/sweepshard';
  let entries: string[] = [];
  try { entries = fs.readdirSync(base); } catch { return; }
  const cutoff = Date.now() - 6 * 3600_000;
  for (const e of entries) {
    const ts = parseInt(e, 10);
    if (Number.isFinite(ts) && ts < cutoff) {
      try { fs.rmSync(path.join(base, e), { recursive: true, force: true }); } catch {}
    }
  }
}

// Create a fresh shard tmp dir for fn, remove it when fn settles — INCLUDING
// on failure (FR-001: cleanup previously ran only on success, so every crash
// stranded a tmpfs dir — RAM on this box). Exported for tests.
export async function withShardTmp<T>(tag: string, fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = path.join('/tmp/sweepshard', `${Date.now()}_${tag}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    return await fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function shardRun(script: string, tag: string, stateFile?: string): Promise<void> {
  pruneStaleShards();
  if (stateFile) fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await withShardTmp(tag, async tmp => {
    console.log(`\n[${tag}] ${shards} shard workers …`);
    const tA = Date.now();
    await Promise.all(
      Array.from({ length: shards }, (_, i) =>
        run(script, { SWEEP_SHARD: `${i}/${shards}`, SWEEP_SHARD_OUT: path.join(tmp, `shard_${i}.json`) }, `${tag}#${i}`)),
    );
    console.log(`[${tag}] shards done in ${((Date.now() - tA) / 1000).toFixed(1)}s → merging …`);
    const tM = Date.now();
    // Merge finalize: SWEEP_STATE (when bootstrapping) makes it persist the
    // merged accumulator so the next nightly run can replay only the new day.
    await run(script, stateFile ? { SWEEP_MERGE: tmp, SWEEP_STATE: stateFile } : { SWEEP_MERGE: tmp },
      `${tag}#merge`, MERGE_HEAP_MB, MERGE_TIMEOUT_S);
    console.log(`[${tag}] merge+finalize in ${((Date.now() - tM) / 1000).toFixed(1)}s${stateFile ? ` (state → ${stateFile})` : ''}`);
  });
}

// Main guard: run the orchestration only when executed directly (tsx …/sweep-
// parallel.ts), not when imported by tests. argv[1] is the script path under
// tsx/node; under vitest it's the runner.
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('sweep-parallel.ts')) {
  installSignalCleanup();
  (async () => {
  const t0 = Date.now();
  console.log(`[sweep-parallel] ${SYM} | ${shards}/${CORES} shards${requestedShards !== shards ? ` (requested ${requestedShards}, capped)` : ''} | nice=${NICE}${HAS_IONICE ? ' ionice=c2n7' : ''} | heap=${HEAP_MB}MB/worker, ${MERGE_HEAP_MB}MB merge`);
  for (const eng of order) {
    await shardRun(ENGINES[eng], eng, stateFor(eng));
  }

  // ── Pipeline steps 4–5 (auto) — mirrors sweep-manager.ts::cmdExecute ──────
  // Only after a FULL credit+iron regen (curate reads the combined sweep
  // JSON). Keeps the cap-variability + risk distribution always fresh so a
  // plain `--engine both` no longer leaves the dashboard with stale caps.
  if (engineArg === 'both' && !noPost) {
    const tP = Date.now();
    console.log(`\n[post] curate-risk-targets → concurrent-distribution (${shards}-way) …`);
    await run('scripts/diag/curate-risk-targets.ts', {}, 'curate');     // ~2s, single
    await shardRun('scripts/diag/concurrent-distribution.ts', 'concurrent-distribution', stateFor('concdist'));
    console.log(`[post] cap/risk refreshed in ${((Date.now() - tP) / 1000).toFixed(1)}s`);
  } else if (noPost) {
    console.log(`\n[post] skipped (--no-post)`);
  } else {
    console.log(`\n[post] skipped (engine=${engineArg}; curate needs combined credit+iron — use --engine both)`);
  }

  console.log(`\n✓ sweep-parallel complete in ${((Date.now() - t0) / 1000).toFixed(1)}s (${shards}-way)`);
  })().catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
}
