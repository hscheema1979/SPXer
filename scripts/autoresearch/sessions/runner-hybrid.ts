/**
 * Hybrid Autoresearch Runner
 * 
 * Runs sessions 1-8 (deterministic, fast) to identify top configs,
 * then runs sessions 9-10 (scanners, slow) on only those top 5-10 configs.
 * 
 * Usage:
 *   npx tsx scripts/autoresearch/sessions/runner-hybrid.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const TEST_DATES = '2026-02-20,2026-02-24,2026-03-05,2026-03-10,2026-03-19,2026-03-20';
const RESULTS_FILE = path.resolve(__dirname, '../../.autoresearch-results.tsv');

interface ResultRow {
  param_id: string;
  win_rate: number;
  total_pnl: number;
  sharpe: number;
}

// Parse TSV results file and extract top N configs by composite score
function getTopConfigs(n = 10): ResultRow[] {
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log(`[WARN] Results file not found: ${RESULTS_FILE}`);
    return [];
  }

  const lines = fs.readFileSync(RESULTS_FILE, 'utf-8').split('\n').filter(l => l);
  if (lines.length < 2) return [];

  const header = lines[0].split('\t');
  const rows: ResultRow[] = lines.slice(1).map(line => {
    const cols = line.split('\t');
    const obj: any = {};
    header.forEach((h, i) => { obj[h] = cols[i]; });
    
    const winRate = parseFloat(obj.win_rate) || 0;
    const pnl = parseFloat(obj.total_pnl) || 0;
    const sharpe = parseFloat(obj.sharpe) || 0;
    
    // Composite score: winRate*40 + sharpe*30 + (pnl>0?20:0) + (pnl>-500?10:0)
    const score = (winRate * 40) + (sharpe * 30) + (pnl > 0 ? 20 : 0) + (pnl > -500 ? 10 : 0);
    
    return {
      param_id: obj.param_id,
      win_rate: winRate,
      total_pnl: pnl,
      sharpe: sharpe,
    };
  });

  // Sort by composite score (descending)
  rows.sort((a, b) => {
    const scoreA = (a.win_rate * 40) + (a.sharpe * 30) + (a.total_pnl > 0 ? 20 : 0) + (a.total_pnl > -500 ? 10 : 0);
    const scoreB = (b.win_rate * 40) + (b.sharpe * 30) + (b.total_pnl > 0 ? 20 : 0) + (b.total_pnl > -500 ? 10 : 0);
    return scoreB - scoreA;
  });

  return rows.slice(0, n);
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Hybrid Autoresearch: Sessions 1-8 (Deterministic)');
  console.log('                       Sessions 9-10 (Scanners on Top Configs)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  // Phase 1: Sessions 1-8 (deterministic)
  console.log('[PHASE 1] Running sessions 1-8 with deterministic signals...');
  
  const sessions = [
    { num: 1, prompt: 'session01-time-otm-morning' },
    { num: 2, prompt: 'session02-rsi-thresholds-25-75' },
    { num: 3, prompt: 'session03-stoploss-60' },
    { num: 4, prompt: 'session04-exit-strategy-5x' },
    { num: 5, prompt: 'session05-option-rsi-30-70' },
    { num: 6, prompt: 'session06-cooldown-300' },
    { num: 7, prompt: 'session07-hma-signals-basic' },
    { num: 8, prompt: 'session08-ema-signals-basic' },
  ];

  for (const s of sessions) {
    try {
      console.log(`  [Session ${s.num}] ${s.prompt}...`);
      execSync(
        `npx tsx scripts/autoresearch/verify-metric.ts --dates=${TEST_DATES} --promptId=${s.prompt} --no-scanners`,
        { stdio: 'pipe' }
      );
    } catch (err) {
      console.log(`  [ERROR] Session ${s.num} failed`);
    }
  }

  console.log('');
  console.log('[PHASE 1 COMPLETE] Sessions 1-8 done.');
  console.log('');

  // Phase 2: Identify top configs
  console.log('[PHASE 2] Analyzing results to find top 10 configs...');
  const topConfigs = getTopConfigs(10);
  
  if (topConfigs.length === 0) {
    console.log('  [ERROR] No results found. Run sessions 1-8 first.');
    process.exit(1);
  }

  console.log(`  Found ${topConfigs.length} top configs:`);
  for (let i = 0; i < topConfigs.length; i++) {
    console.log(`    ${i + 1}. ${topConfigs[i].param_id}: WR=${(topConfigs[i].win_rate*100).toFixed(0)}% P&L=$${topConfigs[i].total_pnl.toFixed(0)}`);
  }

  console.log('');
  console.log('[PHASE 2 COMPLETE] Ready for sessions 9-10 with scanners.');
  console.log('');
  console.log('Next: Run sessions 9-10 with scanners on these top configs');
  console.log('  npx tsx scripts/autoresearch/sessions/runner-sessions-9-10.ts');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
