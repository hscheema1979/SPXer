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
 */
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

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
};
const order = engineArg === 'both' ? ['credit', 'iron', 'broken-wing-butterfly'] : [engineArg];
for (const e of order) if (!ENGINES[e]) { console.error(`unknown --engine ${e} (credit|iron|broken-wing-butterfly|long|multi-dte|both)`); process.exit(2); }

// Resource throttling so a sweep never starves the live services / a build on a
// shared box. Workers run at low CPU + IO priority and a capped V8 heap. Tunable
// without code changes:
//   SWEEP_NICE       nice level 0..19 (default 15 — yields to anything interactive)
//   SWEEP_IONICE     '1' to apply `ionice -c2 -n7` best-effort low IO (default on)
//   SWEEP_HEAP_MB    per-worker --max-old-space-size (default 2048)
const NICE = Math.min(19, Math.max(0, parseInt(process.env.SWEEP_NICE || '15', 10)));
const USE_IONICE = (process.env.SWEEP_IONICE ?? '1') !== '0';
const HEAP_MB = Math.max(512, parseInt(process.env.SWEEP_HEAP_MB || '2048', 10));
const HAS_IONICE = USE_IONICE && process.platform === 'linux';

function run(script: string, env: Record<string, string>, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Prefix: nice [ionice] npx tsx … — low CPU + IO priority. ionice only on
    // Linux (no-op elsewhere). Heap cap goes to the worker via NODE_OPTIONS.
    const prefix = ['nice', '-n', String(NICE),
      ...(HAS_IONICE ? ['ionice', '-c2', '-n7'] : [])];
    const cmd = prefix[0];
    const cmdArgs = [...prefix.slice(1), 'npx', 'tsx', path.join(ROOT, script), ...passthru];
    const workerNodeOpts = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--max-old-space-size=${HEAP_MB}`;
    const ch = spawn(cmd, cmdArgs, {
      cwd: ROOT, env: { ...process.env, ...env, NODE_OPTIONS: workerNodeOpts }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastErr = '';
    ch.stderr.on('data', d => { const s = d.toString(); lastErr = s.trim().split('\n').pop() || lastErr; });
    ch.on('close', code => code === 0 ? resolve()
      : reject(new Error(`${tag} exited ${code}: ${lastErr}`)));
  });
}

// Date-shard a script across `shards` cores: N workers (SWEEP_SHARD/
// SWEEP_SHARD_OUT) in parallel, then one SWEEP_MERGE finalize. Used for the
// sweep engines AND concurrent-distribution (all date-additive reducers).
async function shardRun(script: string, tag: string, stateFile?: string): Promise<void> {
  const tmp = path.join('/tmp/sweepshard', `${Date.now()}_${tag}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (stateFile) fs.mkdirSync(path.dirname(stateFile), { recursive: true });
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
  await run(script, stateFile ? { SWEEP_MERGE: tmp, SWEEP_STATE: stateFile } : { SWEEP_MERGE: tmp }, `${tag}#merge`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`[${tag}] merge+finalize in ${((Date.now() - tM) / 1000).toFixed(1)}s${stateFile ? ` (state → ${stateFile})` : ''}`);
}

(async () => {
  const t0 = Date.now();
  console.log(`[sweep-parallel] ${SYM} | ${shards}/${CORES} shards${requestedShards !== shards ? ` (requested ${requestedShards}, capped)` : ''} | nice=${NICE}${HAS_IONICE ? ' ionice=c2n7' : ''} | heap=${HEAP_MB}MB/worker`);
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
