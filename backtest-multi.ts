/**
 * backtest-multi.ts — Multi-day backtester using regime classifier + deterministic OTM strike selector.
 *
 * NO AI calls. Purely deterministic. Runs in seconds.
 *
 * For each trading day:
 *   1. Loads SPX 1m bars from DB
 *   2. Computes RSI from raw closes (no dependency on stored indicators)
 *   3. Runs regime classifier every bar
 *   4. Applies signal gate (blocks counter-trend trades)
 *   5. On valid signal: deterministic OTM strike selector picks contract
 *   6. Simulates position management (stop/TP/time-exit)
 *   7. Generates replay log for replay-library/
 *
 * Usage:
 *   npx tsx backtest-multi.ts                        # all available days
 *   npx tsx backtest-multi.ts 2026-03-19             # single day
 *   npx tsx backtest-multi.ts 2026-02-18 2026-03-19  # date range
 */
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');
const REPLAY_DIR = path.resolve(__dirname, 'replay-library');

// ── Parameters (tunable) ────────────────────────────────────────────────────

const PARAMS = {
  // Regime classifier
  trendThreshold: 0.15,          // pts/bar for trend detection

  // RSI thresholds
  rsiOversoldTrigger: 25,        // escalate when RSI < this (relaxed from 20)
  rsiOverboughtTrigger: 75,      // escalate when RSI > this (relaxed from 80)
  rsiEmergencyOversold: 15,      // override regime gate
  rsiEmergencyOverbought: 85,    // override regime gate
  rsiMorningEmergencyOversold: 12,  // relaxed from 10 (RSI 10.3 was missing on Mar 2)
  rsiMorningEmergencyOverbought: 90,  // relaxed from 92

  // Strike selection
  priceMin: 0.20,
  priceMax: 8.00,
  idealPrice: 1.50,
  emergencyIdealPrice: 1.00,

  // Position management
  stopPct: 0.70,                 // 70% of premium (widened from 50% — 0DTE options need room)
  tpMultiplier: 5,               // 5x entry (lowered from 10x — take profits sooner)
  maxRiskPerTrade: 300,

  // Cooldown
  cooldownBars: 10,              // 10 bars (10 min) between signals

  // Time gates
  morningEndMinute: 10 * 60 + 15,   // 10:15 ET
  gammaStartMinute: 14 * 60,        // 14:00 ET
  noTradeMinute: 15 * 60 + 30,      // 15:30 ET
  closeMinute: 15 * 60 + 45,        // 15:45 ET — force exit
};

// ── DB helpers ──────────────────────────────────────────────────────────────

interface SpxBar { ts: number; open: number; high: number; low: number; close: number; volume: number; }
interface ContractBar { symbol: string; type: string; strike: number; close: number; volume: number; high: number; low: number; }

function getDb() { return new Database(DB_PATH, { readonly: true }); }

function getAvailableDays(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT substr(symbol, 5, 6) as expiry
    FROM contracts WHERE symbol LIKE 'SPXW%' AND type='call'
    ORDER BY expiry
  `).all() as any[];
  return rows.map(r => {
    const e = r.expiry;
    return `20${e.slice(0,2)}-${e.slice(2,4)}-${e.slice(4,6)}`;
  });
}

function getSpxBarsForDay(db: Database.Database, date: string): SpxBar[] {
  // Convert date to timestamp range (09:30-16:00 ET)
  const startTs = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
  const endTs = startTs + 390 * 60;

  const rows = db.prepare(`
    SELECT ts, open, high, low, close, volume
    FROM bars WHERE symbol='SPX' AND timeframe='1m'
      AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(startTs, endTs) as any[];

  return rows;
}

function getContractsAtTime(db: Database.Database, expiry6: string, ts: number, spxPrice: number): ContractBar[] {
  return db.prepare(`
    SELECT b.symbol, c.type, c.strike, b.close, b.volume, b.high, b.low
    FROM bars b JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE ? AND b.timeframe = '1m'
      AND b.ts = (SELECT MAX(b2.ts) FROM bars b2 WHERE b2.symbol=b.symbol AND b2.timeframe='1m' AND b2.ts<=?)
      AND c.strike BETWEEN ? AND ?
    ORDER BY c.type, c.strike
  `).all(`SPXW${expiry6}%`, ts, spxPrice - 200, spxPrice + 200) as any[];
}

