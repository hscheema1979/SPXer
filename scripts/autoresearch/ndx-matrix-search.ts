/**
 * ndx-matrix-search.ts — NDX Full Grid Search
 *
 * Systematic matrix:
 *   HMA fast:  [3, 5]
 *   HMA slow:  [15, 17, 19, 25]  (all pre-computed in DB)
 *   SL:        [10%, 20%, 30%, 40%, 50%, 60%, 70%, 80%]
 *   TP:        [1.1x, 1.2x, 1.3x, 1.4x, 1.5x, 1.6x, 1.7x, 1.8x, 1.9x, 2.0x]
 *
 * = 2 × 4 × 8 × 10 = 640 variants
 *
 * Fixed params: 3m timeframe, OTM $10, 10:00-15:45 ET, NDX/NDXP execution.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/ndx-matrix-search.ts
 *   npx tsx scripts/autoresearch/ndx-matrix-search.ts --dates=2025-10-10,2026-03-12
 *   npx tsx scripts/autoresearch/ndx-matrix-search.ts --top=30
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config/defaults';
import { ReplayStore } from '../../src/replay/store';
import type { Config } from '../../src/config/types';

// ── All 267 NDX dates ─────────────────────────────────────────────────────
const ALL_DATES = [
  '2025-03-27','2025-03-28','2025-03-31','2025-04-01','2025-04-02','2025-04-03','2025-04-04',
  '2025-04-07','2025-04-08','2025-04-09','2025-04-10','2025-04-11','2025-04-14','2025-04-15',
  '2025-04-16','2025-04-17','2025-04-21','2025-04-22','2025-04-23','2025-04-24','2025-04-25',
  '2025-04-28','2025-04-29','2025-04-30','2025-05-01','2025-05-02','2025-05-05','2025-05-06',
  '2025-05-07','2025-05-08','2025-05-09','2025-05-12','2025-05-13','2025-05-14','2025-05-15',
  '2025-05-16','2025-05-19','2025-05-20','2025-05-21','2025-05-22','2025-05-23','2025-05-27',
  '2025-05-28','2025-05-29','2025-05-30','2025-06-02','2025-06-03','2025-06-04','2025-06-05',
  '2025-06-06','2025-06-09','2025-06-10','2025-06-11','2025-06-12','2025-06-13','2025-06-16',
  '2025-06-17','2025-06-18','2025-06-20','2025-06-23','2025-06-24','2025-06-25','2025-06-26',
  '2025-06-27','2025-06-30','2025-07-01','2025-07-02','2025-07-03','2025-07-07','2025-07-08',
  '2025-07-09','2025-07-10','2025-07-11','2025-07-14','2025-07-15','2025-07-16','2025-07-17',
  '2025-07-18','2025-07-21','2025-07-22','2025-07-23','2025-07-24','2025-07-25','2025-07-28',
  '2025-07-29','2025-07-30','2025-07-31','2025-08-01','2025-08-04','2025-08-05','2025-08-06',
  '2025-08-07','2025-08-08','2025-08-11','2025-08-12','2025-08-13','2025-08-14','2025-08-15',
  '2025-08-18','2025-08-19','2025-08-20','2025-08-21','2025-08-22','2025-08-25','2025-08-26',
  '2025-08-27','2025-08-28','2025-08-29','2025-09-02','2025-09-03','2025-09-04','2025-09-05',
  '2025-09-08','2025-09-09','2025-09-10','2025-09-11','2025-09-12','2025-09-15','2025-09-16',
  '2025-09-17','2025-09-18','2025-09-19','2025-09-22','2025-09-23','2025-09-24','2025-09-25',
  '2025-09-26','2025-09-29','2025-09-30','2025-10-01','2025-10-02','2025-10-03','2025-10-06',
  '2025-10-07','2025-10-08','2025-10-09','2025-10-10','2025-10-13','2025-10-14','2025-10-15',
  '2025-10-16','2025-10-17','2025-10-20','2025-10-21','2025-10-22','2025-10-23','2025-10-24',
  '2025-10-27','2025-10-28','2025-10-29','2025-10-30','2025-10-31','2025-11-03','2025-11-04',
  '2025-11-05','2025-11-06','2025-11-07','2025-11-10','2025-11-11','2025-11-12','2025-11-13',
  '2025-11-14','2025-11-17','2025-11-18','2025-11-19','2025-11-20','2025-11-21','2025-11-24',
  '2025-11-25','2025-11-26','2025-11-28','2025-12-01','2025-12-02','2025-12-03','2025-12-04',
  '2025-12-05','2025-12-08','2025-12-09','2025-12-10','2025-12-11','2025-12-12','2025-12-15',
  '2025-12-16','2025-12-17','2025-12-18','2025-12-19','2025-12-22','2025-12-23','2025-12-24',
  '2025-12-26','2025-12-29','2025-12-30','2025-12-31','2026-01-02','2026-01-05','2026-01-06',
  '2026-01-07','2026-01-08','2026-01-09','2026-01-12','2026-01-13','2026-01-14','2026-01-15',
  '2026-01-16','2026-01-20','2026-01-21','2026-01-22','2026-01-23','2026-01-26','2026-01-27',
  '2026-01-28','2026-01-29','2026-01-30','2026-02-02','2026-02-03','2026-02-04','2026-02-05',
  '2026-02-06','2026-02-09','2026-02-10','2026-02-11','2026-02-12','2026-02-13','2026-02-17',
  '2026-02-18','2026-02-19','2026-02-20','2026-02-23','2026-02-24','2026-02-25','2026-02-26',
  '2026-02-27','2026-03-02','2026-03-03','2026-03-04','2026-03-05','2026-03-06','2026-03-09',
  '2026-03-10','2026-03-11','2026-03-12','2026-03-13','2026-03-16','2026-03-17','2026-03-18',
  '2026-03-19','2026-03-20','2026-03-23','2026-03-24','2026-03-25','2026-03-26','2026-03-27',
  '2026-03-30','2026-03-31','2026-04-01','2026-04-02','2026-04-06','2026-04-07','2026-04-08',
  '2026-04-09','2026-04-10','2026-04-13','2026-04-14','2026-04-15','2026-04-16','2026-04-17',
  '2026-04-20',
];

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : ALL_DATES;
const TOP_N = parseInt(flags.top ?? '30');
const RESULTS_FILE = path.resolve(__dirname, '../../.ndx-matrix-results.tsv');
const LOG_FILE = path.resolve(__dirname, '../../.ndx-matrix.log');

// ── Grid Dimensions ──────────────────────────────────────────────────────
const HMA_FAST = [3, 5];
const HMA_SLOW = [15, 17, 19, 25];                         // all pre-computed in DB
const SL_PCTS  = [10, 20, 30, 40, 50, 60, 70, 80];        // 8 values
const TP_MULTS = [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0]; // 10 values

// Fixed NDX params
const NDX_EXECUTION = { symbol: 'NDX', optionPrefix: 'NDXP', strikeDivisor: 1, strikeInterval: 10 };
const TIMEFRAME = '3m';
const TARGET_OTM = 10;
const ACTIVE_START = '10:00';
const ACTIVE_END = '15:45';

// ── Build Config ─────────────────────────────────────────────────────────

function buildConfig(fast: number, slow: number, sl: number, tp: number): Config {
  const id = `ndx-grid-hma${fast}x${slow}-sl${sl}-tp${(tp * 10).toFixed(0)}`;
  return mergeConfig(DEFAULT_CONFIG, {
    id,
    name: `NDX Grid: HMA${fast}×${slow} SL${sl}% TP${tp}x`,
    execution: NDX_EXECUTION,
    signals: {
      ...DEFAULT_CONFIG.signals,
      enableHmaCrosses: true,
      enableEmaCrosses: false,
      hmaCrossFast: fast,
      hmaCrossSlow: slow,
      signalTimeframe: TIMEFRAME,
      hmaCrossTimeframe: TIMEFRAME,
      targetOtmDistance: TARGET_OTM,
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: sl,
      takeProfitMultiplier: tp,
      maxPositionsOpen: 3,
    },
    strikeSelector: {
      ...DEFAULT_CONFIG.strikeSelector,
      strikeSearchRange: 500,
      contractPriceMin: 0.2,
      contractPriceMax: 50,
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeStart: ACTIVE_START,
      activeEnd: ACTIVE_END,
    },
    pipeline: {
      ...DEFAULT_CONFIG.pipeline,
      strikeBand: 500,
      strikeInterval: 10,
      timeframe: TIMEFRAME as any,
    },
    contracts: { ...DEFAULT_CONFIG.contracts, stickyBandWidth: 500 },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false, entryCooldownSec: 180 },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    regime: { ...DEFAULT_CONFIG.regime, enabled: false },
  });
}

// ── Result tracking ──────────────────────────────────────────────────────

interface GridResult {
  hmaFast: number;
  hmaSlow: number;
  sl: number;
  tp: number;
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
    'hma_fast', 'hma_slow', 'sl_pct', 'tp_mult',
    'dates', 'trades', 'wins', 'win_rate',
    'total_pnl', 'avg_daily_pnl', 'max_win', 'max_loss',
    'sharpe', 'score',
  ].join('\t');
  fs.writeFileSync(RESULTS_FILE, header + '\n');
}

function appendResult(r: GridResult) {
  const row = [
    r.hmaFast, r.hmaSlow, r.sl, r.tp.toFixed(1),
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
  const totalVariants = HMA_FAST.length * HMA_SLOW.length * SL_PCTS.length * TP_MULTS.length;
  const startTime = Date.now();

  // Clear log for this run
  fs.writeFileSync(LOG_FILE, '');

  log('════════════════════════════════════════════════════════════════');
  log('  NDX 0DTE Full Grid Search');
  log('════════════════════════════════════════════════════════════════');
  log(`  HMA fast:     [${HMA_FAST.join(', ')}]`);
  log(`  HMA slow:     [${HMA_SLOW.join(', ')}]`);
  log(`  SL %:         [${SL_PCTS.join(', ')}]`);
  log(`  TP mult:      [${TP_MULTS.join(', ')}]`);
  log(`  Timeframe:    ${TIMEFRAME}`);
  log(`  OTM:          $${TARGET_OTM}`);
  log(`  Window:       ${ACTIVE_START}-${ACTIVE_END} ET`);
  log(`  Variants:     ${totalVariants}`);
  log(`  Dates:        ${DATES.length} (${DATES[0]} → ${DATES[DATES.length - 1]})`);
  log(`  Total runs:   ${totalVariants * DATES.length}`);
  log('');

  initTsv();

  const allResults: GridResult[] = [];
  let variantIdx = 0;

  // Save all configs upfront in a single store session
  const store = new ReplayStore();

  for (const fast of HMA_FAST) {
    for (const slow of HMA_SLOW) {
      for (const sl of SL_PCTS) {
        for (const tp of TP_MULTS) {
          variantIdx++;
          const config = buildConfig(fast, slow, sl, tp);
          store.saveConfig(config);

          const label = `HMA${fast}×${slow} SL${sl}% TP${tp.toFixed(1)}x`;
          const t0 = Date.now();

          let totalTrades = 0, totalWins = 0, totalPnl = 0;
          let maxWin = 0, maxLoss = 0, completedDates = 0;
          const dailyPnls: number[] = [];
          let errCount = 0;

          for (const date of DATES) {
            try {
              const result = await runReplay(config, date, { verbose: false, noJudge: true });
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
            hmaFast: fast, hmaSlow: slow, sl, tp,
            dates: completedDates, trades: totalTrades, wins: totalWins,
            winRate, totalPnl, avgDailyPnl, maxWin, maxLoss, sharpe, score,
          };

          allResults.push(gridResult);
          appendResult(gridResult);

          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          const errStr = errCount > 0 ? ` [${errCount}err]` : '';
          log(`[${variantIdx}/${totalVariants}] ${label} → ${totalTrades}T ${(winRate * 100).toFixed(1)}%WR $${totalPnl.toFixed(0)} Sharpe=${sharpe.toFixed(2)} Score=${score.toFixed(1)} (${elapsed}s)${errStr}`);
        }
      }
    }
  }

  store.close();

  // ── Rankings ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP 30 BY COMPOSITE SCORE (min 10 trades)');
  log('════════════════════════════════════════════════════════════════');

  const byScore = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(TOP_N, byScore.length); i++) {
    const r = byScore[i];
    log(`  #${i + 1}: HMA${r.hmaFast}×${r.hmaSlow} SL${r.sl}% TP${r.tp.toFixed(1)}x | Score=${r.score.toFixed(1)} WR=${(r.winRate * 100).toFixed(1)}% Sharpe=${r.sharpe.toFixed(3)} P&L=$${r.totalPnl.toFixed(0)} (${r.trades}T)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP 30 BY SHARPE (min 10 trades)');
  log('════════════════════════════════════════════════════════════════');

  const bySharpe = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(TOP_N, bySharpe.length); i++) {
    const r = bySharpe[i];
    log(`  #${i + 1}: HMA${r.hmaFast}×${r.hmaSlow} SL${r.sl}% TP${r.tp.toFixed(1)}x | Sharpe=${r.sharpe.toFixed(3)} WR=${(r.winRate * 100).toFixed(1)}% P&L=$${r.totalPnl.toFixed(0)} (${r.trades}T)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP 30 BY TOTAL P&L (min 10 trades)');
  log('════════════════════════════════════════════════════════════════');

  const byPnl = [...allResults].filter(r => r.trades >= 10).sort((a, b) => b.totalPnl - a.totalPnl);
  for (let i = 0; i < Math.min(TOP_N, byPnl.length); i++) {
    const r = byPnl[i];
    log(`  #${i + 1}: HMA${r.hmaFast}×${r.hmaSlow} SL${r.sl}% TP${r.tp.toFixed(1)}x | P&L=$${r.totalPnl.toFixed(0)} WR=${(r.winRate * 100).toFixed(1)}% Sharpe=${r.sharpe.toFixed(3)} (${r.trades}T)`);
  }

  // ── Heatmaps ──────────────────────────────────────────────────────────
  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per HMA combo (across all SL/TP)');
  log('════════════════════════════════════════════════════════════════');

  for (const fast of HMA_FAST) {
    for (const slow of HMA_SLOW) {
      const subset = allResults.filter(r => r.hmaFast === fast && r.hmaSlow === slow && r.trades >= 10);
      if (subset.length === 0) continue;
      const best = subset.sort((a, b) => b.score - a.score)[0];
      const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
      const avgSharpe = subset.reduce((s, r) => s + r.sharpe, 0) / subset.length;
      log(`  HMA${fast}×${slow}: best=SL${best.sl}%/TP${best.tp.toFixed(1)}x Score=${best.score.toFixed(1)} | avg Score=${avgScore.toFixed(1)} avgSharpe=${avgSharpe.toFixed(3)} (${subset.length} combos)`);
    }
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per SL% (across all HMA/TP)');
  log('════════════════════════════════════════════════════════════════');

  for (const sl of SL_PCTS) {
    const subset = allResults.filter(r => r.sl === sl && r.trades >= 10);
    if (subset.length === 0) continue;
    const best = subset.sort((a, b) => b.score - a.score)[0];
    const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
    const avgPnl = subset.reduce((s, r) => s + r.totalPnl, 0) / subset.length;
    log(`  SL${sl}%: best=HMA${best.hmaFast}×${best.hmaSlow}/TP${best.tp.toFixed(1)}x Score=${best.score.toFixed(1)} | avg Score=${avgScore.toFixed(1)} avgP&L=$${avgPnl.toFixed(0)} (${subset.length} combos)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  HEATMAP: Best Score per TP multiplier (across all HMA/SL)');
  log('════════════════════════════════════════════════════════════════');

  for (const tp of TP_MULTS) {
    const subset = allResults.filter(r => r.tp === tp && r.trades >= 10);
    if (subset.length === 0) continue;
    const best = subset.sort((a, b) => b.score - a.score)[0];
    const avgScore = subset.reduce((s, r) => s + r.score, 0) / subset.length;
    const avgPnl = subset.reduce((s, r) => s + r.totalPnl, 0) / subset.length;
    log(`  TP${tp.toFixed(1)}x: best=HMA${best.hmaFast}×${best.hmaSlow}/SL${best.sl}% Score=${best.score.toFixed(1)} | avg Score=${avgScore.toFixed(1)} avgP&L=$${avgPnl.toFixed(0)} (${subset.length} combos)`);
  }

  log('');
  log(`  DONE — ${totalVariants} variants × ${DATES.length} dates = ${totalVariants * DATES.length} runs in ${elapsed} min`);
  log(`  Results TSV: ${RESULTS_FILE}`);
  log(`  Log: ${LOG_FILE}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
