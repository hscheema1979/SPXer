/**
 * etf-long-sweep-parallel.ts — saturate all cores running etf-long-sweep.ts.
 *
 * The sweep engine is single-threaded and processes one ticker at a time. Since
 * every ticker is fully independent (own parquet dir, own output file), the
 * cleanest parallelism is per-ticker: spawn a pool of `etf-long-sweep --symbol X`
 * child processes, N at a time, refilling as each finishes.
 *
 *   npx tsx scripts/diag/etf-long-sweep-parallel.ts                 # all ETF dirs, N=cores-1
 *   npx tsx scripts/diag/etf-long-sweep-parallel.ts --workers=8
 *   npx tsx scripts/diag/etf-long-sweep-parallel.ts --tickers=TQQQ,SOXL
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
const ENGINE = path.resolve(__dirname, 'etf-long-sweep.ts');

function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : undefined;
}

function discoverEtfDirs(): string[] {
  const skip = new Set(['spx-0dte', 'ndx-0dte', 'qqq-0dte', 'qqq-1dte', 'spy-0dte', 'spy-1dte', 'nvda', 'tsla']);
  return fs.readdirSync(PARQUET_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !skip.has(d.name))
    .map(d => d.name.toUpperCase())
    .sort();
}

const tickersArg = argVal('tickers');
const tickers = tickersArg
  ? tickersArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  : discoverEtfDirs();
// Default: 2 workers (safe for shared VPS); --workers=N to override. Max recommended is 6 to leave headroom for other services.
const WORKERS = Math.max(1, parseInt(argVal('workers') || '2', 10));

console.error(`[parallel] ${tickers.length} tickers, ${WORKERS} workers (of ${os.cpus().length} cores)`);
const t0 = Date.now();

let next = 0, done = 0, failed = 0;
const queue = [...tickers];

function runOne(sym: string): Promise<void> {
  return new Promise(resolve => {
    const tStart = Date.now();
    const child = spawn('npx', ['tsx', ENGINE, '--symbol', sym], { stdio: ['ignore', 'ignore', 'pipe'] });
    let lastErr = '';
    child.stderr.on('data', d => { const s = d.toString().trim(); if (s) lastErr = s.split('\n').pop() || lastErr; });
    child.on('close', code => {
      const secs = ((Date.now() - tStart) / 1000).toFixed(0);
      if (code === 0) { done++; console.error(`  ✓ ${sym} (${secs}s) [${done + failed}/${tickers.length}] — ${lastErr.replace(/^✓\s*/, '')}`); }
      else { failed++; done++; console.error(`  ✗ ${sym} (exit ${code}) [${done + failed}/${tickers.length}] — ${lastErr}`); }
      resolve();
    });
  });
}

async function worker(): Promise<void> {
  while (queue.length) {
    const sym = queue.shift()!;
    await runOne(sym);
  }
}

(async () => {
  await Promise.all(Array.from({ length: Math.min(WORKERS, tickers.length) }, () => worker()));
  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.error(`[parallel] done in ${mins} min — ${done - failed} ok, ${failed} failed`);
})();
