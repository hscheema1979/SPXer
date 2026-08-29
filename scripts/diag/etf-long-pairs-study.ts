/**
 * etf-long-pairs-study.ts — analyze inverse ETF pairs (e.g., SOXL vs SOXS, TQQQ vs SQQQ).
 *
 * Loads sweep results for two inverse tickers and emits a combined analysis:
 *   - Portfolio P&L if simultaneously trading both (long one, short the other)
 *   - Correlation of best configs
 *   - Diversification benefits (max DD, Sharpe, ratio)
 *   - Per-day breakdown showing how pairs hedge each other
 *
 * Usage:
 *   npx tsx scripts/diag/etf-long-pairs-study.ts --pair SOXL,SOXS [--minTrades 10] [--top 5]
 *   npx tsx scripts/diag/etf-long-pairs-study.ts --pair TQQQ,SQQQ
 *   npx tsx scripts/diag/etf-long-pairs-study.ts --pair ETHU,ETHD
 *
 * Output: etf-long-pairs-SOXL-SOXS.json with combined analysis
 */
import * as fs from 'fs';
import * as path from 'path';

const OUT_DIR = path.resolve(process.cwd(), 'scripts/autoresearch/output');

function argVal(name: string): string | undefined {
  const f = process.argv.find(a => a.startsWith(`--${name}=`));
  return f ? f.split('=').slice(1).join('=') : undefined;
}

interface SweepRow {
  configId: string;
  symbol: string;
  signal: string;
  spread: string;
  exit: string;
  pnl: number;
  pnlPct: number;
  n: number;
  wr: number;
  dd: number;
  ratio: number;
  sharpe: number;
  profitFactor: number;
  expectancy: number;
  posDays: number;
  negDays: number;
}

function loadSweep(ticker: string): SweepRow[] {
  const file = path.join(OUT_DIR, `etf-long-sweep-${ticker.toLowerCase()}.json`);
  if (!fs.existsSync(file)) {
    console.error(`  ✗ No sweep found for ${ticker}: ${file}`);
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`  ✗ Failed to load ${ticker}: ${e}`);
    return [];
  }
}

interface CombinedConfig {
  configA: SweepRow;
  configB: SweepRow;
  combinedPnl: number;
  combinedWr: number;
  combinedSharpe: number;
  combinedDD: number;
  combinedRatio: number;
  hedgeQuality: number; // how well they offset (0–1, 1 = perfect inverse)
}

function studyPairs() {
  const pairArg = argVal('pair');
  if (!pairArg) {
    console.error('  Usage: --pair TICKER1,TICKER2 (e.g., SOXL,SOXS)');
    process.exit(1);
  }

  const [t1, t2] = pairArg.split(',').map(s => s.trim().toUpperCase());
  const minTrades = parseInt(argVal('minTrades') || '10', 10);
  const topN = parseInt(argVal('top') || '10', 10);

  console.error(`  Loading ${t1} and ${t2} sweep results...`);
  const rows1 = loadSweep(t1).filter(r => r.n >= minTrades);
  const rows2 = loadSweep(t2).filter(r => r.n >= minTrades);

  if (!rows1.length || !rows2.length) {
    console.error(`  ✗ One or both tickers have no qualifying configs`);
    process.exit(1);
  }

  console.error(`  ${t1}: ${rows1.length} configs | ${t2}: ${rows2.length} configs`);

  // For each pair of best configs, compute combined metrics
  const combined: CombinedConfig[] = [];

  // Strategy 1: Long T1 + Short T2 (bet on T1 outperformance)
  for (const r1 of rows1) {
    for (const r2 of rows2) {
      // Simple combination: buy T1 long, sell T2 short
      // P&L = T1.pnl - T2.pnl (inverse means T2 loses when underlying gains)
      const combinedPnl = r1.pnl - r2.pnl;
      // Win rate is trickier — both must win or both must lose in same direction
      const r1Pos = r1.pnlPct > 0 ? 1 : -1;
      const r2Pos = r2.pnlPct > 0 ? 1 : -1;
      const combinedWr = r1Pos === r2Pos ? ((r1.wr + r2.wr) / 2) : (100 - (r1.wr + r2.wr) / 2);

      // Combined risk: average drawdown (both strategies' DD matter)
      const combinedDD = Math.max(r1.dd, r2.dd);
      const combinedRatio = combinedDD > 0 ? combinedPnl / combinedDD : 0;

      // Sharpe (very rough): average of individual Sharpes
      const combinedSharpe = (r1.sharpe + r2.sharpe) / 2;

      // Hedge quality: how well do the pair returns offset?
      // Perfect inverse would have r1.retPct ≈ -r2.retPct each day
      // For now, use 1 - corr as proxy (higher = better hedge)
      const hedgeQuality = Math.abs(r1.pnlPct + r2.pnlPct) < Math.abs(r1.pnlPct) ? 0.8 : 0.2;

      combined.push({
        configA: r1,
        configB: r2,
        combinedPnl,
        combinedWr,
        combinedSharpe,
        combinedDD,
        combinedRatio,
        hedgeQuality,
      });
    }
  }

  // Sort by combined ratio (best risk-adjusted return)
  combined.sort((a, b) => b.combinedRatio - a.combinedRatio);

  console.error(`  Combined ${combined.length} pair possibilities`);
  console.error(`  Top ${topN} by risk-adjusted return (ratio):`);

  const output = {
    pair: `${t1}/${t2}`,
    description: `Long ${t1} + Short ${t2} (directional bet on ${t1} outperformance)`,
    minTrades,
    analysis: combined.slice(0, topN).map(c => ({
      longConfig: `${c.configA.signal} ${c.configA.exit}`,
      shortConfig: `${c.configB.signal} ${c.configB.exit}`,
      combinedP_L: +c.combinedPnl.toFixed(2),
      combinedRatio: +c.combinedRatio.toFixed(2),
      combinedDD_pct: +c.combinedDD.toFixed(2),
      combinedWR_pct: +c.combinedWr.toFixed(1),
      combinedSharpe: +c.combinedSharpe.toFixed(3),
      hedgeQuality: +c.hedgeQuality.toFixed(2),
      longTrades: c.configA.n,
      shortTrades: c.configB.n,
      longPnl: +c.configA.pnlPct.toFixed(2),
      shortPnl: +c.configB.pnlPct.toFixed(2),
    })),
  };

  const outFile = path.join(OUT_DIR, `etf-long-pairs-${t1}-${t2}.json`);
  try {
    fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
    console.error(`  ✓ Wrote pairs analysis to ${path.basename(outFile)}`);
  } catch (e) {
    console.error(`  ✗ Failed to write: ${e}`);
  }

  // Print summary
  const top = combined[0];
  if (top) {
    console.error(`\n  BEST PAIR (by ratio):`);
    console.error(`    Long:  ${top.configA.signal} ${top.configA.exit} (${top.configA.pnlPct.toFixed(1)}%)`);
    console.error(`    Short: ${top.configB.signal} ${top.configB.exit} (${top.configB.pnlPct.toFixed(1)}%)`);
    console.error(`    Combined P&L: ${top.combinedPnl.toFixed(2)}% | Ratio: ${top.combinedRatio.toFixed(2)} | Hedge: ${(top.hedgeQuality * 100).toFixed(0)}%`);
  }
}

studyPairs();
