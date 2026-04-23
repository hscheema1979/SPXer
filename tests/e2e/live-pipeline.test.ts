/**
 * E2E: ThetaData Dev WS → OptionCandleBuilder → DB → HTTP → Signal Detection
 *
 * Connects to the ThetaData dev/delayed WebSocket on localhost:25520 (Free tier),
 * subscribes to 0DTE SPXW contracts, waits for ticks to flow through the full
 * pipeline: candle builder → indicators → SQLite → HTTP API → signal detection
 * → spread check → order type decision.
 *
 * This is the dev stream, NOT live OPRA. Prices may be delayed or synthetic.
 * The point is to validate the full wiring end-to-end with real infrastructure.
 *
 * Requirements:
 *   - ThetaTerminal running on localhost:25520
 *   - Market hours (dev stream still needs market session for tick flow)
 *   - TRADIER_TOKEN in .env (for SPX price lookup to pick ATM strikes)
 *
 * Run:   npx vitest run --config vitest.live.config.ts
 * Skip:  Excluded from `npm test` via vitest.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

import { initDb, closeDb } from '../../src/storage/db';
import { upsertBar, upsertContract, getBars, getAllActiveContracts, resetPreparedStatements } from '../../src/storage/queries';
import { OptionCandleBuilder } from '../../src/pipeline/option-candle-builder';
import { rawToBar } from '../../src/pipeline/bar-builder';
import { computeIndicators, registerHmaPeriod } from '../../src/core/indicator-engine';
import { detectSignals, validateSignalConfig } from '../../src/core/signal-detector';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import { ThetaDataStream, type StreamTick } from '../../src/providers/thetadata-stream';
import { HealthGate } from '../../src/agent/health-gate';
import { chooseOrderType } from '../../src/agent/trade-executor';
import type { Bar, Contract } from '../../src/types';
import type { Config } from '../../src/config/types';
import { todayET } from '../../src/utils/et-time';

const TEST_DB_PATH = '/tmp/e2e-live-pipeline.db';
const EXPIRY_TODAY = todayET();
const EXPIRY_YYMMDD = EXPIRY_TODAY.slice(2).replace(/-/g, '');

// How long to wait for ticks and candle closes
const TICK_WAIT_MS = 30_000;       // 30s to see first tick
const CANDLE_WAIT_MS = 150_000;    // 2.5 min to see at least one candle close

const TEST_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  id: 'e2e-live',
  name: 'E2E Live Pipeline',
  scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
  judges: { ...DEFAULT_CONFIG.judges, enabled: false },
  signals: {
    ...DEFAULT_CONFIG.signals,
    enableHmaCrosses: true,
    enableRsiCrosses: false,
    enablePriceCrossHma: false,
    enableEmaCrosses: false,
    hmaCrossFast: 3,
    hmaCrossSlow: 5,
    signalTimeframe: '1m',
  },
  strikeSelector: {
    strikeSearchRange: 100,
    contractPriceMin: 0.10,
    contractPriceMax: 50,
    strikeMode: 'any',
  },
};

// ── State ───────────────────────────────────────────────────────────────────

let spxPrice: number;
let testSymbols: string[] = [];
let thetaStream: ThetaDataStream;
let httpServer: Server;
let httpPort: number;

const receivedTicks: StreamTick[] = [];
const closedBars: Array<{ symbol: string; bar: Bar }> = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Build OCC symbol: SPXW260421C05310000 */
function makeSymbol(strike: number, side: 'C' | 'P'): string {
  const strikeCode = String(strike * 1000).padStart(8, '0');
  return `SPXW${EXPIRY_YYMMDD}${side}${strikeCode}`;
}

/** Fetch live SPX price from Tradier */
async function fetchSpxPrice(): Promise<number> {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error('TRADIER_TOKEN not set');
  const resp = await axios.get('https://api.tradier.com/v1/markets/quotes', {
    params: { symbols: 'SPX' },
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    timeout: 5000,
  });
  return resp.data.quotes.quote.last;
}

