import { initDb, getDb, closeDb } from './storage/db';
import { getAllActiveContracts, upsertBar, upsertBars, upsertContract, getDbSizeMb, getBars } from './storage/queries';
import { fetchYahooBars } from './providers/yahoo';
import { fetchSpxQuote, fetchOptionsChain, fetchExpirations, fetchSpxTimesales, fetchBatchQuotes, fetchTimesales } from './providers/tradier';
import { fetchScreenerSnapshot } from './providers/tv-screener';
import { buildBars, fillGaps, rawToBar } from './pipeline/bar-builder';
import { aggregate } from './pipeline/aggregator';
import { computeIndicators, seedState, resetVWAP } from './pipeline/indicator-engine';
import { ContractTracker } from './pipeline/contract-tracker';
import { getMarketMode, getActiveExpirations } from './pipeline/scheduler';
import { startHttpServer, setLastSpxPrice, setTrackerCountFn } from './server/http';
import { startWsServer, broadcast } from './server/ws';
import { config, STRIKE_BAND, STRIKE_INTERVAL, POLL_UNDERLYING_MS, POLL_OPTIONS_RTH_MS, POLL_OPTIONS_OVERNIGHT_MS, POLL_SCREENER_MS } from './config';
import { healthTracker } from './utils/health';
import type { Bar, Timeframe } from './types';

const HIGHER_TIMEFRAMES: [Timeframe, number][] = [['3m', 180], ['5m', 300], ['10m', 600], ['15m', 900], ['1h', 3600]];

const tracker = new ContractTracker(STRIKE_BAND, STRIKE_INTERVAL);
let lastSpxPrice: number | null = null;
let prevMode: string | null = null; // tracks mode transitions for VWAP reset

// Per-symbol 1m candle state for options — built incrementally from quote snapshots
const optionBarState = new Map<string, { minuteTs: number; open: number; high: number; low: number; volume: number }>();

// ── SPX Tick Stream → 1m Candle Builder ─────────────────────────────────────
// Streams SPX trades from Tradier for tick-accurate 1m candles.
// Options stay on REST polling (too many symbols to stream efficiently).
import { PriceStream } from './agent/price-stream';

const spxStream = new PriceStream();
let spxCandle: { minuteTs: number; open: number; high: number; low: number; close: number; volume: number; ticks: number } | null = null;
let spxCandleTimer: ReturnType<typeof setInterval> | null = null;

function initSpxStream(): void {
  spxStream.onPrice((_symbol, last, bid, ask) => {
    if (last <= 0) return;
    const ts = Math.floor(Date.now() / 1000);
    const minuteTs = ts - (ts % 60);

    if (!spxCandle || spxCandle.minuteTs !== minuteTs) {
      // New minute — close previous candle if it exists, start new one
      if (spxCandle && spxCandle.ticks > 0) {
        closeSpxCandle(spxCandle);
      }
      spxCandle = { minuteTs, open: last, high: last, low: last, close: last, volume: 0, ticks: 0 };
    }

    // Update current candle
    if (last > spxCandle.high) spxCandle.high = last;
    if (last < spxCandle.low) spxCandle.low = last;
    spxCandle.close = last;
    spxCandle.ticks++;

    // Update last price for contract tracking
    lastSpxPrice = last;
    setLastSpxPrice(last);
  });

  // Safety: close candle on minute boundary even if no new ticks arrive
  spxCandleTimer = setInterval(() => {
    if (!spxCandle) return;
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = now - (now % 60);
    if (spxCandle.minuteTs < currentMinute && spxCandle.ticks > 0) {
      closeSpxCandle(spxCandle);
      spxCandle = null;
    }
  }, 5000); // check every 5s

  spxStream.start(['SPX']);
  console.log('[stream] SPX tick stream started for candle building');
}

function closeSpxCandle(candle: NonNullable<typeof spxCandle>): void {
  const symbol = getMarketMode() === 'rth' ? 'SPX' : 'ES';
  const bar = rawToBar(symbol, '1m', {
    ts: candle.minuteTs,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  });
  const enriched = { ...bar, indicators: computeIndicators(bar, 2) };
  upsertBars([enriched]);

  // Aggregate to higher timeframes
  const recent1m = getBars(symbol, '1m', 60);
  if (recent1m.length > 0) aggregateAndStore(recent1m, 2);

  healthTracker.recordBar(symbol, candle.minuteTs * 1000);
  broadcast({ type: 'spx_bar', data: enriched });

  // Detect HMA cross signal on the closed candle
  if (symbol === 'SPX') {
    detectHmaCrossSignal(enriched);
  }

  console.log(`[stream] SPX 1m candle closed: O=${candle.open.toFixed(2)} H=${candle.high.toFixed(2)} L=${candle.low.toFixed(2)} C=${candle.close.toFixed(2)} (${candle.ticks} ticks)`);
}

