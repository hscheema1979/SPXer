/**
 * Spread comparison analysis — post-processing tool.
 * 
 * Takes existing replay results and computes what the P&L would have been
 * if each trade was structured as a spread instead of a straight buy.
 *
 * For each trade:
 *   - Looks up the adjacent contract's price at entry and exit timestamps
 *   - Computes debit spread and credit spread P&L at $5, $10, $15 widths
 *   - Compares against the original single-leg P&L
 *
 * Runs against all configs with P&L > $1M and 200+ days.
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || 'data/spxer.db');
const WIDTHS = [5, 10, 15];
const COMMISSION_PER_LEG = 0.35;
const HALF_SPREAD = 0.05;

interface TradeJson {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  'pnl$': number;
}

interface SpreadResult {
  mode: 'debit' | 'credit';
  width: number;
  trades: number;
  validTrades: number; // had data for both legs
  totalPnl: number;
  wins: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
}

function parseSymbol(sym: string): { expiry: string; side: 'C' | 'P'; strike: number } | null {
  // SPXW260406C06605000
  const match = sym.match(/^SPXW(\d{6})(C|P)(\d{8})$/);
  if (!match) return null;
  return { expiry: match[1], side: match[2] as 'C' | 'P', strike: parseInt(match[3]) / 1000 };
}

function buildSymbol(expiry: string, side: 'C' | 'P', strike: number): string {
  return `SPXW${expiry}${side}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });

  // Find qualifying configs
  const configs = db.prepare(`
    SELECT configId, COUNT(*) as days, SUM(totalPnl) as pnl
    FROM replay_results
    GROUP BY configId
    HAVING COUNT(*) >= 200 AND SUM(totalPnl) > 1000000
    ORDER BY pnl DESC
  `).all() as { configId: string; days: number; pnl: number }[];

  console.log(`\n  Spread Comparison Analysis`);
  console.log(`  ${configs.length} configs qualifying (>$1M, 200+ days)\n`);

  // For each config, load all trades and compute spread alternatives
  const allResults: Map<string, { baseline: number; days: number; spreads: SpreadResult[] }> = new Map();

  let processedConfigs = 0;

  for (const cfg of configs) {
    // Load all trade JSONs for this config
    const rows = db.prepare(`
      SELECT date, trades_json FROM replay_results WHERE configId = ?
    `).all(cfg.configId) as { date: string; trades_json: string }[];

    const allTrades: TradeJson[] = [];
    for (const row of rows) {
      try {
        const trades = JSON.parse(row.trades_json || '[]') as TradeJson[];
        allTrades.push(...trades);
      } catch {}
    }

    if (allTrades.length === 0) continue;

    // Compute spread results for each mode × width
    const spreadResults: SpreadResult[] = [];

    for (const mode of ['debit', 'credit'] as const) {
      for (const width of WIDTHS) {
        let validTrades = 0;
        let totalPnl = 0;
        let wins = 0;
        let maxWin = -Infinity;
        let maxLoss = Infinity;

        for (const trade of allTrades) {
          const parsed = parseSymbol(trade.symbol);
          if (!parsed) continue;

          // Compute the other leg's strike
          // For debit spread: buy anchor (closer), sell further OTM
          // For credit spread: sell anchor, buy further OTM
          const otherStrike = parsed.side === 'C'
            ? parsed.strike + width  // further OTM call
            : parsed.strike - width; // further OTM put

          if (otherStrike <= 0) continue;

          const otherSymbol = buildSymbol(parsed.expiry, parsed.side, otherStrike);

          // Look up other leg prices at entry and exit timestamps
          // Use the closest bar within 60 seconds
          const otherEntry = db.prepare(`
            SELECT close FROM replay_bars
            WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
            ORDER BY ABS(ts - ?) LIMIT 1
          `).get(otherSymbol, trade.entryTs - 60, trade.entryTs + 60, trade.entryTs) as { close: number } | undefined;

          const otherExit = db.prepare(`
            SELECT close FROM replay_bars
            WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
            ORDER BY ABS(ts - ?) LIMIT 1
          `).get(otherSymbol, trade.exitTs - 60, trade.exitTs + 60, trade.exitTs) as { close: number } | undefined;

          if (!otherEntry || !otherExit) continue;

          validTrades++;

          // Compute spread P&L
          const anchorEntryPrice = trade.entryPrice;
          const anchorExitPrice = trade.exitPrice;
          const otherEntryPrice = otherEntry.close;
          const otherExitPrice = otherExit.close;

          let pnl: number;

          if (mode === 'debit') {
            // Debit spread: Buy anchor, Sell other
            // Entry: pay anchor - receive other = net debit
            const entryDebit = (anchorEntryPrice + HALF_SPREAD) - (otherEntryPrice - HALF_SPREAD);
            // Exit: sell anchor - buy back other = net credit received
            const exitCredit = (anchorExitPrice - HALF_SPREAD) - (otherExitPrice + HALF_SPREAD);
            // P&L = (exit credit - entry debit) × qty × 100 - commissions
            pnl = (exitCredit - entryDebit) * trade.qty * 100 - (COMMISSION_PER_LEG * trade.qty * 4);

            // Cap P&L at max profit (width × qty × 100) and max loss (-entryDebit × qty × 100)
            const maxProfit = (width - Math.max(0, entryDebit)) * trade.qty * 100;
            const maxLossAmt = Math.max(0, entryDebit) * trade.qty * 100;
            pnl = Math.max(-maxLossAmt, Math.min(maxProfit, pnl));
          } else {
            // Credit spread: Sell anchor, Buy other
            // Entry: receive anchor - pay other = net credit
            const entryCredit = (anchorEntryPrice - HALF_SPREAD) - (otherEntryPrice + HALF_SPREAD);
            // Exit: buy back anchor - sell other = net debit to close
            const exitDebit = (anchorExitPrice + HALF_SPREAD) - (otherExitPrice - HALF_SPREAD);
            // P&L = (entry credit - exit debit) × qty × 100 - commissions
            pnl = (entryCredit - exitDebit) * trade.qty * 100 - (COMMISSION_PER_LEG * trade.qty * 4);

            // Cap: max profit = credit collected, max loss = (width - credit) × qty × 100
            const maxProfit = Math.max(0, entryCredit) * trade.qty * 100;
            const maxLossAmt = (width - Math.max(0, entryCredit)) * trade.qty * 100;
            pnl = Math.max(-maxLossAmt, Math.min(maxProfit, pnl));
          }

          totalPnl += pnl;
          if (pnl > 0) wins++;
          if (pnl > maxWin) maxWin = pnl;
          if (pnl < maxLoss) maxLoss = pnl;
        }

        spreadResults.push({
          mode, width,
          trades: allTrades.length,
          validTrades,
          totalPnl,
          wins,
          avgPnl: validTrades > 0 ? totalPnl / validTrades : 0,
          maxWin: maxWin === -Infinity ? 0 : maxWin,
          maxLoss: maxLoss === Infinity ? 0 : maxLoss,
        });
      }
    }

    allResults.set(cfg.configId, {
      baseline: cfg.pnl,
      days: cfg.days,
      spreads: spreadResults,
    });

    processedConfigs++;
    if (processedConfigs % 10 === 0) {
      process.stdout.write(`  Processing: ${processedConfigs}/${configs.length}\r`);
    }
  }

  db.close();

  // ═══ Print Results ═══

  const fmt = (n: number) => n >= 0 ? `+$${(n/1000).toFixed(0)}K` : `-$${(Math.abs(n)/1000).toFixed(0)}K`;

  // Summary table: for each mode × width, aggregate across all configs
  console.log(`\n${'='.repeat(130)}`);
  console.log(`  SPREAD COMPARISON — AGGREGATE ACROSS ${configs.length} CONFIGS`);
  console.log(`${'='.repeat(130)}\n`);

  const p = (s: string|number, w: number) => String(s).padStart(w);

  console.log(`  ${p('Mode',8)} ${p('Width',6)} ${p('Avg Total P&L',14)} ${p('Avg vs Baseline',16)} ${p('Avg WR',8)} ${p('Cfgs Better',12)} ${p('Cfgs Worse',12)}`);
  console.log(`  ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(14)} ${'-'.repeat(16)} ${'-'.repeat(8)} ${'-'.repeat(12)} ${'-'.repeat(12)}`);

  for (const mode of ['debit', 'credit'] as const) {
    for (const width of WIDTHS) {
      let sumPnl = 0, sumBaseline = 0, sumWR = 0;
      let better = 0, worse = 0;

      for (const [, data] of allResults) {
        const sr = data.spreads.find(s => s.mode === mode && s.width === width);
        if (!sr || sr.validTrades === 0) continue;
        sumPnl += sr.totalPnl;
        sumBaseline += data.baseline;
        sumWR += sr.validTrades > 0 ? sr.wins / sr.validTrades : 0;
        if (sr.totalPnl > data.baseline) better++;
        else worse++;
      }

      const n = allResults.size;
      const avgPnl = sumPnl / n;
      const avgBaseline = sumBaseline / n;
      const avgWR = (sumWR / n * 100).toFixed(1);
      const delta = avgPnl - avgBaseline;

      console.log(`  ${p(mode,8)} ${p('$'+width,6)} ${p(fmt(avgPnl),14)} ${p(fmt(delta),16)} ${p(avgWR+'%',8)} ${p(better,12)} ${p(worse,12)}`);
    }
  }

  // Top 10 configs: show baseline vs best spread
  console.log(`\n${'='.repeat(130)}`);
  console.log(`  TOP 20 CONFIGS — BASELINE vs BEST SPREAD`);
  console.log(`${'='.repeat(130)}\n`);

  console.log(`  ${'Config'.padEnd(47)} ${p('Days',5)} ${p('Baseline',12)} ${p('Best Spread',14)} ${p('Mode',8)} ${p('Width',6)} ${p('Delta',12)} ${p('WR',7)}`);
  console.log(`  ${'-'.repeat(47)} ${'-'.repeat(5)} ${'-'.repeat(12)} ${'-'.repeat(14)} ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(12)} ${'-'.repeat(7)}`);

  const sorted = [...allResults.entries()].sort((a, b) => b[1].baseline - a[1].baseline).slice(0, 20);

  for (const [configId, data] of sorted) {
    const best = data.spreads.reduce((a, b) => a.totalPnl > b.totalPnl ? a : b);
    const delta = best.totalPnl - data.baseline;
    const wr = best.validTrades > 0 ? (best.wins / best.validTrades * 100).toFixed(1) : '?';
    const marker = delta > 0 ? '✅' : '❌';

    console.log(`  ${marker} ${configId.slice(0,45).padEnd(45)} ${p(data.days,5)} ${p(fmt(data.baseline),12)} ${p(fmt(best.totalPnl),14)} ${p(best.mode,8)} ${p('$'+best.width,6)} ${p(fmt(delta),12)} ${p(wr+'%',7)}`);
  }

  // Detailed breakdown for top 5 configs
  console.log(`\n${'='.repeat(130)}`);
  console.log(`  DETAILED BREAKDOWN — TOP 5 CONFIGS`);
  console.log(`${'='.repeat(130)}`);

  for (const [configId, data] of sorted.slice(0, 5)) {
    console.log(`\n  ${configId} (${data.days} days, baseline: ${fmt(data.baseline)})`);
    console.log(`  ${p('Mode',8)} ${p('Width',6)} ${p('Total P&L',12)} ${p('vs Baseline',12)} ${p('Trades',7)} ${p('Valid',6)} ${p('WR',7)} ${p('Max Win',10)} ${p('Max Loss',10)}`);
    console.log(`  ${'-'.repeat(8)} ${'-'.repeat(6)} ${'-'.repeat(12)} ${'-'.repeat(12)} ${'-'.repeat(7)} ${'-'.repeat(6)} ${'-'.repeat(7)} ${'-'.repeat(10)} ${'-'.repeat(10)}`);

    // Baseline row
    const baselineTrades = data.spreads[0]?.trades || 0;
    console.log(`  ${p('BUY',8)} ${p('—',6)} ${p(fmt(data.baseline),12)} ${p('—',12)} ${p(baselineTrades,7)} ${p(baselineTrades,6)} ${p('—',7)} ${p('—',10)} ${p('—',10)}`);

    for (const sr of data.spreads) {
      const delta = sr.totalPnl - data.baseline;
      const wr = sr.validTrades > 0 ? (sr.wins / sr.validTrades * 100).toFixed(1) : '?';
      console.log(`  ${p(sr.mode,8)} ${p('$'+sr.width,6)} ${p(fmt(sr.totalPnl),12)} ${p(fmt(delta),12)} ${p(sr.trades,7)} ${p(sr.validTrades,6)} ${p(wr+'%',7)} ${p(fmt(sr.maxWin),10)} ${p(fmt(sr.maxLoss),10)}`);
    }
  }

  console.log('\n');
}

main().catch(console.error);
