/**
 * param-search.ts — Multi-dimensional parameter optimizer for replay config.
 *
 * Searches across: strike range × RSI × HMA/EMA periods × timeframe × stop/TP × time windows
 * Runs the core replay engine (shared with live agent via src/core/) for each variant.
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
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config/defaults';
import { ReplayStore } from '../../src/replay/store';
import type { Config } from '../../src/config/types';

// ── Configuration ──────────────────────────────────────────────────────────

const ALL_DATES = [
  '2026-02-20',
  '2026-02-23', '2026-02-24', '2026-02-25', '2026-02-26', '2026-02-27',
  '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06',
  '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13',
  '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20',
  '2026-03-23',
];

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
  contractPriceMin: number;
  contractPriceMax: number;
  rsiOversold: number;
  rsiOverbought: number;
  optionRsiOversold: number;
  optionRsiOverbought: number;
  stopLossPercent: number;
  takeProfitMultiplier: number;
  tradingStartEt: string;
  tradingEndEt: string;
  maxPositionsOpen: number;
  hmaCrossFast: number;
  hmaCrossSlow: number;
  emaCrossFast: number;
  emaCrossSlow: number;
  enableHmaCrosses: boolean;
  enableEmaCrosses: boolean;
  timeframe: string;
}

function generateParamSets(): ParamSet[] {
  const sets: ParamSet[] = [];

  const baseline: ParamSet = {
    id: 'baseline',
    label: 'Baseline',
    strikeSearchRange: 80,
    contractPriceMin: 0.2,
    contractPriceMax: 8.0,
    rsiOversold: 20,
    rsiOverbought: 80,
    optionRsiOversold: 40,
    optionRsiOverbought: 60,
    stopLossPercent: 0,
    takeProfitMultiplier: 3,
    tradingStartEt: '09:30',
    tradingEndEt: '15:45',
    maxPositionsOpen: 3,
    hmaCrossFast: 5,
    hmaCrossSlow: 19,
    emaCrossFast: 9,
    emaCrossSlow: 21,
    enableHmaCrosses: true,
    enableEmaCrosses: false,
    timeframe: '1m',
  };
  sets.push(baseline);

  // ── Sweep 1: HMA period combos ──────────────────────────────────────────
  const hmaCombos: [number, number, string][] = [
    [5, 19, 'HMA 5×19'],
    [5, 25, 'HMA 5×25'],
    [19, 25, 'HMA 19×25'],
  ];
  for (const [fast, slow, label] of hmaCombos) {
    if (fast === baseline.hmaCrossFast && slow === baseline.hmaCrossSlow) continue;
    sets.push({ ...baseline, id: `hma-${fast}x${slow}`, label, hmaCrossFast: fast, hmaCrossSlow: slow });
  }

  // ── Sweep 2: EMA period combos ──────────────────────────────────────────
  const emaCombos: [number, number, string][] = [
    [9, 21, 'EMA 9×21'],
    [9, 50, 'EMA 9×50'],
    [21, 50, 'EMA 21×50'],
  ];
  for (const [fast, slow, label] of emaCombos) {
    sets.push({ ...baseline, id: `ema-${fast}x${slow}`, label, enableEmaCrosses: true, emaCrossFast: fast, emaCrossSlow: slow });
  }

  // ── Sweep 3: Timeframe ──────────────────────────────────────────────────
  for (const tf of ['2m', '3m', '5m']) {
    sets.push({ ...baseline, id: `tf-${tf}`, label: `Timeframe ${tf}`, timeframe: tf });
  }

  // ── Sweep 4: Contract price band ────────────────────────────────────────
  const priceBands: [number, number, string][] = [
    [0.2, 3.0,  'Price $0.20-$3'],
    [0.2, 5.0,  'Price $0.20-$5'],
    [0.5, 8.0,  'Price $0.50-$8'],
    [1.0, 10.0, 'Price $1-$10'],
    [0.2, 15.0, 'Price $0.20-$15'],
  ];
  for (const [min, max, label] of priceBands) {
    if (min === baseline.contractPriceMin && max === baseline.contractPriceMax) continue;
    sets.push({ ...baseline, id: `price-${min}-${max}`, label, contractPriceMin: min, contractPriceMax: max });
  }

  // ── Sweep 5: Strike range ──────────────────────────────────────────────
  for (const sr of [40, 60, 100, 120, 150]) {
    if (sr === baseline.strikeSearchRange) continue;
    sets.push({ ...baseline, id: `strike-${sr}`, label: `Strike ±${sr}`, strikeSearchRange: sr });
  }

  // ── Sweep 6: RSI thresholds ─────────────────────────────────────────────
  const rsiPairs: [number, number][] = [[15, 85], [25, 75], [30, 70]];
  for (const [os, ob] of rsiPairs) {
    if (os === baseline.rsiOversold && ob === baseline.rsiOverbought) continue;
    sets.push({ ...baseline, id: `rsi-${os}-${ob}`, label: `RSI ${os}/${ob}`, rsiOversold: os, rsiOverbought: ob });
  }

  // ── Sweep 7: Option RSI thresholds ──────────────────────────────────────
  const optRsiPairs: [number, number][] = [[25, 75], [30, 70], [35, 65]];
  for (const [os, ob] of optRsiPairs) {
    if (os === baseline.optionRsiOversold && ob === baseline.optionRsiOverbought) continue;
    sets.push({ ...baseline, id: `optrsi-${os}-${ob}`, label: `Opt RSI ${os}/${ob}`, optionRsiOversold: os, optionRsiOverbought: ob });
  }

  // ── Sweep 8: Stop/TP combos ─────────────────────────────────────────────
  const stopTpCombos: [number, number][] = [[0, 5], [50, 3], [50, 5], [80, 5], [80, 10], [0, 2]];
  for (const [sl, tp] of stopTpCombos) {
    if (sl === baseline.stopLossPercent && tp === baseline.takeProfitMultiplier) continue;
    sets.push({ ...baseline, id: `sl${sl}-tp${tp}`, label: `SL ${sl}% / TP ${tp}x`, stopLossPercent: sl, takeProfitMultiplier: tp });
  }

  // ── Sweep 9: Time windows ──────────────────────────────────────────────
  const timeWindows: [string, string, string][] = [
    ['morning',    '09:30', '11:30'],
    ['midday',     '11:00', '14:00'],
    ['afternoon',  '13:00', '15:45'],
    ['power-hour', '14:00', '15:45'],
  ];
  for (const [name, start, end] of timeWindows) {
    sets.push({ ...baseline, id: `time-${name}`, label: `Time: ${name}`, tradingStartEt: start, tradingEndEt: end });
  }

  // ── Sweep 10: Max positions ─────────────────────────────────────────────
  for (const mp of [1, 2, 5, 10]) {
    if (mp === baseline.maxPositionsOpen) continue;
    sets.push({ ...baseline, id: `maxpos-${mp}`, label: `Max ${mp} positions`, maxPositionsOpen: mp });
  }

  // ── Targeted combos ────────────────────────────────────────────────────
  // Best of HMA 5×25 + 3m timeframe
  sets.push({
    ...baseline, id: 'combo-hma5x25-3m', label: 'HMA 5×25 | 3m',
    hmaCrossFast: 5, hmaCrossSlow: 25, timeframe: '3m',
  });

  // HMA 5×25 + tight price band
  sets.push({
    ...baseline, id: 'combo-hma5x25-tight', label: 'HMA 5×25 | $0.50-$5',
    hmaCrossFast: 5, hmaCrossSlow: 25, contractPriceMin: 0.5, contractPriceMax: 5.0,
  });

  // 3m + tight option RSI
  sets.push({
    ...baseline, id: 'combo-3m-optrsi', label: '3m | Opt RSI 35/65',
    timeframe: '3m', optionRsiOversold: 35, optionRsiOverbought: 65,
  });

  // HMA + EMA dual signals
  sets.push({
    ...baseline, id: 'combo-hma-ema', label: 'HMA 5×19 + EMA 9×21',
    enableEmaCrosses: true,
  });

  // Conservative: 3m + tight everything
  sets.push({
    ...baseline, id: 'combo-conservative-3m', label: '3m | SL 50% | TP 5x | MaxPos 2',
    timeframe: '3m', stopLossPercent: 50, takeProfitMultiplier: 5, maxPositionsOpen: 2,
  });

  return sets;
}

// ── Build Config from ParamSet ────────────────────────────────────────────

function buildConfig(params: ParamSet): Config {
  return mergeConfig(DEFAULT_CONFIG, {
    id: `search-${params.id}`,
    name: `Search: ${params.label}`,
    signals: {
      ...DEFAULT_CONFIG.signals,
      rsiOversold: params.rsiOversold,
      rsiOverbought: params.rsiOverbought,
      optionRsiOversold: params.optionRsiOversold,
      optionRsiOverbought: params.optionRsiOverbought,
      enableHmaCrosses: params.enableHmaCrosses,
      enableEmaCrosses: params.enableEmaCrosses,
      hmaCrossFast: params.hmaCrossFast,
      hmaCrossSlow: params.hmaCrossSlow,
      emaCrossFast: params.emaCrossFast,
      emaCrossSlow: params.emaCrossSlow,
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
      contractPriceMin: params.contractPriceMin,
      contractPriceMax: params.contractPriceMax,
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeStart: params.tradingStartEt,
      activeEnd: params.tradingEndEt,
    },
    pipeline: {
      ...DEFAULT_CONFIG.pipeline,
      timeframe: params.timeframe as any,
    },
    // Disable scanners/judges for fast deterministic runs
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false },
    regime: { ...DEFAULT_CONFIG.regime, enabled: false },
  });
}

// ── Result tracking ──────────────────────────────────────────────────────

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
  // Params for logging
  strikeRange: number;
  priceMin: number;
  priceMax: number;
  hmaCross: string;
  emaCross: string;
  timeframe: string;
  rsiOs: number;
  rsiOb: number;
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
    'strike_range', 'price_min', 'price_max', 'hma_cross', 'ema_cross', 'timeframe',
    'rsi_os', 'rsi_ob', 'stop_loss', 'tp_mult', 'time_start', 'time_end', 'max_pos',
  ].join('\t');
  fs.writeFileSync(RESULTS_FILE, header + '\n');
}

function appendResult(r: SearchResult) {
  const row = [
    r.paramId, r.label, r.dates, r.trades, r.wins, r.winRate.toFixed(3),
    r.totalPnl.toFixed(0), r.avgDailyPnl.toFixed(0), r.maxWin.toFixed(0),
    r.maxLoss.toFixed(0), (r.sharpe || 0).toFixed(3),
    r.strikeRange, r.priceMin, r.priceMax, r.hmaCross, r.emaCross, r.timeframe,
    r.rsiOs, r.rsiOb, r.stopLoss, r.tpMult, r.timeStart, r.timeEnd, r.maxPos,
  ].join('\t');
  fs.appendFileSync(RESULTS_FILE, row + '\n');
}

// ── Logging ──────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const paramSets = generateParamSets();

  log('═══════════════════════════════════════════════════════════');
  log('  SPXer Parameter Search v2 — Core Modules');
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

    log(`─── [${pi + 1}/${paramSets.length}] ${params.label} ───`);

    const store = new ReplayStore();
    store.saveConfig(config);
    store.close();

    let totalTrades = 0, totalWins = 0, totalPnl = 0;
    let maxWin = 0, maxLoss = 0, completedDates = 0;
    const dailyPnls: number[] = [];

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
      } catch (err: any) {
        log(`    ${date}: ERROR — ${err.message}`);
      }
    }

    const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
    const avgDailyPnl = completedDates > 0 ? totalPnl / completedDates : 0;

    let sharpe = 0;
    if (dailyPnls.length > 1) {
      const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
      const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
      sharpe = Math.sqrt(variance) > 0 ? mean / Math.sqrt(variance) : 0;
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
      priceMin: params.contractPriceMin,
      priceMax: params.contractPriceMax,
      hmaCross: `${params.hmaCrossFast}×${params.hmaCrossSlow}`,
      emaCross: params.enableEmaCrosses ? `${params.emaCrossFast}×${params.emaCrossSlow}` : 'off',
      timeframe: params.timeframe,
      rsiOs: params.rsiOversold,
      rsiOb: params.rsiOverbought,
      stopLoss: params.stopLossPercent,
      tpMult: params.takeProfitMultiplier,
      timeStart: params.tradingStartEt,
      timeEnd: params.tradingEndEt,
      maxPos: params.maxPositionsOpen,
    };

    allResults.push(searchResult);
    appendResult(searchResult);

    log(`  → ${totalTrades} trades | ${(winRate * 100).toFixed(1)}% WR | $${totalPnl.toFixed(0)} | Sharpe ${sharpe.toFixed(2)}`);
  }

  // ── Rankings ────────────────────────────────────────────────────────────
  log('');
  log('════════════════════════════════════════════════════════════');
  log('  TOP BY SHARPE (min 5 trades)');
  log('════════════════════════════════════════════════════════════');

  const bySharpe = [...allResults].filter(r => r.trades >= 5).sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(TOP_N, bySharpe.length); i++) {
    const r = bySharpe[i];
    log(`  #${i + 1}: ${r.label} | Sharpe=${r.sharpe.toFixed(3)} WR=${(r.winRate * 100).toFixed(1)}% P&L=$${r.totalPnl.toFixed(0)} (${r.trades} trades)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════');
  log('  TOP BY TOTAL P&L');
  log('════════════════════════════════════════════════════════════');

  const byPnl = [...allResults].filter(r => r.trades >= 5).sort((a, b) => b.totalPnl - a.totalPnl);
  for (let i = 0; i < Math.min(TOP_N, byPnl.length); i++) {
    const r = byPnl[i];
    log(`  #${i + 1}: ${r.label} | P&L=$${r.totalPnl.toFixed(0)} WR=${(r.winRate * 100).toFixed(1)}% Sharpe=${r.sharpe.toFixed(3)} (${r.trades} trades)`);
  }

  log('');
  log(`  DONE — ${allResults.length} variants tested | Results: ${RESULTS_FILE}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
