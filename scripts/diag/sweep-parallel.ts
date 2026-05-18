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
const shards = Math.max(1, parseInt(flag('shards', String(os.cpus().length)) || '8', 10));
const noPost = argv.includes('--no-post');
// Pass-through args for the worker (strip orchestrator-only flags, keep --symbol/--dte/etc.)
const passthru: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--engine' || a === '--shards') { i++; continue; }
  if (a.startsWith('--engine=') || a.startsWith('--shards=') || a === '--no-post') continue;
  passthru.push(a);
}

const ENGINES: Record<string, string> = {
  credit: 'scripts/diag/credit-spread-sweep.ts',
  iron:   'scripts/diag/iron-sweep.ts',
};
const order = engineArg === 'both' ? ['credit', 'iron'] : [engineArg];
for (const e of order) if (!ENGINES[e]) { console.error(`unknown --engine ${e} (credit|iron|both)`); process.exit(2); }

function run(script: string, env: Record<string, string>, tag: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ch = spawn('npx', ['tsx', path.join(ROOT, script), ...passthru], {
      cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let lastErr = '';
    ch.stderr.on('data', d => { const s = d.toString(); lastErr = s.trim().split('\n').pop() || lastErr; });
    ch.on('close', code => code === 0 ? resolve()
      : reject(new Error(`${tag} exited ${code}: ${lastErr}`)));
  });
}

(async () => {
  const t0 = Date.now();
  for (const eng of order) {
    const script = ENGINES[eng];
    const tmp = path.join('/tmp/sweepshard', `${Date.now()}_${eng}`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    console.log(`\n[${eng}] ${shards} shard workers …`);
    const tA = Date.now();
    await Promise.all(
      Array.from({ length: shards }, (_, i) =>
        run(script, { SWEEP_SHARD: `${i}/${shards}`, SWEEP_SHARD_OUT: path.join(tmp, `shard_${i}.json`) }, `${eng}#${i}`)),
    );
    console.log(`[${eng}] shards done in ${((Date.now() - tA) / 1000).toFixed(1)}s → merging …`);
    const tM = Date.now();
    await run(script, { SWEEP_MERGE: tmp }, `${eng}#merge`);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`[${eng}] merge+finalize in ${((Date.now() - tM) / 1000).toFixed(1)}s`);
  }

  // ── Pipeline steps 4–5 (auto) — mirrors sweep-manager.ts::cmdExecute ──────
  // Only after a FULL credit+iron regen (curate reads the combined sweep
  // JSON). Keeps the cap-variability + risk distribution always fresh so a
  // plain `--engine both` no longer leaves the dashboard with stale caps.
  if (engineArg === 'both' && !noPost) {
    const tP = Date.now();
    console.log(`\n[post] curate-risk-targets → concurrent-distribution …`);
    await run('scripts/diag/curate-risk-targets.ts', {}, 'curate');
    await run('scripts/diag/concurrent-distribution.ts', {}, 'concurrent-distribution');
    console.log(`[post] cap/risk refreshed in ${((Date.now() - tP) / 1000).toFixed(1)}s`);
  } else if (noPost) {
    console.log(`\n[post] skipped (--no-post)`);
  } else {
    console.log(`\n[post] skipped (engine=${engineArg}; curate needs combined credit+iron — use --engine both)`);
  }

  console.log(`\n✓ sweep-parallel complete in ${((Date.now() - t0) / 1000).toFixed(1)}s (${shards}-way)`);
})().catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