// ── RSI computation (from raw closes, no stored indicators) ─────────────────

function computeRSI(closes: number[], period: number = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// ── Linear regression slope ─────────────────────────────────────────────────

function linRegSlope(values: number[], period: number): number {
  const n = Math.min(values.length, period);
  if (n < 5) return 0;
  const slice = values.slice(-n);
  let sx = 0, sy = 0, sxy = 0, sx2 = 0;
  for (let i = 0; i < n; i++) {
    sx += i; sy += slice[i]; sxy += i * slice[i]; sx2 += i * i;
  }
  return (n * sxy - sx * sy) / (n * sx2 - sx * sx);
}

// ── ET time helpers ─────────────────────────────────────────────────────────

function getETMinute(ts: number): number {
  const d = new Date(ts * 1000);
  const et = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const tp = et.split(', ')[1] || et;
  const [h, m] = tp.split(':').map(Number);
  return h * 60 + m;
}

function etLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Regime classification ───────────────────────────────────────────────────

type Regime = 'MORNING_MOMENTUM' | 'MEAN_REVERSION' | 'TRENDING_UP' | 'TRENDING_DOWN' | 'GAMMA_EXPIRY' | 'NO_TRADE';

function classifyRegime(minute: number, slope: number): Regime {
  const T = PARAMS.trendThreshold;
  if (minute >= PARAMS.noTradeMinute) return 'NO_TRADE';
  if (minute >= PARAMS.gammaStartMinute) {
    if (slope > T) return 'TRENDING_UP';
    if (slope < -T) return 'TRENDING_DOWN';
    return 'GAMMA_EXPIRY';
  }
  if (minute < PARAMS.morningEndMinute) {
    if (slope > T) return 'TRENDING_UP';
    if (slope < -T) return 'TRENDING_DOWN';
    return 'MORNING_MOMENTUM';
  }
  if (slope > T) return 'TRENDING_UP';
  if (slope < -T) return 'TRENDING_DOWN';
  return 'MEAN_REVERSION';
}

// ── Signal gate ─────────────────────────────────────────────────────────────

function isSignalAllowed(regime: Regime, rsi: number, direction: 'call' | 'put', minute: number): boolean {
  // Emergency override
  const isMorning = minute < PARAMS.morningEndMinute;
  const emergOversold = isMorning ? PARAMS.rsiMorningEmergencyOversold : PARAMS.rsiEmergencyOversold;
  const emergOverbought = isMorning ? PARAMS.rsiMorningEmergencyOverbought : PARAMS.rsiEmergencyOverbought;

  if (rsi < emergOversold && direction === 'call') return true;
  if (rsi > emergOverbought && direction === 'put') return true;

  if (regime === 'NO_TRADE') return false;

  switch (regime) {
    case 'MORNING_MOMENTUM': return false; // no trades until range established
    case 'MEAN_REVERSION': return true;     // both directions OK
    case 'TRENDING_UP':
      return direction === 'call';           // only buy dips in uptrend
    case 'TRENDING_DOWN':
      return direction === 'put';            // only sell rips in downtrend
    case 'GAMMA_EXPIRY':
      return true;                           // allow trades in gamma zone (was: emergency-only)
  }
}

// ── Strike selection (deterministic) ────────────────────────────────────────

interface SelectedStrike {
  symbol: string; strike: number; side: string; price: number;
  qty: number; stopLoss: number; takeProfit: number; reason: string;
}

function selectStrike(contracts: ContractBar[], direction: 'call' | 'put', spxPrice: number, rsi: number): SelectedStrike | null {
  const isEmergency = rsi < PARAMS.rsiEmergencyOversold || rsi > PARAMS.rsiEmergencyOverbought;

  const candidates = contracts
    .filter(c => c.type === direction)
    .filter(c => c.close >= PARAMS.priceMin && c.close <= PARAMS.priceMax)
    .filter(c => direction === 'call' ? c.strike > spxPrice : c.strike < spxPrice);

  if (candidates.length === 0) return null;

  const targetPrice = isEmergency ? PARAMS.emergencyIdealPrice : PARAMS.idealPrice;

  const scored = candidates.map(c => {
    const priceScore = 1 - Math.abs(c.close - targetPrice) / PARAMS.priceMax;
    const otmDist = Math.abs(c.strike - spxPrice);
    const distScore = isEmergency ? Math.min(1, otmDist / 30) : Math.min(1, otmDist / 25);
    return { ...c, score: priceScore * 0.5 + distScore * 0.4 };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  const stopLoss = best.close * (1 - PARAMS.stopPct);
  const takeProfit = best.close * PARAMS.tpMultiplier;
  const riskPerContract = best.close * 100 * PARAMS.stopPct;
  const qty = Math.max(1, Math.min(3, Math.floor(PARAMS.maxRiskPerTrade / riskPerContract)));
  const otmPts = Math.abs(best.strike - spxPrice).toFixed(0);

  return {
    symbol: best.symbol, strike: best.strike, side: best.type, price: best.close,
    qty, stopLoss, takeProfit,
    reason: `${best.type.toUpperCase()} ${best.strike} @ $${best.close.toFixed(2)} (${otmPts}pts OTM, ${qty}x)`,
  };
}

// ── Position tracking ───────────────────────────────────────────────────────

interface Position {
  symbol: string; strike: number; side: string; qty: number;
  entryPrice: number; stopLoss: number; takeProfit: number;
  entryTs: number; entryET: string;
}

interface Trade {
  symbol: string; strike: number; side: string; qty: number;
  entryPrice: number; exitPrice: number;
  entryTs: number; entryET: string; exitTs: number; exitET: string;
  reason: 'stop_loss' | 'take_profit' | 'time_exit';
  pnlPct: number; pnlDollar: number;
  regime: Regime; rsiAtEntry: number;
}

// ── Single day backtest ─────────────────────────────────────────────────────

interface DayResult {
  date: string;
  trades: Trade[];
  signals: Array<{ ts: number; et: string; rsi: number; regime: Regime; direction: string; allowed: boolean; strike?: string; reason?: string; isEmergency?: boolean; spxPrice?: number; contractsAvail?: number; gateReason?: string }>;
  totalPnl: number;
  winRate: number;
  emergenciesCaught: number;
  emergenciesTotal: number;
}

function backtestDay(db: Database.Database, date: string): DayResult | null {
  const expiry6 = date.slice(2).replace(/-/g, '');
  const bars = getSpxBarsForDay(db, date);

  if (bars.length < 30) return null; // not enough data

  const closes: number[] = [];
  const trades: Trade[] = [];
  const signals: DayResult['signals'] = [];
  let position: Position | null = null;
  let lastSignalBar = -999;
  let emergenciesTotal = 0;
  let emergenciesCaught = 0;
  let sessionHigh = 0, sessionLow = Infinity;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    closes.push(bar.close);
    if (bar.high > sessionHigh) sessionHigh = bar.high;
    if (bar.low < sessionLow) sessionLow = bar.low;

    const minute = getETMinute(bar.ts);
    const rsi = computeRSI(closes);
    const slope = linRegSlope(closes, 20);
    const regime = classifyRegime(minute, slope);
    const timeLabel = etLabel(bar.ts);

    // ── Check open position ───────────────────────────────────────────────
    if (position) {
      // Get current option price
      const contracts = getContractsAtTime(db, expiry6, bar.ts, bar.close);
      const contractMap = new Map(contracts.map(c => [`${c.type}_${c.strike}`, c]));
      const curContract = contractMap.get(`${position.side}_${position.strike}`);
      const curPrice = curContract?.close ?? position.entryPrice;

      let closeReason: Trade['reason'] | null = null;
      if (curPrice <= position.stopLoss) closeReason = 'stop_loss';
      else if (curPrice >= position.takeProfit) closeReason = 'take_profit';
      else if (minute >= PARAMS.closeMinute) closeReason = 'time_exit';

      if (closeReason) {
        const pnlPct = (curPrice - position.entryPrice) / position.entryPrice;
        const pnlDollar = (curPrice - position.entryPrice) * position.qty * 100;
        trades.push({
          ...position, exitPrice: curPrice, exitTs: bar.ts, exitET: timeLabel,
          reason: closeReason, pnlPct, pnlDollar,
          regime, rsiAtEntry: rsi ?? 50,
        });
        position = null;
      }
      continue; // don't open new position while one is open
    }

    // ── Check for signals ─────────────────────────────────────────────────
    if (rsi === null) continue;
    if (i - lastSignalBar < PARAMS.cooldownBars) continue;

    const isOversold = rsi < PARAMS.rsiOversoldTrigger;
    const isOverbought = rsi > PARAMS.rsiOverboughtTrigger;
    const isEmergencyOversold = rsi < PARAMS.rsiEmergencyOversold;
    const isEmergencyOverbought = rsi > PARAMS.rsiEmergencyOverbought;

    if (!isOversold && !isOverbought) continue;

    if (isEmergencyOversold || isEmergencyOverbought) emergenciesTotal++;

    const direction: 'call' | 'put' = isOversold ? 'call' : 'put';
    const allowed = isSignalAllowed(regime, rsi, direction, minute);

    const isEmergency = isEmergencyOversold || isEmergencyOverbought;
    const signalEntry: DayResult['signals'][0] = {
      ts: bar.ts, et: timeLabel, rsi, regime, direction, allowed,
      isEmergency, spxPrice: bar.close,
    };

    if (!allowed) {
      // Build gate reasoning
      const isMorning = minute < PARAMS.morningEndMinute;
      const emergThresh = isMorning
        ? (direction === 'call' ? PARAMS.rsiMorningEmergencyOversold : PARAMS.rsiMorningEmergencyOverbought)
        : (direction === 'call' ? PARAMS.rsiEmergencyOversold : PARAMS.rsiEmergencyOverbought);
      signalEntry.gateReason = `${regime} blocks ${direction}; RSI ${rsi.toFixed(1)} didn't reach emergency (${direction === 'call' ? '<' : '>'}${emergThresh})`;
      signalEntry.reason = `BLOCKED by ${regime}`;
      signals.push(signalEntry);
      lastSignalBar = i;
      continue;
    }

    // ── Select strike and enter ─────────────────────────────────────────
    const contracts = getContractsAtTime(db, expiry6, bar.ts, bar.close);
    signalEntry.contractsAvail = contracts.filter(c => c.type === direction).length;
    const selected = selectStrike(contracts, direction, bar.close, rsi);

    if (!selected) {
      signalEntry.reason = `No OTM ${direction} in $${PARAMS.priceMin}-$${PARAMS.priceMax} band`;
      signalEntry.gateReason = `Signal allowed but no matching contract found (${signalEntry.contractsAvail} ${direction}s in range, none OTM $${PARAMS.priceMin}-$${PARAMS.priceMax})`;
      signals.push(signalEntry);
      lastSignalBar = i;
      continue;
    }

    if (isEmergency) emergenciesCaught++;

    signalEntry.allowed = true;
    signalEntry.strike = selected.reason;
    signalEntry.gateReason = `${isEmergency ? 'EMERGENCY override' : regime + ' allows ' + direction}; strike ${selected.strike} scored best (${selected.qty}x @ $${selected.price.toFixed(2)}, SL $${selected.stopLoss.toFixed(2)}, TP $${selected.takeProfit.toFixed(2)})`;
    signals.push(signalEntry);

    position = {
      symbol: selected.symbol, strike: selected.strike, side: selected.side,
      qty: selected.qty, entryPrice: selected.price,
      stopLoss: selected.stopLoss, takeProfit: selected.takeProfit,
      entryTs: bar.ts, entryET: timeLabel,
    };

    lastSignalBar = i;
  }

  // Force close any open position at end
  if (position) {
    const lastBar = bars[bars.length - 1];
    const contracts = getContractsAtTime(db, expiry6, lastBar.ts, lastBar.close);
    const contractMap = new Map(contracts.map(c => [`${c.type}_${c.strike}`, c]));
    const curContract = contractMap.get(`${position.side}_${position.strike}`);
    const curPrice = curContract?.close ?? 0;
    const pnlPct = position.entryPrice > 0 ? (curPrice - position.entryPrice) / position.entryPrice : 0;
    const pnlDollar = (curPrice - position.entryPrice) * position.qty * 100;
    trades.push({
      ...position, exitPrice: curPrice, exitTs: lastBar.ts, exitET: etLabel(lastBar.ts),
      reason: 'time_exit', pnlPct, pnlDollar,
      regime: 'NO_TRADE', rsiAtEntry: 50,
    });
  }

  const winners = trades.filter(t => t.pnlDollar > 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlDollar, 0);

  return {
    date,
    trades,
    signals,
    totalPnl,
    winRate: trades.length > 0 ? winners / trades.length : 0,
    emergenciesCaught,
    emergenciesTotal,
  };
}

// ── Generate replay markdown ────────────────────────────────────────────────

function generateReplayMd(result: DayResult): string {
  const { date, trades, signals, totalPnl, winRate } = result;
  const winners = trades.filter(t => t.pnlDollar > 0);
  const losers = trades.filter(t => t.pnlDollar <= 0);

  let md = `# SPX 0DTE Replay — ${date}\n\n`;
  md += `## Summary\n`;
  md += `| Metric | Value |\n|--------|-------|\n`;
  md += `| Trades | ${trades.length} |\n`;
  md += `| Winners | ${winners.length} |\n`;
  md += `| Losers | ${losers.length} |\n`;
  md += `| Win Rate | ${(winRate * 100).toFixed(0)}% |\n`;
  md += `| Total P&L | $${totalPnl.toFixed(0)} |\n`;
  md += `| Emergency Signals | ${result.emergenciesCaught}/${result.emergenciesTotal} caught |\n\n`;

  md += `## Signals\n\n`;
  md += `| Time | RSI | Regime | Direction | Emerg | Allowed | Strike/Reason |\n`;
  md += `|------|-----|--------|-----------|-------|---------|---------------|\n`;
  for (const s of signals) {
    const mark = s.allowed ? '✅' : '🚫';
    const emerg = s.isEmergency ? '🚨' : '';
    md += `| ${s.et} | ${s.rsi.toFixed(1)} | ${s.regime} | ${s.direction} | ${emerg} | ${mark} | ${s.strike || s.reason || ''} |\n`;
  }

  // Escalation details
  const escalations = signals.filter(s => s.gateReason);
  if (escalations.length > 0) {
    md += `\n### Escalation Details\n\n`;
    for (const s of escalations) {
      const label = s.isEmergency ? '🚨 EMERGENCY' : s.allowed ? '✅ ALLOWED' : '🚫 BLOCKED';
      md += `**${s.et}** — ${label} (SPX ${s.spxPrice?.toFixed(0) || '?'}, RSI ${s.rsi.toFixed(1)})\n`;
      md += `> ${s.gateReason}\n\n`;
    }
  }

  md += `\n## Trades\n\n`;
  if (trades.length === 0) {
    md += `No trades taken.\n`;
  } else {
    md += `| Entry | Exit | Contract | Entry$ | Exit$ | P&L% | P&L$ | Reason |\n`;
    md += `|-------|------|----------|--------|-------|------|------|--------|\n`;
    for (const t of trades) {
      const mark = t.pnlDollar > 0 ? '✅' : '❌';
      md += `| ${t.entryET} | ${t.exitET} | ${t.side.toUpperCase()} ${t.strike} | $${t.entryPrice.toFixed(2)} | $${t.exitPrice.toFixed(2)} | ${(t.pnlPct * 100).toFixed(0)}% | ${mark} $${t.pnlDollar.toFixed(0)} | ${t.reason} |\n`;
    }
  }

  md += `\n## DB Queries\n\n`;
  md += '```sql\n';
  md += `-- SPX bars for ${date}\n`;
  md += `SELECT datetime(ts, 'unixepoch', '-4 hours') as et, close,\n`;
  md += `  json_extract(indicators, '$.rsi14') as rsi\n`;
  md += `FROM bars WHERE symbol='SPX' AND timeframe='1m'\n`;
  const expiry6 = date.slice(2).replace(/-/g, '');
  md += `  AND ts >= strftime('%s', '${date} 13:30:00') AND ts <= strftime('%s', '${date} 20:00:00')\nORDER BY ts;\n\n`;
  md += `-- Option contracts for ${date}\n`;
  md += `SELECT b.symbol, c.type, c.strike, b.close, b.volume\n`;
  md += `FROM bars b JOIN contracts c ON b.symbol=c.symbol\n`;
  md += `WHERE b.symbol LIKE 'SPXW${expiry6}%' AND b.timeframe='1m'\nORDER BY b.ts, c.strike;\n`;
  md += '```\n';

  return md;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = getDb();
  const args = process.argv.slice(2);

  let dates: string[];
  if (args.length === 2) {
    const allDays = getAvailableDays(db);
    dates = allDays.filter(d => d >= args[0] && d <= args[1]);
  } else if (args.length === 1) {
    dates = [args[0]];
  } else {
    dates = getAvailableDays(db);
  }

  // Filter to days that have SPX data
  dates = dates.filter(d => getSpxBarsForDay(db, d).length > 30);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  MULTI-DAY BACKTEST — ${dates.length} days`);
  console.log(`  ${dates[0] || 'none'} → ${dates[dates.length - 1] || 'none'}`);
  console.log(`  Parameters: trend=${PARAMS.trendThreshold} stop=${PARAMS.stopPct} tp=${PARAMS.tpMultiplier}x`);
  console.log(`${'═'.repeat(70)}\n`);

  const results: DayResult[] = [];

  for (const date of dates) {
    const result = backtestDay(db, date);
    if (!result) {
      console.log(`  ${date}: SKIPPED (insufficient data)`);
      continue;
    }
    results.push(result);

    const mark = result.totalPnl >= 0 ? '✅' : '❌';
    const trades = result.trades.length;
    const wins = result.trades.filter(t => t.pnlDollar > 0).length;
    console.log(`  ${mark} ${date}: ${trades} trades (${wins}W/${trades - wins}L) | P&L: $${result.totalPnl.toFixed(0)} | WR: ${(result.winRate * 100).toFixed(0)}% | Emerg: ${result.emergenciesCaught}/${result.emergenciesTotal}`);

    // Save replay markdown
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
    const md = generateReplayMd(result);
    fs.writeFileSync(path.join(REPLAY_DIR, `${date}-replay.md`), md);
  }

  // ── Overall scorecard ───────────────────────────────────────────────────

  const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
  const totalWins = results.reduce((s, r) => s + r.trades.filter(t => t.pnlDollar > 0).length, 0);
  const totalPnl = results.reduce((s, r) => s + r.totalPnl, 0);
  const avgPnlPerDay = results.length > 0 ? totalPnl / results.length : 0;
  const maxDayLoss = Math.min(0, ...results.map(r => r.totalPnl));
  const maxDayWin = Math.max(0, ...results.map(r => r.totalPnl));
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
  const profitableDays = results.filter(r => r.totalPnl >= 0).length;
  const totalEmergencies = results.reduce((s, r) => s + r.emergenciesTotal, 0);
  const caughtEmergencies = results.reduce((s, r) => s + r.emergenciesCaught, 0);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SCORECARD`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Days tested        : ${results.length}`);
  console.log(`  Profitable days    : ${profitableDays}/${results.length} (${results.length > 0 ? (profitableDays / results.length * 100).toFixed(0) : 0}%)`);
  console.log(`  Total trades       : ${totalTrades}`);
  console.log(`  Win rate           : ${(winRate * 100).toFixed(1)}%`);
  console.log(`  Total P&L          : $${totalPnl.toFixed(0)}`);
  console.log(`  Avg P&L/day        : $${avgPnlPerDay.toFixed(0)}`);
  console.log(`  Max day win        : $${maxDayWin.toFixed(0)}`);
  console.log(`  Max day loss       : $${maxDayLoss.toFixed(0)}`);
  console.log(`  Emergency signals  : ${caughtEmergencies}/${totalEmergencies} caught`);
  console.log(`${'═'.repeat(70)}`);

  // ── Target check ────────────────────────────────────────────────────────

  const targets = {
    winRate: winRate > 0.40,
    avgPnlPositive: avgPnlPerDay > 0,
    maxDayLossOk: maxDayLoss > -500,
    emergenciesCaught: totalEmergencies === 0 || caughtEmergencies / totalEmergencies > 0.80,
  };

  console.log(`\n  TARGETS:`);
  console.log(`  ${targets.winRate ? '✅' : '❌'} Win rate > 40%: ${(winRate * 100).toFixed(1)}%`);
  console.log(`  ${targets.avgPnlPositive ? '✅' : '❌'} Avg P&L positive: $${avgPnlPerDay.toFixed(0)}`);
  console.log(`  ${targets.maxDayLossOk ? '✅' : '❌'} No day > -$500: worst=$${maxDayLoss.toFixed(0)}`);
  console.log(`  ${targets.emergenciesCaught ? '✅' : '❌'} Emergencies caught: ${caughtEmergencies}/${totalEmergencies}`);

  const allPass = Object.values(targets).every(Boolean);
  console.log(`\n  ${allPass ? '🎯 ALL TARGETS MET — READY FOR LIVE' : '⚠️ TARGETS NOT MET — NEEDS ITERATION'}\n`);

  // Save scorecard
  const scorecard = `# Backtest Scorecard\n\n` +
    `**Date range**: ${dates[0]} → ${dates[dates.length - 1]}\n` +
    `**Days tested**: ${results.length}\n\n` +
    `| Metric | Value | Target | Pass |\n|--------|-------|--------|------|\n` +
    `| Win rate | ${(winRate * 100).toFixed(1)}% | >40% | ${targets.winRate ? '✅' : '❌'} |\n` +
    `| Avg P&L/day | $${avgPnlPerDay.toFixed(0)} | >$0 | ${targets.avgPnlPositive ? '✅' : '❌'} |\n` +
    `| Max day loss | $${maxDayLoss.toFixed(0)} | >-$500 | ${targets.maxDayLossOk ? '✅' : '❌'} |\n` +
    `| Emergencies caught | ${caughtEmergencies}/${totalEmergencies} | >80% | ${targets.emergenciesCaught ? '✅' : '❌'} |\n\n` +
    `## Parameters\n\`\`\`json\n${JSON.stringify(PARAMS, null, 2)}\n\`\`\`\n\n` +
    `## Per-Day Results\n\n| Date | Trades | W/L | P&L | WR | Emerg |\n|------|--------|-----|-----|----|-------|\n` +
    results.map(r => {
      const w = r.trades.filter(t => t.pnlDollar > 0).length;
      const l = r.trades.length - w;
      return `| ${r.date} | ${r.trades.length} | ${w}/${l} | $${r.totalPnl.toFixed(0)} | ${(r.winRate * 100).toFixed(0)}% | ${r.emergenciesCaught}/${r.emergenciesTotal} |`;
    }).join('\n') + '\n';

  fs.writeFileSync(path.join(REPLAY_DIR, 'SCORECARD.md'), scorecard);
  console.log(`  Scorecard saved to replay-library/SCORECARD.md`);

  db.close();
}

main().catch(console.error);
