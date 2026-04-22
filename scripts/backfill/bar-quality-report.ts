#!/usr/bin/env tsx
/**
 * bar-quality-report.ts — Post-market comparison of live bars vs backfill bars.
 *
 * Compares the live-collected option bars (from WS trade ticks + batch-quote poll)
 * against clean backfill data (from Polygon/ThetaData REST historical endpoints).
 * Flags data corruption patterns and writes a JSON report for review.
 *
 * Designed to run after daily-backfill completes (PM2 cron or manually).
 * Reports are stored in data/quality-reports/{date}.json and logged to stdout.
 *
 * What it checks:
 *   1. Flat bars (O=H=L=C) — batch-quote snapshot artifacts
 *   2. Cumulative volume — session volume leak from quote polling
 *   3. Missing bars — gaps in the 1m series
 *   4. OHLC divergence — live vs backfill price differences
 *   5. Volume divergence — live vs backfill volume mismatch
 *   6. Synthetic/interpolated bars — gap-fill artifacts
 *
 * Usage:
 *   npx tsx scripts/backfill/bar-quality-report.ts                    # today
 *   npx tsx scripts/backfill/bar-quality-report.ts 2026-04-21         # specific date
 *   npx tsx scripts/backfill/bar-quality-report.ts --verbose          # show per-contract details
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// ── Config ──────────────────────────────────────────────────────────────────

/** Replay metadata + replay_bars (always spxer.db). */
const REPLAY_DB = path.resolve(process.env.DB_PATH || path.resolve(__dirname, '../../data/spxer.db'));
const REPORT_DIR = path.resolve(__dirname, '../../data/quality-reports');

/** Day-scoped live DB: data/live/YYYY-MM-DD.db */
function liveDbPath(date: string): string {
  return path.join(path.resolve(__dirname, '../../data/live'), `${date}.db`);
}

/** Resolve the live DB for a date — day-scoped first, legacy spxer.db fallback. */
function resolveLiveDb(date: string): string {
  const dayScoped = liveDbPath(date);
  if (fs.existsSync(dayScoped)) return dayScoped;
  return REPLAY_DB; // pre-migration dates had live bars in spxer.db
}

