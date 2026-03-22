/**
 * replay-agent.ts — Instant replay of agent logic against historical bars.
 *
 * Two modes:
 *   --price-action  deterministic price-action confluence (no AI calls, fast)
 *   --scanners      full agent: price-action + scanners + judge (real API calls)
 *
 * For each day: iterates every 1m SPX bar, feeds CycleSnapshot into agent logic,
 * simulates position management (stop/TP/time), collects P&L.
 *
 * Usage:
 *   npx tsx replay-agent.ts                              # price-action mode, all days
 *   npx tsx replay-agent.ts 2026-03-19                   # single day
 *   npx tsx replay-agent.ts --scanners 2026-03-19        # with scanner + judge
 */
import * as dotenv from 'dotenv';
dotenv.config();

import path from 'path';
import Database from 'better-sqlite3';
import { createReplayContext, buildCycleSnapshot, runReplayDay, type CycleSnapshot, type ReplayContext, type ReplayResult, type TradeResult } from '../../src/replay';
import { initPriceAction, processBar, getRecentSignals, type ConfluenceResult } from '../../src/agent/price-action';
import { selectStrike, type ContractCandidate } from '../../src/agent/strike-selector';
import { assess } from '../../src/agent/judgment-engine';
import type { Assessment } from '../../src/agent/judgment-engine';

const DB_PATH = path.resolve(__dirname, 'data/spxer.db');
const USE_SCANNERS = process.argv.includes('--scanners');

const STOP_PCT = 0.70;
const TP_MULTIPLIER = 5;
const COOLDOWN_MS = 5 * 60 * 1000;
const CLOSE_CUTOFF_MIN = 15 * 60;

interface ActivePosition {
  ts: number;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  expiry: string;
  entryPrice: number;
  positionSize: number;
  stopLoss: number;
  takeProfit: number;
  barsEntered: number;
}

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dates = args.length > 0 ? args : getAllDates(db);

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  REPLAY AGENT  |  mode: ${USE_SCANNERS ? 'SCANNERS + JUDGE' : 'PRICE-ACTION ONLY'}  |  ${dates.length} day(s)`);
  console.log(`${'═'.repeat(70)}\n`);

  const allResults: ReplayResult[] = [];

  for (const date of dates) {
    const result = await replayDay(date, db);
    allResults.push(result);
    printDayResult(result);
  }

  printScorecard(allResults);
}

function getAllDates(db: Database.Database): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT date(ts / 86400, 'unixepoch', 'utc') as d
    FROM bars WHERE symbol='SPX' AND timeframe='1m'
    AND ts >= ? AND ts <= ?
    ORDER BY d
  `).all(
    Math.floor(new Date('2026-01-01').getTime() / 1000),
    Math.floor(new Date('2026-12-31').getTime() / 1000),
  ) as { d: string }[];
  return rows.map(r => r.d);
}

async function replayDay(date: string, db: Database.Database): Promise<ReplayResult> {
  const ctx = createReplayContext(db, date);
  if (ctx.spxBars.length === 0) {
    return { date, trades: [], pnl: 0, wins: 0, losses: 0 };
  }

  initPriceAction();
  const state = new ReplayState(ctx);

  await runReplayDay(ctx, {
    async onCycle(snap: CycleSnapshot, barTs: number) {
      state.tick(snap, barTs);
    },
  });

  return state.result();
}

class ReplayState {
  private ctx: ReplayContext;
  private snap: CycleSnapshot | null = null;
  private barTs: number = 0;
  private position: ActivePosition | null = null;
  private lastTradeTs: number = 0;
  private barCount: number = 0;
  private trades: TradeResult[] = [];
  private priceActionFired: number = 0;
  private scannerTriggered: number = 0;

  constructor(ctx: ReplayContext) {
    this.ctx = ctx;
  }

  tick(snap: CycleSnapshot, barTs: number) {
    this.snap = snap;
    this.barTs = barTs;
    this.barCount++;

    this.monitorPosition();

    if (snap.minutesToClose <= CLOSE_CUTOFF_MIN) return;
    if (this.position) return;
    if (barTs - this.lastTradeTs < COOLDOWN_MS / 1000) return;

    if (!USE_SCANNERS) {
      this.runPriceAction();
    } else {
      this.runWithScanners().catch(() => {});
    }
  }

