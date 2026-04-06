/**
 * Spread comparison analysis — post-processing tool.
 * 
 * Takes existing replay results and computes what the P&L would have been
 * if each trade was structured as a spread instead of a straight buy.
 *
 * Now includes risk-adjusted metrics: max drawdown, Sharpe, Sortino,
 * profit factor, consecutive loss streaks, daily P&L distribution.
 *
 * Runs against all configs with P&L > $1M and 200+ days.
 *
 * OPTIMIZATION: 922K trades across 172 configs share only ~99K unique
 * (symbol, entryTs, exitTs) combos. We deduplicate, batch-lookup prices
 * once, cache spread P&L, and re-map to configs. ~100x faster.
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
  date?: string; // we'll attach this from the result row
}

interface DailyMetrics {
  totalPnl: number;
  winDays: number;
  lossDays: number;
  maxDrawdown: number;       // peak-to-trough in $
  maxDrawdownPct: number;    // as % of peak equity
  sharpe: number;
  sortino: number;
  profitFactor: number;
  maxConsecLoss: number;     // consecutive losing days
  maxConsecWin: number;
  avgWinDay: number;
  avgLossDay: number;
  worstDay: number;
  bestDay: number;
  dailyStdDev: number;
  calmarRatio: number;       // annualized return / max drawdown
}

interface StrategyResult {
  mode: string;   // 'buy' | 'debit' | 'credit'
  width: number;  // 0 for buy
  trades: number;
  validTrades: number;
  wins: number;
  metrics: DailyMetrics;
}

function parseSymbol(sym: string): { expiry: string; side: 'C' | 'P'; strike: number } | null {
  const match = sym.match(/^SPXW(\d{6})(C|P)(\d{8})$/);
  if (!match) return null;
  return { expiry: match[1], side: match[2] as 'C' | 'P', strike: parseInt(match[3]) / 1000 };
}

function buildSymbol(expiry: string, side: 'C' | 'P', strike: number): string {
  return `SPXW${expiry}${side}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
}

function computeSpreadPnl(
  mode: 'debit' | 'credit',
  width: number,
  anchorEntryPrice: number,
  anchorExitPrice: number,
  otherEntryPrice: number,
  otherExitPrice: number,
  qty: number,
): number {
  let pnl: number;

  if (mode === 'debit') {
    const entryDebit = (anchorEntryPrice + HALF_SPREAD) - (otherEntryPrice - HALF_SPREAD);
    const exitCredit = (anchorExitPrice - HALF_SPREAD) - (otherExitPrice + HALF_SPREAD);
    pnl = (exitCredit - entryDebit) * qty * 100 - (COMMISSION_PER_LEG * qty * 4);
    const maxProfit = (width - Math.max(0, entryDebit)) * qty * 100;
    const maxLossAmt = Math.max(0, entryDebit) * qty * 100;
    pnl = Math.max(-maxLossAmt, Math.min(maxProfit, pnl));
  } else {
    const entryCredit = (anchorEntryPrice - HALF_SPREAD) - (otherEntryPrice + HALF_SPREAD);
    const exitDebit = (anchorExitPrice + HALF_SPREAD) - (otherExitPrice - HALF_SPREAD);
    pnl = (entryCredit - exitDebit) * qty * 100 - (COMMISSION_PER_LEG * qty * 4);
    const maxProfit = Math.max(0, entryCredit) * qty * 100;
    const maxLossAmt = (width - Math.max(0, entryCredit)) * qty * 100;
    pnl = Math.max(-maxLossAmt, Math.min(maxProfit, pnl));
  }

  return pnl;
}

function computeDailyMetrics(dailyPnls: number[]): DailyMetrics {
  if (dailyPnls.length === 0) {
    return { totalPnl: 0, winDays: 0, lossDays: 0, maxDrawdown: 0, maxDrawdownPct: 0,
      sharpe: 0, sortino: 0, profitFactor: 0, maxConsecLoss: 0, maxConsecWin: 0,
      avgWinDay: 0, avgLossDay: 0, worstDay: 0, bestDay: 0, dailyStdDev: 0, calmarRatio: 0 };
  }

  const totalPnl = dailyPnls.reduce((s, x) => s + x, 0);
  const winDays = dailyPnls.filter(x => x > 0).length;
  const lossDays = dailyPnls.filter(x => x < 0).length;
  const winAmounts = dailyPnls.filter(x => x > 0);
  const lossAmounts = dailyPnls.filter(x => x < 0);
  const avgWinDay = winAmounts.length > 0 ? winAmounts.reduce((s, x) => s + x, 0) / winAmounts.length : 0;
  const avgLossDay = lossAmounts.length > 0 ? lossAmounts.reduce((s, x) => s + x, 0) / lossAmounts.length : 0;
  const worstDay = Math.min(...dailyPnls);
  const bestDay = Math.max(...dailyPnls);

  // Equity curve and drawdown
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  for (const pnl of dailyPnls) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDrawdown) maxDrawdown = dd;
    if (peak > 0 && dd / peak > maxDrawdownPct) maxDrawdownPct = dd / peak;
  }

  // Sharpe (daily, annualized: √252)
  const mean = totalPnl / dailyPnls.length;
  const variance = dailyPnls.reduce((s, x) => s + (x - mean) ** 2, 0) / dailyPnls.length;
  const dailyStdDev = Math.sqrt(variance);
  const sharpe = dailyStdDev > 0 ? (mean / dailyStdDev) * Math.sqrt(252) : 0;

  // Sortino (downside deviation only)
  const downsideVariance = dailyPnls.reduce((s, x) => s + (x < 0 ? x ** 2 : 0), 0) / dailyPnls.length;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : 0;

  // Profit factor
  const grossWin = winAmounts.reduce((s, x) => s + x, 0);
  const grossLoss = Math.abs(lossAmounts.reduce((s, x) => s + x, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Consecutive streaks
  let maxConsecLoss = 0, maxConsecWin = 0;
  let curLoss = 0, curWin = 0;
  for (const pnl of dailyPnls) {
    if (pnl < 0) { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
    else if (pnl > 0) { curWin++; curLoss = 0; maxConsecWin = Math.max(maxConsecWin, curWin); }
    else { curLoss = 0; curWin = 0; }
  }

  // Calmar ratio (annualized return / max drawdown)
  const annualizedReturn = mean * 252;
  const calmarRatio = maxDrawdown > 0 ? annualizedReturn / maxDrawdown : 0;

  return {
    totalPnl, winDays, lossDays, maxDrawdown, maxDrawdownPct,
    sharpe, sortino, profitFactor, maxConsecLoss, maxConsecWin,
    avgWinDay, avgLossDay, worstDay, bestDay, dailyStdDev, calmarRatio,
  };
}

async function main() {
  const t0 = Date.now();
  const db = new Database(DB_PATH, { readonly: true });
  
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -512000');
  db.pragma('mmap_size = 2147483648');

  // ═══ Step 1: Find qualifying configs ═══
  const configs = db.prepare(`
    SELECT configId, COUNT(*) as days, SUM(totalPnl) as pnl
    FROM replay_results
    GROUP BY configId
    HAVING COUNT(*) >= 200 AND SUM(totalPnl) > 1000000
    ORDER BY pnl DESC
  `).all() as { configId: string; days: number; pnl: number }[];

  console.log(`\n  Spread Comparison Analysis (with risk metrics)`);
  console.log(`  ${configs.length} configs qualifying (>$1M, 200+ days)`);

  // ═══ Step 2: Load all trades WITH dates, dedup ═══
  console.log(`  Loading trades...`);
  
  // Map: configId → { date → trades[] }
  const configDateTrades = new Map<string, Map<string, TradeJson[]>>();
  // Also: configId → baseline daily P&L from replay_results
  const configBaselineDailyPnl = new Map<string, Map<string, number>>();
  let totalTradeCount = 0;

  for (const cfg of configs) {
    const rows = db.prepare(`
      SELECT date, totalPnl, trades_json FROM replay_results WHERE configId = ? ORDER BY date
    `).all(cfg.configId) as { date: string; totalPnl: number; trades_json: string }[];

    const dateTrades = new Map<string, TradeJson[]>();
    const dailyPnl = new Map<string, number>();

    for (const row of rows) {
      dailyPnl.set(row.date, row.totalPnl);
      try {
        const trades = JSON.parse(row.trades_json || '[]') as TradeJson[];
        // Attach date to each trade for grouping
        for (const t of trades) t.date = row.date;
        dateTrades.set(row.date, trades);
        totalTradeCount += trades.length;
      } catch {}
    }

    configDateTrades.set(cfg.configId, dateTrades);
    configBaselineDailyPnl.set(cfg.configId, dailyPnl);
  }

  console.log(`  ${totalTradeCount.toLocaleString()} total trades across ${configs.length} configs`);

  // Collect unique trades for dedup
  type TradeKey = string;
  const uniqueTrades = new Map<TradeKey, TradeJson>();

  for (const [, dateTrades] of configDateTrades) {
    for (const [, trades] of dateTrades) {
      for (const trade of trades) {
        const key = `${trade.symbol}|${trade.entryTs}|${trade.exitTs}`;
        if (!uniqueTrades.has(key)) uniqueTrades.set(key, trade);
      }
    }
  }

  console.log(`  ${uniqueTrades.size.toLocaleString()} unique trades (deduped from ${totalTradeCount.toLocaleString()})`);

  // ═══ Step 3: Collect needed price lookups ═══
  const priceLookups = new Map<string, number | null>();

  for (const [, trade] of uniqueTrades) {
    const parsed = parseSymbol(trade.symbol);
    if (!parsed) continue;

    for (const width of WIDTHS) {
      const otherStrike = parsed.side === 'C'
        ? parsed.strike + width
        : parsed.strike - width;
      if (otherStrike <= 0) continue;

      const otherSymbol = buildSymbol(parsed.expiry, parsed.side, otherStrike);
      priceLookups.set(`${otherSymbol}|${trade.entryTs}`, null);
      priceLookups.set(`${otherSymbol}|${trade.exitTs}`, null);
    }
  }

  console.log(`  ${priceLookups.size.toLocaleString()} price lookups needed`);

  // ═══ Step 4: Batch price lookups ═══
  const symbolTs = new Map<string, number[]>();
  for (const key of priceLookups.keys()) {
    const [sym, tsStr] = key.split('|');
    if (!symbolTs.has(sym)) symbolTs.set(sym, []);
    symbolTs.get(sym)!.push(parseInt(tsStr));
  }

  console.log(`  Looking up prices for ${symbolTs.size.toLocaleString()} symbols...`);

  const lookupStmt = db.prepare(`
    SELECT ts, close FROM replay_bars
    WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    ORDER BY ts ASC LIMIT 1
  `);

  let lookedUp = 0;
  const lookupTotal = symbolTs.size;
  const startLookup = Date.now();

  for (const [symbol, timestamps] of symbolTs) {
    timestamps.sort((a, b) => a - b);
    for (const ts of timestamps) {
      const row = lookupStmt.get(symbol, ts - 60, ts + 60) as { ts: number; close: number } | undefined;
      priceLookups.set(`${symbol}|${ts}`, row ? row.close : null);
    }

    lookedUp++;
    if (lookedUp % 1000 === 0) {
      const elapsed = (Date.now() - startLookup) / 1000;
      const rate = lookedUp / elapsed;
      const remaining = (lookupTotal - lookedUp) / rate;
      process.stdout.write(`\r  Lookups: ${lookedUp.toLocaleString()}/${lookupTotal.toLocaleString()} (${rate.toFixed(0)}/s, ~${remaining.toFixed(0)}s remaining)   `);
    }
  }
  process.stdout.write(`\r  Lookups complete: ${lookedUp.toLocaleString()} symbols in ${((Date.now() - startLookup) / 1000).toFixed(1)}s                    \n`);

  // ═══ Step 5: Build spread price cache ═══
  const spreadCache = new Map<TradeKey, Map<string, { valid: boolean; otherEntry: number; otherExit: number }>>();

  for (const [tradeKey, trade] of uniqueTrades) {
    const parsed = parseSymbol(trade.symbol);
    if (!parsed) continue;

    const widthResults = new Map<string, { valid: boolean; otherEntry: number; otherExit: number }>();

    for (const width of WIDTHS) {
      const otherStrike = parsed.side === 'C'
        ? parsed.strike + width
        : parsed.strike - width;
      
      if (otherStrike <= 0) {
        widthResults.set(String(width), { valid: false, otherEntry: 0, otherExit: 0 });
        continue;
      }

      const otherSymbol = buildSymbol(parsed.expiry, parsed.side, otherStrike);
      const otherEntryPrice = priceLookups.get(`${otherSymbol}|${trade.entryTs}`);
      const otherExitPrice = priceLookups.get(`${otherSymbol}|${trade.exitTs}`);

      if (otherEntryPrice == null || otherExitPrice == null) {
        widthResults.set(String(width), { valid: false, otherEntry: 0, otherExit: 0 });
      } else {
        widthResults.set(String(width), { valid: true, otherEntry: otherEntryPrice, otherExit: otherExitPrice });
      }
    }

    spreadCache.set(tradeKey, widthResults);
  }

  console.log(`  Spread prices cached for ${spreadCache.size.toLocaleString()} unique trades`);

  // ═══ Step 6: Aggregate per config with daily P&L tracking ═══
  console.log(`  Computing risk metrics across ${configs.length} configs...`);

  // For each config, compute: baseline daily metrics + each mode×width daily metrics
  interface ConfigResult {
    configId: string;
    baseline: DailyMetrics;
    baselineDays: number;
    strategies: StrategyResult[];
  }

  const allResults: ConfigResult[] = [];

  for (const cfg of configs) {
    const dateTrades = configDateTrades.get(cfg.configId)!;
    const baselineDailyPnl = configBaselineDailyPnl.get(cfg.configId)!;
    
    // Get sorted dates
    const dates = [...baselineDailyPnl.keys()].sort();
    
    // Baseline daily P&L array
    const baselineDailyArr = dates.map(d => baselineDailyPnl.get(d) || 0);
    const baselineMetrics = computeDailyMetrics(baselineDailyArr);

    const strategies: StrategyResult[] = [];

    for (const mode of ['debit', 'credit'] as const) {
      for (const width of WIDTHS) {
        // Compute daily P&L for this spread variant
        const dailyPnls: number[] = [];
        let totalTrades = 0;
        let validTrades = 0;
        let wins = 0;

        for (const date of dates) {
          const trades = dateTrades.get(date) || [];
          let dayPnl = 0;

          for (const trade of trades) {
            totalTrades++;
            const tradeKey = `${trade.symbol}|${trade.entryTs}|${trade.exitTs}`;
            const cached = spreadCache.get(tradeKey);
            if (!cached) continue;

            const widthData = cached.get(String(width));
            if (!widthData || !widthData.valid) continue;

            validTrades++;

            const pnl = computeSpreadPnl(
              mode, width,
              trade.entryPrice, trade.exitPrice,
              widthData.otherEntry, widthData.otherExit,
              trade.qty,
            );

            dayPnl += pnl;
            if (pnl > 0) wins++;
          }

          dailyPnls.push(dayPnl);
        }

        const metrics = computeDailyMetrics(dailyPnls);

        strategies.push({
          mode, width, trades: totalTrades, validTrades, wins, metrics,
        });
      }
    }

    allResults.push({
      configId: cfg.configId,
      baseline: baselineMetrics,
      baselineDays: dates.length,
      strategies,
    });
  }

  db.close();

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);

  // ═══ Print Results ═══

  const fmt = (n: number) => n >= 0 ? `+$${(n/1000).toFixed(0)}K` : `-$${(Math.abs(n)/1000).toFixed(0)}K`;
  const fmtD = (n: number) => `$${(n/1000).toFixed(0)}K`;
  const p = (s: string|number, w: number) => String(s).padStart(w);
  const pct = (n: number) => (n * 100).toFixed(1) + '%';

  // ════════════════════════════════════════════════════════════════════
  // SECTION 1: Aggregate risk metrics across all configs
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(160)}`);
  console.log(`  SPREAD COMPARISON — RISK-ADJUSTED AGGREGATE ACROSS ${configs.length} CONFIGS (completed in ${totalTime}s)`);
  console.log(`${'='.repeat(160)}\n`);

  const header = `  ${p('Strategy',12)} ${p('Avg P&L',10)} ${p('Avg WR',8)} ${p('MaxDD',10)} ${p('DD%',7)} ${p('Sharpe',8)} ${p('Sortino',9)} ${p('PF',6)} ${p('Calmar',8)} ${p('ConsLoss',9)} ${p('WorstDay',10)} ${p('BestDay',10)} ${p('StdDev',10)} ${p('Better',7)} ${p('Worse',7)}`;
  console.log(header);
  console.log(`  ${'-'.repeat(header.length - 2)}`);

  // Aggregate: baseline
  {
    const n = allResults.length;
    const avgPnl = allResults.reduce((s, r) => s + r.baseline.totalPnl, 0) / n;
    const avgWR = allResults.reduce((s, r) => s + (r.baseline.winDays / (r.baseline.winDays + r.baseline.lossDays || 1)), 0) / n;
    const avgDD = allResults.reduce((s, r) => s + r.baseline.maxDrawdown, 0) / n;
    const avgDDPct = allResults.reduce((s, r) => s + r.baseline.maxDrawdownPct, 0) / n;
    const avgSharpe = allResults.reduce((s, r) => s + r.baseline.sharpe, 0) / n;
    const avgSortino = allResults.reduce((s, r) => s + r.baseline.sortino, 0) / n;
    const avgPF = allResults.reduce((s, r) => s + Math.min(r.baseline.profitFactor, 100), 0) / n;
    const avgCalmar = allResults.reduce((s, r) => s + r.baseline.calmarRatio, 0) / n;
    const avgConsLoss = allResults.reduce((s, r) => s + r.baseline.maxConsecLoss, 0) / n;
    const avgWorst = allResults.reduce((s, r) => s + r.baseline.worstDay, 0) / n;
    const avgBest = allResults.reduce((s, r) => s + r.baseline.bestDay, 0) / n;
    const avgStd = allResults.reduce((s, r) => s + r.baseline.dailyStdDev, 0) / n;

    console.log(`  ${p('BUY (base)',12)} ${p(fmt(avgPnl),10)} ${p(pct(avgWR),8)} ${p(fmtD(avgDD),10)} ${p(pct(avgDDPct),7)} ${p(avgSharpe.toFixed(2),8)} ${p(avgSortino.toFixed(2),9)} ${p(avgPF.toFixed(2),6)} ${p(avgCalmar.toFixed(2),8)} ${p(avgConsLoss.toFixed(1),9)} ${p(fmt(avgWorst),10)} ${p(fmt(avgBest),10)} ${p(fmtD(avgStd),10)} ${p('—',7)} ${p('—',7)}`);
  }

  // Aggregate: each spread variant
  for (const mode of ['debit', 'credit'] as const) {
    for (const width of WIDTHS) {
      const n = allResults.length;
      const strats = allResults.map(r => r.strategies.find(s => s.mode === mode && s.width === width)!);
      
      const avgPnl = strats.reduce((s, st) => s + st.metrics.totalPnl, 0) / n;
      const avgWR = strats.reduce((s, st) => s + (st.metrics.winDays / (st.metrics.winDays + st.metrics.lossDays || 1)), 0) / n;
      const avgDD = strats.reduce((s, st) => s + st.metrics.maxDrawdown, 0) / n;
      const avgDDPct = strats.reduce((s, st) => s + st.metrics.maxDrawdownPct, 0) / n;
      const avgSharpe = strats.reduce((s, st) => s + st.metrics.sharpe, 0) / n;
      const avgSortino = strats.reduce((s, st) => s + st.metrics.sortino, 0) / n;
      const avgPF = strats.reduce((s, st) => s + Math.min(st.metrics.profitFactor, 100), 0) / n;
      const avgCalmar = strats.reduce((s, st) => s + st.metrics.calmarRatio, 0) / n;
      const avgConsLoss = strats.reduce((s, st) => s + st.metrics.maxConsecLoss, 0) / n;
      const avgWorst = strats.reduce((s, st) => s + st.metrics.worstDay, 0) / n;
      const avgBest = strats.reduce((s, st) => s + st.metrics.bestDay, 0) / n;
      const avgStd = strats.reduce((s, st) => s + st.metrics.dailyStdDev, 0) / n;

      // How many configs have better Sharpe vs baseline?
      let betterSharpe = 0, worseSharpe = 0;
      for (let i = 0; i < n; i++) {
        if (strats[i].metrics.sharpe > allResults[i].baseline.sharpe) betterSharpe++;
        else worseSharpe++;
      }

      const label = `${mode} $${width}`;
      console.log(`  ${p(label,12)} ${p(fmt(avgPnl),10)} ${p(pct(avgWR),8)} ${p(fmtD(avgDD),10)} ${p(pct(avgDDPct),7)} ${p(avgSharpe.toFixed(2),8)} ${p(avgSortino.toFixed(2),9)} ${p(avgPF.toFixed(2),6)} ${p(avgCalmar.toFixed(2),8)} ${p(avgConsLoss.toFixed(1),9)} ${p(fmt(avgWorst),10)} ${p(fmt(avgBest),10)} ${p(fmtD(avgStd),10)} ${p(betterSharpe,7)} ${p(worseSharpe,7)}`);
    }
  }

  console.log(`\n  Better/Worse = configs where spread Sharpe > baseline Sharpe`);

  // ════════════════════════════════════════════════════════════════════
  // SECTION 2: Drawdown comparison — top 10 configs
  // ════════════════════════════════════════════════════════════════════
  console.log(`\n${'='.repeat(160)}`);
  console.log(`  DRAWDOWN & RISK COMPARISON — TOP 10 CONFIGS BY BASELINE P&L`);
  console.log(`${'='.repeat(160)}\n`);

  const sorted = [...allResults].sort((a, b) => b.baseline.totalPnl - a.baseline.totalPnl).slice(0, 10);

  for (const result of sorted) {
    console.log(`  ${result.configId} (${result.baselineDays} days)`);
    console.log(`  ${p('Strategy',12)} ${p('Total P&L',12)} ${p('WinDays',8)} ${p('MaxDD',10)} ${p('DD%',8)} ${p('Sharpe',8)} ${p('Sortino',9)} ${p('PF',6)} ${p('Calmar',8)} ${p('CnsLoss',8)} ${p('CnsWin',7)} ${p('Worst',10)} ${p('Best',10)} ${p('AvgWin',10)} ${p('AvgLoss',10)}`);
    console.log(`  ${'-'.repeat(148)}`);

    // Baseline
    const b = result.baseline;
    const bWR = b.winDays + '/' + (b.winDays + b.lossDays);
    console.log(`  ${p('BUY',12)} ${p(fmt(b.totalPnl),12)} ${p(bWR,8)} ${p(fmtD(b.maxDrawdown),10)} ${p(pct(b.maxDrawdownPct),8)} ${p(b.sharpe.toFixed(2),8)} ${p(b.sortino.toFixed(2),9)} ${p(b.profitFactor.toFixed(2),6)} ${p(b.calmarRatio.toFixed(2),8)} ${p(b.maxConsecLoss,8)} ${p(b.maxConsecWin,7)} ${p(fmt(b.worstDay),10)} ${p(fmt(b.bestDay),10)} ${p(fmt(b.avgWinDay),10)} ${p(fmt(b.avgLossDay),10)}`);

    for (const st of result.strategies) {
      const m = st.metrics;
      const wr = m.winDays + '/' + (m.winDays + m.lossDays);
      const label = `${st.mode} $${st.width}`;
      const sharpeVs = m.sharpe > b.sharpe ? '↑' : m.sharpe < b.sharpe ? '↓' : '=';
      const ddVs = m.maxDrawdown < b.maxDrawdown ? '↑' : m.maxDrawdown > b.maxDrawdown ? '↓' : '=';
      console.log(`  ${p(label,12)} ${p(fmt(m.totalPnl),12)} ${p(wr,8)} ${p(fmtD(m.maxDrawdown)+ddVs,10)} ${p(pct(m.maxDrawdownPct),8)} ${p(m.sharpe.toFixed(2)+sharpeVs,8)} ${p(m.sortino.toFixed(2),9)} ${p(m.profitFactor.toFixed(2),6)} ${p(m.calmarRatio.toFixed(2),8)} ${p(m.maxConsecLoss,8)} ${p(m.maxConsecWin,7)} ${p(fmt(m.worstDay),10)} ${p(fmt(m.bestDay),10)} ${p(fmt(m.avgWinDay),10)} ${p(fmt(m.avgLossDay),10)}`);
    }
    console.log('');
  }

  // ════════════════════════════════════════════════════════════════════
  // SECTION 3: Find configs where spreads have BETTER risk-adjusted returns
  // ════════════════════════════════════════════════════════════════════
  console.log(`${'='.repeat(160)}`);
  console.log(`  CONFIGS WHERE ANY SPREAD HAS BETTER SHARPE THAN BASELINE`);
  console.log(`${'='.repeat(160)}\n`);

  let foundBetter = false;
  for (const result of allResults) {
    const bestSpreadSharpe = Math.max(...result.strategies.map(s => s.metrics.sharpe));
    if (bestSpreadSharpe > result.baseline.sharpe) {
      foundBetter = true;
      const bestStrat = result.strategies.find(s => s.metrics.sharpe === bestSpreadSharpe)!;
      console.log(`  ${result.configId}`);
      console.log(`    Baseline: Sharpe ${result.baseline.sharpe.toFixed(2)}, DD ${fmtD(result.baseline.maxDrawdown)}, P&L ${fmt(result.baseline.totalPnl)}`);
      console.log(`    Best:     ${bestStrat.mode} $${bestStrat.width} — Sharpe ${bestStrat.metrics.sharpe.toFixed(2)}, DD ${fmtD(bestStrat.metrics.maxDrawdown)}, P&L ${fmt(bestStrat.metrics.totalPnl)}`);
      console.log('');
    }
  }

  if (!foundBetter) {
    console.log(`  None. Straight buys have better Sharpe across all ${configs.length} configs.\n`);
  }

  // ════════════════════════════════════════════════════════════════════
  // SECTION 4: Capital efficiency — P&L per dollar risked
  // ════════════════════════════════════════════════════════════════════
  console.log(`${'='.repeat(160)}`);
  console.log(`  CAPITAL EFFICIENCY — RETURN ON MAX RISK`);
  console.log(`${'='.repeat(160)}\n`);
  console.log(`  Spreads cap max loss per trade. "Return on max risk" = total P&L / sum(max possible loss per trade).`);
  console.log(`  For buys, max risk = entry price × qty × 100. For spreads, max risk = width × qty × 100 (debit) or (width - credit) × qty × 100.\n`);

  // Compute for top 5 configs
  const top5 = sorted.slice(0, 5);
  for (const result of top5) {
    const dateTrades = configDateTrades.get(result.configId)!;
    const allTrades: TradeJson[] = [];
    for (const [, trades] of dateTrades) allTrades.push(...trades);

    console.log(`  ${result.configId} (${allTrades.length} trades)`);
    console.log(`  ${p('Strategy',12)} ${p('Total Risk',14)} ${p('Total P&L',12)} ${p('Return/Risk',12)} ${p('Avg Risk/Trade',15)}`);
    console.log(`  ${'-'.repeat(67)}`);

    // Baseline: risk = sum of entry price × qty × 100
    const baselineRisk = allTrades.reduce((s, t) => s + (t.entryPrice + HALF_SPREAD) * t.qty * 100 + COMMISSION_PER_LEG * t.qty * 2, 0);
    console.log(`  ${p('BUY',12)} ${p(fmtD(baselineRisk),14)} ${p(fmt(result.baseline.totalPnl),12)} ${p(pct(result.baseline.totalPnl / baselineRisk),12)} ${p('$' + (baselineRisk / allTrades.length).toFixed(0),15)}`);

    for (const mode of ['debit', 'credit'] as const) {
      for (const width of WIDTHS) {
        let totalRisk = 0;
        let validCount = 0;

        for (const trade of allTrades) {
          const tradeKey = `${trade.symbol}|${trade.entryTs}|${trade.exitTs}`;
          const cached = spreadCache.get(tradeKey);
          if (!cached) continue;
          const widthData = cached.get(String(width));
          if (!widthData || !widthData.valid) continue;
          validCount++;

          if (mode === 'debit') {
            const entryDebit = (trade.entryPrice + HALF_SPREAD) - (widthData.otherEntry - HALF_SPREAD);
            totalRisk += Math.max(0, entryDebit) * trade.qty * 100 + COMMISSION_PER_LEG * trade.qty * 4;
          } else {
            const entryCredit = (trade.entryPrice - HALF_SPREAD) - (widthData.otherEntry + HALF_SPREAD);
            totalRisk += (width - Math.max(0, entryCredit)) * trade.qty * 100 + COMMISSION_PER_LEG * trade.qty * 4;
          }
        }

        const strat = result.strategies.find(s => s.mode === mode && s.width === width)!;
        const returnOnRisk = totalRisk > 0 ? strat.metrics.totalPnl / totalRisk : 0;
        const avgRisk = validCount > 0 ? totalRisk / validCount : 0;
        const label = `${mode} $${width}`;

        console.log(`  ${p(label,12)} ${p(fmtD(totalRisk),14)} ${p(fmt(strat.metrics.totalPnl),12)} ${p(pct(returnOnRisk),12)} ${p('$' + avgRisk.toFixed(0),15)}`);
      }
    }
    console.log('');
  }

  console.log(`\n  Total analysis time: ${totalTime}s\n`);
}

main().catch(console.error);
