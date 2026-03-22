/**
 * Price-action replay — fast deterministic backtest.
 *
 * Pre-loads all data once, then steps bar-by-bar feeding processBar().
 * No scanner calls, no recompute — pure deterministic.
 */
import Database from 'better-sqlite3';
import { initPriceAction, processBar, type ConfluenceResult } from '../../src/agent/price-action';
import { selectStrike, type ContractCandidate } from '../../src/agent/strike-selector';

const DB_PATH = './data/spxer.db';
const CLOSE_CUTOFF_SECS = 15 * 60;

interface Bar { ts: number; open: number; high: number; low: number; close: number; volume: number; indicators: string; }
interface Contract { symbol: string; type: 'call' | 'put'; strike: number; expiry: string; }
type PriceMap = Map<string, number>;

interface Trade {
  ts: number; symbol: string; side: string; expiry: string;
  entryPrice: number; exitPrice: number;
  positionSize: number; stopLoss: number; takeProfit: number;
  reason: string; pnl: number; barsHeld: number;
}

interface DayResult { date: string; trades: Trade[]; pnl: number; wins: number; losses: number; }

function getDb() { return new Database(DB_PATH, { readonly: true }); }

function getSpxBars(db: Database.Database, date: string): Bar[] {
  const start = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
  const end = start + 390 * 60;
  return db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM bars WHERE symbol='SPX' AND timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(start, end) as Bar[];
}

function getContracts(db: Database.Database, date: string): Contract[] {
  const start = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
  const end = start + 390 * 60;
  return db.prepare(`
    SELECT DISTINCT c.symbol, c.type, c.strike, c.expiry
    FROM contracts c JOIN bars b ON b.symbol = c.symbol
    WHERE b.timeframe='1m' AND b.ts >= ? AND b.ts <= ?
  `).all(start, end) as Contract[];
}

function buildPriceMap(db: Database.Database, symbols: string[], bars: Bar[]): PriceMap {
  const map = new Map<string, number>();
  const rows = db.prepare(`
    SELECT symbol, ts, close FROM bars
    WHERE symbol IN (${symbols.map(() => '?').join(',')})
    AND timeframe='1m' AND ts >= ? AND ts <= ?
    ORDER BY ts
  `).all(...symbols, bars[0].ts, bars[bars.length - 1].ts) as { symbol: string; ts: number; close: number }[];
  for (const r of rows) {
    map.set(`${r.symbol}@${r.ts}`, r.close);
  }
  return map;
}

function getPrice(pm: PriceMap, symbol: string, atTs: number): number {
  const exact = pm.get(`${symbol}@${atTs}`);
  if (exact !== undefined) return exact;
  let best: number | undefined;
  let bestTs = 0;
  const prefix = symbol + '@';
  for (const [k, v] of pm) {
    if (!k.startsWith(prefix)) continue;
    const kts = parseInt(k.slice(prefix.length));
    if (kts < atTs && kts > bestTs) { bestTs = kts; best = v; }
  }
  return best ?? 0;
}

function etLabel(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }) + ' ET';
}

