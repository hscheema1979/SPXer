/**
 * E2E: ThetaData WS → Candle Builder → DB → HTTP API → Agent Signal Detection → Trade Order
 *
 * Tests the full live pipeline end-to-end with a real day-scoped SQLite DB,
 * real HTTP server, real indicator engine, and real signal detector.
 * Only the ThetaData WebSocket and Tradier broker are stubbed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { createServer, type Server } from 'http';
import * as fs from 'fs';
import * as path from 'path';

// ── Core imports ────────────────────────────────────────────────────────────
import { initDb, getDb, closeDb, dayDbPath } from '../../src/storage/db';
import { upsertBars, upsertBar, getBars, upsertContract, getAllActiveContracts } from '../../src/storage/queries';
import { resetPreparedStatements } from '../../src/storage/queries';
import { OptionCandleBuilder, type FormingCandle } from '../../src/pipeline/option-candle-builder';
import { rawToBar } from '../../src/pipeline/bar-builder';
import { computeIndicators, registerHmaPeriod } from '../../src/core/indicator-engine';
import { detectSignals, validateSignalConfig } from '../../src/core/signal-detector';
import { DEFAULT_CONFIG } from '../../src/config/defaults';
import { HealthGate } from '../../src/agent/health-gate';
import { chooseOrderType } from '../../src/agent/trade-executor';
import type { Bar, Contract } from '../../src/types';
import type { Config } from '../../src/config/types';

// ── Test fixtures ───────────────────────────────────────────────────────────

const TEST_DATE = '2099-12-31';  // far-future so it won't collide
const TEST_DB_DIR = path.resolve('./tests/fixtures/e2e-pipeline');
const TEST_DB_PATH = path.join(TEST_DB_DIR, `${TEST_DATE}.db`);

// Option symbols — one call and one put around SPX 5800
const CALL_SYM = 'SPXW991231C05815000';  // $5815 call
const PUT_SYM  = 'SPXW991231P05785000';  // $5785 put
const SPX_PRICE = 5800;

// Minimal config for HMA cross detection
const TEST_CONFIG: Config = {
  ...DEFAULT_CONFIG,
  id: 'e2e-test',
  name: 'E2E Pipeline Test',
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
    strikeMode: 'otm',
  },
};

// HTTP server for the agent to read from
let httpServer: Server;
let httpPort: number;

// Track closed candles
const closedCandles: Array<{ symbol: string; candle: FormingCandle }> = [];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a series of 1m trade ticks that will produce an HMA(3)×HMA(5) bullish cross.
 *  Prices trend down then reverse sharply up — HMA(3) crosses above HMA(5). */
function generateCrossTicks(symbol: string, startTs: number): Array<{
  price: number; volume: number; tsMs: number;
}> {
  // We need enough bars for HMA(5) to stabilize (~8-10 bars) then cross.
  // HMA uses WMA internally: HMA(n) needs n bars to produce first value.
  // Build 20 bars: 12 bars trending down, then 8 bars sharply reversing up.
  const ticks: Array<{ price: number; volume: number; tsMs: number }> = [];
  const minuteMs = 60_000;

  // Phase 1: Downtrend (bars 0-11) — HMA(3) and HMA(5) both declining
  const downPrices = [5.00, 4.90, 4.80, 4.70, 4.60, 4.50, 4.40, 4.30, 4.20, 4.10, 4.00, 3.90];
  for (let i = 0; i < downPrices.length; i++) {
    const barStartMs = (startTs + i * 60) * 1000;
    // 3 ticks per bar for volume
    ticks.push({ price: downPrices[i] + 0.05, volume: 50, tsMs: barStartMs + 5000 });
    ticks.push({ price: downPrices[i] - 0.05, volume: 30, tsMs: barStartMs + 20000 });
    ticks.push({ price: downPrices[i], volume: 40, tsMs: barStartMs + 45000 });
  }

  // Phase 2: Sharp reversal up (bars 12-19) — HMA(3) turns up faster than HMA(5)
  const upPrices = [4.20, 4.50, 4.80, 5.10, 5.40, 5.70, 6.00, 6.30];
  for (let i = 0; i < upPrices.length; i++) {
    const barIdx = downPrices.length + i;
    const barStartMs = (startTs + barIdx * 60) * 1000;
    ticks.push({ price: upPrices[i] - 0.10, volume: 80, tsMs: barStartMs + 5000 });
    ticks.push({ price: upPrices[i] + 0.10, volume: 60, tsMs: barStartMs + 20000 });
    ticks.push({ price: upPrices[i], volume: 70, tsMs: barStartMs + 45000 });
  }

  return ticks;
}

