/**
 * view-results.ts — View and compare replay results from the store.
 *
 * Usage:
 *   npx tsx scripts/backtest/view-results.ts                       # show all configs + summaries
 *   npx tsx scripts/backtest/view-results.ts --config=default      # daily breakdown for a config
 *   npx tsx scripts/backtest/view-results.ts --compare=default,aggressive  # side-by-side comparison
 *   npx tsx scripts/backtest/view-results.ts --csv=default         # export CSV
 */

import { createStore } from '../../src/replay';

const args = process.argv.slice(2);
const flags = Object.fromEntries(
  args.filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v ?? 'true'];
  })
);

const store = createStore();

if (flags['csv']) {
  console.log(store.exportResultsToCsv(flags['csv']));
} else if (flags['compare']) {
  const [id1, id2] = flags['compare'].split(',');
  const cmp = store.compareConfigs(id1, id2);
  const c1 = cmp.config1;
  const c2 = cmp.config2;
  const diff = cmp.difference;

  console.log(`\n  Comparison: ${id1} vs ${id2}`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  Metric              ${id1.padEnd(15)} ${id2.padEnd(15)} Diff`);
  console.log(`  ${'─'.repeat(70)}`);
  console.log(`  Total Trades        ${String(c1.totalTrades || 0).padEnd(15)} ${String(c2.totalTrades || 0).padEnd(15)} ${diff.totalTrades > 0 ? '+' : ''}${diff.totalTrades}`);
  console.log(`  Win Rate            ${((c1.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${((c2.avgWinRate || 0) * 100).toFixed(1).padEnd(14)}% ${(diff.winRateDiff * 100 > 0 ? '+' : '')}${(diff.winRateDiff * 100).toFixed(1)}%`);
  console.log(`  Cumulative P&L      $${String(c1.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${String(c2.cumulativePnl?.toFixed(0) || 0).padEnd(14)} $${diff.pnlDiff > 0 ? '+' : ''}${diff.pnlDiff.toFixed(0)}`);
  console.log(`  Avg Daily P&L       $${(c1.avgDailyPnl || 0).toFixed(0).padEnd(14)} $${(c2.avgDailyPnl || 0).toFixed(0).padEnd(14)}`);
  console.log(`  Best Day            $${(c1.bestDay || 0).toFixed(0).padEnd(14)} $${(c2.bestDay || 0).toFixed(0).padEnd(14)}`);
  console.log(`  Worst Day           $${(c1.worstDay || 0).toFixed(0).padEnd(14)} $${(c2.worstDay || 0).toFixed(0).padEnd(14)}`);
} else if (flags['config']) {
  const results = store.getResultsByConfig(flags['config']);
  const summary = store.getConfigSummary(flags['config']);

  console.log(`\n  Config: ${flags['config']}`);
  console.log(`  ${'─'.repeat(70)}`);

  if (results.length === 0) {
    console.log('  No results found.');
  } else {
    console.log(`  ${'Date'.padEnd(12)} ${'Trades'.padEnd(8)} ${'Wins'.padEnd(6)} ${'WR%'.padEnd(8)} ${'P&L'.padEnd(10)} ${'Max Win'.padEnd(10)} ${'Max Loss'.padEnd(10)}`);
    console.log(`  ${'─'.repeat(70)}`);
    for (const r of results) {
      console.log(`  ${r.date.padEnd(12)} ${String(r.trades).padEnd(8)} ${String(r.wins).padEnd(6)} ${(r.winRate * 100).toFixed(0).padEnd(7)}% $${r.totalPnl.toFixed(0).padStart(8)} $${(r.maxWin || 0).toFixed(0).padStart(8)} $${(r.maxLoss || 0).toFixed(0).padStart(8)}`);
    }
    console.log(`  ${'─'.repeat(70)}`);
    console.log(`  TOTAL: ${summary.totalTrades} trades | ${(summary.avgWinRate * 100).toFixed(1)}% WR | $${summary.cumulativePnl?.toFixed(0)} cumulative P&L`);
  }
} else {
  // List all configs with summaries
  const configs = store.listConfigs();
  if (configs.length === 0) {
    console.log('\n  No configs found. Run a replay first to create one.');
  } else {
    console.log(`\n  Saved Configurations (${configs.length}):`);
    console.log(`  ${'─'.repeat(70)}`);
    for (const c of configs) {
      const s = store.getConfigSummary(c.id);
      const runs = s?.totalRuns || 0;
      const pnl = s?.cumulativePnl?.toFixed(0) || '0';
      const wr = s?.avgWinRate ? (s.avgWinRate * 100).toFixed(1) + '%' : '-';
      console.log(`  ${c.id.padEnd(20)} ${c.name.padEnd(25)} ${String(runs).padEnd(5)} runs | WR ${wr.padEnd(6)} | P&L $${pnl}`);
    }
  }
}

store.close();
