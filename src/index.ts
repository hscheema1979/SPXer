import { initDb, getDb, closeDb, dayDbPath, previousTradingDay, copyWarmupBars } from './storage/db';
import { getAllActiveContracts, upsertBar, upsertBars, upsertContract, getDbSizeMb, getBars, getLatestBar, expireContractsBefore, expireContractsOnDate, insertSignal } from './storage/queries';
import { fetchSpxQuote, fetchOptionsChain, fetchExpirations, fetchSpxTimesales, fetchBatchQuotes, fetchTimesales } from './providers/tradier';
import { fetchScreenerSnapshot } from './providers/tv-screener';
import { buildBars, fillGaps, rawToBar } from './pipeline/bar-builder';
import { aggregate } from './pipeline/aggregator';
import { computeIndicators, seedState, resetVWAP } from './pipeline/indicator-engine';
import { registerHmaPeriod, getActiveHmaPeriods } from './core/indicator-engine';
import { validateSignalConfig, parseSymbol } from './core/signal-detector';
import { createStore } from './replay/store';
import { ContractTracker } from './pipeline/spx/contract-tracker';
import { getMarketMode, getActiveExpirations } from './pipeline/spx/scheduler';
import { initSignalsDb, closeSignalsDb } from './storage/signals-db';
import { startHttpServer, setLastSpxPrice, setTrackerCountFn, setOptionStreamStatusFn } from './server/http';
import { startWsServer, broadcast } from './server/ws';
import { config, STRIKE_BAND, STRIKE_INTERVAL, POLL_UNDERLYING_MS, POLL_OPTIONS_RTH_MS, POLL_OPTIONS_OVERNIGHT_MS, POLL_SCREENER_MS, OPTION_STREAM_WAKE_ET, OPTION_STREAM_CLOSE_ET, OPTION_STREAM_THETA_STALE_MS } from './config';
import { healthTracker } from './utils/health';
import { OptionStream } from './pipeline/spx/option-stream';
import { PriceLine } from './pipeline/price-line';
import { ThetaDataStream } from './providers/thetadata-stream';
import { todayET, nowET } from './utils/et-time';
import type { Bar, Timeframe } from './types';
import { pipelineHealth, recordModeTransition } from './ops/pipeline-health';
import { startAlertMonitor } from './ops/alerter';
import { startAlertEngine } from './ops/alert-rules';

const HIGHER_TIMEFRAMES: [Timeframe, number][] = [['3m', 180], ['5m', 300], ['10m', 600], ['15m', 900], ['1h', 3600]];

// HMA pairs to detect crosses for (common pairs used by configs)
const HMA_PAIRS: [number, number][] = [
  [3, 12],
  [3, 19],
  [5, 19],
];

// Only broadcast contract signals for strikes within ±$25 of SPX (covers ITM5/ATM/OTM5 range)
const SIGNAL_STRIKE_BAND = 30;

const tracker = new ContractTracker(STRIKE_BAND, STRIKE_INTERVAL);
let lastSpxPrice: number | null = null;
let prevMode: string | null = null; // tracks mode transitions for VWAP reset
let currentDbDate: string = '';

// Per-symbol 1m candle state for options — built incrementally from quote snapshots
// optionBarState removed — batch-quote bar building permanently disabled (corrupted HMA signals)

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
    // // signalPoller.setSpxPrice // Removed: signal-poller deprecated(last); // Removed: signal-poller deprecated
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
  const symbol = 'SPX';
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

// ── Option WebSocket Stream → Price Line → 1m Bars ──────────────────────────
// Streams real-time trade/quote events for ~250-480 option contracts via ThetaData
// (primary) + Tradier WS (hot standby). Tick stream feeds PriceLine which tracks
// last price per symbol per minute. At each minute boundary, validates against
// Tradier REST quote mids and records closed bars. Replaces the old candle-builder
// approach with something much simpler: just track close price + REST validate.

const optionStream = new OptionStream();
const thetaStream = new ThetaDataStream();
let priceLine: PriceLine | null = null;
let optionCandleTimer: ReturnType<typeof setInterval> | null = null;
let optionStreamActive = false;       // true when stream is live — suppresses pollOptions()
let optionStreamScheduleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Prefer ThetaData ticks (true tick-level OPRA feed) whenever the WS is
 * connected AND is actually delivering market data. Tradier WS is cold-
 * standby — fires whenever ThetaData is unavailable.
 *
 * Two-part gate:
 *   1. `isConnected()` — WebSocket is open (catches crashes, network drops
 *      to 127.0.0.1:25520, and explicit disconnects).
 *   2. `lastActivity` freshness — last TRADE or QUOTE frame arrived within
 *      `OPTION_STREAM_THETA_STALE_MS`. STATUS keepalives don't reset this
 *      counter, so a feed that goes silent while the socket stays up (e.g.
 *      an internal ThetaTerminal stall, or subscriptions silently dropped)
 *      will flip us over to Tradier instead of blinding the agent.
 *
 * `lastActivity === 0` means we've never seen market data on this session —
 * treated as stale, so Tradier handles ticks until ThetaData proves itself.
 * No hysteresis beyond the staleness window: each call re-evaluates.
 */
function thetaIsPrimary(): boolean {
  if (!thetaStream.isConnected()) return false;
  const last = thetaStream.lastActivity;
  if (last <= 0) return false;
  return Date.now() - last < OPTION_STREAM_THETA_STALE_MS;
}

