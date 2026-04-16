/**
 * Autonomous config optimizer using autoresearch principles
 * Runs the 22-day backtest with the aggressive preset to establish baseline
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const RESULTS_FILE = path.resolve(__dirname, '../../.autoresearch-results.tsv');
const LOG_FILE = path.resolve(__dirname, '../../.autoresearch.log');

function log(msg: string) {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] ${msg}`;
  console.log(entry);
  fs.appendFileSync(LOG_FILE, entry + '\n');
}

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd: path.resolve(__dirname, '../../'), stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

async function main() {
  log('═══════════════════════════════════════════════════════════');
  log('  SPXer Config Optimizer — Running 22-Day Backtest');
  log('═══════════════════════════════════════════════════════════');

  log(`\nRunning 22-day backtest with aggressive preset...`);
  log(`Command: bash scripts/backtest/run-backtest.sh --config=aggressive --no-judge --parallel=3`);

  exec('bash scripts/backtest/run-backtest.sh --config=aggressive --no-judge --parallel=3 2>&1');

  log(`\nGenerating results summary...`);
  const output = exec('npx tsx scripts/backtest/view-results.ts 2>&1');

  log(`\n${'═'.repeat(60)}`);
  log(`  RESULTS SUMMARY`);
  log(`${'═'.repeat(60)}`);
  log(output);

  // Parse win rate from output
  const match = output.match(/TOTAL:\s+\d+\s+trades\s+\|\s+([0-9.]+)%\s+WR/);
  const winRate = match ? parseFloat(match[1]) : 0;

  log(`\nWin Rate: ${winRate.toFixed(1)}%`);
  log(`\nBacktest complete. Check replay-logs/ for detailed results.`);
}

main().catch(e => {
  log(`Error: ${e.message}`);
  console.error(e);
  process.exit(1);
});