  private runPriceAction() {
    const snap = this.snap!;
    const latestBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];
    if (!latestBar) return;

    const spxRsi = latestBar.rsi14;
    const optionSnaps = snap.contracts.map(c => ({
      symbol: c.meta.symbol,
      strike: c.meta.strike,
      side: c.meta.side,
      price: c.quote.last ?? 0,
      prevPrice: snap.spx.bars1m.length > 1 ? snap.spx.bars1m[snap.spx.bars1m.length - 2]?.close ?? null : null,
      volume: c.greeks.volume ?? 0,
      avgVolume: c.greeks.volume ?? 0,
    }));

    const confluence: ConfluenceResult = processBar(
      { ts: latestBar.ts, open: latestBar.close, high: latestBar.close, low: latestBar.close, close: latestBar.close, rsi: spxRsi },
      optionSnaps,
    );

    if (!confluence.triggered || !confluence.direction) return;

    this.priceActionFired++;
    const candidates: ContractCandidate[] = snap.contracts.map(c => ({
      symbol: c.meta.symbol,
      side: c.meta.side,
      strike: c.meta.strike,
      price: c.quote.last ?? 0,
      volume: c.greeks.volume ?? 0,
      delta: c.greeks.delta,
      gamma: c.greeks.gamma,
    }));

    const selection = selectStrike(candidates, confluence.direction, snap.spx.price, spxRsi);
    if (!selection) return;