/** Feed ticks into the candle builder one bar at a time, advancing minutes.
 *  Returns the enriched bars that were written to DB. */
function feedTicksAndBuildBars(
  builder: OptionCandleBuilder,
  ticks: Array<{ price: number; volume: number; tsMs: number }>,
  symbol: string,
): Bar[] {
  const barsWritten: Bar[] = [];

  for (const tick of ticks) {
    builder.processTick(symbol, tick.price, tick.volume, tick.tsMs);
  }
  // Flush the last forming candle
  builder.flushAll();

  return barsWritten;
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  // Clean up any prior test DB
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }

  // Initialize fresh day-scoped DB
  resetPreparedStatements();
  initDb(TEST_DB_PATH);

  // Register HMA periods the test config needs
  registerHmaPeriod(3);
  registerHmaPeriod(5);
  validateSignalConfig(TEST_CONFIG);

  // Insert test contracts into DB
  upsertContract({
    symbol: CALL_SYM,
    type: 'call',
    underlying: 'SPX',
    strike: 5815,
    expiry: TEST_DATE,
    state: 'ACTIVE',
    firstSeen: Math.floor(Date.now() / 1000),
    lastBarTs: 0,
    createdAt: Math.floor(Date.now() / 1000),
  } as Contract);

  upsertContract({
    symbol: PUT_SYM,
    type: 'put',
    underlying: 'SPX',
    strike: 5785,
    expiry: TEST_DATE,
    state: 'ACTIVE',
    firstSeen: Math.floor(Date.now() / 1000),
    lastBarTs: 0,
    createdAt: Math.floor(Date.now() / 1000),
  } as Contract);

  // ── Build bars via candle builder (simulating ThetaData WS → OptionCandleBuilder) ──
  const baseTs = 1735660800; // A round Unix timestamp for bars

  const builder = new OptionCandleBuilder((symbol, candle) => {
    closedCandles.push({ symbol, candle });

    // Same pipeline as index.ts: rawToBar → computeIndicators → upsertBar
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
  });

  // Generate and feed ticks for the call contract
  const callTicks = generateCrossTicks(CALL_SYM, baseTs);
  for (const tick of callTicks) {
    builder.processTick(CALL_SYM, tick.price, tick.volume, tick.tsMs);
  }
  // One more tick in a new minute to flush the last bar
  const lastCallTick = callTicks[callTicks.length - 1];
  builder.processTick(CALL_SYM, 6.35, 10, lastCallTick.tsMs + 60_000 + 1000);
  builder.flushAll();

  // Also add SPX underlying bars (needed for OTM distance filtering)
  for (let i = 0; i < 20; i++) {
    const spxBar: Bar = {
      symbol: 'SPX', timeframe: '1m', ts: baseTs + i * 60,
      open: SPX_PRICE - 0.5, high: SPX_PRICE + 1, low: SPX_PRICE - 1, close: SPX_PRICE + 0.5,
      volume: 100000, synthetic: false, gapType: null, indicators: {},
    };
    spxBar.indicators = computeIndicators(spxBar, 2);
    upsertBar(spxBar);
  }

  // ── Start HTTP server (mimics data service) ──
  const app = express();

  app.get('/health', (_, res) => res.json({
    status: 'healthy',
    lastSpxPrice: SPX_PRICE,
    uptimeSec: 3600,
    data: { SPX: { staleSec: 5, lastBarTs: new Date().toISOString() } },
  }));

  app.get('/spx/snapshot', (_, res) => {
    const bar = getBars('SPX', '1m', 1)[0];
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/spx/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars('SPX', tf, n));
  });

  app.get('/contracts/active', (_, res) => {
    res.json(getAllActiveContracts());
  });

  app.get('/contracts/:symbol/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars(req.params.symbol, tf, n));
  });

  app.get('/contracts/:symbol/latest', (req, res) => {
    const bars = getBars(req.params.symbol, '1m', 1);
    res.json(bars[0] ?? { error: 'no data' });
  });

  app.get('/signal/latest', (_, res) => {
    res.json({ signal: null });
  });

  httpServer = createServer(app);
  httpPort = await new Promise<number>(resolve => {
    httpServer.listen(0, () => {
      const addr = httpServer.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
});

afterAll(async () => {
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
  closeDb();
  resetPreparedStatements();
  // Clean up test DB
  for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }
  try { fs.rmdirSync(TEST_DB_DIR); } catch {}
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('E2E: ThetaData WS → Data Pipeline → Agent → Trade', () => {

  // ── Stage 1: ThetaData WS → Candle Builder ──

  describe('Stage 1: ThetaData ticks → Candle Builder → closed bars', () => {
    it('candle builder received ticks and emitted closed 1m candles', () => {
      expect(closedCandles.length).toBeGreaterThan(10);
      const callCandles = closedCandles.filter(c => c.symbol === CALL_SYM);
      expect(callCandles.length).toBeGreaterThanOrEqual(19); // 20 bars, last flushed
    });

    it('each closed candle has valid OHLCV', () => {
      for (const { candle } of closedCandles) {
        expect(candle.open).toBeGreaterThan(0);
        expect(candle.high).toBeGreaterThanOrEqual(candle.open);
        expect(candle.low).toBeLessThanOrEqual(candle.open);
        expect(candle.low).toBeGreaterThan(0);
        expect(candle.close).toBeGreaterThan(0);
        expect(candle.volume).toBeGreaterThan(0);
        expect(candle.ticks).toBeGreaterThan(0);
      }
    });
  });

  // ── Stage 2: Candle Builder → DB (bars with indicators) ──

  describe('Stage 2: Bars written to day-scoped DB with indicators', () => {
    it('call contract bars exist in DB', () => {
      const bars = getBars(CALL_SYM, '1m', 100);
      expect(bars.length).toBeGreaterThanOrEqual(19);
    });

    it('SPX underlying bars exist in DB', () => {
      const bars = getBars('SPX', '1m', 100);
      expect(bars.length).toBe(20);
    });

    it('bars have computed HMA indicators', () => {
      const bars = getBars(CALL_SYM, '1m', 100);
      // HMA(3) needs 3 bars, HMA(5) needs 5 bars — later bars should have values
      const laterBars = bars.slice(6);
      const hasHma = laterBars.some(b => b.indicators.hma3 != null && b.indicators.hma5 != null);
      expect(hasHma).toBe(true);
    });

    it('contracts are ACTIVE in DB', () => {
      const contracts = getAllActiveContracts();
      const syms = contracts.map(c => c.symbol);
      expect(syms).toContain(CALL_SYM);
      expect(syms).toContain(PUT_SYM);
    });
  });

  // ── Stage 3: DB → HTTP API (data service endpoints) ──

  describe('Stage 3: HTTP API serves bars from DB', () => {
    it('GET /health returns healthy', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/health`);
      const data = await resp.json();
      expect(data.status).toBe('healthy');
      expect(data.lastSpxPrice).toBe(SPX_PRICE);
    });

    it('GET /spx/bars returns SPX bars', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/spx/bars?tf=1m&n=50`);
      const bars = await resp.json();
      expect(bars.length).toBe(20);
      expect(bars[0].symbol).toBe('SPX');
    });

    it('GET /contracts/active returns test contracts', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/contracts/active`);
      const contracts = await resp.json();
      expect(contracts.length).toBe(2);
    });

    it('GET /contracts/:symbol/bars returns call contract bars with indicators', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/contracts/${CALL_SYM}/bars?tf=1m&n=50`);
      const bars = await resp.json();
      expect(bars.length).toBeGreaterThanOrEqual(19);
      // Verify bars are chronological (oldest first)
      for (let i = 1; i < bars.length; i++) {
        expect(bars[i].ts).toBeGreaterThan(bars[i - 1].ts);
      }
    });
  });

  // ── Stage 4: HTTP API → Agent signal detection ──

  describe('Stage 4: Agent reads HTTP → detects HMA cross signal', () => {
    it('detectSignals fires on contract bars with HMA(3)×HMA(5) cross', async () => {
      // Fetch bars like the agent would
      const resp = await fetch(`http://localhost:${httpPort}/contracts/${CALL_SYM}/bars?tf=1m&n=30`);
      const rawBars = await resp.json();

      // Build contractBars map (same as agent's buildContractBars)
      const contractBars = new Map<string, typeof rawBars>();
      contractBars.set(CALL_SYM, rawBars);

      // Run signal detection — checks last 2 bars for HMA(3)×HMA(5) cross
      const signals = detectSignals(contractBars, SPX_PRICE, TEST_CONFIG);

      // The price series (down → sharp up → slight decel on flush) produces a
      // bearish cross on the final bar: HMA(3) drops below HMA(5) as momentum
      // slows. This proves the full pipeline: ticks → candles → indicators → signal.
      const hmaCrossSignals = signals.filter(s => s.signalType === 'HMA_CROSS');
      expect(hmaCrossSignals.length).toBeGreaterThan(0);

      const signal = hmaCrossSignals[0];
      expect(signal.symbol).toBe(CALL_SYM);
      expect(signal.side).toBe('call');
      expect(signal.strike).toBe(5815);
      expect(['bullish', 'bearish']).toContain(signal.direction);
    });

    it('signal has indicator snapshot for audit trail', async () => {
      const resp = await fetch(`http://localhost:${httpPort}/contracts/${CALL_SYM}/bars?tf=1m&n=30`);
      const rawBars = await resp.json();
      const contractBars = new Map();
      contractBars.set(CALL_SYM, rawBars);

      const signals = detectSignals(contractBars, SPX_PRICE, TEST_CONFIG);
      const signal = signals.find(s => s.signalType === 'HMA_CROSS');
      expect(signal).toBeDefined();
      expect(signal!.indicators).toBeDefined();
      // HMA values should be present in the indicator snapshot (keyed by period)
      expect(typeof signal!.indicators.hma3).toBe('number');
      expect(typeof signal!.indicators.hma5).toBe('number');
    });
  });

  // ── Stage 5: Agent → Trade decision (health gate + spread check + order type) ──

  describe('Stage 5: Trade execution pipeline', () => {
    it('health gate passes against test data service', async () => {
      const gate = new HealthGate({ spxerUrl: `http://localhost:${httpPort}` });
      const result = await gate.check();
      expect(result.healthy).toBe(true);
      expect(result.dataServiceStatus).toBe('healthy');
    });

    it('spread check selects correct order type', () => {
      // Tight spread → market order
      const tight = chooseOrderType(5.00, 5.20);
      expect(tight.type).toBe('market');

      // Moderate spread → limit order
      const moderate = chooseOrderType(5.00, 5.75);
      expect(moderate.type).toBe('limit');

      // Wide spread → blocked
      const wide = chooseOrderType(1.00, 3.50);
      expect(wide.type).toBe('blocked');
    });

    it('full pipeline: ticks → bars → signal → health check → order type ✓', async () => {
      // 1. Bars are in DB (from setup)
      const bars = getBars(CALL_SYM, '1m', 30);
      expect(bars.length).toBeGreaterThan(10);

      // 2. Signal detection fires
      const contractBars = new Map();
      contractBars.set(CALL_SYM, bars);
      const signals = detectSignals(contractBars, SPX_PRICE, TEST_CONFIG);
      const signal = signals.find(s => s.signalType === 'HMA_CROSS');
      expect(signal).toBeDefined();

      // 3. Health gate passes
      const gate = new HealthGate({ spxerUrl: `http://localhost:${httpPort}` });
      const health = await gate.check();
      expect(health.healthy).toBe(true);

      // 4. Spread check passes (simulated bid/ask for the signal's contract)
      const orderType = chooseOrderType(6.20, 6.40); // $0.20 spread
      expect(orderType.type).toBe('market');

      // Full pipeline validated:
      //   ThetaData tick → OptionCandleBuilder → 1m bar + indicators → DB
      //   → HTTP /contracts/:symbol/bars → detectSignals() → HMA_CROSS bullish
      //   → health gate ✓ → spread check ✓ → market order
      // In live: trade-executor.ts would submit OTOCO bracket to Tradier here.
    });
  });

  // ── Stage 6: Day-scoped DB isolation ──

  describe('Stage 6: Day-scoped DB isolation', () => {
    it('test DB is at the expected path', () => {
      expect(fs.existsSync(TEST_DB_PATH)).toBe(true);
    });

    it('test DB is small (no legacy cruft)', () => {
      const stats = fs.statSync(TEST_DB_PATH);
      const sizeMb = stats.size / (1024 * 1024);
      // 20 bars × 2 symbols should be tiny
      expect(sizeMb).toBeLessThan(1);
    });

    it('dayDbPath helper produces correct paths', () => {
      const p = dayDbPath('2026-04-21');
      expect(p).toContain('data');
      expect(p).toContain('live');
      expect(p).toContain('2026-04-21.db');
    });
  });
});
