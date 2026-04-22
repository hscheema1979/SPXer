/**
 * ndx-param-search.ts — NDX 0DTE Parameter Optimizer
 *
 * Sweeps across 3m/5m timeframes, HMA fast/slow combos, and OTM distances
 * ($5 and $10) for NDX options contracts. Active window 10:00-15:45 ET.
 *
 * Uses 34 sample dates spread across 267 days of NDX data (2025-03-27 → 2026-04-20).
 *
 * Usage:
 *   npx tsx scripts/autoresearch/ndx-param-search.ts
 *   npx tsx scripts/autoresearch/ndx-param-search.ts --dates=2026-03-19,2026-03-20
 *   npx tsx scripts/autoresearch/ndx-param-search.ts --top=10
 *   npx tsx scripts/autoresearch/ndx-param-search.ts --all-dates   # Use all 267 dates (slow)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { runReplay } from '../../src/replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../../src/config/defaults';
import { ReplayStore } from '../../src/replay/store';
import type { Config } from '../../src/config/types';

// ── NDX Date Universe ─────────────────────────────────────────────────────
// Every 8th trading day across the full 267-day range (diverse market conditions)
const SAMPLE_DATES = [
  '2025-03-27', '2025-04-08', '2025-04-21', '2025-05-01', '2025-05-13',
  '2025-05-23', '2025-06-05', '2025-06-17', '2025-06-30', '2025-07-11',
  '2025-07-23', '2025-08-04', '2025-08-14', '2025-08-26', '2025-09-08',
  '2025-09-18', '2025-09-30', '2025-10-10', '2025-10-22', '2025-11-03',
  '2025-11-13', '2025-11-25', '2025-12-08', '2025-12-18', '2025-12-31',
  '2026-01-13', '2026-01-26', '2026-02-05', '2026-02-18', '2026-03-02',
  '2026-03-12', '2026-03-24', '2026-04-06', '2026-04-16',
];

const args = process.argv.slice(2);
const flags: Record<string, string> = {};
for (const a of args) {
  const [k, v] = a.replace(/^--/, '').split('=');
  flags[k] = v ?? 'true';
}

const DATES = flags.dates ? flags.dates.split(',') : SAMPLE_DATES;
const TOP_N = parseInt(flags.top ?? '20');
const RESULTS_FILE = path.resolve(__dirname, '../../.ndx-autoresearch-results.tsv');
const LOG_FILE = path.resolve(__dirname, '../../.ndx-autoresearch.log');

// ── NDX Execution Config (constant across all variants) ───────────────────
const NDX_EXECUTION = {
  symbol: 'NDX',
  optionPrefix: 'NDXP',
  strikeDivisor: 1,
  strikeInterval: 10,
};

const NDX_PIPELINE_BASE = {
  strikeBand: 500,
  strikeInterval: 10,
};

// ── Parameter Search Space ─────────────────────────────────────────────────

interface ParamSet {
  id: string;
  label: string;
  hmaCrossFast: number;
  hmaCrossSlow: number;
  timeframe: string;
  targetOtmDistance: number;
  strikeSearchRange: number;
  contractPriceMin: number;
  contractPriceMax: number;
  stopLossPercent: number;
  takeProfitMultiplier: number;
  tradingStartEt: string;
  tradingEndEt: string;
  maxPositionsOpen: number;
  rsiOversold: number;
  rsiOverbought: number;
  optionRsiOversold: number;
  optionRsiOverbought: number;
  cooldownSec: number;
}

function generateParamSets(): ParamSet[] {
  const sets: ParamSet[] = [];

  // NDX baseline — adapted from existing ndx-default-v5
  const baseline: ParamSet = {
    id: 'ndx-baseline',
    label: 'NDX Baseline',
    hmaCrossFast: 3,
    hmaCrossSlow: 15,
    timeframe: '3m',
    targetOtmDistance: 10,
    strikeSearchRange: 500,
    contractPriceMin: 0.2,
    contractPriceMax: 50.0,   // NDX premiums are higher than SPX
    stopLossPercent: 20,
    takeProfitMultiplier: 1.2,
    tradingStartEt: '10:00',
    tradingEndEt: '15:45',
    maxPositionsOpen: 3,
    rsiOversold: 20,
    rsiOverbought: 80,
    optionRsiOversold: 40,
    optionRsiOverbought: 60,
    cooldownSec: 180,
  };
  sets.push(baseline);

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 1: Timeframe × OTM Distance (core matrix)
  // ══════════════════════════════════════════════════════════════════════════
  for (const tf of ['3m', '5m']) {
    for (const otm of [5, 10]) {
      const id = `tf${tf}-otm${otm}`;
      if (tf === baseline.timeframe && otm === baseline.targetOtmDistance) continue;
      sets.push({ ...baseline, id, label: `${tf} | OTM $${otm}`, timeframe: tf, targetOtmDistance: otm });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 2: HMA Fast × Slow combos (across both timeframes)
  // ══════════════════════════════════════════════════════════════════════════
  const hmaCombos: [number, number][] = [
    [3, 12], [3, 15], [3, 17], [3, 19], [3, 21], [3, 25],
    [5, 12], [5, 15], [5, 17], [5, 19], [5, 25],
  ];

  for (const tf of ['3m', '5m']) {
    for (const [fast, slow] of hmaCombos) {
      const id = `hma${fast}x${slow}-${tf}`;
      // Skip exact baseline duplicate
      if (fast === baseline.hmaCrossFast && slow === baseline.hmaCrossSlow && tf === baseline.timeframe) continue;
      sets.push({
        ...baseline, id, label: `HMA ${fast}×${slow} | ${tf}`,
        hmaCrossFast: fast, hmaCrossSlow: slow, timeframe: tf,
      });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 3: HMA combos × OTM distance (cross product with both TFs)
  // Best HMA combos from existing NDX configs × OTM 5 vs 10
  // ══════════════════════════════════════════════════════════════════════════
  const topHmaCombos: [number, number][] = [[3, 12], [3, 15], [3, 21], [5, 19], [5, 25]];
  for (const tf of ['3m', '5m']) {
    for (const [fast, slow] of topHmaCombos) {
      for (const otm of [5, 10]) {
        const id = `hma${fast}x${slow}-${tf}-otm${otm}`;
        sets.push({
          ...baseline, id, label: `HMA ${fast}×${slow} | ${tf} | OTM $${otm}`,
          hmaCrossFast: fast, hmaCrossSlow: slow, timeframe: tf, targetOtmDistance: otm,
        });
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 4: Stop Loss / Take Profit combos (on promising HMA+TF combos)
  // ══════════════════════════════════════════════════════════════════════════
  const slTpCombos: [number, number, string][] = [
    [10, 1.2, 'SL10/TP1.2x'],
    [15, 1.4, 'SL15/TP1.4x'],
    [20, 1.2, 'SL20/TP1.2x'],
    [20, 1.5, 'SL20/TP1.5x'],
    [20, 2.0, 'SL20/TP2x'],
    [25, 1.25, 'SL25/TP1.25x'],
    [30, 1.5, 'SL30/TP1.5x'],
    [40, 2.0, 'SL40/TP2x'],
    [50, 3.0, 'SL50/TP3x'],
    [0, 1.5, 'NoSL/TP1.5x'],
    [0, 2.0, 'NoSL/TP2x'],
  ];

  for (const [sl, tp, slTpLabel] of slTpCombos) {
    if (sl === baseline.stopLossPercent && tp === baseline.takeProfitMultiplier) continue;
    sets.push({
      ...baseline, id: `sltp-${sl}-${tp}`, label: `${slTpLabel} | 3m`,
      stopLossPercent: sl, takeProfitMultiplier: tp,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 5: Contract price bands (NDX premiums are higher)
  // ══════════════════════════════════════════════════════════════════════════
  const priceBands: [number, number, string][] = [
    [0.5, 10, '$0.50-$10'],
    [1.0, 20, '$1-$20'],
    [2.0, 30, '$2-$30'],
    [5.0, 50, '$5-$50'],
    [0.2, 100, '$0.20-$100'],
  ];
  for (const [min, max, label] of priceBands) {
    sets.push({
      ...baseline, id: `price-${min}-${max}`, label: `Price ${label}`,
      contractPriceMin: min, contractPriceMax: max,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 6: Option RSI filters
  // ══════════════════════════════════════════════════════════════════════════
  const optRsiPairs: [number, number][] = [[30, 70], [35, 65], [45, 55], [25, 75]];
  for (const [os, ob] of optRsiPairs) {
    if (os === baseline.optionRsiOversold && ob === baseline.optionRsiOverbought) continue;
    sets.push({ ...baseline, id: `optrsi-${os}-${ob}`, label: `OptRSI ${os}/${ob}`, optionRsiOversold: os, optionRsiOverbought: ob });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 7: Cooldown
  // ══════════════════════════════════════════════════════════════════════════
  for (const cd of [60, 120, 180, 300, 600]) {
    if (cd === baseline.cooldownSec) continue;
    sets.push({ ...baseline, id: `cooldown-${cd}`, label: `Cooldown ${cd}s`, cooldownSec: cd });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 8: Max positions
  // ══════════════════════════════════════════════════════════════════════════
  for (const mp of [1, 2, 5]) {
    if (mp === baseline.maxPositionsOpen) continue;
    sets.push({ ...baseline, id: `maxpos-${mp}`, label: `Max ${mp} pos`, maxPositionsOpen: mp });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SWEEP 9: Targeted combo configs (hand-picked promising combos)
  // ══════════════════════════════════════════════════════════════════════════
  // Tight: 3m, HMA 3×12, OTM 5, SL15, TP1.4x
  sets.push({
    ...baseline, id: 'combo-tight-3m',
    label: 'Tight 3m: HMA3×12 OTM5 SL15/TP1.4x',
    hmaCrossFast: 3, hmaCrossSlow: 12, timeframe: '3m',
    targetOtmDistance: 5, stopLossPercent: 15, takeProfitMultiplier: 1.4,
  });

  // Wide: 5m, HMA 5×25, OTM 10, SL40, TP2x
  sets.push({
    ...baseline, id: 'combo-wide-5m',
    label: 'Wide 5m: HMA5×25 OTM10 SL40/TP2x',
    hmaCrossFast: 5, hmaCrossSlow: 25, timeframe: '5m',
    targetOtmDistance: 10, stopLossPercent: 40, takeProfitMultiplier: 2.0,
  });

  // Balanced: 3m, HMA 3×15, OTM 10, SL25, TP1.25x
  sets.push({
    ...baseline, id: 'combo-balanced-3m',
    label: 'Balanced 3m: HMA3×15 OTM10 SL25/TP1.25x',
    hmaCrossFast: 3, hmaCrossSlow: 15, timeframe: '3m',
    targetOtmDistance: 10, stopLossPercent: 25, takeProfitMultiplier: 1.25,
  });

  // Scalp: 3m, HMA 3×12, OTM 5, SL10, TP1.2x, max 5 pos
  sets.push({
    ...baseline, id: 'combo-scalp',
    label: 'Scalp: HMA3×12 OTM5 SL10/TP1.2x 5pos',
    hmaCrossFast: 3, hmaCrossSlow: 12, timeframe: '3m',
    targetOtmDistance: 5, stopLossPercent: 10, takeProfitMultiplier: 1.2, maxPositionsOpen: 5,
  });

  // Conservative: 5m, HMA 3×21, OTM 10, SL50, TP3x, 1 pos
  sets.push({
    ...baseline, id: 'combo-conservative',
    label: 'Conservative: HMA3×21 OTM10 SL50/TP3x 1pos',
    hmaCrossFast: 3, hmaCrossSlow: 21, timeframe: '5m',
    targetOtmDistance: 10, stopLossPercent: 50, takeProfitMultiplier: 3.0, maxPositionsOpen: 1,
  });

  // ATM-ish: 3m, HMA 3×15, OTM 5, high premium, SL20, TP1.5x
  sets.push({
    ...baseline, id: 'combo-atm-3m',
    label: 'Near-ATM: HMA3×15 OTM5 $5-$50 SL20/TP1.5x',
    hmaCrossFast: 3, hmaCrossSlow: 15, timeframe: '3m',
    targetOtmDistance: 5, contractPriceMin: 5, contractPriceMax: 50,
    stopLossPercent: 20, takeProfitMultiplier: 1.5,
  });

  // Wide swing: 5m, HMA 5×19, OTM 10, no SL, TP2x
  sets.push({
    ...baseline, id: 'combo-swing-5m',
    label: 'Swing: HMA5×19 OTM10 NoSL/TP2x',
    hmaCrossFast: 5, hmaCrossSlow: 19, timeframe: '5m',
    targetOtmDistance: 10, stopLossPercent: 0, takeProfitMultiplier: 2.0,
  });

  return sets;
}

// ── Build Config from ParamSet ────────────────────────────────────────────

function buildConfig(params: ParamSet): Config {
  return mergeConfig(DEFAULT_CONFIG, {
    id: `ndx-search-${params.id}`,
    name: `NDX Search: ${params.label}`,
    execution: NDX_EXECUTION,
    signals: {
      ...DEFAULT_CONFIG.signals,
      enableHmaCrosses: true,
      enableEmaCrosses: false,
      hmaCrossFast: params.hmaCrossFast,
      hmaCrossSlow: params.hmaCrossSlow,
      signalTimeframe: params.timeframe,    // Signal detection uses this TF
      hmaCrossTimeframe: params.timeframe,  // HMA crosses on this TF
      targetOtmDistance: params.targetOtmDistance,
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
      ...NDX_PIPELINE_BASE,
      timeframe: params.timeframe as any,
    },
    contracts: {
      ...DEFAULT_CONFIG.contracts,
      stickyBandWidth: 500,
    },
    judges: {
      ...DEFAULT_CONFIG.judges,
      enabled: false,
      entryCooldownSec: params.cooldownSec,
    },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
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
  score: number;
  // Params
  hmaCross: string;
  timeframe: string;
  otmDist: number;
  stopLoss: number;
  tpMult: number;
  priceMin: number;
  priceMax: number;
  optRsiOs: number;
  optRsiOb: number;
  cooldown: number;
  maxPos: number;
}

function initTsv() {
  const header = [
    'param_id', 'label', 'dates', 'trades', 'wins', 'win_rate', 'total_pnl',
    'avg_daily_pnl', 'max_win', 'max_loss', 'sharpe', 'score',
    'hma_cross', 'timeframe', 'otm_dist', 'stop_loss', 'tp_mult',
    'price_min', 'price_max', 'opt_rsi_os', 'opt_rsi_ob', 'cooldown', 'max_pos',
  ].join('\t');
  fs.writeFileSync(RESULTS_FILE, header + '\n');
}

function appendResult(r: SearchResult) {
  const row = [
    r.paramId, r.label, r.dates, r.trades, r.wins, r.winRate.toFixed(3),
    r.totalPnl.toFixed(0), r.avgDailyPnl.toFixed(0), r.maxWin.toFixed(0),
    r.maxLoss.toFixed(0), (r.sharpe || 0).toFixed(3), r.score.toFixed(2),
    r.hmaCross, r.timeframe, r.otmDist, r.stopLoss, r.tpMult,
    r.priceMin, r.priceMax, r.optRsiOs, r.optRsiOb, r.cooldown, r.maxPos,
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

// ── Composite Score ─────────────────────────────────────────────────────

function computeScore(winRate: number, sharpe: number, avgDailyPnl: number, worstDay: number): number {
  return (
    (winRate * 40) +
    (Math.max(0, Math.min(sharpe, 1)) * 30) +
    (avgDailyPnl > 0 ? 20 : 0) +
    (worstDay > -500 ? 10 : 0)
  );
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const paramSets = generateParamSets();
  const startTime = Date.now();

  log('═══════════════════════════════════════════════════════════════');
  log('  NDX 0DTE Parameter Search — 3m/5m × HMA × OTM $5/$10');
  log('═══════════════════════════════════════════════════════════════');
  log(`  Variants:    ${paramSets.length}`);
  log(`  Dates:       ${DATES.length} (${DATES[0]} → ${DATES[DATES.length - 1]})`);
  log(`  Total runs:  ${paramSets.length * DATES.length}`);
  log(`  Timeframes:  3m, 5m`);
  log(`  OTM targets: $5, $10`);
  log(`  Window:      10:00-15:45 ET`);
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
      } catch (err: any) {
        errCount++;
        if (errCount <= 2) log(`    ${date}: ERROR — ${err.message}`);
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

    const score = computeScore(winRate, sharpe, avgDailyPnl, worstDay);

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
      score,
      hmaCross: `${params.hmaCrossFast}×${params.hmaCrossSlow}`,
      timeframe: params.timeframe,
      otmDist: params.targetOtmDistance,
      stopLoss: params.stopLossPercent,
      tpMult: params.takeProfitMultiplier,
      priceMin: params.contractPriceMin,
      priceMax: params.contractPriceMax,
      optRsiOs: params.optionRsiOversold,
      optRsiOb: params.optionRsiOverbought,
      cooldown: params.cooldownSec,
      maxPos: params.maxPositionsOpen,
    };

    allResults.push(searchResult);
    appendResult(searchResult);

    const errStr = errCount > 0 ? ` (${errCount} errors)` : '';
    log(`  → ${totalTrades} trades | ${(winRate * 100).toFixed(1)}% WR | $${totalPnl.toFixed(0)} | Sharpe ${sharpe.toFixed(2)} | Score ${score.toFixed(1)}${errStr}`);
  }

  // ── Rankings ────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP BY COMPOSITE SCORE (min 5 trades)');
  log('════════════════════════════════════════════════════════════════');

  const byScore = [...allResults].filter(r => r.trades >= 5).sort((a, b) => b.score - a.score);
  for (let i = 0; i < Math.min(TOP_N, byScore.length); i++) {
    const r = byScore[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`       Score=${r.score.toFixed(1)} | Sharpe=${r.sharpe.toFixed(3)} | WR=${(r.winRate * 100).toFixed(1)}% | P&L=$${r.totalPnl.toFixed(0)} | ${r.trades} trades`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP BY SHARPE (min 5 trades)');
  log('════════════════════════════════════════════════════════════════');

  const bySharpe = [...allResults].filter(r => r.trades >= 5).sort((a, b) => b.sharpe - a.sharpe);
  for (let i = 0; i < Math.min(TOP_N, bySharpe.length); i++) {
    const r = bySharpe[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`       Sharpe=${r.sharpe.toFixed(3)} | WR=${(r.winRate * 100).toFixed(1)}% | P&L=$${r.totalPnl.toFixed(0)} (${r.trades} trades)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log('  TOP BY TOTAL P&L (min 5 trades)');
  log('════════════════════════════════════════════════════════════════');

  const byPnl = [...allResults].filter(r => r.trades >= 5).sort((a, b) => b.totalPnl - a.totalPnl);
  for (let i = 0; i < Math.min(TOP_N, byPnl.length); i++) {
    const r = byPnl[i];
    log(`  #${i + 1}: ${r.label}`);
    log(`       P&L=$${r.totalPnl.toFixed(0)} | WR=${(r.winRate * 100).toFixed(1)}% | Sharpe=${r.sharpe.toFixed(3)} (${r.trades} trades)`);
  }

  log('');
  log('════════════════════════════════════════════════════════════════');
  log(`  PATTERN ANALYSIS — 3m vs 5m × OTM $5 vs $10`);
  log('════════════════════════════════════════════════════════════════');

  // Aggregate by dimension
  for (const tf of ['3m', '5m']) {
    const tfResults = allResults.filter(r => r.timeframe === tf && r.trades >= 3);
    if (tfResults.length === 0) continue;
    const avgScore = tfResults.reduce((s, r) => s + r.score, 0) / tfResults.length;
    const avgSharpe = tfResults.reduce((s, r) => s + r.sharpe, 0) / tfResults.length;
    const avgWr = tfResults.reduce((s, r) => s + r.winRate, 0) / tfResults.length;
    log(`  ${tf}: avgScore=${avgScore.toFixed(1)} avgSharpe=${avgSharpe.toFixed(3)} avgWR=${(avgWr * 100).toFixed(1)}% (${tfResults.length} variants)`);
  }

  for (const otm of [5, 10]) {
    const otmResults = allResults.filter(r => r.otmDist === otm && r.trades >= 3);
    if (otmResults.length === 0) continue;
    const avgScore = otmResults.reduce((s, r) => s + r.score, 0) / otmResults.length;
    const avgSharpe = otmResults.reduce((s, r) => s + r.sharpe, 0) / otmResults.length;
    const avgWr = otmResults.reduce((s, r) => s + r.winRate, 0) / otmResults.length;
    log(`  OTM $${otm}: avgScore=${avgScore.toFixed(1)} avgSharpe=${avgSharpe.toFixed(3)} avgWR=${(avgWr * 100).toFixed(1)}% (${otmResults.length} variants)`);
  }

  // Best HMA by average score
  const hmaGroups = new Map<string, SearchResult[]>();
  for (const r of allResults.filter(r => r.trades >= 3)) {
    const key = r.hmaCross;
    if (!hmaGroups.has(key)) hmaGroups.set(key, []);
    hmaGroups.get(key)!.push(r);
  }
  const hmaRanking = [...hmaGroups.entries()]
    .map(([hma, results]) => ({
      hma,
      avgScore: results.reduce((s, r) => s + r.score, 0) / results.length,
      avgSharpe: results.reduce((s, r) => s + r.sharpe, 0) / results.length,
      count: results.length,
    }))
    .sort((a, b) => b.avgScore - a.avgScore);

  log('');
  log('  HMA combo ranking (by avg score):');
  for (const h of hmaRanking.slice(0, 10)) {
    log(`    HMA ${h.hma}: avgScore=${h.avgScore.toFixed(1)} avgSharpe=${h.avgSharpe.toFixed(3)} (${h.count} variants)`);
  }

  log('');
  log(`  DONE — ${allResults.length} variants tested in ${elapsed} min`);
  log(`  Results: ${RESULTS_FILE}`);
}

main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