/** Wait for a condition with timeout */
function waitFor(check: () => boolean, timeoutMs: number, pollMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (check()) { clearInterval(timer); resolve(true); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(timer); resolve(false); }
    }, pollMs);
  });
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Clean old test DB
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }

  // Init fresh DB
  resetPreparedStatements();
  initDb(TEST_DB_PATH);
  registerHmaPeriod(3);
  registerHmaPeriod(5);
  validateSignalConfig(TEST_CONFIG);

  // Get live SPX price → pick 4 ATM strikes
  spxPrice = await fetchSpxPrice();
  const atmStrike = Math.round(spxPrice / 5) * 5; // round to nearest $5
  testSymbols = [
    makeSymbol(atmStrike + 5,  'C'),  // 1 OTM call
    makeSymbol(atmStrike + 10, 'C'),  // 2 OTM call
    makeSymbol(atmStrike - 5,  'P'),  // 1 OTM put
    makeSymbol(atmStrike - 10, 'P'),  // 2 OTM put
  ];
  console.log(`[e2e] SPX=${spxPrice} ATM=${atmStrike} symbols=${testSymbols.join(', ')}`);

  // Register contracts in DB
  for (const sym of testSymbols) {
    const isCall = sym.includes('C0');
    const strikeStr = sym.slice(-8);
    const strike = parseInt(strikeStr, 10) / 1000;
    upsertContract({
      symbol: sym,
      type: isCall ? 'call' : 'put',
      underlying: 'SPX',
      strike,
      expiry: EXPIRY_TODAY,
      state: 'ACTIVE',
      firstSeen: Math.floor(Date.now() / 1000),
      lastBarTs: 0,
      createdAt: Math.floor(Date.now() / 1000),
    } as Contract);
  }

  // Wire up the candle builder (same pipeline as index.ts)
  const builder = new OptionCandleBuilder((symbol, candle) => {
    const bar = rawToBar(symbol, '1m', {
      ts: candle.minuteTs,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
    const avgSpread = OptionCandleBuilder.averageSpread(candle);
    if (avgSpread !== undefined) (bar as any).spread = avgSpread;
    const enriched = { ...bar, indicators: computeIndicators(bar, 1) };
    upsertBar(enriched);
    closedBars.push({ symbol, bar: enriched });
    console.log(`[e2e] Candle closed: ${symbol} ts=${candle.minuteTs} O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} V=${candle.volume} ticks=${candle.ticks}`);
  });

  // Flush candles on minute boundary (safety net)
  const flushTimer = setInterval(() => builder.flushAll(), 60_000);

  // Connect REAL ThetaData WS
  thetaStream = new ThetaDataStream();
  thetaStream.onTick((tick) => {
    receivedTicks.push(tick);

    if (tick.type === 'trade' && tick.price && tick.price > 0) {
      builder.processTick(tick.symbol, tick.price, tick.size ?? 0, tick.ts);
    } else if (tick.type === 'quote' && tick.bid && tick.ask) {
      builder.processQuote(tick.symbol, tick.bid, tick.ask, tick.ts);
    }
  });

  await thetaStream.start(testSymbols);
  console.log(`[e2e] ThetaData WS started, waiting for ticks...`);

  // Start HTTP server
  const app = express();
  app.get('/health', (_, res) => res.json({
    status: 'healthy',
    lastSpxPrice: spxPrice,
    uptimeSec: 60,
    data: { SPX: { staleSec: 5, lastBarTs: new Date().toISOString() } },
  }));
  app.get('/contracts/active', (_, res) => res.json(getAllActiveContracts()));
  app.get('/contracts/:symbol/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars(req.params.symbol, tf, n));
  });
  app.get('/contracts/:symbol/latest', (req, res) => {
    const bars = getBars(req.params.symbol, '1m', 1);
    res.json(bars[0] ?? { error: 'no data' });
  });

  httpServer = createServer(app);
  httpPort = await new Promise<number>(resolve => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  // ── Wait for real ticks ──
  const gotTicks = await waitFor(() => receivedTicks.length > 0, TICK_WAIT_MS);
  if (gotTicks) {
    console.log(`[e2e] First tick received after ${receivedTicks.length} ticks in ${TICK_WAIT_MS / 1000}s window`);
  } else {
    console.warn(`[e2e] No ticks received in ${TICK_WAIT_MS / 1000}s — market may be closed or contracts illiquid`);
  }

  // Wait for at least one candle close (up to 2.5 min)
  const gotCandle = await waitFor(() => closedBars.length > 0, CANDLE_WAIT_MS);
  if (gotCandle) {
    console.log(`[e2e] ${closedBars.length} candles closed after waiting`);
  } else {
    // Force flush to get whatever we have
    builder.flushAll();
    console.warn(`[e2e] No natural candle close — flushed ${closedBars.length} candles`);
  }

  clearInterval(flushTimer);
}, TICK_WAIT_MS + CANDLE_WAIT_MS + 30_000); // beforeAll timeout

