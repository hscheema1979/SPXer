/**
 * Option Candle Builder — Tick-to-Candle Aggregator for Streamed Options
 *
 * Receives real-time trade and quote ticks from OptionStream and builds
 * proper 1m OHLCV candles per symbol. Only emits CLOSED candles via the
 * onClose callback — the forming candle lives exclusively in internal state
 * and is never exposed to callers.
 *
 * This is the options equivalent of the SPX candle builder in src/index.ts,
 * but generalized for multi-symbol streaming.
 *
 * Usage:
 *   const builder = new OptionCandleBuilder((symbol, candle) => {
 *     // candle is closed — run indicators, store to DB, aggregate HTFs
 *     computeIndicators(candle);
 *     upsertBars([candle]);
 *     aggregateAndStore(symbol, candle);
 *   });
 *
 *   // Wire to option stream
 *   optionStream.onTick((tick) => {
 *     if (tick.type === 'trade') {
 *       builder.processTick(tick.symbol, tick.price!, tick.size!, tick.ts);
 *     } else if (tick.type === 'quote') {
 *       builder.processQuote(tick.symbol, tick.bid!, tick.ask!, tick.ts);
 *     }
 *   });
 *
 *   // Safety net: flush all candles on minute boundary
 *   setInterval(() => builder.flushAll(), 60_000);
 */

export interface FormingCandle {
  minuteTs: number;  // unix seconds, floored to minute
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ticks: number;     // number of trade ticks in this candle
  // Spread aggregation: running average of (ask - bid) observed during the bar
  spreadSum: number;
  spreadSamples: number;
  /** Source of the close price: 'trade' | 'quote' | 'rest' */
  closeSource: 'trade' | 'quote' | 'rest';
}

export type CandleCloseCallback = (symbol: string, candle: FormingCandle) => void;

export class OptionCandleBuilder {
  private candles = new Map<string, FormingCandle>();
  private closeCallback: CandleCloseCallback;
  /** Per-symbol last seen tick timestamp — rejects out-of-order ticks from reconnects/replays. */
  private lastTickTs = new Map<string, number>();

  constructor(onClose: CandleCloseCallback) {
    this.closeCallback = onClose;
  }

  /**
   * Process a trade tick into the forming candle.
   *
   * If the tick belongs to a new minute, the previous candle is closed
   * (emitted via onClose) and a new candle is opened. Trade ticks always
   * open new candles if none exists for the current minute.
   *
   * @param symbol — option contract symbol (e.g., 'SPXW260401C06500000')
   * @param price — trade price (must be > 0)
   * @param volume — trade size/volume
   * @param tsMs — timestamp in unix milliseconds
   */
  processTick(symbol: string, price: number, volume: number, tsMs: number): void {
    if (price <= 0) return;

    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);

    // Out-of-order guard: reject ticks older than the last tick we processed for
    // this symbol (with 2s tolerance for minor clock skew between data sources).
    // Prevents stale ticks from ThetaData reconnects from corrupting forming candles.
    const prevTs = this.lastTickTs.get(symbol);
    if (prevTs != null && ts < prevTs - 2) return;
    this.lastTickTs.set(symbol, ts);

    let candle = this.candles.get(symbol);

    if (!candle || candle.minuteTs !== minuteTs) {
      // New minute — close previous candle if it exists and has trades
      if (candle && candle.ticks > 0) {
        this.closeCallback(symbol, candle);
      }
      // Open new candle
      candle = {
        minuteTs,
        open: price,
        high: price,
        low: price,
        close: price,
        volume: 0,
        ticks: 0,
        spreadSum: 0,
        spreadSamples: 0,
        closeSource: 'trade',
      };
      this.candles.set(symbol, candle);
    }

    // Update OHLCV
    if (price > candle.high) candle.high = price;
    if (price < candle.low) candle.low = price;
    candle.close = price;
    candle.volume += volume;
    candle.ticks++;
  }

  /**
   * Process a quote tick — updates existing candle from bid/ask midpoint.
   *
   * Quotes update high/low/close of an existing candle but do NOT open
   * new candles. This prevents phantom candles from quote-only activity
   * (e.g., market maker updates without actual trades).
   *
   * @param symbol — option contract symbol
   * @param bid — bid price (must be > 0)
   * @param ask — ask price (must be > 0)
   * @param tsMs — timestamp in unix milliseconds
   */
  processQuote(symbol: string, bid: number, ask: number, tsMs: number): void {
    if (bid <= 0 || ask <= 0) return;

    const ts = Math.floor(tsMs / 1000);

    // Out-of-order guard (same as processTick)
    const prevTs = this.lastTickTs.get(symbol);
    if (prevTs != null && ts < prevTs - 2) return;
    this.lastTickTs.set(symbol, ts);

    const mid = (bid + ask) / 2;

    // Only update an existing candle — don't open a new one from just a quote
    const candle = this.candles.get(symbol);
    if (!candle) return;

    // Check the quote is for the current candle's minute
    const minuteTs = ts - (ts % 60);
    if (candle.minuteTs !== minuteTs) return; // stale quote for a previous minute

    // Update high/low/close from mid
    if (mid > candle.high) candle.high = mid;
    if (mid < candle.low) candle.low = mid;
    candle.close = mid;
    candle.closeSource = 'quote';

    // Aggregate spread (ask - bid) for this bar
    const spread = ask - bid;
    if (spread >= 0) {
      candle.spreadSum += spread;
      candle.spreadSamples++;
    }
  }

  /**
   * Average spread observed during a forming candle's lifetime.
   * Returns `undefined` when no quote samples were collected.
   */
  static averageSpread(candle: FormingCandle): number | undefined {
    if (candle.spreadSamples <= 0) return undefined;
    return candle.spreadSum / candle.spreadSamples;
  }

  /**
   * Close all forming candles — call on minute boundary timer.
   *
   * This is the safety net that ensures candles close even if no new tick
   * arrives to trigger the minute rollover. Only emits candles that have
   * at least one trade tick (ticks > 0).
   */
  flushAll(): void {
    for (const [symbol, candle] of this.candles) {
      if (candle.ticks > 0) {
        this.closeCallback(symbol, candle);
      }
    }
    this.candles.clear();
  }

  /** Number of symbols with active forming candles */
  get activeSymbols(): number {
    return this.candles.size;
  }

  /**
   * Validate forming candle closes against a ground-truth source (e.g., REST quote mid).
   * If the candle close diverges from restMid by more than maxDivergencePct,
   * replace the close with restMid and mark the source as 'rest'.
   *
   * Call this just before flushAll() at each minute boundary.
   *
   * @param restMids — Map of symbol → REST quote mid price
   * @param maxDivergencePct — Max allowed divergence before override (default 5%)
   * @param validateSymbols — Set of symbols to validate. If undefined, validates all active candles.
   */
  validateCandles(
    restMids: Map<string, number>,
    maxDivergencePct = 5,
    validateSymbols?: Set<string>,
  ): void {
    const threshold = maxDivergencePct / 100;
    for (const [symbol, candle] of this.candles) {
      if (validateSymbols && !validateSymbols.has(symbol)) continue;
      const restMid = restMids.get(symbol);
      if (restMid === undefined) continue;
      if (candle.close <= 0) continue;
      const divergence = Math.abs(candle.close - restMid) / candle.close;
      if (divergence > threshold) {
        candle.close = restMid;
        candle.closeSource = 'rest';
      }
    }
  }

  /** Get the forming candle for a symbol (for diagnostics only — not for trading decisions) */
  getFormingCandle(symbol: string): FormingCandle | undefined {
    return this.candles.get(symbol);
  }
}
