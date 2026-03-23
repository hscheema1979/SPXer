import { initDb } from './storage/db';
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
import type { Bar, Timeframe } from './types';

const HIGHER_TIMEFRAMES: [Timeframe, number][] = [['3m', 180], ['5m', 300], ['10m', 600], ['15m', 900], ['1h', 3600]];

const tracker = new ContractTracker(STRIKE_BAND, STRIKE_INTERVAL);
let lastSpxPrice: number | null = null;
let prevMode: string | null = null; // tracks mode transitions for VWAP reset

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
      const raw = await fetchSpxTimesales(today);
      if (raw.length) {
        bars = buildBars('SPX', '1m', raw.slice(-5));
      } else {
        // Timesales may lag on session open — fall back to live quote to prime lastSpxPrice
        const quote = await fetchSpxQuote();
        if (quote.last > 0) {
          const ts = Math.floor(Date.now() / 1000);
          bars = [rawToBar('SPX', '1m', { ts, open: quote.last, high: quote.ask || quote.last, low: quote.bid || quote.last, close: quote.last, volume: quote.volume ?? 0 })];
        }
      }
    } else {
      const raw = await fetchYahooBars('ES=F', '1m', '1d');
      bars = buildBars('ES', '1m', raw.slice(-5));
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
      broadcast({ type: 'spx_bar', data: enriched[enriched.length - 1] });
    }
  } catch (e) {
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
    // Uses real OHLCV from Tradier quotes (open/high/low/close/volume are session values)
    const tracked = tracker.getActive().concat(tracker.getSticky());
    if (tracked.length > 0) {
      const quotes = await fetchBatchQuotes(tracked.map(c => c.symbol));
      const ts = Math.floor(Date.now() / 1000);
      const minuteTs = ts - (ts % 60); // align to minute boundary
      const newBars: ReturnType<typeof rawToBar>[] = [];
      quotes.forEach((q, sym) => {
        const price = q.last ?? q.bid ?? q.ask;
        if (price === null || price <= 0) return;
        const bar = rawToBar(sym, '1m', {
          ts: minuteTs,
          open: q.open ?? price,
          high: q.high ?? Math.max(price, q.ask ?? price),
          low: q.low ?? Math.min(price, q.bid ?? price),
          close: price,
          volume: q.volume ?? 0,
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
  } catch (e) {
    console.error('[poll:options]', e);
  }
}

async function pollScreener(): Promise<void> {
  try {
    const snap = await fetchScreenerSnapshot();
    broadcast({ type: 'market_context', data: snap });
  } catch (e) {
    console.error('[poll:screener]', e);
  }
}

async function main(): Promise<void> {
  console.log('[SPXer] Starting...');

  if (!config.tradierToken) {
    console.warn('[SPXer] TRADIER_TOKEN not set — running in degraded mode (no live data)');
  }

  initDb(config.dbPath);
  loadContractsFromDb(); // restore ACTIVE/STICKY contracts from previous session

  if (config.tradierToken) {
    await warmup();
    // Run initial pollOptions to discover today's contracts, then backfill bars
    await pollOptions();
    await backfillOptionBars();
  }

  // Seed indicator state from DB so RSI/EMA are warm immediately (no 14-bar blind spot)
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

  // Seed tracked option contracts with tier 1 indicators across all timeframes
  const trackedContracts = tracker.getActive().concat(tracker.getSticky());
  for (const c of trackedContracts) {
    for (const tf of allTimeframes) {
      const histBars = getBars(c.symbol, tf, 50);
      if (histBars.length > 0) {
        seedState(c.symbol, tf as any, histBars);
        for (const bar of histBars) computeIndicators(bar, 2);
      }
    }
  }
  if (trackedContracts.length > 0) {
    console.log(`[startup] Seeded ${trackedContracts.length} option contracts across ${allTimeframes.length} timeframes`);
  }

  const { app, httpServer } = startHttpServer(config.port);
  startWsServer(httpServer); // pass http.Server, not Express app
  setTrackerCountFn(() => tracker.getActive().length + tracker.getSticky().length);

  setInterval(pollUnderlying, POLL_UNDERLYING_MS);
  const optionsInterval = getMarketMode() === 'rth' ? POLL_OPTIONS_RTH_MS : POLL_OPTIONS_OVERNIGHT_MS;
  setInterval(pollOptions, optionsInterval);
  setInterval(pollScreener, POLL_SCREENER_MS);

  // Reset VWAP exactly once on transition into RTH (not every minute during RTH)
  setInterval(() => {
    const mode = getMarketMode();
    if (mode === 'rth' && prevMode !== 'rth') {
      for (const sym of ['SPX', 'ES']) {
        resetVWAP(sym, '1m');
        for (const [tf] of HIGHER_TIMEFRAMES) resetVWAP(sym, tf);
      }
    }
    prevMode = mode;
  }, 60_000);

  console.log(`[SPXer] Running on port ${config.port}`);

  if (config.tradierToken) {
    await pollUnderlying();
    await pollOptions();
    await pollScreener();
  }

  // Graceful shutdown
  process.on('SIGTERM', () => { console.log('[SPXer] Shutting down'); process.exit(0); });
  process.on('SIGINT',  () => { console.log('[SPXer] Shutting down'); process.exit(0); });
}

main().catch(console.error);