    this.enterPosition(selection.contract.symbol, selection.contract.side, selection.contract.strike, selection.contract.price, selection.positionSize, selection.stopLoss, selection.takeProfit);
  }

  private async runWithScanners() {
    const snap = this.snap!;

    const latestBar = snap.spx.bars1m[snap.spx.bars1m.length - 1];
    if (!latestBar) return;

    const spxRsi = latestBar.rsi14;
    const optionSnaps = snap.contracts.map(c => ({
      symbol: c.meta.symbol,
      strike: c.meta.strike,
      side: c.meta.side,
      price: c.quote.last ?? 0,
      prevPrice: snap.spx.bars1m.length > 1 ? snap.spx.bars1m[snap.spx.bars1m.length - 2]?.close ?? null : null,
      volume: c.greeks.volume ?? 0,
      avgVolume: c.greeks.volume ?? 0,
    }));

    const confluence: ConfluenceResult = processBar(
      { ts: latestBar.ts, open: latestBar.close, high: latestBar.close, low: latestBar.close, close: latestBar.close, rsi: spxRsi },
      optionSnaps,
    );

    if (confluence.triggered && confluence.direction) {
      this.priceActionFired++;
      const candidates: ContractCandidate[] = snap.contracts.map(c => ({
        symbol: c.meta.symbol,
        side: c.meta.side,
        strike: c.meta.strike,
        price: c.quote.last ?? 0,
        volume: c.greeks.volume ?? 0,
        delta: c.greeks.delta,
        gamma: c.greeks.gamma,
      }));
      const selection = selectStrike(candidates, confluence.direction, snap.spx.price, spxRsi);
      if (selection) {
        this.scannerTriggered++;
        this.enterPosition(selection.contract.symbol, selection.contract.side, selection.contract.strike, selection.contract.price, selection.positionSize, selection.stopLoss, selection.takeProfit);
        return;
      }
    }

    const { assessment } = await assess(snap as any, [], {} as any, new Map());
    if (assessment.action === 'buy' && assessment.direction) {
      const candidates: ContractCandidate[] = snap.contracts.map(c => ({
        symbol: c.meta.symbol,
        side: c.meta.side,
        strike: c.meta.strike,
        price: c.quote.last ?? 0,
        volume: c.greeks.volume ?? 0,
        delta: c.greeks.delta,
        gamma: c.greeks.gamma,
      }));
      const selection = selectStrike(candidates, assessment.direction, snap.spx.price, spxRsi);
      if (selection) {
        this.scannerTriggered++;
        this.enterPosition(selection.contract.symbol, selection.contract.side, selection.contract.strike, selection.contract.price, selection.positionSize, selection.stopLoss, selection.takeProfit);
      }
    }
  }

  private enterPosition(symbol: string, side: 'call' | 'put', strike: number, price: number, size: number, stop: number, tp: number) {
    const contract = this.ctx.contracts.find(c => c.symbol === symbol);
    this.position = {
      ts: this.barTs,
      symbol,
      side,
      strike,
      expiry: contract?.expiry ?? '',
      entryPrice: price,
      positionSize: size,
      stopLoss: stop,
      takeProfit: tp,
      barsEntered: this.barCount,
    };
    this.lastTradeTs = this.barTs;
    const et = new Date(this.barTs * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`  [${et}] ENTER  ${side.toUpperCase()} ${symbol} @ $${price.toFixed(2)} size=${size} sl=$${stop.toFixed(2)} tp=$${tp.toFixed(2)}`);
  }

  private monitorPosition() {
    if (!this.position) return;
    const snap = this.snap!;
    const contract = snap.contracts.find(c => c.meta.symbol === this.position!.symbol);
    if (!contract) return;

    const currentPrice = contract.quote.last ?? this.position.entryPrice;
    const entry = this.position.entryPrice;
    const pnlPerContract = (currentPrice - entry) * 100 * this.position.positionSize;
    const pnlPct = (currentPrice - entry) / entry;

    let reason = '';
    let exited = false;

    if (this.position.side === 'call') {
      if (currentPrice <= this.position.stopLoss) reason = 'stop_loss';
      else if (currentPrice >= this.position.takeProfit) reason = 'take_profit';
    } else {
      if (currentPrice <= this.position.stopLoss) reason = 'stop_loss';
      else if (currentPrice >= this.position.takeProfit) reason = 'take_profit';
    }

    if (snap.minutesToClose <= 0) reason = 'time_exit';

    if (reason) {
      const pnl = pnlPerContract;
      exited = true;
      const et = new Date(this.barTs * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
      const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
      console.log(`  [${et}] EXIT   ${this.position.symbol} @ $${currentPrice.toFixed(2)} [${reason}] ${pnlStr}`);
      this.trades.push({
        ts: this.position.ts,
        symbol: this.position.symbol,
        side: this.position.side,
        entryPrice: this.position.entryPrice,
        exitPrice: currentPrice,
        positionSize: this.position.positionSize,
        stopLoss: this.position.stopLoss,
        takeProfit: this.position.takeProfit,
        reason,
        pnl,
        barsHeld: this.barCount - this.position.barsEntered,
      });
    }
    if (exited) this.position = null;
  }

  result(): ReplayResult {
    return {
      date: this.ctx.date,
      trades: this.trades,
      pnl: this.trades.reduce((s, t) => s + t.pnl, 0),
      wins: this.trades.filter(t => t.pnl > 0).length,
      losses: this.trades.filter(t => t.pnl <= 0).length,
    };
  }
}

function printDayResult(r: ReplayResult) {
  const wr = r.trades.length > 0 ? ((r.wins / r.trades.length) * 100).toFixed(0) : '—';
  const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
  console.log(`  ${r.date}: ${r.trades.length} trades WR=${wr}% ${pnlStr}`);
}

function printScorecard(results: ReplayResult[]) {
  const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
  const totalTrades = results.reduce((s, r) => s + r.trades.length, 0);
  const totalWins = results.reduce((s, r) => s + r.wins, 0);
  const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '—';
  const days = results.filter(r => r.trades.length > 0).length;
  const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SCORECARD`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Days tested       : ${results.length}`);
  console.log(`  Days with trades  : ${days}`);
  console.log(`  Total trades     : ${totalTrades}`);
  console.log(`  Win rate         : ${wr}%`);
  console.log(`  Total P&L        : ${pnlStr}`);
  console.log(`  Avg P&L/day      : ${pnlStr} / ${results.length} = ${pnlStr.replace('$', '$')}`);
  console.log(`${'═'.repeat(70)}\n`);
}

main().catch(console.error);
