/**
 * Auto-Update Config from Autoresearch Results
 *
 * Runs at 6 AM to:
 * 1. Parse .autoresearch-results.tsv
 * 2. Find best config by composite score
 * 3. Save updated config to DB via ConfigManager
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

function computeScore(r: ResultRow): number {
  return (parseFloat(r.win_rate) * 40) + (parseFloat(r.sharpe) * 30) +
    (parseFloat(r.total_pnl) > 0 ? 20 : 0) + (parseFloat(r.total_pnl) > -500 ? 10 : 0);
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

  rows.sort((a, b) => computeScore(b) - computeScore(a));

  return { best: rows[0], all: rows };
}

function saveToDb(best: ResultRow) {
  // Save via ConfigManager — import dynamically to avoid circular deps
  try {
    const { getConfigManager } = require('../src/config/manager');
    const mgr = getConfigManager();

    // Load current config, apply autoresearch best params
    const existing = mgr.getConfig('paper-mode-live');
    if (existing) {
      const updated = {
        ...existing,
        updatedAt: Date.now(),
        signals: {
          ...existing.signals,
          rsiOversold: parseInt(best.rsi_os),
          rsiOverbought: parseInt(best.rsi_ob),
          optionRsiOversold: parseInt(best.opt_rsi_os),
          optionRsiOverbought: parseInt(best.opt_rsi_ob),
        },
        strikeSelector: {
          ...existing.strikeSelector,
          strikeSearchRange: parseInt(best.strike_range),
        },
        position: {
          ...existing.position,
          stopLossPercent: parseInt(best.stop_loss),
          takeProfitMultiplier: parseFloat(best.tp_mult),
          maxPositionsOpen: parseInt(best.max_pos),
        },
        timeWindows: {
          ...existing.timeWindows,
          activeStart: best.time_start,
          activeEnd: best.time_end,
        },
      };
      mgr.saveConfig(updated);
      mgr.bindSubsystem('live-agent', updated.id);
      console.log(`[UPDATED] DB config '${updated.id}' and bound to live-agent`);
    } else {
      console.log('[WARN] Config "paper-mode-live" not found in DB — skipping DB update');
    }
  } catch (err) {
    console.log(`[WARN] Could not update DB config: ${(err as Error).message}`);
    console.log('  (This is OK if running before first agent startup)');
  }
}

function main() {
  console.log('===================================================================');
  console.log('  Auto-Update: Config from Autoresearch Results');
  console.log('===================================================================');
  console.log('');

  try {
    const { best, all } = parseResults();

    console.log(`[PARSED] Found ${all.length} results in autoresearch`);
    console.log('');
    console.log('[TOP 5 CONFIGS]');
    for (let i = 0; i < Math.min(5, all.length); i++) {
      const r = all[i];
      console.log(`  ${i+1}. ${r.label}`);
      console.log(`     WR: ${(parseFloat(r.win_rate) * 100).toFixed(1)}%, P&L: $${r.total_pnl}, Score: ${computeScore(r).toFixed(0)}`);
    }
    console.log('');

    console.log(`[BEST] ${best.label}`);
    console.log(`  Win rate: ${(parseFloat(best.win_rate) * 100).toFixed(1)}%`);
    console.log(`  P&L: $${best.total_pnl}`);
    console.log(`  Score: ${computeScore(best).toFixed(1)}`);
    console.log('');

    saveToDb(best);
    console.log('');

    // Restart agent to pick up new config
    console.log('[RESTART] Restarting spxer-agent PM2 process...');
    try {
      execSync('pm2 restart spxer-agent', { stdio: 'pipe' });
      console.log('  Agent restarted');
    } catch {
      console.log('  [WARN] Failed to restart agent (may need manual restart)');
    }

    console.log('');
    console.log('===================================================================');
    console.log('  Configuration updated. Agent ready for trading.');
    console.log('===================================================================');

  } catch (err) {
    console.error('[ERROR]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