function stopSpxStream(): void {
  spxStream.stop();
  if (spxCandleTimer) { clearInterval(spxCandleTimer); spxCandleTimer = null; }
}

// ── HMA Cross Signal Detection ──────────────────────────────────────────────
// Detects HMA(3)×HMA(17) crossovers at the data pipeline level.
// Fires exactly once per candle close — agents subscribe via WebSocket
// instead of polling. The signal IS the trigger, not something to check for.
let prevHma3: number | null = null;
let prevHma17: number | null = null;
let lastHmaSignal: { type: string; direction: string; ts: number; price: number; hmaFast: number; hmaSlow: number } | null = null;

/** Get the last HMA cross signal (for REST API) */
export function getLastHmaSignal() { return lastHmaSignal; }

function detectHmaCrossSignal(bar: Bar): void {
  const hma3 = bar.indicators?.hma3;
  const hma17 = bar.indicators?.hma17;
  if (hma3 == null || hma17 == null) return;

  if (prevHma3 != null && prevHma17 != null) {
    const wasFastAbove = prevHma3 > prevHma17;
    const isFastAbove = hma3 > hma17;

    if (!wasFastAbove && isFastAbove) {
      const signal = {
        type: 'hma_cross_signal' as const,
        direction: 'bullish' as const,
        ts: bar.ts,
        price: bar.close,
        hmaFast: hma3,
        hmaSlow: hma17,
      };
      console.log(`[signal] 🔼 BULLISH HMA(3)×HMA(17) cross @ ${bar.close.toFixed(2)} (candle ts=${bar.ts})`);
      lastHmaSignal = signal;
      broadcast(signal);
    } else if (wasFastAbove && !isFastAbove) {
      const signal = {
        type: 'hma_cross_signal' as const,
        direction: 'bearish' as const,
        ts: bar.ts,
        price: bar.close,
        hmaFast: hma3,
        hmaSlow: hma17,
      };
      console.log(`[signal] 🔽 BEARISH HMA(3)×HMA(17) cross @ ${bar.close.toFixed(2)} (candle ts=${bar.ts})`);
      lastHmaSignal = signal;
      broadcast(signal);
    }
  }

  prevHma3 = hma3;
  prevHma17 = hma17;
}

/** Aggregate 1m bars to all higher timeframes (3m, 5m, 15m, 1h) with indicator computation */
function aggregateAndStore(bars1m: Bar[], tier: 1 | 2 = 1): void {
  for (const [tf, secs] of HIGHER_TIMEFRAMES) {
    const agg = aggregate(bars1m, tf, secs).map(b => ({
      ...b, indicators: computeIndicators(b, tier)
    }));
    if (agg.length > 0) upsertBars(agg);
  }
}

function loadContractsFromDb(): void {
  // Reload ACTIVE/STICKY contracts into tracker on startup so sticky state survives restarts
  const persisted = getAllActiveContracts();
  for (const contract of persisted) {
    tracker.restoreContract(contract);
  }
  console.log(`[startup] Restored ${persisted.length} active/sticky contracts from DB`);
}

/** Backfill 1m bars from Tradier timesales for tracked option contracts */
async function backfillOptionBars(): Promise<void> {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tracked = tracker.getActive().concat(tracker.getSticky());
  const todayContracts = tracked.filter(c => c.expiry === today || c.expiry > today);
  if (todayContracts.length === 0) return;

  console.log(`[backfill] Fetching timesales for ${todayContracts.length} contracts...`);
  let totalBars = 0;

  // Process in batches of 10 to avoid rate limits
  for (let i = 0; i < todayContracts.length; i += 10) {
    const batch = todayContracts.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async c => {
        // Omit date for option contracts — Tradier returns null with explicit dates
        const raw = await fetchTimesales(c.symbol);
        if (raw.length === 0) return 0;
        const bars = raw.map(r => {
          const bar = rawToBar(c.symbol, '1m', r);
          return { ...bar, indicators: computeIndicators(bar, 2) };
        });
        upsertBars(bars);
        // Aggregate to higher timeframes
        aggregateAndStore(bars, 2);
        return bars.length;
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') totalBars += r.value;
    }
  }
  console.log(`[backfill] Persisted ${totalBars} bars across ${todayContracts.length} contracts`);
}

