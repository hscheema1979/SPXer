/**
 * replay-machine.ts — Execution engine for replay with configurable parameters
 * Takes a config + date and runs the backtest, storing results
 */

import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { ReplayConfig } from '../../src/replay';
import { createStore, ReplayResult } from '../../src/replay';
import { getJudgeConfigs, askModel } from '../../src/agent/model-clients';
import { initSession as initRegimeSession, classify, getSignalGate, formatRegimeContext } from '../../src/agent/regime-classifier';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');

interface Trade {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryTs: number;
  entryET: string;
  entryPrice: number;
  exitTs: number;
  exitET: string;
  exitPrice: number;
  reason: 'stop_loss' | 'take_profit' | 'time_exit';
  pnlPct: number;
  pnl$: number;
  signalType: string;
}

interface Bar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators: Record<string, number | null>;
}

function etLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function getDb() {
  return new Database(DB_PATH, { readonly: true });
}

/**
 * Run a replay with a specific configuration
 */
export async function runReplay(config: ReplayConfig, targetDate: string): Promise<ReplayResult> {
  const store = createStore();
  const runId = store.createRun(config.id, targetDate);

  try {
    const db = getDb();

    // Parse date and build timestamps
    const dateObj = new Date(`${targetDate}T09:30:00-04:00`);
    const SESSION_START = Math.floor(dateObj.getTime() / 1000);
    const SESSION_END = SESSION_START + 390 * 60;
    const CLOSE_CUTOFF = SESSION_END - 15 * 60;

    const SYMBOL_FILTER = '%' + targetDate.slice(2, 4) + targetDate.slice(5, 7) + targetDate.slice(8, 10) + '%';

    // Get SPX bars
    const spxBarsRows = db
      .prepare(
        `SELECT ts, open, high, low, close, volume, indicators
        FROM bars WHERE symbol='SPX' AND timeframe='1m'
        AND ts >= ? AND ts <= ? ORDER BY ts`
      )
      .all(SESSION_START, SESSION_END) as any[];

    if (spxBarsRows.length === 0) {
      throw new Error(`No bars found for ${targetDate}`);
    }

    const timestamps = spxBarsRows.map(r => r.ts);

    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  Replay: ${config.name} on ${targetDate}`);
    console.log(`  Config ID: ${config.id}`);
    console.log(`  Bars: ${timestamps.length}`);
    console.log('═'.repeat(72));

    initRegimeSession(6606.49);

    const trades: Trade[] = [];
    const openPositions = new Map();
    let lastEscalationTs = 0;

    // Main replay loop
    for (const ts of timestamps) {
      // Get current SPX bar
      const spxRow = spxBarsRows.find(r => r.ts === ts);
      if (!spxRow) continue;
      const spx: Bar = {
        ...spxRow,
        indicators: JSON.parse(spxRow.indicators || '{}'),
      };

      // Position monitoring (check stops/TP)
      for (const [posId, openPos] of openPositions.entries()) {
        const posRow = db
          .prepare(
            `SELECT b.close FROM bars b JOIN contracts c ON b.symbol = c.symbol
          WHERE c.type = ? AND c.strike = ? AND b.symbol LIKE ?
          AND b.timeframe = '1m' AND b.ts <= ? ORDER BY b.ts DESC LIMIT 1`
          )
          .get(openPos.side, openPos.strike, SYMBOL_FILTER, ts) as any;

        if (posRow) {
          const curPrice = posRow.close;
          let closeReason: Trade['reason'] | null = null;

          if (curPrice <= openPos.stopLoss) {
            closeReason = 'stop_loss';
          } else if (curPrice >= openPos.takeProfit) {
            closeReason = 'take_profit';
          } else if (ts >= CLOSE_CUTOFF) {
            closeReason = 'time_exit';
          }

          if (closeReason) {
            const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
            const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
            trades.push({
              symbol: openPos.symbol,
              side: openPos.side,
              strike: openPos.strike,
              qty: openPos.qty,
              entryTs: openPos.entryTs,
              entryET: openPos.entryET,
              entryPrice: openPos.entryPrice,
              exitTs: ts,
              exitET: etLabel(ts),
              exitPrice: curPrice,
              reason: closeReason,
              pnlPct,
              pnl$,
              signalType: '',
            });
            openPositions.delete(posId);
          }
        }
      }

      // Detect signals (simplified for now)
      const regimeState = classify({ close: spx.close, high: spx.high, low: spx.low, ts });

      // Check for escalation
      if (ts >= CLOSE_CUTOFF) continue;
      if (ts - lastEscalationTs < config.judge.escalationCooldownSec * 1000) continue;

      // (Signal detection would happen here with config-driven thresholds)
      // For now, we're demonstrating the structure
    }

    // Close all remaining positions at EOD
    const finalTs = timestamps[timestamps.length - 1];
    for (const [, openPos] of openPositions.entries()) {
      const curPrice = openPos.entryPrice; // Fallback to entry
      const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
      const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
      trades.push({
        symbol: openPos.symbol,
        side: openPos.side,
        strike: openPos.strike,
        qty: openPos.qty,
        entryTs: openPos.entryTs,
        entryET: openPos.entryET,
        entryPrice: openPos.entryPrice,
        exitTs: finalTs,
        exitET: etLabel(finalTs),
        exitPrice: curPrice,
        reason: 'time_exit',
        pnlPct,
        pnl$,
        signalType: '',
      });
    }

    // Compute metrics
    let totalPnl = 0;
    let wins = 0;
    let maxWin = 0;
    let maxLoss = 0;
    let maxConsecutiveWins = 0;
    let maxConsecutiveLosses = 0;
    let currentConsecutiveWins = 0;
    let currentConsecutiveLosses = 0;

    for (const trade of trades) {
      totalPnl += trade.pnl$;
      if (trade.pnlPct > 0) {
        wins++;
        currentConsecutiveWins++;
        currentConsecutiveLosses = 0;
        maxWin = Math.max(maxWin, trade.pnl$);
      } else {
        currentConsecutiveLosses++;
        currentConsecutiveWins = 0;
        maxLoss = Math.min(maxLoss, trade.pnl$);
      }
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentConsecutiveWins);
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentConsecutiveLosses);
    }

    const winRate = trades.length ? wins / trades.length : 0;
    const avgPnlPerTrade = trades.length ? totalPnl / trades.length : 0;

    const result: ReplayResult = {
      runId,
      configId: config.id,
      date: targetDate,
      trades: trades.length,
      wins,
      winRate,
      totalPnl,
      avgPnlPerTrade,
      maxWin: maxWin || 0,
      maxLoss: maxLoss || 0,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      trades_json: JSON.stringify(trades),
    };

    // Store results
    store.saveResult(result);
    store.completeRun(runId);

    // Display summary
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`📈 RESULTS`);
    console.log('═'.repeat(72));
    console.log(`  Trades: ${trades.length} | Win Rate: ${(winRate * 100).toFixed(1)}%`);
    console.log(`  Total P&L: $${totalPnl.toFixed(0)}`);
    console.log(`  Best Day Trade: $${maxWin.toFixed(0)}`);
    console.log(`  Worst Trade: $${maxLoss.toFixed(0)}`);

    db.close();
    store.close();

    return result;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    store.failRun(runId, errorMsg);
    store.close();
    throw error;
  }
}

// CLI usage
if (require.main === module) {
  const configId = process.argv[2];
  const targetDate = process.argv[3];

  if (!configId || !targetDate) {
    console.error('Usage: npx tsx replay-machine.ts <configId> <date>');
    console.error('Example: npx tsx replay-machine.ts default 2026-03-20');
    process.exit(1);
  }

  const store = createStore();
  const config = store.getConfig(configId);
  store.close();

  if (!config) {
    console.error(`Config not found: ${configId}`);
    process.exit(1);
  }

  runReplay(config, targetDate).catch(console.error);
}