/** Thresholds for flagging issues */
const THRESHOLDS = {
  /** Max acceptable % of flat bars (O=H=L=C) during RTH */
  flatBarPctWarn: 20,
  flatBarPctCrit: 40,
  /** Volume > this on a flat bar = cumulative volume artifact */
  cumulativeVolumeThreshold: 500,
  /** Price divergence > this between live and backfill = flagged */
  priceDivergencePct: 2.0,
  /** Volume divergence > this multiplier = flagged */
  volumeDivergenceMultiplier: 10,
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function todayET(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** RTH timestamp range for a date (09:30-16:00 ET, approximate in UTC) */
function rthRange(date: string): { start: number; end: number } {
  return {
    start: Math.floor(new Date(date + 'T13:30:00Z').getTime() / 1000),
    end: Math.floor(new Date(date + 'T20:00:00Z').getTime() / 1000),
  };
}

interface BarRow {
  symbol: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic: number;
  spread: number | null;
}

interface ContractReport {
  symbol: string;
  liveBars: number;
  backfillBars: number;
  flatBars: number;
  flatPct: number;
  cumulativeVolumeBars: number;
  syntheticBars: number;
  missingInLive: number;
  missingInBackfill: number;
  priceDivergences: number;
  volumeDivergences: number;
  maxPriceDivPct: number;
}

interface QualityReport {
  date: string;
  generatedAt: string;
  summary: {
    totalLiveBars: number;
    totalBackfillBars: number;
    totalContracts: number;
    contractsCompared: number;
    flatBars: number;
    flatPct: number;
    cumulativeVolumeBars: number;
    syntheticBars: number;
    totalPriceDivergences: number;
    totalVolumeDivergences: number;
    severity: 'clean' | 'warning' | 'critical';
    issues: string[];
  };
  contracts: ContractReport[];
  worstContracts: ContractReport[];
}

// ── Analysis ────────────────────────────────────────────────────────────────

function analyzeLiveBars(db: Database.Database, date: string): {
  bars: Map<string, BarRow[]>;
  flatCount: number;
  cumulativeVolumeCount: number;
  syntheticCount: number;
  totalBars: number;
} {
  const { start, end } = rthRange(date);
  const dateCode = date.replace(/-/g, '').slice(2); // '260421'

  const rows = db.prepare(`
    SELECT symbol, ts, open, high, low, close, volume, synthetic, spread
    FROM bars
    WHERE symbol LIKE ? AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
    ORDER BY symbol, ts
  `).all(`SPXW${dateCode}%`, start, end) as BarRow[];

  const bars = new Map<string, BarRow[]>();
  let flatCount = 0;
  let cumulativeVolumeCount = 0;
  let syntheticCount = 0;

  for (const r of rows) {
    if (!bars.has(r.symbol)) bars.set(r.symbol, []);
    bars.get(r.symbol)!.push(r);

    if (r.open === r.high && r.high === r.low && r.low === r.close) {
      flatCount++;
      if (r.volume > THRESHOLDS.cumulativeVolumeThreshold) {
        cumulativeVolumeCount++;
      }
    }
    if (r.synthetic) syntheticCount++;
  }

  return { bars, flatCount, cumulativeVolumeCount, syntheticCount, totalBars: rows.length };
}

function analyzeBackfillBars(db: Database.Database, date: string): Map<string, BarRow[]> {
  const { start, end } = rthRange(date);
  const dateCode = date.replace(/-/g, '').slice(2);

  const rows = db.prepare(`
    SELECT symbol, ts, open, high, low, close, volume, 0 as synthetic, spread
    FROM replay_bars
    WHERE symbol LIKE ? AND timeframe = '1m'
      AND ts >= ? AND ts <= ?
    ORDER BY symbol, ts
  `).all(`SPXW${dateCode}%`, start, end) as BarRow[];

  const bars = new Map<string, BarRow[]>();
  for (const r of rows) {
    if (!bars.has(r.symbol)) bars.set(r.symbol, []);
    bars.get(r.symbol)!.push(r);
  }
  return bars;
}

function compareContract(
  symbol: string,
  liveBars: BarRow[],
  backfillBars: BarRow[],
): ContractReport {
  const liveByTs = new Map(liveBars.map(b => [b.ts, b]));
  const backfillByTs = new Map(backfillBars.map(b => [b.ts, b]));

  let flatBars = 0;
  let cumulativeVolumeBars = 0;
  let syntheticBars = 0;
  let priceDivergences = 0;
  let volumeDivergences = 0;
  let maxPriceDivPct = 0;
  let missingInLive = 0;
  let missingInBackfill = 0;

  // Analyze live bars
  for (const bar of liveBars) {
    if (bar.open === bar.high && bar.high === bar.low && bar.low === bar.close) {
      flatBars++;
      if (bar.volume > THRESHOLDS.cumulativeVolumeThreshold) cumulativeVolumeBars++;
    }
    if (bar.synthetic) syntheticBars++;

    if (!backfillByTs.has(bar.ts)) missingInBackfill++;
  }

  // Compare overlapping timestamps
  for (const [ts, backfillBar] of backfillByTs) {
    const liveBar = liveByTs.get(ts);
    if (!liveBar) {
      missingInLive++;
      continue;
    }

    // Price divergence (use close price)
    if (backfillBar.close > 0) {
      const divPct = Math.abs(liveBar.close - backfillBar.close) / backfillBar.close * 100;
      if (divPct > THRESHOLDS.priceDivergencePct) {
        priceDivergences++;
        maxPriceDivPct = Math.max(maxPriceDivPct, divPct);
      }
    }

    // Volume divergence
    if (backfillBar.volume > 0 && liveBar.volume > 0) {
      const ratio = Math.max(liveBar.volume, backfillBar.volume) / Math.min(liveBar.volume, backfillBar.volume);
      if (ratio > THRESHOLDS.volumeDivergenceMultiplier) {
        volumeDivergences++;
      }
    }
  }

  return {
    symbol,
    liveBars: liveBars.length,
    backfillBars: backfillBars.length,
    flatBars,
    flatPct: liveBars.length > 0 ? Math.round(flatBars / liveBars.length * 100) : 0,
    cumulativeVolumeBars,
    syntheticBars,
    missingInLive,
    missingInBackfill,
    priceDivergences,
    volumeDivergences,
    maxPriceDivPct: Math.round(maxPriceDivPct * 100) / 100,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function generateReport(date: string, verbose: boolean): QualityReport {
  // Live bars come from the day-scoped DB (data/live/{date}.db)
  const livePath = resolveLiveDb(date);
  console.log(`  Live DB:    ${livePath}`);
  console.log(`  Replay DB:  ${REPLAY_DB}`);

  const liveDb = new Database(livePath, { readonly: true });
  liveDb.pragma('busy_timeout = 10000');
  const replayDb = new Database(REPLAY_DB, { readonly: true });
  replayDb.pragma('busy_timeout = 10000');

  try {
    // Load live bars from day-scoped DB
    const live = analyzeLiveBars(liveDb, date);
    console.log(`  Live bars: ${live.totalBars} (${live.bars.size} contracts)`);
    console.log(`  Flat: ${live.flatCount} (${live.totalBars > 0 ? Math.round(live.flatCount / live.totalBars * 100) : 0}%)`);
    console.log(`  Cumulative volume artifacts: ${live.cumulativeVolumeCount}`);
    console.log(`  Synthetic: ${live.syntheticCount}`);

    // Load backfill bars from replay_bars in spxer.db
    const backfill = analyzeBackfillBars(replayDb, date);
    console.log(`  Backfill bars: ${[...backfill.values()].reduce((s, b) => s + b.length, 0)} (${backfill.size} contracts)`);

    // Compare per-contract
    const allSymbols = new Set([...live.bars.keys(), ...backfill.keys()]);
    const contractReports: ContractReport[] = [];

    for (const symbol of allSymbols) {
      const liveBars = live.bars.get(symbol) || [];
      const backfillBars = backfill.get(symbol) || [];

      // Skip contracts with < 5 bars in both sources (noise)
      if (liveBars.length < 5 && backfillBars.length < 5) continue;

      contractReports.push(compareContract(symbol, liveBars, backfillBars));
    }

    // Aggregate
    const totalPriceDivergences = contractReports.reduce((s, c) => s + c.priceDivergences, 0);
    const totalVolumeDivergences = contractReports.reduce((s, c) => s + c.volumeDivergences, 0);

    const flatPct = live.totalBars > 0 ? Math.round(live.flatCount / live.totalBars * 100) : 0;

    // Determine severity
    const issues: string[] = [];
    let severity: 'clean' | 'warning' | 'critical' = 'clean';

    if (flatPct >= THRESHOLDS.flatBarPctCrit) {
      severity = 'critical';
      issues.push(`${flatPct}% flat bars (batch-quote corruption likely active)`);
    } else if (flatPct >= THRESHOLDS.flatBarPctWarn) {
      severity = severity === 'critical' ? 'critical' : 'warning';
      issues.push(`${flatPct}% flat bars (elevated — check batch-quote path)`);
    }

    if (live.cumulativeVolumeCount > 50) {
      severity = 'critical';
      issues.push(`${live.cumulativeVolumeCount} bars with cumulative session volume`);
    } else if (live.cumulativeVolumeCount > 10) {
      severity = severity === 'critical' ? 'critical' : 'warning';
      issues.push(`${live.cumulativeVolumeCount} bars with cumulative session volume`);
    }

    if (totalPriceDivergences > 100) {
      severity = severity === 'critical' ? 'critical' : 'warning';
      issues.push(`${totalPriceDivergences} bars with >${THRESHOLDS.priceDivergencePct}% price divergence vs backfill`);
    }

    if (live.totalBars === 0) {
      severity = 'critical';
      issues.push('No live bars collected — data pipeline may have been down');
    }

    if (backfill.size === 0) {
      issues.push('No backfill data available for comparison');
    }

    if (issues.length === 0) issues.push('No issues detected');

    // Worst contracts by flat %
    const worstContracts = [...contractReports]
      .filter(c => c.liveBars >= 10)
      .sort((a, b) => b.flatPct - a.flatPct)
      .slice(0, 10);

    const report: QualityReport = {
      date,
      generatedAt: new Date().toISOString(),
      summary: {
        totalLiveBars: live.totalBars,
        totalBackfillBars: [...backfill.values()].reduce((s, b) => s + b.length, 0),
        totalContracts: allSymbols.size,
        contractsCompared: contractReports.length,
        flatBars: live.flatCount,
        flatPct,
        cumulativeVolumeBars: live.cumulativeVolumeCount,
        syntheticBars: live.syntheticCount,
        totalPriceDivergences,
        totalVolumeDivergences,
        severity,
        issues,
      },
      contracts: verbose ? contractReports : [],
      worstContracts,
    };

    return report;
  } finally {
    liveDb.close();
    replayDb.close();
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || todayET();

  console.log(`[bar-quality-report] ${new Date().toISOString()}`);
  console.log(`  Date: ${date}`);
  console.log();

  const report = generateReport(date, verbose);

  // Print summary
  const s = report.summary;
  const severityIcon = s.severity === 'clean' ? '✅' : s.severity === 'warning' ? '⚠️' : '🔴';
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  BAR QUALITY REPORT: ${date}  ${severityIcon} ${s.severity.toUpperCase()}`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Live bars:     ${s.totalLiveBars} (${s.totalContracts} contracts)`);
  console.log(`  Backfill bars: ${s.totalBackfillBars}`);
  console.log(`  Flat bars:     ${s.flatBars} (${s.flatPct}%)`);
  console.log(`  Cumul. volume: ${s.cumulativeVolumeBars}`);
  console.log(`  Synthetic:     ${s.syntheticBars}`);
  console.log(`  Price divs:    ${s.totalPriceDivergences}`);
  console.log(`  Volume divs:   ${s.totalVolumeDivergences}`);
  console.log();
  console.log(`  Issues:`);
  for (const issue of s.issues) {
    console.log(`    - ${issue}`);
  }

  if (report.worstContracts.length > 0) {
    console.log(`\n  Worst contracts by flat %:`);
    for (const c of report.worstContracts) {
      console.log(`    ${c.symbol}: ${c.flatPct}% flat (${c.flatBars}/${c.liveBars}), cumVol: ${c.cumulativeVolumeBars}, priceDivs: ${c.priceDivergences}`);
    }
  }
  console.log(`${'═'.repeat(60)}\n`);

  // Write report file
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, `${date}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`  Report saved: ${reportPath}`);
}

main();
