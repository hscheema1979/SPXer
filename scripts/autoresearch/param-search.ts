/**
 * param-search.ts — Multi-dimensional parameter optimizer for replay config.
 *
 * Searches across: strike range × RSI thresholds × stop/TP × time windows
 * Runs the actual replay engine (not shell scripts) for each config variant.
 * Tracks all results in TSV for analysis.
 *
 * Usage:
 *   npx tsx scripts/autoresearch/param-search.ts
 *   npx tsx scripts/autoresearch/param-search.ts --dates=2026-03-19,2026-03-20
 *   npx tsx scripts/autoresearch/param-search.ts --top=10
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/replay/config';
import { ReplayStore } from '../../src/replay/store';
import type { ReplayConfig, ReplayResult } from '../../src/replay/types';

// ── Configuration ──────────────────────────────────────────────────────────

const ALL_DATES = [
  '2026-02-20',
  '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27',
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
];

// Parse CLI flags
const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : ALL_DATES;
const TOP_N = parseInt(flags.top ?? '20');
const RESULTS_FILE = path.resolve(__dirname, '../../.autoresearch-results.tsv');
const LOG_FILE = path.resolve(__dirname, '../../.autoresearch.log');

// ── Parameter Search Space ─────────────────────────────────────────────────

interface ParamSet {
  id: string;
  label: string;
  strikeSearchRange: number;
  rsiOversold: number;
  rsiOverbought: number;
  optionRsiOversold: number;
  optionRsiOverbought: number;
  stopLossPercent: number;
  takeProfitMultiplier: number;
  tradingStartEt: string;
  tradingEndEt: string;
  maxPositionsOpen: number;
}

function generateParamSets(): ParamSet[] {
  const sets: ParamSet[] = [];

  // Dimension 1: Strike range
  const strikeRanges = [40, 60, 80, 100, 120, 150];

  // Dimension 2: RSI thresholds (SPX-level)
  const rsiPairs: [number, number][] = [
    [15, 85], [20, 80], [25, 75], [30, 70],
  ];

  // Dimension 3: Option RSI thresholds
  const optRsiPairs: [number, number][] = [
    [25, 75], [30, 70], [35, 65],
  ];

  // Dimension 4: Stop loss / Take profit combos
  const stopTpCombos: [number, number][] = [
    [40, 3], [50, 5], [60, 5], [70, 5], [70, 8], [80, 8], [80, 10],
  ];

  // Dimension 5: Time windows
  const timeWindows: [string, string, string][] = [
    ['all-day',    '09:30', '15:45'],
    ['morning',    '09:30', '11:30'],
    ['midday',     '11:00', '14:00'],
    ['afternoon',  '13:00', '15:45'],
    ['power-hour', '14:00', '15:45'],
  ];

  // Dimension 6: Max positions
  const maxPositions = [2, 3, 5];

  // Full grid would be 6 × 4 × 3 × 7 × 5 × 3 = 7,560 combos — too many.
  // Use smart sampling: vary one dimension at a time from baseline, then targeted combos.

  const baseline: ParamSet = {
    id: 'baseline',
    label: 'Baseline (DEFAULT_CONFIG)',
    strikeSearchRange: 60,
    rsiOversold: 20,
    rsiOverbought: 80,
    optionRsiOversold: 30,
    optionRsiOverbought: 70,
    stopLossPercent: 50,
    takeProfitMultiplier: 5,
    tradingStartEt: '09:30',
    tradingEndEt: '15:45',
    maxPositionsOpen: 3,
  };
  sets.push(baseline);

  // Sweep 1: Strike range (keep everything else at baseline)
  for (const sr of strikeRanges) {
    if (sr === baseline.strikeSearchRange) continue;
    sets.push({
      ...baseline,
      id: `strike-${sr}`,
      label: `Strike range ±${sr}`,
      strikeSearchRange: sr,
    });
  }

  // Sweep 2: RSI thresholds
  for (const [os, ob] of rsiPairs) {
    if (os === baseline.rsiOversold && ob === baseline.rsiOverbought) continue;
    sets.push({
      ...baseline,
      id: `rsi-${os}-${ob}`,
      label: `RSI ${os}/${ob}`,
      rsiOversold: os,
      rsiOverbought: ob,
    });
  }

  // Sweep 3: Option RSI thresholds
  for (const [os, ob] of optRsiPairs) {
    if (os === baseline.optionRsiOversold && ob === baseline.optionRsiOverbought) continue;
    sets.push({
      ...baseline,
      id: `optrsi-${os}-${ob}`,
      label: `Option RSI ${os}/${ob}`,
      optionRsiOversold: os,
      optionRsiOverbought: ob,
    });
  }

  // Sweep 4: Stop/TP combos
  for (const [sl, tp] of stopTpCombos) {
    if (sl === baseline.stopLossPercent && tp === baseline.takeProfitMultiplier) continue;
    sets.push({
      ...baseline,
      id: `stop${sl}-tp${tp}`,
      label: `SL ${sl}% / TP ${tp}x`,
      stopLossPercent: sl,
      takeProfitMultiplier: tp,
    });
  }

  // Sweep 5: Time windows
  for (const [name, start, end] of timeWindows) {
    if (start === baseline.tradingStartEt && end === baseline.tradingEndEt) continue;
    sets.push({
      ...baseline,
      id: `time-${name}`,
      label: `Time: ${name} (${start}-${end})`,
      tradingStartEt: start,
      tradingEndEt: end,
    });
  }

  // Sweep 6: Max positions
  for (const mp of maxPositions) {
    if (mp === baseline.maxPositionsOpen) continue;
    sets.push({
      ...baseline,
      id: `maxpos-${mp}`,
      label: `Max positions: ${mp}`,
      maxPositionsOpen: mp,
    });
  }

  // Targeted combos: best-of-each combined
  // Wide strike + tight RSI + wide stop
  sets.push({
    ...baseline,
    id: 'combo-wide-tight',
    label: 'Wide strike(120) + RSI 15/85 + SL 70%/TP 8x',
    strikeSearchRange: 120,
    rsiOversold: 15,
    rsiOverbought: 85,
    stopLossPercent: 70,
    takeProfitMultiplier: 8,
  });

  // Morning-only with tight strikes
  sets.push({
    ...baseline,
    id: 'combo-morning-tight',
    label: 'Morning only + Strike 60 + RSI 25/75',
    strikeSearchRange: 60,
    rsiOversold: 25,
    rsiOverbought: 75,
    tradingStartEt: '09:30',
    tradingEndEt: '11:30',
  });

  // Afternoon with wide strikes
  sets.push({
    ...baseline,
    id: 'combo-afternoon-wide',
    label: 'Afternoon + Strike 120 + RSI 20/80 + SL 80%/TP 10x',
    strikeSearchRange: 120,
    rsiOversold: 20,
    rsiOverbought: 80,
    stopLossPercent: 80,
    takeProfitMultiplier: 10,
    tradingStartEt: '13:00',
    tradingEndEt: '15:45',
  });

  // Power hour aggressive
  sets.push({
    ...baseline,
    id: 'combo-power-hour',
    label: 'Power hour + Strike 150 + RSI 15/85 + SL 80%/TP 10x + 5 pos',
    strikeSearchRange: 150,
    rsiOversold: 15,
    rsiOverbought: 85,
    stopLossPercent: 80,
    takeProfitMultiplier: 10,
    tradingStartEt: '14:00',
    tradingEndEt: '15:45',
    maxPositionsOpen: 5,
  });

  // Conservative: narrow everything
  sets.push({
    ...baseline,
    id: 'combo-conservative',
    label: 'Conservative: Strike 40 + RSI 30/70 + SL 40%/TP 3x + 2 pos',
    strikeSearchRange: 40,
    rsiOversold: 30,
    rsiOverbought: 70,
    optionRsiOversold: 35,
    optionRsiOverbought: 65,
    stopLossPercent: 40,
    takeProfitMultiplier: 3,
    maxPositionsOpen: 2,
  });

  // Wide strike + option RSI 25/75 (more signals from wider band)
  sets.push({
    ...baseline,
    id: 'combo-wide-optrsi',
    label: 'Strike 120 + OptionRSI 25/75 + SL 60%/TP 5x',
    strikeSearchRange: 120,
    optionRsiOversold: 25,
    optionRsiOverbought: 75,
    stopLossPercent: 60,
  });

  return sets;
}

// ── Build ReplayConfig from ParamSet ───────────────────────────────────────

function buildConfig(params: ParamSet): ReplayConfig {
  return mergeConfig(DEFAULT_CONFIG, {
    id: `search-${params.id}`,
    name: `Search: ${params.label}`,
    description: `Autoresearch param search variant: ${params.label}`,
    signals: {
      ...DEFAULT_CONFIG.signals,
      rsiOversold: params.rsiOversold,
      rsiOverbought: params.rsiOverbought,
      optionRsiOversold: params.optionRsiOversold,
      optionRsiOverbought: params.optionRsiOverbought,
    },
    position: {
      ...DEFAULT_CONFIG.position,
      stopLossPercent: params.stopLossPercent,
      takeProfitMultiplier: params.takeProfitMultiplier,
      maxPositionsOpen: params.maxPositionsOpen,
    },
    strikeSelector: {
      ...DEFAULT_CONFIG.strikeSelector,
      strikeSearchRange: params.strikeSearchRange,
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeStart: params.tradingStartEt,
      activeEnd: params.tradingEndEt,
    },
  });
}

// ── Result tracking ────────────────────────────────────────────────────────

interface SearchResult {
  paramId: string;
  label: string;
  dates: number;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgDailyPnl: number;
  maxWin: number;
  maxLoss: number;
  sharpe: number;
  strikeRange: number;
  rsiOs: number;
  rsiOb: number;
  optRsiOs: number;
  optRsiOb: number;
  stopLoss: number;
  tpMult: number;
  timeStart: string;
  timeEnd: string;
  maxPos: number;
}

function initTsv() {
  const header = [
    'param_id', 'label', 'dates', 'trades', 'wins', 'win_rate', 'total_pnl',
    'avg_daily_pnl', 'max_win', 'max_loss', 'sharpe',
    'strike_range', 'rsi_os', 'rsi_ob', 'opt_rsi_os', 'opt_rsi_ob',
    'stop_loss', 'tp_mult', 'time_start', 'time_end', 'max_pos',
  ].join('\t');
  fs.writeFileSync(RESULTS_FILE, header + '\n');
}

function appendResult(r: SearchResult) {
  const row = [
    r.paramId, r.label, r.dates, r.trades, r.wins, r.winRate.toFixed(3),
    r.totalPnl.toFixed(0), r.avgDailyPnl.toFixed(0), r.maxWin.toFixed(0),
    r.maxLoss.toFixed(0), (r.sharpe || 0).toFixed(3),
    r.strikeRange, r.rsiOs, r.rsiOb, r.optRsiOs, r.optRsiOb,
    r.stopLoss, r.tpMult, r.timeStart, r.timeEnd, r.maxPos,
  ].join('\t');
  fs.appendFileSync(RESULTS_FILE, row + '\n');
}

// ── Logging ────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const paramSets = generateParamSets();

  log('═══════════════════════════════════════════════════════════');
  log('  SPXer Parameter Search — Autoresearch');
  log('═══════════════════════════════════════════════════════════');
  log(`  Variants: ${paramSets.length}`);
  log(`  Dates: ${DATES.length} (${DATES[0]} → ${DATES[DATES.length - 1]})`);
  log(`  Total runs: ${paramSets.length * DATES.length}`);
  log('');

  initTsv();

  const allResults: SearchResult[] = [];

  for (let pi = 0; pi < paramSets.length; pi++) {
    const params = paramSets[pi];
    const config = buildConfig(params);

    log(`────────────────────────────────────────────────────────────`);
    log(`  [${pi + 1}/${paramSets.length}] ${params.label}`);
    log(`────────────────────────────────────────────────────────────`);

    // Save config to store so runReplay can create runs (FK constraint)
    const store = new ReplayStore();
    store.saveConfig(config);
    store.close();

    let totalTrades = 0;
    let totalWins = 0;
    let totalPnl = 0;
    let maxWin = 0;
    let maxLoss = 0;
    let completedDates = 0;
    const dailyPnls: number[] = [];

    for (const date of DATES) {
      try {
        // Set date on config
        const dateConfig = { ...config, date };

        const result = await runReplay(dateConfig, date, {
          verbose: false,
          noJudge: true,
        });

        totalTrades += result.trades;
        totalWins += result.wins;
        totalPnl += result.totalPnl;
        dailyPnls.push(result.totalPnl);
        if (result.maxWin > maxWin) maxWin = result.maxWin;
        if (result.maxLoss < maxLoss) maxLoss = result.maxLoss;
        completedDates++;

        if (result.trades > 0) {
          log(`    ${date}: ${result.trades} trades, ${result.wins} wins, $${result.totalPnl.toFixed(0)}`);
        }
      } catch (err: any) {
        log(`    ${date}: ERROR — ${err.message}`);
      }
    }

    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgDailyPnl = completedDates > 0 ? totalPnl / completedDates : 0;

    // Compute Sharpe ratio (daily)
    let sharpe = 0;
    if (dailyPnls.length > 1) {
      const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
      const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? mean / std : 0;
    }

    const searchResult: SearchResult = {
      paramId: params.id,
      label: params.label,
      dates: completedDates,
      trades: totalTrades,
      wins: totalWins,
      winRate,
      totalPnl,
      avgDailyPnl,
      maxWin,
      maxLoss,
      sharpe,
      strikeRange: params.strikeSearchRange,
      rsiOs: params.rsiOversold,
      rsiOb: params.rsiOverbought,
      optRsiOs: params.optionRsiOversold,
      optRsiOb: params.optionRsiOverbought,
      stopLoss: params.stopLossPercent,
      tpMult: params.takeProfitMultiplier,
      timeStart: params.tradingStartEt,
      timeEnd: params.tradingEndEt,
      maxPos: params.maxPositionsOpen,
    };

    allResults.push(searchResult);
    appendResult(searchResult);

    log(`  → ${totalTrades} trades | ${(winRate * 100).toFixed(1)}% WR | $${totalPnl.toFixed(0)} P&L | $${avgDailyPnl.toFixed(0)}/day | Sharpe ${sharpe.toFixed(2)}`);
    log('');
  }

  // ── Summary: top N by Sharpe ratio ────────────────────────────────────
  log('');
  log('════════════════════════════════════════════════════════════');
  log('  TOP CONFIGS BY SHARPE RATIO');
  log('════════════════════════════════════════════════════════════');

  const ranked = [...allResults]
    .filter(r => r.trades >= 5) // minimum 5 trades to be meaningful
    .sort((a, b) => b.sharpe - a.sharpe);

  for (let i = 0; i < Math.min(TOP_N, ranked.length); i++) {
    const r = ranked[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`      Sharpe=${r.sharpe.toFixed(3)} | WR=${(r.winRate * 100).toFixed(1)}% | P&L=$${r.totalPnl.toFixed(0)} | ${r.trades} trades`);
    log(`      Strike=±${r.strikeRange} RSI=${r.rsiOs}/${r.rsiOb} SL=${r.stopLoss}% TP=${r.tpMult}x Time=${r.timeStart}-${r.timeEnd} MaxPos=${r.maxPos}`);
  }

  log('');
  log('════════════════════════════════════════════════════════════');
  log('  TOP CONFIGS BY WIN RATE (min 10 trades)');
  log('════════════════════════════════════════════════════════════');

  const byWinRate = [...allResults]
    .filter(r => r.trades >= 10)
    .sort((a, b) => b.winRate - a.winRate);

  for (let i = 0; i < Math.min(TOP_N, byWinRate.length); i++) {
    const r = byWinRate[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`      WR=${(r.winRate * 100).toFixed(1)}% | Sharpe=${r.sharpe.toFixed(3)} | P&L=$${r.totalPnl.toFixed(0)} | ${r.trades} trades`);
  }

  log('');
  log('════════════════════════════════════════════════════════════');
  log('  TOP CONFIGS BY TOTAL P&L');
  log('════════════════════════════════════════════════════════════');

  const byPnl = [...allResults]
    .filter(r => r.trades >= 5)
    .sort((a, b) => b.totalPnl - a.totalPnl);

  for (let i = 0; i < Math.min(TOP_N, byPnl.length); i++) {
    const r = byPnl[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`      P&L=$${r.totalPnl.toFixed(0)} | WR=${(r.winRate * 100).toFixed(1)}% | Sharpe=${r.sharpe.toFixed(3)} | ${r.trades} trades | $${r.avgDailyPnl.toFixed(0)}/day`);
  }

  log('');
  log('════════════════════════════════════════════════════════════');
  log(`  SEARCH COMPLETE — ${allResults.length} variants tested`);
  log(`  Results: ${RESULTS_FILE}`);
  log('════════════════════════════════════════════════════════════');
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  console.error(err);
  process.exit(1);
});
