import { initDb } from './storage/db';
import { getAllActiveContracts, upsertBar, upsertBars, upsertContract, getDbSizeMb } from './storage/queries';
import { fetchYahooBars } from './providers/yahoo';
import { fetchSpxQuote, fetchOptionsChain, fetchExpirations, fetchSpxTimesales, fetchBatchQuotes } from './providers/tradier';
import { fetchScreenerSnapshot } from './providers/tv-screener';
import { buildBars, fillGaps, rawToBar } from './pipeline/bar-builder';
import { aggregate } from './pipeline/aggregator';
import { computeIndicators, seedState, resetVWAP } from './pipeline/indicator-engine';
import { ContractTracker } from './pipeline/contract-tracker';
import { getMarketMode, getActiveExpirations } from './pipeline/scheduler';
import { startHttpServer, setLastSpxPrice, setTrackerCountFn } from './server/http';
import { startWsServer, broadcast } from './server/ws';
import { config, STRIKE_BAND, STRIKE_INTERVAL, POLL_UNDERLYING_MS, POLL_OPTIONS_RTH_MS, POLL_OPTIONS_OVERNIGHT_MS, POLL_SCREENER_MS } from './config';

const tracker = new ContractTracker(STRIKE_BAND, STRIKE_INTERVAL);
let lastSpxPrice: number | null = null;
let prevMode: string | null = null; // tracks mode transitions for VWAP reset

function loadContractsFromDb(): void {
  // Reload ACTIVE/STICKY contracts into tracker on startup so sticky state survives restarts
  const persisted = getAllActiveContracts();
  for (const contract of persisted) {
    tracker.restoreContract(contract);
  }
  console.log(`[startup] Restored ${persisted.length} active/sticky contracts from DB`);
}

async function warmup(): Promise<void> {
  console.log('[startup] Warming up ES=F overnight bars...');
  const rawBars = await fetchYahooBars('ES=F', '1m', '2d');
  const bars = fillGaps('ES', '1m', buildBars('ES', '1m', rawBars), 60);
  const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
  upsertBars(enriched);

  // Aggregate to higher timeframes
  for (const [tf, secs] of [['5m', 300], ['15m', 900], ['1h', 3600]] as const) {
    const agg = aggregate(enriched, tf, secs).map(b => ({
      ...b, indicators: computeIndicators(b, 2)
    }));
    upsertBars(agg);
  }
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

    // Batch-quote update for already-tracked contracts (avoids full chain re-fetch overhead)
    const tracked = tracker.getActive().concat(tracker.getSticky());
    if (tracked.length > 0) {
      const quotes = await fetchBatchQuotes(tracked.map(c => c.symbol));
      quotes.forEach((q, sym) => broadcast({ type: 'contract_bar', symbol: sym, data: q }));
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
      resetVWAP('SPX', '1m');
      resetVWAP('ES', '1m');
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