/** ES→SPX fair value offset: ES trades ~46 pts above SPX (simple fixed estimate) */
// ES_SPX_OFFSET removed — no longer polling ES futures overnight

/**
 * Get today's and tomorrow's expiry dates for the contract pool.
 * Uses todayET() for accurate ET date and adds the next trading day.
 */
function getPoolExpiries(): string[] {
  const today = todayET();
  // Next calendar day — the pool covers 0DTE (today) + 1DTE (tomorrow)
  const todayDate = new Date(today + 'T12:00:00Z');
  const tomorrow = new Date(todayDate.getTime() + 86400_000)
    .toISOString().split('T')[0];
  return [today, tomorrow];
}

/**
 * Initialize the option WebSocket stream:
 *   1. Get SPX price (from lastSpxPrice, DB, or live Tradier quote)
 *   2. Build contract pool: ±STRIKE_BAND pts × $5 × calls+puts × active expiries
 *   3. Create OptionCandleBuilder with onClose → rawToBar → indicators → DB → broadcast
 *   4. Wire optionStream.onTick → candleBuilder
 *   5. Start the stream — REST polling (pollOptions) is suppressed once connected
 *
 * Called once daily at OPTION_STREAM_WAKE_ET (09:22 ET). Pre-market SPX is firm
 * by this time, so the band is built once on an accurate center — no preliminary
 * band, no 9:30 re-lock. Subscriptions settle before market open and OPRA prints
 * flow immediately at 9:30.
 */
async function initOptionStream(): Promise<void> {
  // Step 1: Get a price to center the pool on
  let centerPrice = lastSpxPrice;
  if (!centerPrice) {
    // Try SPX from DB
    const spxBar = getLatestBar('SPX', '1m');
    if (spxBar) {
      centerPrice = spxBar.close;
    }
  }
  if (!centerPrice) {
    // Try live Tradier quote as last resort
    try {
      const quote = await fetchSpxQuote();
      if (quote && quote.last > 0) {
        centerPrice = quote.last;
      }
    } catch (e) {
      console.error('[option-stream] Failed to fetch SPX quote for pool centering:', e);
    }
  }
  if (!centerPrice) {
    console.error('[option-stream] No price available to center contract pool — skipping stream init');
    return;
  }

  // Step 2: Build the pool
  const expiries = getPoolExpiries();
  const pool = OptionStream.buildContractPool(centerPrice, STRIKE_BAND, STRIKE_INTERVAL, expiries);
  if (pool.length === 0) {
    console.error('[option-stream] Empty contract pool — skipping stream init');
    return;
  }
  console.log(`[option-stream] Pool: ${pool.length} symbols centered on SPX≈${centerPrice.toFixed(0)} (±${STRIKE_BAND}), expiries=${expiries.join(',')}`);

  // Step 3: Create price line
  priceLine = new PriceLine();

  // Step 4a: Wire Tradier ticks — ignored when ThetaData is primary
  optionStream.onTick((tick) => {
    if (!priceLine) return;
    if (thetaIsPrimary()) return; // drop Tradier ticks — theta is delivering

    if (tick.type === 'trade' && tick.price && tick.price > 0) {
      priceLine.processTick(tick.symbol, tick.price, tick.ts, tick.size ?? 0);
    } else if (tick.type === 'quote' && tick.bid && tick.ask) {
      priceLine.processQuote(tick.symbol, tick.bid, tick.ask, tick.ts);
    }

    healthTracker.recordSuccess('option-stream');
  });

  // Step 4b: Wire ThetaData ticks — always pass through, this is the primary feed
  thetaStream.onTick((tick) => {
    if (!priceLine) return;

    if (tick.type === 'trade' && tick.price && tick.price > 0) {
      priceLine.processTick(tick.symbol, tick.price, tick.ts, tick.size ?? 0);
    } else if (tick.type === 'quote' && tick.bid && tick.ask) {
      priceLine.processQuote(tick.symbol, tick.bid, tick.ask, tick.ts);
    }

    healthTracker.recordSuccess('thetadata-stream');
  });

  // Step 5a: Start Tradier WS (fallback)
  try {
    await optionStream.start(pool);
    optionStreamActive = true;
    console.log(`[option-stream] Tradier WS started — ${pool.length} symbols, polling suppressed`);
  } catch (e) {
    console.error('[option-stream] Tradier WS failed to start:', e);
    optionStreamActive = false;
    healthTracker.recordFailure('option-stream');
  }

  // Step 5b: Start ThetaData WS (primary during RTH — see thetaIsPrimary()).
  // Runs in parallel with Tradier WS; Tradier ticks are dropped when theta delivers.
  try {
    await thetaStream.start(pool);
    console.log(`[thetadata-stream] Started — ${pool.length} symbols (preferred source)`);
  } catch (e) {
    console.error('[thetadata-stream] Failed to start (continuing on Tradier WS):', e);
    healthTracker.recordFailure('thetadata-stream');
  }

  // Step 6: Minute-boundary timer — REST validate + snapshot price line into bars
  if (optionCandleTimer) clearInterval(optionCandleTimer);
  optionCandleTimer = setInterval(async () => {
    if (!priceLine) return;

    // Fetch REST mids for active band contracts — validates closes before storage
    // Poll ATM and nearest strikes FIRST so the most-traded contracts are validated first,
    // minimizing lag for the contracts that matter for signals.
    if (optionStreamActive) {
      const activeContracts = tracker.getActive();
      if (activeContracts.length > 0) {
        try {
          // Sort by distance from ATM — nearest strikes first
          const atm = lastSpxPrice ?? 5000;
          activeContracts.sort((a, b) => {
            const distA = Math.abs(a.strike - atm);
            const distB = Math.abs(b.strike - atm);
            return distA - distB;
          });
          const sortedSymbols = activeContracts.map(c => c.symbol);
          const mids = await fetchBatchQuotes(sortedSymbols);
          const restMids = new Map<string, number>();
          for (const [sym, q] of mids) {
            if (q.bid != null && q.ask != null) {
              restMids.set(sym, (q.bid + q.ask) / 2);
            }
          }
          const bars = priceLine.snapshotAndFlush(restMids, 5);
          for (const bar of bars) {
            const clampedClose = Math.min(Math.max(bar.close, bar.low), bar.high);
            const b = rawToBar(bar.symbol, '1m', {
              ts: bar.ts,
              open: bar.open,
              high: bar.high,
              low: bar.low,
              close: clampedClose,
              volume: bar.volume,
            });
            const enriched = { ...b, indicators: computeIndicators(b, 2) };
            upsertBars([enriched]);
            const recent1m = getBars(bar.symbol, '1m', 60);
            if (recent1m.length > 0) aggregateAndStore(recent1m, 2);
            healthTracker.recordBar(bar.symbol, bar.ts * 1000);
            broadcast({ type: 'contract_bar', symbol: bar.symbol, data: enriched });

            detectContractSignals(enriched);

            const barMin = new Date(bar.ts * 1000).getUTCMinutes();
            if (barMin % 3 === 0) {
              const agg3m = aggregate(recent1m, '3m', 180);
              if (agg3m.length > 0) {
                const latest3m = { ...agg3m[agg3m.length - 1], indicators: computeIndicators(agg3m[agg3m.length - 1], 2) };
                detectContractSignals(latest3m, '3m');
              }
            }
            if (barMin % 5 === 0) {
              const agg5m = aggregate(recent1m, '5m', 300);
              if (agg5m.length > 0) {
                const latest5m = { ...agg5m[agg5m.length - 1], indicators: computeIndicators(agg5m[agg5m.length - 1], 2) };
                detectContractSignals(latest5m, '5m');
              }
            }
          }
        } catch (e) {
          console.warn('[price-line] REST validation failed:', e);
        }
      }
    }
  }, 5_000);

  // Also register tracked contracts with the contract tracker for the sticky band
  for (const sym of pool) {
    // Parse symbol to extract strike and type for tracker
    // OCC format: SPXW260401C06500000
    const match = sym.match(/^(SPXW?)(\d{6})([CP])(\d{8})$/);
    if (match) {
      const [, prefix, expiryCode, type, strikeCode] = match;
      const strike = parseInt(strikeCode) / 1000;
      const expiry = `20${expiryCode.slice(0, 2)}-${expiryCode.slice(2, 4)}-${expiryCode.slice(4, 6)}`;
      const added = tracker.updateBand(centerPrice, [{
        symbol: sym,
        strike,
        expiry,
        type: type === 'C' ? 'call' : 'put',
      }]);
      for (const c of added) upsertContract(c);
    }
  }
}