async function warmup(): Promise<void> {
  console.log('[startup] Warming up ES=F overnight bars...');
  const rawBars = await fetchYahooBars('ES=F', '1m', '2d');
  const bars = fillGaps('ES', '1m', buildBars('ES', '1m', rawBars), 60);
  const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
  upsertBars(enriched);

  // Aggregate to higher timeframes (3m, 5m, 15m, 1h)
  aggregateAndStore(enriched, 2);
  console.log(`[startup] Warmed ${enriched.length} ES 1m bars`);
}

async function pollUnderlying(): Promise<void> {
  const mode = getMarketMode();
  const today = new Date().toISOString().split('T')[0];

  try {
    let bars: ReturnType<typeof buildBars> | undefined;
    if (mode === 'rth') {
      // Fetch without date filter — Tradier returns null for SPX timesales with explicit dates
      // but returns proper 1m OHLCV bars without date params (defaults to current session)
      const raw = await fetchTimesales('SPX');
      if (raw.length) {
        bars = buildBars('SPX', '1m', raw.slice(-5));
      } else {
        // Timesales may lag on session open — fall back to live quote to prime lastSpxPrice
        const quote = await fetchSpxQuote();
        if (quote && quote.last > 0) {
          const ts = Math.floor(Date.now() / 1000);
          bars = [rawToBar('SPX', '1m', { ts, open: quote.last, high: quote.ask || quote.last, low: quote.bid || quote.last, close: quote.last, volume: quote.volume ?? 0 })];
        }
      }
      healthTracker.recordSuccess('tradier');
    } else {
      const raw = await fetchYahooBars('ES=F', '1m', '1d');
      bars = buildBars('ES', '1m', raw.slice(-5));
      healthTracker.recordSuccess('yahoo');
    }

    if (bars?.length) {
      const symbol = mode === 'rth' ? 'SPX' : 'ES';
      const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
      upsertBars(enriched);

      // Aggregate to higher timeframes — fetch recent 1m bars for proper aggregation
      const recent1m = getBars(symbol, '1m', 60);
      if (recent1m.length > 0) aggregateAndStore(recent1m, 2);

      lastSpxPrice = enriched[enriched.length - 1].close;
      setLastSpxPrice(lastSpxPrice);
      const lastBar = enriched[enriched.length - 1];
      healthTracker.recordBar(symbol, lastBar.ts * 1000);
      broadcast({ type: 'spx_bar', data: lastBar });

      // Detect HMA cross signal on the newly closed candle
      // Only check during RTH on SPX bars (not overnight ES)
      if (symbol === 'SPX') {
        detectHmaCrossSignal(lastBar);
      }
    }
  } catch (e) {
    healthTracker.recordFailure(mode === 'rth' ? 'tradier' : 'yahoo');
    console.error('[poll:underlying]', e);
  }
}

