/**
 * spx-matrix-search.ts — SPX Full Grid Search
 *
 * Systematic matrix (customize dimensions below):
 *   HMA fast:  [3, 5]
 *   HMA slow:  [12, 15, 19, 25]
 *   SL:        [20, 30, 40, 50, 60, 70, 80]
 *   TP:        [1.1x, 1.25x, 1.5x, 2.0x, 2.5x, 3.0x]
 *   Timeframe: [1m, 3m]
 *   ATM offset:[-5 (ITM5), 0 (ATM), 5 (OTM5), 10 (OTM10)]
 *
 * = 2 × 4 × 7 × 6 × 2 × 4 = 2,688 variants  (full grid)
 *
 * Key feature: uses INSERT OR REPLACE directly — NO auto-versioning.
 * Re-running the script with the same params overwrites configs in place
 * instead of spawning -v2, -v3, etc.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --dates=2026-03-19,2026-03-20
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --top=50
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --dry-run          # count variants, don't run
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --resume            # skip configs with existing results
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --concurrency=4    # parallel date runs (default: 1)
 *   npx tsx scripts/autoresearch/spx-matrix-search.ts --clear-results    # wipe old results for these configs before running
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config/defaults';
import type { Config } from '../../src/config/types';

// ── All 267 SPX dates ────────────────────────────────────────────────────
const ALL_DATES = fs.readdirSync(path.resolve(__dirname, '../../data/parquet/bars/spx'))
  .filter(f => f.endsWith('.parquet'))
  .map(f => f.replace('.parquet', ''))
  .sort();

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : ALL_DATES;
const TOP_N = parseInt(flags.top ?? '30');
const DRY_RUN = flags['dry-run'] === 'true';
const RESUME = flags.resume === 'true';
const CLEAR_RESULTS = flags['clear-results'] === 'true';
const CONCURRENCY = parseInt(flags.concurrency ?? '1');
const RESULTS_FILE = path.resolve(__dirname, '../../.spx-matrix-results.tsv');
const LOG_FILE = path.resolve(__dirname, '../../.spx-matrix.log');

// ── Grid Dimensions — EDIT THESE ─────────────────────────────────────────
// Uncomment/edit to control what gets swept. Smaller grids run faster.
const HMA_FAST = [3];
const HMA_SLOW = [12, 15];
const SL_PCTS  = [20, 25, 30, 35, 40, 45, 50];
const TP_MULTS = [1.1, 1.15, 1.25, 1.35, 1.5, 1.65, 1.75, 2.0];
const TIMEFRAMES = ['3m'];                        // add '1m', '5m' as needed
const ATM_OFFSETS = [-5, 0, 5, 10];               // -5=ITM5, 0=ATM, 5=OTM5, 10=OTM10

// Fixed SPX params
const ACTIVE_START = '10:00';
const ACTIVE_END = '15:45';
const MAX_CONTRACTS = 25;
const BASE_DOLLARS = 30000;

// ── Build Config ─────────────────────────────────────────────────────────

function atmLabel(offset: number): string {
  if (offset < 0) return `itm${Math.abs(offset)}`;
  if (offset === 0) return 'atm';
  return `otm${offset}`;
}

function buildConfig(fast: number, slow: number, sl: number, tp: number, tf: string, atmOffset: number): Config {
  const tpStr = tp % 1 === 0 ? `${tp.toFixed(0)}x` : `${(tp * 100).toFixed(0).replace(/0$/, '')}x`;
  const id = `spx-hma${fast}x${slow}-${atmLabel(atmOffset)}-tp${tpStr}-sl${sl}-${tf}-${MAX_CONTRACTS}c-$${BASE_DOLLARS}`;
  return mergeConfig(DEFAULT_CONFIG, {
    id,
    name: `SPX | HMA${fast}x${slow} | ${atmLabel(atmOffset).toUpperCase()} | TP${tp}x | SL${sl}% | ${tf} | ${MAX_CONTRACTS}c | $${BASE_DOLLARS}`,
    description: 'Baseline 0DTE trading config — conservative defaults',
    signals: {
      ...DEFAULT_CONFIG.signals,
      enableHmaCrosses: true,
      enableEmaCrosses: false,
      enableRsiCrosses: false,
      enablePriceCrossHma: false,
      requireUnderlyingHmaCross: false,
      hmaCrossFast: fast,
      hmaCrossSlow: slow,
      signalTimeframe: tf,
      hmaCrossTimeframe: tf,
      targetOtmDistance: atmOffset > 0 ? atmOffset : null,
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: sl,
      takeProfitMultiplier: tp,
      maxPositionsOpen: 3,
    },
    strikeSelector: {
      ...DEFAULT_CONFIG.strikeSelector,
      strikeSearchRange: 100,
      contractPriceMin: 0.2,
      contractPriceMax: 9999,
      strikeMode: atmOffset <= 0 ? (atmOffset < 0 ? 'itm' : 'atm') : 'otm',
      ...(atmOffset !== 0 ? { atmOffset: Math.abs(atmOffset) } : {}),
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeStart: ACTIVE_START,
      activeEnd: ACTIVE_END,
    },
    sizing: {
      ...DEFAULT_CONFIG.sizing,
      baseDollarsPerTrade: BASE_DOLLARS,
      maxContracts: MAX_CONTRACTS,
    },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false, entryCooldownSec: 180 },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    regime: { ...DEFAULT_CONFIG.regime, enabled: false },
  });
}

// ── Direct DB upsert — bypasses auto-versioning ─────────────────────────

function upsertConfig(db: Database.Database, config: Config) {
  db.prepare(`
    INSERT OR REPLACE INTO replay_configs
    (id, name, description, config_json, baselineConfigId, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, NULL, ?, ?)
  `).run(config.id, config.name, config.description || '', JSON.stringify(config), Date.now(), Date.now());
}

// ── Result tracking ─────────────────────────────────────────────────────

interface GridResult {
  id: string;
  hmaFast: number;
  hmaSlow: number;
  sl: number;
  tp: number;
  tf: string;
  atm: number;
  dates: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgDailyPnl: number;
  maxWin: number;
  maxLoss: number;
  sharpe: number;
  score: number;
}

function initTsv() {
  const header = [
    'config_id', 'hma_fast', 'hma_slow', 'sl_pct', 'tp_mult', 'timeframe', 'atm_offset',
    'dates', 'trades', 'wins', 'win_rate',
    'total_pnl', 'avg_daily_pnl', 'max_win', 'max_loss',
    'sharpe', 'score',
  ].join('\t');
  fs.writeFileSync(RESULTS_FILE, header + '\n');
}

function appendResult(r: GridResult) {
  const row = [
    r.id, r.hmaFast, r.hmaSlow, r.sl, r.tp.toFixed(2), r.tf, r.atm,
    r.dates, r.trades, r.wins, r.winRate.toFixed(4),
    r.totalPnl.toFixed(0), r.avgDailyPnl.toFixed(0),
    r.maxWin.toFixed(0), r.maxLoss.toFixed(0),
    r.sharpe.toFixed(4), r.score.toFixed(2),
  ].join('\t');
  fs.appendFileSync(RESULTS_FILE, row + '\n');
}

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // Build all variant configs
  const variants: Array<{ fast: number; slow: number; sl: number; tp: number; tf: string; atm: number; config: Config }> = [];

  for (const fast of HMA_FAST) {
    for (const slow of HMA_SLOW) {
      for (const sl of SL_PCTS) {
        for (const tp of TP_MULTS) {
          for (const tf of TIMEFRAMES) {
            for (const atm of ATM_OFFSETS) {
              const config = buildConfig(fast, slow, sl, tp, tf, atm);
              variants.push({ fast, slow, sl, tp, tf, atm, config });
            }
          }
        }
      }
    }
  }

  const totalVariants = variants.length;
  const startTime = Date.now();

  fs.writeFileSync(LOG_FILE, '');

  log('════════════════════════════════════════════════════════════════');
  log('  SPX 0DTE Full Grid Search');
  log('════════════════════════════════════════════════════════════════');
  log(`  HMA fast:     [${HMA_FAST.join(', ')}]`);
  log(`  HMA slow:     [${HMA_SLOW.join(', ')}]`);
  log(`  SL %:         [${SL_PCTS.join(', ')}]`);
  log(`  TP mult:      [${TP_MULTS.join(', ')}]`);
  log(`  Timeframes:   [${TIMEFRAMES.join(', ')}]`);
  log(`  ATM offsets:  [${ATM_OFFSETS.join(', ')}]`);
  log(`  Variants:     ${totalVariants}`);
  log(`  Dates:        ${DATES.length} (${DATES[0]} → ${DATES[DATES.length - 1]})`);
  log(`  Total runs:   ${totalVariants * DATES.length}`);
  log(`  Resume:       ${RESUME}`);
  log(`  Concurrency:  ${CONCURRENCY}`);
  log('');

  if (DRY_RUN) {
    log('  DRY RUN — listing all config IDs:');
    for (const v of variants) {
      log(`    ${v.config.id}`);
    }
    log(`\n  ${totalVariants} configs × ${DATES.length} dates = ${totalVariants * DATES.length} total runs`);
    return;
  }

  // Open DB directly for config upserts (bypasses auto-versioning)
  const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../../data/spxer.db');
  const db = new Database(dbPath);

  // Upsert all configs upfront — no versioning, just overwrite
  log(`  Upserting ${totalVariants} configs (direct INSERT OR REPLACE, no auto-versioning)...`);
  const upsertAll = db.transaction(() => {
    for (const v of variants) {
      upsertConfig(db, v.config);
    }
  });
  upsertAll();
  log(`  ✓ ${totalVariants} configs saved\n`);

  // Optionally clear old results
  if (CLEAR_RESULTS) {
    log('  Clearing old results for these configs...');
    const delStmt = db.prepare('DELETE FROM replay_results WHERE configId = ?');
    const clearAll = db.transaction(() => {
      for (const v of variants) {
        delStmt.run(v.config.id);
      }
    });
    clearAll();
    log('  ✓ Old results cleared\n');
  }

  // Check which configs already have full results (for --resume)
  const completedConfigs = new Set<string>();
  if (RESUME) {
    const rows = db.prepare(`
      SELECT configId, COUNT(DISTINCT date) as dateCount
      FROM replay_results
      WHERE configId IN (${variants.map(() => '?').join(',')})
      GROUP BY configId
      HAVING dateCount >= ?
    `).all(...variants.map(v => v.config.id), DATES.length) as Array<{ configId: string; dateCount: number }>;

    for (const row of rows) {
      completedConfigs.add(row.configId);
    }
    if (completedConfigs.size > 0) {
      log(`  Resuming: skipping ${completedConfigs.size} configs with ≥${DATES.length} results\n`);
    }
  }

  db.close();

  initTsv();
  const allResults: GridResult[] = [];
  let variantIdx = 0;

  for (const v of variants) {
    variantIdx++;

    if (RESUME && completedConfigs.has(v.config.id)) {
      log(`[${variantIdx}/${totalVariants}] SKIP (resume) ${v.config.id}`);
      continue;
    }

    const label = `HMA${v.fast}×${v.slow} ${atmLabel(v.atm).toUpperCase()} SL${v.sl}% TP${v.tp.toFixed(1)}x ${v.tf}`;
    const t0 = Date.now();

    let totalTrades = 0, totalWins = 0, totalPnl = 0;
    let maxWin = 0, maxLoss = 0, completedDates = 0;
    const dailyPnls: number[] = [];
    let errCount = 0;

    // Run dates — optionally parallel
    if (CONCURRENCY <= 1) {
      for (const date of DATES) {
        try {
          const result = await runReplay(v.config, date, { verbose: false, noJudge: true });
          totalTrades += result.trades;
          totalWins += result.wins;
          totalPnl += result.totalPnl;
          dailyPnls.push(result.totalPnl);
          if (result.maxWin > maxWin) maxWin = result.maxWin;
          if (result.maxLoss < maxLoss) maxLoss = result.maxLoss;
          completedDates++;
        } catch {
          errCount++;
        }
      }
    } else {
      // Parallel date execution (chunked)
      for (let i = 0; i < DATES.length; i += CONCURRENCY) {
        const chunk = DATES.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(
          chunk.map(date => runReplay(v.config, date, { verbose: false, noJudge: true }))
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            const result = r.value;
            totalTrades += result.trades;
            totalWins += result.wins;
            totalPnl += result.totalPnl;
            dailyPnls.push(result.totalPnl);
            if (result.maxWin > maxWin) maxWin = result.maxWin;
            if (result.maxLoss < maxLoss) maxLoss = result.maxLoss;
            completedDates++;
          } else {
            errCount++;
          }
        }
      }
    }

    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgDailyPnl = completedDates > 0 ? totalPnl / completedDates : 0;
    const worstDay = dailyPnls.length > 0 ? Math.min(...dailyPnls) : 0;

    let sharpe = 0;
    if (dailyPnls.length > 1) {
      const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
      const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
      sharpe = Math.sqrt(variance) > 0 ? mean / Math.sqrt(variance) : 0;
    }

    const score =
      (winRate * 40) +
      (Math.max(0, Math.min(sharpe, 1)) * 30) +
      (avgDailyPnl > 0 ? 20 : 0) +
      (worstDay > -500 ? 10 : 0);

    const gridResult: GridResult = {
      id: v.config.id,
      hmaFast: v.fast, hmaSlow: v.slow, sl: v.sl, tp: v.tp, tf: v.tf, atm: v.atm,
      dates: completedDates, trades: totalTrades, wins: totalWins,
      winRate, totalPnl, avgDailyPnl, maxWin, maxLoss, sharpe, score,
    };

    allResults.push(gridResult);
    appendResult(gridResult);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const errStr = errCount > 0 ? ` [${errCount}err]` : '';
    log(`[${variantIdx}/${totalVariants}] ${label} → ${totalTrades}T ${(winRate * 100).toFixed(1)}%WR $${totalPnl.toFixed(0)} Sharpe=${sharpe.toFixed(2)} Score=${score.toFixed(1)} (${elapsed}s)${errStr}`);
  }

  // ── Rankings ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  log('');
  log('════════════════════════════════════════════════════════════════');
  log(`  TOP ${TOP_N} BY COMPOSITE SCORE (min 10 trades)`);
  log('════════════════════════════════════════════════════════════════');

  const byScore = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(TOP_N, byScore.length); i++) {
    const r = byScore[i];
    log(`  #${i + 1}: ${r.id} | Score=${r.score.toFixed(1)} WR=${(r.winRate * 100).toFixed(1)}% Sharpe=${r.sharpe.toFixed(3)} P&L=$${r.totalPnl.toFixed(0)} (${r.trades}T)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log(`  TOP ${TOP_N} BY SHARPE (min 10 trades)`);
  log('════════════════════════════════════════════════════════════════');

  const bySharpe = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(TOP_N, bySharpe.length); i++) {
    const r = bySharpe[i];
    log(`  #${i + 1}: ${r.id} | Sharpe=${r.sharpe.toFixed(3)} WR=${(r.winRate * 100).toFixed(1)}% P&L=$${r.totalPnl.toFixed(0)} (${r.trades}T)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log(`  TOP ${TOP_N} BY TOTAL P&L (min 10 trades)`);
  log('════════════════════════════════════════════════════════════════');

  const byPnl = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.totalPnl - a.totalPnl);
  for (let i = 0; i < Math.min(TOP_N, byPnl.length); i++) {
    const r = byPnl[i];
    log(`  #${i + 1}: ${r.id} | P&L=$${r.totalPnl.toFixed(0)} WR=${(r.winRate * 100).toFixed(1)}% Sharpe=${r.sharpe.toFixed(3)} (${r.trades}T)`);
  }

  // ── Heatmaps ──────────────────────────────────────────────────────────
  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per HMA combo (across all SL/TP/ATM)');
  log('════════════════════════════════════════════════════════════════');

  for (const fast of HMA_FAST) {
    for (const slow of HMA_SLOW) {
      const subset = allResults.filter(r => r.hmaFast === fast && r.hmaSlow === slow && r.trades >= 10);
      if (subset.length === 0) continue;
      const best = subset.sort((a, b) => b.score - a.score)[0];
      const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
      log(`  HMA${fast}×${slow}: best=${best.id} Score=${best.score.toFixed(1)} | avg=${avgScore.toFixed(1)} (${subset.length} combos)`);
    }
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per ATM offset (across all HMA/SL/TP)');
  log('════════════════════════════════════════════════════════════════');

  for (const atm of ATM_OFFSETS) {
    const subset = allResults.filter(r => r.atm === atm && r.trades >= 10);
    if (subset.length === 0) continue;
    const best = subset.sort((a, b) => b.score - a.score)[0];
    const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
    const avgPnl = subset.reduce((s, r) => s + r.totalPnl, 0) / subset.length;
    log(`  ${atmLabel(atm).toUpperCase()}: best=${best.id} Score=${best.score.toFixed(1)} | avg Score=${avgScore.toFixed(1)} avgP&L=$${avgPnl.toFixed(0)} (${subset.length} combos)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per SL% (across all HMA/TP/ATM)');
  log('════════════════════════════════════════════════════════════════');

  for (const sl of SL_PCTS) {
    const subset = allResults.filter(r => r.sl === sl && r.trades >= 10);
    if (subset.length === 0) continue;
    const best = subset.sort((a, b) => b.score - a.score)[0];
    const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
    log(`  SL${sl}%: best=${best.id} Score=${best.score.toFixed(1)} | avg=${avgScore.toFixed(1)} (${subset.length} combos)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per TP multiplier (across all HMA/SL/ATM)');
  log('════════════════════════════════════════════════════════════════');

  for (const tp of TP_MULTS) {
    const subset = allResults.filter(r => r.tp === tp && r.trades >= 10);
    if (subset.length === 0) continue;
    const best = subset.sort((a, b) => b.score - a.score)[0];
    const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
    log(`  TP${tp.toFixed(1)}x: best=${best.id} Score=${best.score.toFixed(1)} | avg=${avgScore.toFixed(1)} (${subset.length} combos)`);
  }

  log('');
  log(`  DONE — ${totalVariants} variants × ${DATES.length} dates = ${totalVariants * DATES.length} runs in ${elapsed} min`);
  log(`  Results TSV: ${RESULTS_FILE}`);
  log(`  Log: ${LOG_FILE}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}\n${err.stack}`);
  process.exit(1);
});