/** Stop the option stream and flush remaining candles */
function stopOptionStream(): void {
  optionStream.stop();
  thetaStream.stop();
  optionStreamActive = false;

  if (priceLine) {
    const restMids = new Map<string, number>();
    const bars = priceLine.snapshotAndFlush(restMids, 5);
    for (const bar of bars) {
      const b = rawToBar(bar.symbol, '1m', {
        ts: bar.ts,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      });
      const enriched = { ...b, indicators: computeIndicators(b, 2) };
      upsertBars([enriched]);

      // Detect HMA crosses on option contracts (end-of-day flush)
      detectContractSignals(enriched);
    }
    priceLine = null;
  }

  if (optionCandleTimer) {
    clearInterval(optionCandleTimer);
    optionCandleTimer = null;
  }

  console.log('[option-stream] Stopped and flushed (Tradier + ThetaData)');
}

/**
 * Check option stream health — if disconnected, fall back to polling.
 * If reconnected, suppress polling again.
 */
function checkOptionStreamFallback(): void {
  if (!optionStreamActive) return; // stream was never started or intentionally stopped

  if (!optionStream.isConnected()) {
    // Stream disconnected — fall back to polling
    if (optionStreamActive) {
      console.warn('[option-stream] Disconnected — falling back to REST polling');
      optionStreamActive = false;
      healthTracker.recordFailure('option-stream');
    }
  } else {
    // Stream is connected — suppress polling
    if (!optionStreamActive) {
      console.log('[option-stream] Reconnected — suppressing REST polling');
      optionStreamActive = true;
    }
    healthTracker.recordSuccess('option-stream');
  }
}

/**
 * Parse ET time string 'HH:MM' into minutes since midnight.
 */
