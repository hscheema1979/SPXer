/**
 * Auto-Update Config from Autoresearch Results
 *
 * Runs at 6 AM to:
 * 1. Parse .autoresearch-results.tsv
 * 2. Find best config by composite score
 * 3. Update agent-config.ts and scanner prompt
 * 4. Restart spxer-agent PM2 process
 *
 * Usage:
 *   npx tsx scripts/update-config-from-autoresearch.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface ResultRow {
  param_id: string;
  label: string;
  strike_range: string;
  rsi_os: string;
  rsi_ob: string;
  opt_rsi_os: string;
  opt_rsi_ob: string;
  stop_loss: string;
  tp_mult: string;
  time_start: string;
  time_end: string;
  max_pos: string;
  win_rate: string;
  total_pnl: string;
  sharpe: string;
}

function parseResults(): { best: ResultRow; all: ResultRow[] } {
  const resultsFile = path.resolve(__dirname, '../.autoresearch-results.tsv');

  if (!fs.existsSync(resultsFile)) {
    throw new Error(`Results file not found: ${resultsFile}`);
  }

  const lines = fs.readFileSync(resultsFile, 'utf-8').split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Empty results file');

  const header = lines[0].split('\t');
  const rows: ResultRow[] = lines.slice(1).map(line => {
    const cols = line.split('\t');
    const obj: any = {};
    header.forEach((h, i) => { obj[h] = cols[i]; });
    return obj as ResultRow;
  });

  // Score by: winRate*40 + sharpe*30 + (pnl>0?20:0) + (pnl>-500?10:0)
  rows.sort((a, b) => {
    const scoreA = (parseFloat(a.win_rate) * 40) + (parseFloat(a.sharpe) * 30) +
      (parseFloat(a.total_pnl) > 0 ? 20 : 0) + (parseFloat(a.total_pnl) > -500 ? 10 : 0);
    const scoreB = (parseFloat(b.win_rate) * 40) + (parseFloat(b.sharpe) * 30) +
      (parseFloat(b.total_pnl) > 0 ? 20 : 0) + (parseFloat(b.total_pnl) > -500 ? 10 : 0);
    return scoreB - scoreA;
  });

  return { best: rows[0], all: rows };
}

function updateAgentConfig(best: ResultRow) {
  const configPath = path.resolve(__dirname, '../agent-config.ts');

  const strikeRange = parseInt(best.strike_range);
  const rsiOs = parseInt(best.rsi_os);
  const rsiOb = parseInt(best.rsi_ob);
  const optRsiOs = parseInt(best.opt_rsi_os);
  const optRsiOb = parseInt(best.opt_rsi_ob);
  const stopLoss = parseInt(best.stop_loss);
  const tpMult = parseFloat(best.tp_mult);
  const timeStart = best.time_start;
  const timeEnd = best.time_end;
  const maxPos = parseInt(best.max_pos);

  let config = fs.readFileSync(configPath, 'utf-8');

  // Update strike range
  config = config.replace(
    /strikeSearchRange: \d+/,
    `strikeSearchRange: ${strikeRange}`
  );

  // Update RSI thresholds
  config = config.replace(/rsiOversold: \d+/, `rsiOversold: ${rsiOs}`);
  config = config.replace(/rsiOverbought: \d+/, `rsiOverbought: ${rsiOb}`);

  // Update option RSI thresholds
  config = config.replace(/optionRsiOversold: \d+/, `optionRsiOversold: ${optRsiOs}`);
  config = config.replace(/optionRsiOverbought: \d+/, `optionRsiOverbought: ${optRsiOb}`);

  // Update stop loss
  config = config.replace(/stopLossPercent: \d+/, `stopLossPercent: ${stopLoss}`);

  // Update TP multiplier
  config = config.replace(/takeProfitMultiplier: [\d.]+/, `takeProfitMultiplier: ${tpMult}`);

  // Update time windows
  config = config.replace(/activeStart: '[0-9:]+'/,  `activeStart: '${timeStart}'`);
  config = config.replace(/activeEnd: '[0-9:]+'/,    `activeEnd: '${timeEnd}'`);

  // Update max positions
  config = config.replace(/maxPositionsOpen: \d+/, `maxPositionsOpen: ${maxPos}`);

  fs.writeFileSync(configPath, config);
  console.log(`[UPDATED] Agent config with best params from autoresearch`);
  console.log(`  Strike: ±${strikeRange} | RSI: ${rsiOs}/${rsiOb} | Stop: ${stopLoss}% | TP: ${tpMult}x`);
  console.log(`  Time: ${timeStart}-${timeEnd} | Max pos: ${maxPos}`);
}

function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Auto-Update: Config from Autoresearch Results');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  try {
    const { best, all } = parseResults();

    console.log(`[PARSED] Found ${all.length} results in autoresearch`);
    console.log('');
    console.log('[TOP 5 CONFIGS]');
    for (let i = 0; i < Math.min(5, all.length); i++) {
      const r = all[i];
      const score = (parseFloat(r.win_rate) * 40) + (parseFloat(r.sharpe) * 30) +
        (parseFloat(r.total_pnl) > 0 ? 20 : 0) + (parseFloat(r.total_pnl) > -500 ? 10 : 0);
      console.log(`  ${i+1}. ${r.label}`);
      console.log(`     WR: ${r.win_rate}, P&L: $${r.total_pnl}, Score: ${score.toFixed(0)}`);
    }
    console.log('');

    console.log(`[BEST] ${best.label}`);
    console.log(`  Win rate: ${(parseFloat(best.win_rate) * 100).toFixed(0)}%`);
    console.log(`  P&L: $${best.total_pnl}`);
    console.log('');

    updateAgentConfig(best);
    console.log('');

    // Restart agent to pick up new config
    console.log('[RESTART] Restarting spxer-agent PM2 process...');
    try {
      execSync('pm2 restart spxer-agent', { stdio: 'pipe' });
      console.log('  ✓ Agent restarted');
    } catch (err) {
      console.log('  [WARN] Failed to restart agent (may need manual restart)');
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Configuration updated. Agent ready for trading.');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (err) {
    console.error('[ERROR]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
