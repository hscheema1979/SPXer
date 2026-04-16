/**
 * Schwaber — Schwab ETF Trading Agent
 *
 * Trades SPY/QQQ (or any equity) via the Schwab API using the same
 * HMA3×17 cross signal that drives the SPX options agents.
 *
 * Signal source: polls SPX HMA bars from the SPXer data service (localhost:3600)
 * Execution:     Schwab Trader API (OAuth2 — tokens managed by src/providers/schwab.ts)
 *
 * Usage:
 *   npm run schwaber          # paper mode (log only, no real orders)
 *   npm run schwaber:live     # live trading (AGENT_PAPER=false)
 *
 * Requirements:
 *   - SPXer data service running (npm run dev)
 *   - Schwab OAuth tokens in DB (visit https://bitloom.cloud/schwab/auth first)
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { SCHWABER_CONFIG } from './schwaber-config';
import {
  getAccessToken,
  startTokenRefresher,
  loadTokens,
  getQuotes,
  placeOrder,
  equityMarketOrder,
  equityLimitOrder,
  getSchwabAuthStatus,
} from './src/providers/schwab';
import { nowET, todayET } from './src/utils/et-time';
import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────

interface SpxBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators?: {
    hma3?: number | null;
    hma17?: number | null;
    [key: string]: any;
  };
}

interface Position {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  shares: number;
  takeProfit: number;
  stopLoss: number;
  enteredAt: number;
  orderId?: string;
}

interface SymbolState {
  prevHma3: number | null;
  prevHma17: number | null;
  lastBarTs: number;
}

// ── State ─────────────────────────────────────────────────────────────────

const isPaper = process.env.AGENT_PAPER !== 'false' && SCHWABER_CONFIG.paper;

const positions = new Map<string, Position>(); // symbol → position
const symbolState = new Map<string, SymbolState>(); // symbol → HMA state
for (const sym of SCHWABER_CONFIG.symbols) {
  symbolState.set(sym, { prevHma3: null, prevHma17: null, lastBarTs: 0 });
}

let cycleCount = 0;
let tradesTotal = 0;
let winsTotal = 0;
let dailyPnl = 0;

// ── Logging ───────────────────────────────────────────────────────────────

const LOGS_DIR = path.join(process.cwd(), 'logs');

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'schwaber.log'), line + '\n');
  } catch {}
}

// Structured status file — read by the viewer API
function writeSchwaberStatus() {
  try {
    const status = {
      ts: Date.now(),
      paper: isPaper,
      symbols: SCHWABER_CONFIG.symbols,
      openPositions: Array.from(positions.values()).map(p => ({
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        shares: p.shares,
        takeProfit: p.takeProfit,
        stopLoss: p.stopLoss,
        enteredAt: p.enteredAt,
        orderId: p.orderId ?? null,
      })),
      dailyPnl,
      tradesTotal,
      winsTotal,
      cycleCount,
      winRate: tradesTotal > 0 ? (winsTotal / tradesTotal * 100) : 0,
    };
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOGS_DIR, 'schwaber-status.json'), JSON.stringify(status, null, 2));
  } catch {}
}

// Structured activity log — append-only JSONL, read by viewer API
function logSchwaberActivity(event: string, summary: string, details: Record<string, any> = {}) {
  try {
    const entry = JSON.stringify({
      ts: Date.now(),
      event,
      summary,
      details,
    });
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOGS_DIR, 'schwaber-activity.jsonl'), entry + '\n');
  } catch {}
}

// ── ET time helpers ────────────────────────────────────────────────────────

function etMinutes(): number {
  const { h, m } = nowET();
  return h * 60 + m;
}

function parseET(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function isActiveWindow(): boolean {
  const mins = etMinutes();
  return mins >= parseET(SCHWABER_CONFIG.activeStart) &&
         mins < parseET(SCHWABER_CONFIG.activeEnd);
}

const MARKET_OPEN  = parseET('09:30');
const MARKET_CLOSE = parseET('16:00');

function isMarketOpen(): boolean {
  const mins = etMinutes();
  return mins >= MARKET_OPEN && mins < MARKET_CLOSE;
}

async function sleepUntilMarketOpen(): Promise<void> {
  while (true) {
    if (isMarketOpen()) return;
    const mins = etMinutes();
    const waitMins = mins >= MARKET_CLOSE
      ? (24 * 60 - mins) + MARKET_OPEN
      : MARKET_OPEN - mins;
    const waitMs = Math.min(waitMins * 60 * 1000, 5 * 60 * 1000);
    log(`Market closed — ${waitMins}m until open. Sleeping...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

// ── SPXer data fetch ───────────────────────────────────────────────────────

async function fetchSpxBars(n = 30): Promise<SpxBar[]> {
  const url = `${SCHWABER_CONFIG.spxerBaseUrl}/spx/bars?tf=1m&n=${n}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`SPXer bars fetch failed: ${resp.status}`);
  return resp.json() as Promise<SpxBar[]>;
}

// ── HMA cross detection ────────────────────────────────────────────────────

type CrossDirection = 'bullish' | 'bearish' | null;

function detectHmaCross(bars: SpxBar[], state: SymbolState): CrossDirection {
  // Need at least 2 closed bars with HMA values
  if (bars.length < 2) return null;

  // Use the second-to-last bar as "just closed" (last may be forming)
  const closed = bars[bars.length - 2];
  const prev   = bars[bars.length - 3] ?? null;

  const hma3  = closed.indicators?.hma3  ?? null;
  const hma17 = closed.indicators?.hma17 ?? null;

  if (hma3 == null || hma17 == null) return null;
  if (closed.ts === state.lastBarTs) return null; // already processed this bar

  const prevHma3  = state.prevHma3  ?? (prev?.indicators?.hma3  ?? null);
  const prevHma17 = state.prevHma17 ?? (prev?.indicators?.hma17 ?? null);

  state.lastBarTs = closed.ts;
  state.prevHma3  = hma3;
  state.prevHma17 = hma17;

  if (prevHma3 == null || prevHma17 == null) return null;

  const wasBelowOrEqual = prevHma3 <= prevHma17;
  const isAbove         = hma3 > hma17;
  if (wasBelowOrEqual && isAbove) return 'bullish';

  const wasAboveOrEqual = prevHma3 >= prevHma17;
  const isBelow         = hma3 < hma17;
  if (wasAboveOrEqual && isBelow) return 'bearish';

  return null;
}

// ── Quote fetch ────────────────────────────────────────────────────────────

async function getPrice(symbol: string): Promise<number | null> {
  try {
    const quotes = await getQuotes([symbol]);
    const q = quotes[symbol];
    // Schwab quote format: q.quote.lastPrice or q.quote.bidPrice
    return q?.quote?.lastPrice ?? q?.quote?.bidPrice ?? null;
  } catch (e: any) {
    log(`⚠️  getPrice(${symbol}) failed: ${e.message}`);
    return null;
  }
}

// ── Position monitoring ────────────────────────────────────────────────────

async function monitorPositions(): Promise<void> {
  for (const [symbol, pos] of positions) {
    const price = await getPrice(symbol);
    if (price == null) continue;

    const pnl = (price - pos.entryPrice) * pos.shares * (pos.side === 'long' ? 1 : -1);

    if (pos.side === 'long') {
      if (price >= pos.takeProfit) {
        log(`🎯 TP HIT ${symbol}: $${price.toFixed(2)} >= TP $${pos.takeProfit.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
        await exitPosition(pos, price, 'tp');
      } else if (price <= pos.stopLoss) {
        log(`🛑 SL HIT ${symbol}: $${price.toFixed(2)} <= SL $${pos.stopLoss.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
        await exitPosition(pos, price, 'sl');
      }
    } else {
      // short
      if (price <= pos.takeProfit) {
        log(`🎯 TP HIT ${symbol} short: $${price.toFixed(2)} <= TP $${pos.takeProfit.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
        await exitPosition(pos, price, 'tp');
      } else if (price >= pos.stopLoss) {
        log(`🛑 SL HIT ${symbol} short: $${price.toFixed(2)} >= SL $${pos.stopLoss.toFixed(2)} | P&L $${pnl.toFixed(2)}`);
        await exitPosition(pos, price, 'sl');
      }
    }
  }
}

async function exitPosition(pos: Position, price: number, reason: 'tp' | 'sl' | 'eod' | 'reversal'): Promise<void> {
  const instruction = pos.side === 'long' ? 'SELL' : 'BUY';
  const pnl = (price - pos.entryPrice) * pos.shares * (pos.side === 'long' ? 1 : -1);

  if (!isPaper) {
    try {
      const order = equityMarketOrder(pos.symbol, instruction, pos.shares);
      const result = await placeOrder(order);
      log(`📤 EXIT order placed for ${pos.symbol} x${pos.shares} ${instruction} (${reason}) | orderId: ${result.orderId}`);
    } catch (e: any) {
      log(`❌ EXIT order failed for ${pos.symbol}: ${e.message}`);
    }
  } else {
    log(`📋 PAPER EXIT ${pos.symbol} x${pos.shares} ${instruction} @ $${price.toFixed(2)} (${reason}) | P&L $${pnl.toFixed(2)}`);
  }

  dailyPnl += pnl;
  if (pnl > 0) winsTotal++;
  tradesTotal++;
  positions.delete(pos.symbol);

  const emoji = pnl >= 0 ? '💰' : '💸';
  log(`${emoji} CLOSED ${pos.symbol} (${reason}) @ $${price.toFixed(2)} | P&L $${pnl.toFixed(2)} | daily P&L $${dailyPnl.toFixed(2)}`);
  writeSchwaberStatus();
  logSchwaberActivity('exit', `${pos.side.toUpperCase()} ${pos.symbol} closed (${reason}) @ $${price.toFixed(2)} | P&L $${pnl.toFixed(2)}`, { symbol: pos.symbol, side: pos.side, reason, entryPrice: pos.entryPrice, exitPrice: price, shares: pos.shares, pnl, dailyPnl });
}

// ── Entry execution ────────────────────────────────────────────────────────

async function enterPosition(symbol: string, direction: CrossDirection, price: number): Promise<void> {
  if (!direction) return;
  if (positions.has(symbol)) return; // already in a position for this symbol
  if (positions.size >= SCHWABER_CONFIG.maxOpenPositions) {
    log(`⏸️  Max positions (${SCHWABER_CONFIG.maxOpenPositions}) reached — skipping ${symbol}`);
    return;
  }
  if (dailyPnl <= -SCHWABER_CONFIG.maxDailyLoss) {
    log(`🚫 Daily loss limit ($${SCHWABER_CONFIG.maxDailyLoss}) reached — no new trades`);
    return;
  }

  const side   = direction === 'bullish' ? 'long' : 'short';
  const shares = SCHWABER_CONFIG.sharesPerTrade;
  const tp     = direction === 'bullish'
    ? price * (1 + SCHWABER_CONFIG.takeProfitPct)
    : price * (1 - SCHWABER_CONFIG.takeProfitPct);
  const sl     = direction === 'bullish'
    ? price * (1 - SCHWABER_CONFIG.stopLossPct)
    : price * (1 + SCHWABER_CONFIG.stopLossPct);

  const instruction = direction === 'bullish' ? 'BUY' : 'SELL';

  let orderId: string | undefined;
  if (!isPaper) {
    try {
      const order = equityMarketOrder(symbol, instruction, shares);
      const result = await placeOrder(order);
      orderId = result.orderId;
      log(`📤 ENTRY order placed: ${symbol} x${shares} ${instruction} | orderId: ${orderId}`);
    } catch (e: any) {
      log(`❌ ENTRY order failed for ${symbol}: ${e.message}`);
      return;
    }
  } else {
    log(`📋 PAPER ENTRY ${symbol} x${shares} ${instruction} @ $${price.toFixed(2)} | TP $${tp.toFixed(2)} SL $${sl.toFixed(2)}`);
  }

  const pos: Position = {
    id: `${symbol}-${Date.now()}`,
    symbol,
    side,
    entryPrice: price,
    shares,
    takeProfit: tp,
    stopLoss: sl,
    enteredAt: Date.now(),
    orderId,
  };

  positions.set(symbol, pos);
  log(`✅ ENTERED ${side.toUpperCase()} ${symbol} x${shares} @ $${price.toFixed(2)} | TP $${tp.toFixed(2)} SL $${sl.toFixed(2)}`);
  writeSchwaberStatus();
  logSchwaberActivity('entry', `${side.toUpperCase()} ${symbol} x${shares} @ $${price.toFixed(2)}`, { symbol, side, price, shares, tp, sl, orderId: orderId ?? null });
}

// ── HMA cross reversal exit ────────────────────────────────────────────────

async function checkReversalExit(symbol: string, cross: CrossDirection): Promise<void> {
  const pos = positions.get(symbol);
  if (!pos || !cross) return;

  const isLongAndBearish  = pos.side === 'long'  && cross === 'bearish';
  const isShortAndBullish = pos.side === 'short' && cross === 'bullish';

  if (isLongAndBearish || isShortAndBullish) {
    const price = await getPrice(symbol);
    if (price == null) return;
    log(`🔄 REVERSAL EXIT ${symbol} (${cross} cross while ${pos.side})`);
    await exitPosition(pos, price, 'reversal');
  }
}

// ── EOD close all ─────────────────────────────────────────────────────────

async function closeAllPositions(reason: 'eod'): Promise<void> {
  for (const [symbol, pos] of positions) {
    const price = await getPrice(symbol);
    if (price != null) {
      await exitPosition(pos, price, reason);
    }
  }
}

// ── Main cycle ─────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  cycleCount++;
  const { h, m } = nowET();
  const timeET = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} ET`;

  log(`\n═══ Cycle #${cycleCount} @ ${timeET} | ${positions.size} open | daily P&L $${dailyPnl.toFixed(2)} ═══`);
  writeSchwaberStatus();

  // Fetch SPX bars (signal source for all symbols)
  let bars: SpxBar[];
  try {
    bars = await fetchSpxBars(30);
  } catch (e: any) {
    log(`⚠️  SPXer fetch failed: ${e.message} — skipping cycle`);
    return;
  }

  if (bars.length < 3) {
    log('⏳ Not enough bars yet — waiting for warmup');
    return;
  }

  // 1. Monitor existing positions for TP/SL
  await monitorPositions();

  if (!isActiveWindow()) {
    log(`⏸️  Outside active window (${SCHWABER_CONFIG.activeStart}–${SCHWABER_CONFIG.activeEnd} ET)`);
    return;
  }

  // 2. Check for HMA crosses on each symbol
  for (const symbol of SCHWABER_CONFIG.symbols) {
    const state = symbolState.get(symbol)!;
    const cross = detectHmaCross(bars, state);

    if (cross) {
      log(`📡 HMA cross: ${cross.toUpperCase()} on ${symbol} (using SPX bars)`);

      // First check if we need to reverse an existing position
      await checkReversalExit(symbol, cross);

      // Then enter new position if we're now flat
      if (!positions.has(symbol)) {
        const price = await getPrice(symbol);
        if (price != null) {
          await enterPosition(symbol, cross, price);
        } else {
          log(`⚠️  Could not get price for ${symbol} — skipping entry`);
        }
      }
    }
  }
}

// ── Banner ─────────────────────────────────────────────────────────────────

function banner(): void {
  log('\n╔══════════════════════════════════════════════════════════╗');
  log('║           Schwaber — Schwab ETF Agent                   ║');
  log(`║  Mode:    ${isPaper ? 'PAPER (no real orders)              ' : 'LIVE  ⚠️  REAL MONEY                  '}║`);
  log(`║  Symbols: ${SCHWABER_CONFIG.symbols.join(', ').padEnd(47)}║`);
  log(`║  Signal:  HMA(${SCHWABER_CONFIG.hmaCrossFast})×HMA(${SCHWABER_CONFIG.hmaCrossSlow}) cross (from SPX bars)        ║`);
  log(`║  Size:    ${SCHWABER_CONFIG.sharesPerTrade} share(s) per trade, max ${SCHWABER_CONFIG.maxOpenPositions} open             ║`);
  log(`║  TP/SL:   ${(SCHWABER_CONFIG.takeProfitPct * 100).toFixed(2)}% / ${(SCHWABER_CONFIG.stopLossPct * 100).toFixed(2)}%                              ║`);
  log(`║  Window:  ${SCHWABER_CONFIG.activeStart}–${SCHWABER_CONFIG.activeEnd} ET                           ║`);
  log('╚══════════════════════════════════════════════════════════╝\n');
}

// ── Daily review ──────────────────────────────────────────────────────────

function dailyReview(): void {
  const wr = tradesTotal > 0 ? (winsTotal / tradesTotal * 100).toFixed(1) : '0';
  log(`\n${'═'.repeat(60)}`);
  log(`  SCHWABER DAILY REVIEW — ${todayET()}`);
  log(`  Trades: ${tradesTotal} | Wins: ${winsTotal} | Win Rate: ${wr}%`);
  log(`  Daily P&L: $${dailyPnl.toFixed(2)}`);
  log(`  Paper: ${isPaper}`);
  log(`${'═'.repeat(60)}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  // Verify Schwab auth
  const authStatus = getSchwabAuthStatus();
  if (!authStatus.authenticated && !isPaper) {
    log('❌ Not authenticated with Schwab. Visit https://bitloom.cloud/schwab/auth first.');
    process.exit(1);
  }
  if (!authStatus.authenticated) {
    log('⚠️  Schwab tokens not present — running in PAPER mode (no Schwab quotes, using SPXer prices only)');
  } else {
    log(`✅ Schwab authenticated. Refresh token expires in ${authStatus.refreshTokenDaysLeft} day(s).`);
    startTokenRefresher();
  }

  // Outer loop: one trading day per iteration
  while (true) {
    log('Waiting for market open...');
    await sleepUntilMarketOpen();
    log('Market open — starting session');

    // Reset daily state
    dailyPnl = 0;
    tradesTotal = 0;
    winsTotal = 0;
    for (const [, state] of symbolState) {
      state.prevHma3 = null;
      state.prevHma17 = null;
      state.lastBarTs = 0;
    }

    log('First cycle in 10s...');
    await new Promise(r => setTimeout(r, 10_000));

    // Inner loop: trade until market close
    while (isMarketOpen()) {
      try {
        await runCycle();
      } catch (e: any) {
        log(`❌ Cycle error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, SCHWABER_CONFIG.pollIntervalSec * 1000));
    }

    // Market closed — close any remaining positions
    log('🔔 Market closed — closing all positions');
    await closeAllPositions('eod');
    dailyReview();
    log('Sleeping until next market open...\n');
  }
}

process.on('SIGTERM', async () => {
  log('Shutting down (SIGTERM)');
  await closeAllPositions('eod');
  process.exit(0);
});
process.on('SIGINT', async () => {
  log('Shutting down (SIGINT)');
  await closeAllPositions('eod');
  process.exit(0);
});

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