function parseETTime(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Schedule option stream lifecycle (single-phase):
 *   Wake  — OPTION_STREAM_WAKE_ET (09:22 ET): init stream with band centered on
 *           pre-market SPX price (firm by 9:22). One subscribe event — ~200
 *           contracts subscribed to Theta WS + Tradier WS, fully settled before
 *           9:30 open so OPRA prints flow instantly. No separate re-lock phase.
 *   Close — OPTION_STREAM_CLOSE_ET (17:00 ET): stop stream, expire 0DTE contracts.
 *
 * Also checks for fallback/reconnection every 30s.
 * SPX underlying indicator warm-up is independent of this schedule — it runs
 * from 8:00 ET via the Tradier timesales poll.
 */
function scheduleOptionStream(): void {
  const wakeMinutes = parseETTime(OPTION_STREAM_WAKE_ET);
  const closeMinutes = parseETTime(OPTION_STREAM_CLOSE_ET);
  let streamInitialized = false;
  let streamStopped = false;

  optionStreamScheduleTimer = setInterval(async () => {
    const et = nowET();
    const nowMinutes = et.h * 60 + et.m;

    // Check if we're in the streaming window
    if (nowMinutes >= wakeMinutes && nowMinutes < closeMinutes) {
      // Single-phase wake: init stream with pre-market-derived band
      if (!streamInitialized && !optionStreamActive) {
        streamInitialized = true;
        streamStopped = false;
        console.log(`[option-stream] Wake time reached (${OPTION_STREAM_WAKE_ET} ET) — initializing with pre-market SPX band`);
        try {
          await initOptionStream();
        } catch (e) {
          console.error('[option-stream] Init failed:', e);
          streamInitialized = false;
        }
      }

      // Check fallback status
      checkOptionStreamFallback();
    } else if (nowMinutes >= closeMinutes && !streamStopped) {
      // Past close time — stop stream
      if (optionStream.isConnected() || optionStreamActive) {
        console.log(`[option-stream] Close time reached (${OPTION_STREAM_CLOSE_ET} ET) — stopping`);
        stopOptionStream();
      }
      streamStopped = true;
      streamInitialized = false;
    } else if (nowMinutes < wakeMinutes) {
      // Before wake time — reset flags for new day
      streamInitialized = false;
      streamStopped = false;
    }
  }, 30_000); // check every 30s
}

// ── HMA Cross Signal Detection ──────────────────────────────────────────────
// Detects HMA(fast)×HMA(slow) crossovers at the data pipeline level.
// Fast/slow periods come from the active agent config (AGENT_CONFIG_ID) — same
// pair the trading agent actually trades on. Falls back to 3/17 if no config.
// Fires exactly once per candle close — consumers subscribe via WebSocket
// instead of polling. The signal IS the trigger, not something to check for.
let prevHmaFast: number | null = null;
let prevHmaSlow: number | null = null;
let activeHmaFastPeriod = 3;
let activeHmaSlowPeriod = 17;
// DISABLED: Tick-based signal detection is too fragile (bar validator, aggregation issues,
// indicator state, dedup, catchup). Migrating to absurdly simple poll-based detection.
// See docs/SIGNAL-SOURCE-PROBLEM.md for context.
let activeHmaSignalEnabled = false;

const emittedSignals = new Set<string>();
let lastHmaSignal:
  | { type: string; direction: string; ts: number; price: number; hmaFast: number; hmaSlow: number; hmaFastPeriod: number; hmaSlowPeriod: number }
  | null = null;

/** Get the last HMA cross signal (for REST API) */
export function getLastHmaSignal() { return lastHmaSignal; }

/**
 * Load the active agent config's HMA pair so the pipeline's broadcast signal
 * matches the strategy the live agent actually trades. Called once at startup
 * after config registration. Safe to call without AGENT_CONFIG_ID set.
 */
function loadAgentHmaPair(): void {
  const configId = process.env.AGENT_CONFIG_ID;
  if (!configId) {
    console.log(`[signal] No AGENT_CONFIG_ID set — using default HMA(${activeHmaFastPeriod})×HMA(${activeHmaSlowPeriod})`);
    return;
  }
  try {
    const store = createStore();
    const cfg = store.getConfig(configId);
    store.close();
    if (!cfg) {
      console.warn(`[signal] AGENT_CONFIG_ID=${configId} not found in DB — using default HMA(${activeHmaFastPeriod})×HMA(${activeHmaSlowPeriod})`);
      return;
    }
    const sig = cfg.signals;
    const fast = sig?.hmaCrossFast ?? 3;
    const slow = sig?.hmaCrossSlow ?? 17;
    const enabled = sig?.enableHmaCrosses !== false;
    activeHmaFastPeriod = fast;
    activeHmaSlowPeriod = slow;
    activeHmaSignalEnabled = enabled;
    // Ensure indicator engine computes both periods on every bar.
    registerHmaPeriod(fast);
    registerHmaPeriod(slow);
    console.log(`[signal] Using HMA(${fast})×HMA(${slow}) from config ${configId} (enabled=${enabled})`);
  } catch (e: any) {
    console.warn(`[signal] Failed to load agent config for HMA pair: ${e.message} — using default HMA(${activeHmaFastPeriod})×HMA(${activeHmaSlowPeriod})`);
  }
}

function detectHmaCrossSignal(bar: Bar): void {
  if (!activeHmaSignalEnabled) return;
  const fastKey = `hma${activeHmaFastPeriod}`;
  const slowKey = `hma${activeHmaSlowPeriod}`;
  const hmaFast = (bar.indicators as any)?.[fastKey];
  const hmaSlow = (bar.indicators as any)?.[slowKey];
  if (hmaFast == null || hmaSlow == null) return;

  if (prevHmaFast != null && prevHmaSlow != null) {
    const wasFastAbove = prevHmaFast > prevHmaSlow;
    const isFastAbove = hmaFast > hmaSlow;

    if (!wasFastAbove && isFastAbove) {
      const signal = {
        type: 'hma_cross_signal' as const,
        direction: 'bullish' as const,
        ts: bar.ts,
        price: bar.close,
        hmaFast,
        hmaSlow,
        hmaFastPeriod: activeHmaFastPeriod,
        hmaSlowPeriod: activeHmaSlowPeriod,
      };
      console.log(`[signal] 🔼 BULLISH HMA(${activeHmaFastPeriod})×HMA(${activeHmaSlowPeriod}) cross @ ${bar.close.toFixed(2)} (candle ts=${bar.ts})`);
      lastHmaSignal = signal;
      broadcast(signal);
    } else if (wasFastAbove && !isFastAbove) {
      const signal = {
        type: 'hma_cross_signal' as const,
        direction: 'bearish' as const,
        ts: bar.ts,
        price: bar.close,
        hmaFast,
        hmaSlow,
        hmaFastPeriod: activeHmaFastPeriod,
        hmaSlowPeriod: activeHmaSlowPeriod,
      };
      console.log(`[signal] 🔽 BEARISH HMA(${activeHmaFastPeriod})×HMA(${activeHmaSlowPeriod}) cross @ ${bar.close.toFixed(2)} (candle ts=${bar.ts})`);
      lastHmaSignal = signal;
      broadcast(signal);
    }
  }

  prevHmaFast = hmaFast;
  prevHmaSlow = hmaSlow;
}

/**
 * Detect HMA crosses on option contract bars and emit channelized events.
 *
 * Emits signals to offset-based channels like "otm5:3_12:call" so agents
 * subscribe only to the exact offset/HMA pair/side their config targets.
 * No filtering needed in the event handler.
 */
function detectContractSignals(bar: Bar, timeframe: Timeframe = '1m'): void {
  if (!activeHmaSignalEnabled) return;
  if (!lastSpxPrice) return;

  const symbol = bar.symbol;
  const prevBars = getBars(symbol, timeframe, 2);
  if (prevBars.length < 2) return;
  const prevBar = prevBars[prevBars.length - 2];

  const parsed = parseSymbol(symbol);
  if (!parsed) return;
  const { strike, expiry, isCall } = parsed;
  const side = isCall ? 'call' : 'put';

  const today = todayET();
  if (expiry !== today) return;

  const strikeDistance = Math.abs(strike - lastSpxPrice);
  if (strikeDistance > SIGNAL_STRIKE_BAND) return;

  const offsetRaw = Math.round((strike - lastSpxPrice) / STRIKE_INTERVAL) * STRIKE_INTERVAL;
  // ITM/OTM depends on side: calls ITM = strike < SPX, puts ITM = strike > SPX
  const isItm = isCall ? offsetRaw < 0 : offsetRaw > 0;
  const offsetDollar = Math.abs(offsetRaw);
  const offsetLabel = offsetDollar === 0 ? 'atm' : isItm ? `itm${offsetDollar}` : `otm${offsetDollar}`;

  for (const [hmaFastPeriod, hmaSlowPeriod] of HMA_PAIRS) {
    const hmaFastKey = `hma${hmaFastPeriod}`;
    const hmaSlowKey = `hma${hmaSlowPeriod}`;

    const hmaFast = (bar.indicators as any)?.[hmaFastKey];
    const hmaSlow = (bar.indicators as any)?.[hmaSlowKey];
    if (hmaFast == null || hmaSlow == null) continue;

    const prevHmaFast = (prevBar.indicators as any)?.[hmaFastKey];
    const prevHmaSlow = (prevBar.indicators as any)?.[hmaSlowKey];
    if (prevHmaFast == null || prevHmaSlow == null) continue;

    const wasFastAbove = prevHmaFast > prevHmaSlow;
    const isFastAbove = hmaFast > hmaSlow;

    if (wasFastAbove !== isFastAbove) {
      const dedupKey = `${symbol}:${hmaFastPeriod}_${hmaSlowPeriod}:${timeframe}:${bar.ts}`;
      if (emittedSignals.has(dedupKey)) continue;
      emittedSignals.add(dedupKey);
      if (emittedSignals.size > 50000) {
        const oldest = [...emittedSignals].slice(0, 25000);
        oldest.forEach(k => emittedSignals.delete(k));
      }

      const direction = isFastAbove ? 'bullish' as const : 'bearish' as const;
      const hmaChannel = `${offsetLabel}:${hmaFastPeriod}_${hmaSlowPeriod}:${side}`;
      const signal = {
        type: 'contract_signal',
        channel: hmaChannel,
        data: {
          symbol,
          strike,
          expiry,
          side,
          direction,
          hmaFastPeriod,
          hmaSlowPeriod,
          hmaFast,
          hmaSlow,
          price: bar.close,
          timestamp: bar.ts * 1000,
          offsetLabel,
          timeframe,
        },
      };
      console.log(`[signal] CONTRACT ${direction.toUpperCase()} HMA(${hmaFastPeriod})×HMA(${hmaSlowPeriod}) ${symbol} @ ${bar.close.toFixed(2)} (${offsetLabel}, ${side}, ${timeframe})`);
      insertSignal({
        symbol, strike, expiry, side, direction, offsetLabel,
        hmaFast: hmaFastPeriod, hmaSlow: hmaSlowPeriod,
        hmaFastVal: hmaFast, hmaSlowVal: hmaSlow,
        timeframe, price: bar.close, ts: bar.ts,
      });
      broadcast(signal);
    }
  }
}

/** Aggregate 1m bars to all higher timeframes (3m, 5m, 15m, 1h) with indicator computation */
function aggregateAndStore(bars1m: Bar[], tier: 1 | 2 = 1): void {
  for (const [tf, secs] of HIGHER_TIMEFRAMES) {
    const agg = aggregate(bars1m, tf, secs).map(b => ({
      ...b, indicators: computeIndicators(b, tier)
    }));
    if (agg.length > 0) {
      upsertBars(agg);
    }
  }
}

function loadContractsFromDb(): void {
  // First, expire any stale contracts from previous sessions
  const todayStr = todayET();
  const expiredCount = expireContractsBefore(todayStr);
  if (expiredCount > 0) console.log(`[startup] Expired ${expiredCount} stale contracts with expiry < ${todayStr}`);

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
  // Seed SPX price from Tradier quote if we don't have one yet
  if (!lastSpxPrice) {
    try {
      const quote = await fetchSpxQuote();
      if (quote && quote.last > 0) {
        lastSpxPrice = quote.last;
        setLastSpxPrice(lastSpxPrice);
        // signalPoller.setSpxPrice // Removed: signal-poller deprecated(lastSpxPrice);
        console.log(`[startup] Primed SPX price from Tradier quote: $${lastSpxPrice}`);
      }
    } catch (e) {
      console.warn('[startup] Could not fetch SPX quote — price will be set when RTH data arrives');
    }
  }
}

async function pollUnderlying(): Promise<void> {
  const mode = getMarketMode();

  // Only poll during RTH — no overnight ES data needed
  if (mode !== 'rth') return;

  try {
    let bars: ReturnType<typeof buildBars> | undefined;
    // Fetch without date filter — Tradier returns null for SPX timesales with explicit dates
    // but returns proper 1m OHLCV bars without date params (defaults to current session)
    const raw = await fetchTimesales('SPX');
    if (raw.length) {
      bars = buildBars('SPX', '1m', raw.slice(-5));
    } else {
      // Timesales may lag on session open — fall back to live quote to prime lastSpxPrice ONLY.
      // Do NOT persist this as a bar: it's a mid-minute quote snapshot (open=close=last,
      // high=ask, low=bid, volume=0) — not a closed candle. Storing it would corrupt HMA
      // calculations on the aggregated 3m/5m bar series.
      const quote = await fetchSpxQuote();
      if (quote && quote.last > 0) {
        lastSpxPrice = quote.last;
        setLastSpxPrice(lastSpxPrice);
        // signalPoller.setSpxPrice // Removed: signal-poller deprecated(lastSpxPrice);
        healthTracker.recordBar('SPX', Date.now());
      }
    }
    healthTracker.recordSuccess('tradier');

    if (bars?.length) {
      const enriched = bars.map(b => ({ ...b, indicators: computeIndicators(b, 2) }));
      upsertBars(enriched);

      // Aggregate to higher timeframes — fetch recent 1m bars for proper aggregation
      const recent1m = getBars('SPX', '1m', 60);
      if (recent1m.length > 0) aggregateAndStore(recent1m, 2);

      lastSpxPrice = enriched[enriched.length - 1].close;
      setLastSpxPrice(lastSpxPrice);
      // signalPoller.setSpxPrice // Removed: signal-poller deprecated(lastSpxPrice);
      const lastBar = enriched[enriched.length - 1];
      healthTracker.recordBar('SPX', lastBar.ts * 1000);
      broadcast({ type: 'spx_bar', data: lastBar });
      detectHmaCrossSignal(lastBar);
    }
  } catch (e) {
    healthTracker.recordFailure('tradier');
    console.error('[poll:underlying]', e);
  }
}

async function pollOptions(): Promise<void> {
  if (!lastSpxPrice) return;
  // Skip REST polling when option stream is active — stream provides tick-level data.
  // Flag tradier-options as cold-standby so the health aggregator doesn't vote it
  // "unhealthy" on staleness (we're deliberately not polling it).
  if (optionStreamActive && optionStream.isConnected()) {
    healthTracker.markStandby('tradier-options', true);
    return;
  }
  // Primary stream isn't carrying the load — Tradier REST is active again.
  healthTracker.markStandby('tradier-options', false);
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

    // Batch-quote update for already-tracked contracts.
    // NEVER build bars from batch quotes.  Tradier quotes are snapshot-level
    // (single price per poll, session-cumulative volume) and produce flat
    // O=H=L=C candles that corrupt HMA signal detection.  ThetaTerminal
    // disconnects ~200×/day (code 1006) so the old thetaIsPrimary() guard
    // let corrupted bars slip through every few minutes — permanently removed.
    //
    // Bar construction is handled EXCLUSIVELY by OptionCandleBuilder from
    // ThetaData WS trade ticks (primary) or Tradier WS ticks (fallback).
    // This path only fetches quotes for dashboard/UI display and contract
    // tracking (bid/ask/last).
    const tracked = tracker.getActive().concat(tracker.getSticky());
    if (tracked.length > 0) {
      const quotes = await fetchBatchQuotes(tracked.map(c => c.symbol));
      quotes.forEach((q, sym) => {
        broadcast({ type: 'contract_bar', symbol: sym, data: q });
      });
    }

    // Expire contracts in memory AND persist to DB
    tracker.checkExpiries();
    const todayStr = todayET();
    const expiredBefore = expireContractsBefore(todayStr);
    if (expiredBefore > 0) console.log(`[contracts] Expired ${expiredBefore} contracts with expiry < ${todayStr}`);
    // Also expire today's contracts after RTH close (5:00 PM ET)
    const etNow = nowET();
    if (etNow.h >= 17) {
      const expiredToday = expireContractsOnDate(todayStr);
      if (expiredToday > 0) console.log(`[contracts] Expired ${expiredToday} contracts for today (${todayStr}) after RTH close`);
    }
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

  // Stop signal poller
  // signalPoller.stop(); // Removed: signal-poller deprecated

  // Close signals DB
  try { closeSignalsDb(); } catch {}

  // Safety timeout — force exit after 5s if cleanup hangs
  setTimeout(() => {
    console.log('[shutdown] forced exit after 5s timeout');
    process.exit(1);
  }, 5000).unref();

  // 1. Stop all polling intervals and option stream
  for (const id of intervals) clearInterval(id);
  if (optionStreamScheduleTimer) clearInterval(optionStreamScheduleTimer);
  stopOptionStream();

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
  console.warn('[SPXer] ⚠️ TICK-BASED SIGNALS DISABLED — Migrating to poll-based detection (see docs/SIGNAL-SOURCE-PROBLEM.md)');

  if (!config.tradierToken) {
    console.warn('[SPXer] TRADIER_TOKEN not set — running in degraded mode (no live data)');
  }

  // ── initDb — day-scoped live DB for isolation ──
  // Each trading day gets a fresh SQLite DB at data/live/YYYY-MM-DD.db.
  // If DB_PATH is set explicitly, honor it (escape hatch / backwards compat).
  const today = todayET();
  const liveDbPath = process.env.DB_PATH || dayDbPath(today);
  currentDbDate = today;
  console.log(`[startup] Live DB: ${liveDbPath}`);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      initDb(liveDbPath);
      // Initialize signals DB (separate persistent DB for EOD review)
      initSignalsDb();
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

  // Copy warmup bars from previous trading day (indicator seed)
  if (!process.env.DB_PATH) {
    try {
      const prevDay = previousTradingDay(today);
      const prevPath = dayDbPath(prevDay);
      copyWarmupBars(prevPath);
      console.log(`[startup] Warmup bars seeded from ${prevDay}`);
    } catch (e) {
      console.warn('[startup] Warmup copy failed, indicators will warm naturally:', e);
    }
  }

  // ── loadContractsFromDb — non-fatal, start with empty contracts ──
  try {
    loadContractsFromDb();
  } catch (e) {
    console.warn('[startup] DB read failed, starting with empty contracts:', e);
  }

  // ── Register HMA periods from every stored replay_config ──
  // The data service computes indicators for every bar it serves; if any config
  // (live or research) references hmaCrossFast/Slow outside the default set,
  // we must teach the engine about those periods BEFORE any bar flows.
  // Otherwise the engine silently emits `hma${period}: undefined` and the
  // signal detector never fires — the exact failure mode from 2026-04-20.
  try {
    const _configStore = createStore();
    const configs = _configStore.listConfigs();
    _configStore.close();
    let registered = 0;
    for (const cfg of configs) {
      try {
        validateSignalConfig(cfg);
        registered++;
      } catch (e: any) {
        console.warn(`[startup] config ${cfg.id} failed validateSignalConfig: ${e.message}`);
      }
    }
    console.log(`[startup] Registered HMA periods from ${registered}/${configs.length} configs → active periods: [${getActiveHmaPeriods().join(', ')}]`);
  } catch (e) {
    console.warn('[startup] HMA period registration failed, falling back to defaults:', e);
  }

  // ── Align pipeline HMA cross signal with the active agent config ──
  // Guarantees the broadcast `hma_cross_signal` fires on the same pair the
  // live agent trades (AGENT_CONFIG_ID). No-op if env var is unset.
  loadAgentHmaPair();

  if (config.tradierToken) {
    // ── warmup — non-fatal, continue without history ──
    try {
      await warmup();
    } catch (e) {
      console.warn('[startup] warmup failed (provider down?), starting without history:', e);
    }

    // Start signal poller after SPX price is set (stateful detection)
    // Removed: signal-poller deprecated in v2.0 independent architecture
    // if (lastSpxPrice) {
    //   signalPoller.setSpxPrice(lastSpxPrice);
    // }
    // signalPoller.start();

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

    // Seed underlying SPX with tier 2 indicators
    for (const sym of ['SPX']) {
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

  // ── Catch-up scan: detect signals from recent DB bars missed during restart ──
  try {
    const catchupContracts = tracker.getActive().concat(tracker.getSticky());
    const catchupTfs: [Timeframe, number][] = [['3m', 180], ['5m', 300]];
    let catchupSignals = 0;
    for (const contract of catchupContracts) {
      for (const [tf] of catchupTfs) {
        const recentBars = getBars(contract.symbol, tf, 3);
        if (recentBars.length >= 2) {
          const latest = recentBars[recentBars.length - 1];
          const prev = recentBars[recentBars.length - 2];
          const parsed = parseSymbol(latest.symbol);
          if (!parsed) continue;
          for (const [hmaFastPeriod, hmaSlowPeriod] of HMA_PAIRS) {
            const fastKey = `hma${hmaFastPeriod}`;
            const slowKey = `hma${hmaSlowPeriod}`;
            const currFast = (latest.indicators as any)?.[fastKey];
            const currSlow = (latest.indicators as any)?.[slowKey];
            const prevFast = (prev.indicators as any)?.[fastKey];
            const prevSlow = (prev.indicators as any)?.[slowKey];
            if (currFast == null || currSlow == null || prevFast == null || prevSlow == null) continue;
            const wasAbove = prevFast > prevSlow;
            const isAbove = currFast > currSlow;
            if (wasAbove !== isAbove) {
              const direction = isAbove ? 'bullish' as const : 'bearish' as const;
              const side = parsed.isCall ? 'call' : 'put';
              const offsetRaw = Math.round((parsed.strike - (lastSpxPrice ?? 0)) / STRIKE_INTERVAL) * STRIKE_INTERVAL;
              const isItm = parsed.isCall ? offsetRaw < 0 : offsetRaw > 0;
              const offsetDollar = Math.abs(offsetRaw);
              const offsetLabel = offsetDollar === 0 ? 'atm' : isItm ? `itm${offsetDollar}` : `otm${offsetDollar}`;
              const hmaChannel = `${offsetLabel}:${hmaFastPeriod}_${hmaSlowPeriod}:${side}`;
              const signal = {
                type: 'contract_signal',
                channel: hmaChannel,
                data: {
                  symbol: latest.symbol,
                  strike: parsed.strike,
                  expiry: parsed.expiry,
                  side,
                  direction,
                  hmaFastPeriod,
                  hmaSlowPeriod,
                  hmaFast: currFast,
                  hmaSlow: currSlow,
                  price: latest.close,
                  timestamp: latest.ts * 1000,
                  offsetLabel,
                  timeframe: tf,
                },
              };
              insertSignal({
                symbol: latest.symbol, strike: parsed.strike, expiry: parsed.expiry ?? '', side, direction, offsetLabel,
                hmaFast: hmaFastPeriod, hmaSlow: hmaSlowPeriod,
                hmaFastVal: currFast, hmaSlowVal: currSlow,
                timeframe: tf, price: latest.close, ts: latest.ts,
              });
              broadcast(signal);
              catchupSignals++;
              console.log(`[catchup] ${direction.toUpperCase()} HMA(${hmaFastPeriod})xHMA(${hmaSlowPeriod}) ${latest.symbol} @ ${latest.close.toFixed(2)} (${offsetLabel}, ${side}, ${tf})`);
            }
          }
        }
      }
    }
    if (catchupSignals > 0) console.log(`[catchup] Emitted ${catchupSignals} missed signals from DB bars`);
  } catch (e) {
    console.warn('[startup] catchup signal scan failed:', e);
  }

  const { httpServer } = startHttpServer(config.port);
  httpServerRef = httpServer;
  wsServerRef = startWsServer(httpServer);
  setTrackerCountFn(() => tracker.getActive().length + tracker.getSticky().length);

  // Wire option stream status into /health endpoint
  setOptionStreamStatusFn(() => ({
    connected: optionStream.isConnected(),
    symbolCount: optionStream.symbolCount,
    lastActivity: optionStream.lastActivity,
    theta: {
      connected: thetaStream.isConnected(),
      symbolCount: thetaStream.symbolCount,
      lastActivity: thetaStream.lastActivity,
      staleMs: thetaStream.lastActivity > 0 ? Date.now() - thetaStream.lastActivity : null,
      staleThresholdMs: OPTION_STREAM_THETA_STALE_MS,
      primary: thetaIsPrimary(),
    },
  }));

  intervals.push(setInterval(pollUnderlying, POLL_UNDERLYING_MS));
  const optionsInterval = getMarketMode() === 'rth' ? POLL_OPTIONS_RTH_MS : POLL_OPTIONS_OVERNIGHT_MS;
  intervals.push(setInterval(pollOptions, optionsInterval));
  intervals.push(setInterval(pollScreener, POLL_SCREENER_MS));

  // Schedule option stream lifecycle (single-phase):
  //  09:22 ET — Wake: init stream with pre-market SPX strike band (one subscribe event)
  //  17:00 ET — Close: stop stream, expire 0DTE contracts
  // REST polling (pollOptions) auto-suppresses once WebSocket is connected.
  if (config.tradierToken) {
    scheduleOptionStream();

    // If we're already in the streaming window at startup, init immediately
    const et = nowET();
    const nowMinutes = et.h * 60 + et.m;
    const wakeMinutes = parseETTime(OPTION_STREAM_WAKE_ET);
    const closeMinutes = parseETTime(OPTION_STREAM_CLOSE_ET);
    if (nowMinutes >= wakeMinutes && nowMinutes < closeMinutes) {
      console.log('[option-stream] Inside streaming window at startup — initializing now');
      initOptionStream().catch(e => console.error('[option-stream] Startup init failed:', e));
    }
  }

  // Reset VWAP exactly once on transition into RTH (not every minute during RTH)
  intervals.push(setInterval(() => {
    const mode = getMarketMode();
    if (mode !== prevMode) {
      recordModeTransition(prevMode ?? 'startup', mode);
    }
    if (mode === 'rth' && prevMode !== 'rth') {
      resetVWAP('SPX', '1m');
      for (const [tf] of HIGHER_TIMEFRAMES) resetVWAP('SPX', tf);
    }
    prevMode = mode;
    pipelineHealth.currentMode = mode;

    if (!process.env.DB_PATH) {
      const now = todayET();
      if (currentDbDate && now !== currentDbDate) {
        console.log(`[rotation] Day changed: ${currentDbDate} → ${now}, restarting for DB rotation`);
        process.exit(0);
      }
    }
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
  startAlertMonitor();
  startAlertEngine(60_000); // Centralized alert rules — 60s check interval

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