async function pollOptions(): Promise<void> {
  if (!lastSpxPrice) return;
  try {
    const expirations = await fetchExpirations('SPX');
    const today = new Date().toISOString().split('T')[0];
    const active = getActiveExpirations(today, expirations);

    // Full chain fetch to discover new contracts entering the band
    for (const expiry of active) {
      const chain = await fetchOptionsChain('SPX', expiry);
      const added = tracker.updateBand(lastSpxPrice, chain.map(c => ({
        symbol: c.symbol, strike: c.strike, expiry: c.expiry, type: c.type
      })));
      for (const c of added) upsertContract(c);
      if (added.length) console.log(`[poll:options] added ${added.length} contracts for ${expiry}`);
      broadcast({ type: 'chain_update', expiry, data: chain });
    }

    // Batch-quote update for already-tracked contracts → build bars + persist
    // We build 1m candles incrementally from quote snapshots (last/bid/ask).
    // Tradier's q.open/high/low are SESSION-level, not candle-level — don't use them.
    const tracked = tracker.getActive().concat(tracker.getSticky());
    if (tracked.length > 0) {
      const quotes = await fetchBatchQuotes(tracked.map(c => c.symbol));
      const ts = Math.floor(Date.now() / 1000);
      const minuteTs = ts - (ts % 60); // align to minute boundary
      const newBars: ReturnType<typeof rawToBar>[] = [];
      quotes.forEach((q, sym) => {
        const price = q.last ?? q.bid ?? q.ask;
        if (price === null || price <= 0) return;

        // Build proper 1m candle from quote snapshot:
        // Track open/high/low per minute in optionBarState
        let state = optionBarState.get(sym);
        if (!state || state.minuteTs !== minuteTs) {
          // New minute — start fresh candle with current price as open
          state = { minuteTs, open: price, high: price, low: price, volume: 0 };
          optionBarState.set(sym, state);
        }
        // Update high/low within the minute
        if (price > state.high) state.high = price;
        if (price < state.low) state.low = price;
        state.volume += (q.volume ?? 0) - state.volume; // session volume delta approximation

        const bar = rawToBar(sym, '1m', {
          ts: minuteTs,
          open: state.open,
          high: state.high,
          low: state.low,
          close: price,
          volume: state.volume,
        });
        const enriched = { ...bar, indicators: computeIndicators(bar, 2) };
        newBars.push(enriched);
        broadcast({ type: 'contract_bar', symbol: sym, data: q });
      });
      if (newBars.length > 0) {
        upsertBars(newBars);

        // Aggregate option bars to higher timeframes per symbol
        const bySymbol = new Map<string, Bar[]>();
        for (const b of newBars) {
          if (!bySymbol.has(b.symbol)) bySymbol.set(b.symbol, []);
          bySymbol.get(b.symbol)!.push(b as Bar);
        }
        for (const [sym] of bySymbol) {
          const recent1m = getBars(sym, '1m', 60);
          if (recent1m.length > 0) aggregateAndStore(recent1m, 2);
        }
      }
    }

    tracker.checkExpiries();
    healthTracker.recordSuccess('tradier-options');
  } catch (e) {
    healthTracker.recordFailure('tradier-options');
    console.error('[poll:options]', e);
  }
}

async function pollScreener(): Promise<void> {
  try {
    const snap = await fetchScreenerSnapshot();
    broadcast({ type: 'market_context', data: snap });
    healthTracker.recordSuccess('tvScreener');
  } catch (e) {
    healthTracker.recordFailure('tvScreener');
    console.error('[poll:screener]', e);
  }
}

/**
 * Seed indicator state for a large list of contracts without blocking the
 * event loop. Processes CHUNK contracts per tick, yielding via setImmediate
 * between chunks so the HTTP server can handle requests during startup.
 */
