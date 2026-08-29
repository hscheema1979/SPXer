/**
 * etf-long-sweep-distributed.ts — Farm ETF long sweeps across Tailscale peers.
 *
 * Uses Tailscale IPs to distribute tickers across available machines via SSH.
 * Each remote runs etf-long-sweep.ts in parallel locally, then syncs results back.
 *
 * Usage:
 *   npx tsx scripts/diag/etf-long-sweep-distributed.ts                # all ETFs
 *   npx tsx scripts/diag/etf-long-sweep-distributed.ts --tickers=SOXL,TQQQ,TNA
 *   npx tsx scripts/diag/etf-long-sweep-distributed.ts --skip-sync     # don't pull results back
 *
 * Environment:
 *   - Must have SSH key-pair setup for Tailscale IPs (vps1, vps2, vps3, vps4, vps5, etc.)
 *   - Results accumulated in local scripts/autoresearch/output/ via rsync
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
const OUTPUT_DIR = path.resolve(__dirname, '../autoresearch/output');

// Tailscale host mapping (name → IP)
const TAILSCALE_HOSTS: Record<string, string> = {
  'vps1': '100.101.179.63',
  'vps2': '100.103.208.24',
  'vps3': '100.72.152.122',
  'vps4': '100.97.253.91',
  'vps5': '100.99.47.10',
};

// Exclude these profiles (0DTE, single stocks)
const SKIP_PROFILES = new Set(['spx-0dte', 'ndx-0dte', 'qqq-0dte', 'qqq-1dte', 'spy-0dte', 'spy-1dte', 'nvda', 'tsla']);

function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.some(a => a === `--${name}`);
}

function discoverEtfDirs(): string[] {
  return fs.readdirSync(PARQUET_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory() && !SKIP_PROFILES.has(d.name))
    .map(d => d.name.toUpperCase())
    .sort();
}

async function checkHostAvailability(host: string, ip: string): Promise<boolean> {
  try {
    await execAsync(`timeout 2 ssh -o ConnectTimeout=1 -o BatchMode=yes ubuntu@${ip} 'echo ok' 2>/dev/null`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function findRepoDir(ip: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`ssh -o BatchMode=yes ubuntu@${ip} 'ls -1d SPXer SPX-0DTE 2>/dev/null | head -1'`);
    const dir = stdout.trim();
    return dir || 'SPXer'; // fallback
  } catch {
    return 'SPXer'; // default fallback
  }
}

async function runRemoteSweep(host: string, ip: string, tickers: string[]): Promise<void> {
  const tickerList = tickers.join(',');
  console.error(`[${host}] dispatching ${tickers.length} tickers: ${tickerList}`);

  const repoDir = await findRepoDir(ip);
  // Try parallel runner first (current repo), fall back to individual sweeps (older repos)
  const tryParallel = `test -f ${repoDir}/scripts/diag/etf-long-sweep-parallel.ts && npx tsx scripts/diag/etf-long-sweep-parallel.ts --tickers=${tickerList}`;
  const fallback = `for sym in ${tickers.join(' ')}; do npx tsx scripts/diag/etf-long-sweep.ts --symbol "$sym" || exit 1; done`;
  const cmd = `cd ${repoDir} && (${tryParallel}) || (${fallback})`;
  const t0 = Date.now();

  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', ['-o', 'BatchMode=yes', `ubuntu@${ip}`, cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d; process.stdout.write(`[${host}] ${d}`); });
    proc.stderr.on('data', d => { stderr += d; process.stderr.write(`[${host}] ${d}`); });

    proc.on('close', code => {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      if (code === 0) {
        console.error(`[${host}] done (${elapsed}s)`);
        resolve();
      } else {
        console.error(`[${host}] failed: exit code ${code} (${elapsed}s)`);
        reject(new Error(`${host} exit ${code}`));
      }
    });
  });
}

async function syncResultsBack(host: string, ip: string, tickers: string[]): Promise<void> {
  console.error(`[${host}] syncing ${tickers.length} results back...`);
  const repoDir = await findRepoDir(ip);
  for (const ticker of tickers) {
    const files = [
      `etf-long-daily-${ticker}.json`,
      `etf-long-hourly-${ticker}.json`,
    ];
    for (const file of files) {
      const remote = `ubuntu@${ip}:${repoDir}/scripts/autoresearch/output/${file}`;
      const local = path.join(OUTPUT_DIR, file);
      try {
        await execAsync(`rsync -a ${remote} ${local}`, { timeout: 30000 });
      } catch (err) {
        console.error(`[${host}] rsync ${file}: ${err}`);
      }
    }
  }
}

async function main() {
  // Check output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const tickersArg = argVal('tickers');
  const allTickers = tickersArg
    ? tickersArg.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : discoverEtfDirs();

  console.error(`[distributed] ${allTickers.length} total tickers`);

  // Check host availability
  const availableHosts: { host: string; ip: string }[] = [];
  for (const [host, ip] of Object.entries(TAILSCALE_HOSTS)) {
    const ok = await checkHostAvailability(host, ip);
    if (ok) {
      availableHosts.push({ host, ip });
      console.error(`✓ ${host} (${ip})`);
    } else {
      console.error(`✗ ${host} (${ip}) — unreachable`);
    }
  }

  if (availableHosts.length === 0) {
    console.error('no hosts available, falling back to local serial execution');
    // Fallback: run locally using etf-long-sweep-parallel.ts
    await new Promise(resolve => {
      spawn('npx', ['tsx', 'scripts/diag/etf-long-sweep-parallel.ts', `--tickers=${allTickers.join(',')}`], {
        stdio: 'inherit',
      }).on('close', resolve);
    });
    return;
  }

  // Partition tickers round-robin across available hosts
  const hostQueues = new Map<string, string[]>();
  for (const host of availableHosts) {
    hostQueues.set(host.host, []);
  }
  for (let i = 0; i < allTickers.length; i++) {
    const host = availableHosts[i % availableHosts.length].host;
    hostQueues.get(host)!.push(allTickers[i]);
  }

  console.error(`[distributed] partitioning ${allTickers.length} tickers across ${availableHosts.length} hosts`);
  for (const [host, tickers] of hostQueues.entries()) {
    console.error(`  ${host}: ${tickers.length} tickers (${tickers.join(', ')})`);
  }

  // Launch all hosts in parallel
  const t0 = Date.now();
  const results = await Promise.allSettled(
    availableHosts.map(({ host, ip }) => {
      const tickers = hostQueues.get(host)!;
      if (tickers.length === 0) return Promise.resolve();
      return runRemoteSweep(host, ip, tickers).then(
        () => hasFlag('skip-sync') ? Promise.resolve() : syncResultsBack(host, ip, tickers)
      );
    })
  );

  // Summarize
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected').length;

  console.error(`\n[distributed] done in ${elapsed}s (${succeeded}/${availableHosts.length} hosts, ${failed} failures)`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