function replayDay(date: string, pm: PriceMap): DayResult {
  const db = getDb();
  const bars = getSpxBars(db, date);
  const contracts = getContracts(db, date);
  db.close();

  if (bars.length === 0) return { date, trades: [], pnl: 0, wins: 0, losses: 0 };

  initPriceAction();

  const sessionEndTs = bars[bars.length - 1].ts + 15 * 60;
  let position: { ts: number; symbol: string; side: 'call' | 'put'; expiry: string; entryPrice: number; positionSize: number; stopLoss: number; takeProfit: number; barsEntered: number; } | null = null;
  let lastTradeTs = 0;
  const cooldownSecs = 5 * 60;
  const trades: Trade[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const spxPrice = bar.close;
    const sessionCloseTs = bars[bars.length - 1].ts;
    const minutesToClose = Math.max(0, Math.floor((sessionCloseTs - bar.ts) / 60));
    const barCount = i;

    if (position) {
      const exitPrice = getPrice(pm, position.symbol, bar.ts);
      const pnlPerContract = (exitPrice - position.entryPrice) * 100 * position.positionSize;

      let reason = '';
      if (position.side === 'call') {
        if (exitPrice <= position.stopLoss) reason = 'stop_loss';
        else if (exitPrice >= position.takeProfit) reason = 'take_profit';
      } else {
        if (exitPrice <= position.stopLoss) reason = 'stop_loss';
        else if (exitPrice >= position.takeProfit) reason = 'take_profit';
      }
      if (minutesToClose <= 0) reason = 'time_exit';

      if (reason) {
        const pnl = pnlPerContract;
        trades.push({
          ts: position.ts, symbol: position.symbol, side: position.side, expiry: position.expiry,
          entryPrice: position.entryPrice, exitPrice, positionSize: position.positionSize,
          stopLoss: position.stopLoss, takeProfit: position.takeProfit,
          reason, pnl, barsHeld: barCount - position.barsEntered,
        });
        const et = etLabel(bar.ts);
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(0)}` : `-$${Math.abs(pnl).toFixed(0)}`;
        console.log(`  [${et}] EXIT   ${position.symbol} @ $${exitPrice.toFixed(2)} [${reason}] ${pnlStr}`);
        position = null;
      }
      continue;
    }

    if (minutesToClose <= CLOSE_CUTOFF_SECS / 60) break;
    if (bar.ts - lastTradeTs < cooldownSecs) continue;

    const rsi = (() => {
      try { const ind = JSON.parse(bar.indicators || '{}'); return ind.rsi14 ?? null; }
      catch { return null; }
    })();

    const optionSnaps = contracts.map(c => ({
      symbol: c.symbol, strike: c.strike, side: c.type,
      price: getPrice(pm, c.symbol, bar.ts),
      prevPrice: i > 0 ? getPrice(pm, c.symbol, bars[i - 1].ts) : null,
      volume: bar.volume, avgVolume: bar.volume,
    }));

    const confluence: ConfluenceResult = processBar(
      { ts: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, rsi },
      optionSnaps,
    );

    if (!confluence.triggered || !confluence.direction) continue;

    const candidates: ContractCandidate[] = contracts.map(c => ({
      symbol: c.symbol, side: c.type, strike: c.strike,
      price: getPrice(pm, c.symbol, bar.ts),
      volume: bar.volume, delta: null, gamma: null,
    }));

    const selection = selectStrike(candidates, confluence.direction, spxPrice, rsi);
    if (!selection) continue;

    const et = etLabel(bar.ts);
    console.log(`  [${et}] ENTER  ${selection.contract.side.toUpperCase()} ${selection.contract.symbol} @ $${selection.contract.price.toFixed(2)} size=${selection.positionSize} sl=$${selection.stopLoss.toFixed(2)} tp=$${selection.takeProfit.toFixed(2)}`);

    const contract = contracts.find(c => c.symbol === selection.contract.symbol);
    position = {
      ts: bar.ts, symbol: selection.contract.symbol, side: selection.contract.side,
      expiry: contract?.expiry ?? '', entryPrice: selection.contract.price,
      positionSize: selection.positionSize, stopLoss: selection.stopLoss,
      takeProfit: selection.takeProfit, barsEntered: barCount,
    };
    lastTradeTs = bar.ts;
  }

  return {
    date,
    trades,
    pnl: trades.reduce((s, t) => s + t.pnl, 0),
    wins: trades.filter(t => t.pnl > 0).length,
    losses: trades.filter(t => t.pnl <= 0).length,
  };
}

function getAllDates(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT ts FROM bars WHERE symbol='SPX' AND timeframe='1m'
    AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(
    Math.floor(new Date('2026-01-01').getTime() / 1000),
    Math.floor(new Date('2026-12-31').getTime() / 1000),
  ) as { ts: number }[];
  db.close();
  const seen = new Set<string>();
  for (const r of rows) {
    const d = new Date(r.ts * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    seen.add(d);
  }
  return [...seen].sort();
}

function printResult(r: ReturnType<typeof replayDay>) {
  const wr = r.trades.length > 0 ? ((r.wins / r.trades.length) * 100).toFixed(0) : '—';
  const pnlStr = r.pnl >= 0 ? `+$${r.pnl.toFixed(0)}` : `-$${Math.abs(r.pnl).toFixed(0)}`;
  console.log(`  ${r.date}: ${r.trades.length} trades WR=${wr}% ${pnlStr}`);
}

function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dates = args.length > 0 ? args : getAllDates();

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  PRICE-ACTION REPLAY  |  ${dates.length} day(s)`);
  console.log(`${'═'.repeat(70)}\n`);

  const all: ReturnType<typeof replayDay>[] = [];
  for (const date of dates) {
    const db = getDb();
    const bars = getSpxBars(db, date);
    const contracts = getContracts(db, date);
    const pm = buildPriceMap(db, contracts.map(c => c.symbol), bars);
    db.close();
    const result = replayDay(date, pm);
    all.push(result);
    printResult(result);
  }

  const totalPnl = all.reduce((s, r) => s + r.pnl, 0);
  const totalTrades = all.reduce((s, r) => s + r.trades.length, 0);
  const totalWins = all.reduce((s, r) => s + r.wins, 0);
  const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '—';
  const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`;
  const days = all.filter(r => r.trades.length > 0).length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SCORECARD`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Days tested      : ${all.length}`);
  console.log(`  Days w/ trades  : ${days}`);
  console.log(`  Total trades    : ${totalTrades}`);
  console.log(`  Win rate        : ${wr}%`);
  console.log(`  Total P&L       : ${pnlStr}`);
  console.log(`  Avg P&L/day     : ${pnlStr} / ${all.length}`);
  console.log(`${'═'.repeat(70)}\n`);
}

main();