async function seedContractsChunked(contracts: import('./types').Contract[], allTimeframes: string[]): Promise<void> {
  const CHUNK = 20;
  for (let i = 0; i < contracts.length; i += CHUNK) {
    const chunk = contracts.slice(i, i + CHUNK);
    for (const c of chunk) {
      for (const tf of allTimeframes) {
        const histBars = getBars(c.symbol, tf, 50);
        if (histBars.length > 0) {
          seedState(c.symbol, tf as any, histBars);
          for (const bar of histBars) computeIndicators(bar, 2);
        }
      }
    }
    // Yield to event loop between chunks
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

// ── Shutdown state ──
let shuttingDown = false;
const intervals: NodeJS.Timeout[] = [];
let httpServerRef: import('http').Server | null = null;
let wsServerRef: import('ws').WebSocketServer | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, cleaning up...`);

  // Safety timeout — force exit after 5s if cleanup hangs
  setTimeout(() => {
    console.log('[shutdown] forced exit after 5s timeout');
    process.exit(1);
  }, 5000).unref();

  // 1. Stop all polling intervals
  for (const id of intervals) clearInterval(id);

  // 2. Notify WebSocket clients and close WS server
  try {
    broadcast({ type: 'service_shutdown' });
  } catch {}
  if (wsServerRef) {
    try {
      for (const client of wsServerRef.clients) {
        try { client.close(); } catch {}
      }
      wsServerRef.close();
    } catch {}
  }

  // 3. Close HTTP server
  if (httpServerRef) {
    try {
      httpServerRef.close();
    } catch {}
  }

  // 4. Checkpoint WAL and close database
  try {
    const db = getDb();
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {}
  try {
    closeDb();
  } catch {}

  console.log('[shutdown] clean exit');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function main(): Promise<void> {
  console.log('[SPXer] Starting...');

  if (!config.tradierToken) {
    console.warn('[SPXer] TRADIER_TOKEN not set — running in degraded mode (no live data)');
  }

  // ── initDb — retry up to 3 times with 2s delay (no DB = no service) ──
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      initDb(config.dbPath);
      break;
    } catch (e) {
      console.error(`[startup] initDb failed (attempt ${attempt}/3):`, e);
      if (attempt === 3) {
        console.error('[startup] All DB init attempts failed, cannot start');
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── loadContractsFromDb — non-fatal, start with empty contracts ──
  try {
    loadContractsFromDb();
  } catch (e) {
    console.warn('[startup] DB read failed, starting with empty contracts:', e);
  }

  if (config.tradierToken) {
    // ── warmup — non-fatal, continue without history ──
    try {
      await warmup();
    } catch (e) {
      console.warn('[startup] warmup failed (provider down?), starting without history:', e);
    }

    // ── Initial pollOptions + backfillOptionBars — non-fatal ──
    try {
      await pollOptions();
    } catch (e) {
      console.warn('[startup] initial pollOptions failed, will pick up on next cycle:', e);
    }
    try {
      await backfillOptionBars();
    } catch (e) {
      console.warn('[startup] initial backfillOptionBars failed, will pick up on next cycle:', e);
    }
  }

  // ── seedIndicatorState — non-fatal, indicators will warm up naturally ──
  try {
    const allTimeframes = ['1m', ...HIGHER_TIMEFRAMES.map(([t]) => t)];

    // Seed underlying (SPX/ES) with tier 2 indicators
    for (const sym of ['SPX', 'ES']) {
      for (const tf of allTimeframes) {
        const histBars = getBars(sym, tf, 50);
        if (histBars.length > 0) {
          seedState(sym, tf as any, histBars);
          for (const bar of histBars) computeIndicators(bar, 2);
          console.log(`[startup] Seeded ${sym} ${tf} indicator state from ${histBars.length} bars`);
        }
      }
    }

    // Seed tracked option contracts with tier 1 indicators across all timeframes.
    // Chunked with setImmediate to avoid blocking the event loop for 30+ seconds.
    const trackedContracts = tracker.getActive().concat(tracker.getSticky());
    if (trackedContracts.length > 0) {
      await seedContractsChunked(trackedContracts, allTimeframes);
      console.log(`[startup] Seeded ${trackedContracts.length} option contracts across ${allTimeframes.length} timeframes`);
    }
  } catch (e) {
    console.warn('[startup] seedIndicatorState failed, indicators will warm up from incoming bars:', e);
  }

  const { httpServer } = startHttpServer(config.port);
  httpServerRef = httpServer;
  wsServerRef = startWsServer(httpServer);
  setTrackerCountFn(() => tracker.getActive().length + tracker.getSticky().length);

  intervals.push(setInterval(pollUnderlying, POLL_UNDERLYING_MS));
  const optionsInterval = getMarketMode() === 'rth' ? POLL_OPTIONS_RTH_MS : POLL_OPTIONS_OVERNIGHT_MS;
  intervals.push(setInterval(pollOptions, optionsInterval));
  intervals.push(setInterval(pollScreener, POLL_SCREENER_MS));

  // Reset VWAP exactly once on transition into RTH (not every minute during RTH)
  intervals.push(setInterval(() => {
    const mode = getMarketMode();
    if (mode === 'rth' && prevMode !== 'rth') {
      for (const sym of ['SPX', 'ES']) {
        resetVWAP(sym, '1m');
        for (const [tf] of HIGHER_TIMEFRAMES) resetVWAP(sym, tf);
      }
    }
    prevMode = mode;
  }, 60_000));

  // Periodic health check — log warnings when providers are degraded or data is stale
  intervals.push(setInterval(() => {
    const report = healthTracker.getStatus();
    if (report.status === 'critical') {
      console.error('[health] CRITICAL: all providers down');
    } else if (report.status === 'degraded') {
      console.warn('[health] DEGRADED: some providers failing');
    }
    const spxData = report.data['SPX'];
    if (spxData && spxData.staleSec > 120) {
      const currentMode = getMarketMode();
      if (currentMode === 'rth') {
        console.warn(`[health] SPX data stale: ${spxData.staleSec}s since last bar`);
      }
    }
  }, 60_000));

  console.log(`[SPXer] Running on port ${config.port}`);

  if (config.tradierToken) {
    // Delay first polls by 2 seconds so the HTTP server can process requests
    // before the event loop is occupied by the first round of network calls.
    setTimeout(async () => {
      await pollUnderlying();
      await pollOptions();
      await pollScreener();
    }, 2000);
  }
}

main().catch(console.error);