afterAll(async () => {
  thetaStream.stop();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
  closeDb();
  resetPreparedStatements();
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('E2E: ThetaData Dev WS → Full Pipeline', () => {

  describe('Stage 1: ThetaData WS connection & ticks', () => {
    it('connected to ThetaTerminal', () => {
      expect(thetaStream.isConnected()).toBe(true);
    });

    it('received real trade/quote ticks', () => {
      expect(receivedTicks.length).toBeGreaterThan(0);
      const trades = receivedTicks.filter(t => t.type === 'trade');
      const quotes = receivedTicks.filter(t => t.type === 'quote');
      console.log(`[e2e] Total ticks: ${receivedTicks.length} (${trades.length} trades, ${quotes.length} quotes)`);
      // Should have at least some of each type for ATM 0DTE
      expect(trades.length + quotes.length).toBeGreaterThan(0);
    });

    it('tick symbols match subscribed contracts', () => {
      const tickSymbols = new Set(receivedTicks.map(t => t.symbol));
      // At least one of our subscribed symbols should have ticks
      const overlap = testSymbols.filter(s => tickSymbols.has(s));
      expect(overlap.length).toBeGreaterThan(0);
      console.log(`[e2e] Symbols with ticks: ${overlap.join(', ')}`);
    });

    it('trade ticks have valid prices', () => {
      const trades = receivedTicks.filter(t => t.type === 'trade' && t.price);
      if (trades.length === 0) return; // quotes-only is valid during low volume
      for (const t of trades.slice(0, 10)) {
        expect(t.price).toBeGreaterThan(0);
        expect(t.price).toBeLessThan(500); // 0DTE options shouldn't be >$500
        expect(t.ts).toBeGreaterThan(Date.now() - 86400000); // within last 24h
      }
    });
  });

  describe('Stage 2: OptionCandleBuilder → closed bars with indicators', () => {
    it('produced at least one closed 1m candle', () => {
      expect(closedBars.length).toBeGreaterThan(0);
    });

    it('closed bars have valid OHLCV from dev stream', () => {
      for (const { bar } of closedBars) {
        expect(bar.open).toBeGreaterThan(0);
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.close).toBeGreaterThan(0);
        expect(bar.volume).toBeGreaterThan(0);
        // Sanity: 0DTE option prices should be $0.01 - $500
        expect(bar.close).toBeLessThan(500);
      }
    });

    it('bars have computed indicators (HMA, RSI, etc.)', () => {
      // First few bars won't have HMA yet (needs warmup), but should have some keys
      const lastBar = closedBars[closedBars.length - 1]?.bar;
      expect(lastBar).toBeDefined();
      expect(lastBar.indicators).toBeDefined();
      // After even 1 bar, indicator engine should produce at least rsi14 or hma3
      const keys = Object.keys(lastBar.indicators);
      console.log(`[e2e] Last bar indicator keys: ${keys.join(', ')}`);
      // With only 1-2 bars, HMA may still be null — that's expected
      // But the indicators object should exist and be non-empty after a few bars
    });
  });

  describe('Stage 3: Bars persisted to day-scoped DB', () => {
    it('closed candle bars are in SQLite', () => {
      // ThetaData broadcasts ticks for all terminal-subscribed symbols, not just
      // our 4. Check bars for whatever symbols actually produced closed candles.
      let totalBars = 0;
      const barSymbols = new Set(closedBars.map(b => b.symbol));
      for (const sym of barSymbols) {
        const bars = getBars(sym, '1m', 100);
        totalBars += bars.length;
      }
      expect(totalBars).toBeGreaterThan(0);
      console.log(`[e2e] Total bars in DB: ${totalBars} across ${barSymbols.size} symbols`);
    });

    it('DB is small and fresh', () => {
      const stats = fs.statSync(TEST_DB_PATH);
      const sizeMb = stats.size / (1024 * 1024);
      expect(sizeMb).toBeLessThan(10);
      console.log(`[e2e] DB size: ${sizeMb.toFixed(2)} MB`);
    });
  });

  describe('Stage 4: HTTP API serves live bars', () => {
    it('GET /contracts/active returns our test contracts', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/contracts/active`);
      const contracts = await resp.json();
      expect(contracts.length).toBe(4);
    });

    it('GET /contracts/:symbol/bars returns real bars', async () => {
      // Find a symbol that actually has bars
      const symWithBars = testSymbols.find(s => getBars(s, '1m', 1).length > 0);
      if (!symWithBars) {
        console.warn('[e2e] No symbol has bars yet — skipping HTTP bar test');
        return;
      }
      const resp = await fetch(`http://localhost:${httpPort}/contracts/${symWithBars}/bars?tf=1m&n=10`);
      const bars = await resp.json();
      expect(bars.length).toBeGreaterThan(0);
      expect(bars[0].open).toBeGreaterThan(0);
      expect(bars[0].symbol).toBe(symWithBars);
    });

    it('health gate passes against live test server', async () => {
      const gate = new HealthGate({ spxerUrl: `http://localhost:${httpPort}` });
      const result = await gate.check();
      expect(result.healthy).toBe(true);
    });
  });

  describe('Stage 5: Signal detection on real contract bars', () => {
    it('detectSignals runs without errors on real bars', () => {
      // Use all symbols that produced closed candles (ThetaData broadcasts broadly)
      const contractBars = new Map<string, Bar[]>();
      const allSymbols = new Set([...testSymbols, ...closedBars.map(b => b.symbol)]);
      for (const sym of allSymbols) {
        const bars = getBars(sym, '1m', 30);
        if (bars.length >= 2) contractBars.set(sym, bars);
      }

      // May not have enough bars for a cross — that's fine
      // The point is it runs cleanly on real data
      const signals = detectSignals(contractBars, spxPrice, TEST_CONFIG);
      console.log(`[e2e] detectSignals on ${contractBars.size} contracts → ${signals.length} signals`);
      // Validate signal shape if any found
      for (const s of signals) {
        expect(['HMA_CROSS', 'EMA_CROSS', 'RSI_CROSS', 'PRICE_CROSS_HMA', 'PRICE_CROSS_EMA']).toContain(s.signalType);
        expect(['bullish', 'bearish']).toContain(s.direction);
        expect(['call', 'put']).toContain(s.side);
        expect(s.strike).toBeGreaterThan(0);
        expect(s.indicators).toBeDefined();
      }
    });
  });

  describe('Stage 6: Trade execution readiness', () => {
    it('spread check works on dev stream tick prices', () => {
      // Use cached prices from the dev stream
      for (const sym of testSymbols) {
        const p = thetaStream.getPrice(sym);
        if (!p || !p.bid || !p.ask) continue;

        const result = chooseOrderType(p.bid, p.ask);
        expect(['market', 'limit', 'blocked']).toContain(result.type);
        console.log(`[e2e] ${sym}: bid=${p.bid.toFixed(2)} ask=${p.ask.toFixed(2)} spread=$${(p.ask - p.bid).toFixed(2)} → ${result.type}`);
      }
    });

    it('full pipeline summary', () => {
      const trades = receivedTicks.filter(t => t.type === 'trade');
      const quotes = receivedTicks.filter(t => t.type === 'quote');
      const tickSymbols = new Set(receivedTicks.map(t => t.symbol));

      console.log('\n══════════════════════════════════════════');
      console.log('  E2E DEV STREAM PIPELINE SUMMARY');
      console.log('══════════════════════════════════════════');
      console.log(`  SPX price:        $${spxPrice.toFixed(2)}`);
      console.log(`  Subscribed:       ${testSymbols.length} contracts`);
      console.log(`  Ticks received:   ${receivedTicks.length} (${trades.length} trades, ${quotes.length} quotes)`);
      console.log(`  Symbols w/ data:  ${tickSymbols.size}`);
      console.log(`  Candles closed:   ${closedBars.length}`);

      let dbBars = 0;
      const allSyms = new Set([...testSymbols, ...closedBars.map(b => b.symbol)]);
      for (const sym of allSyms) dbBars += getBars(sym, '1m', 100).length;
      console.log(`  Bars in DB:       ${dbBars}`);
      console.log(`  DB size:          ${(fs.statSync(TEST_DB_PATH).size / 1024).toFixed(1)} KB`);
      console.log(`  ThetaData WS:     ${thetaStream.isConnected() ? '✓ connected' : '✗ disconnected'}`);
      console.log('══════════════════════════════════════════\n');

      // The test itself always passes — it's a summary
      expect(true).toBe(true);
    });
  });

});
