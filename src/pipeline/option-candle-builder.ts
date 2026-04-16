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
}

export type CandleCloseCallback = (symbol: string, candle: FormingCandle) => void;

export class OptionCandleBuilder {
  private candles = new Map<string, FormingCandle>();
  private closeCallback: CandleCloseCallback;

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

    const mid = (bid + ask) / 2;

    // Only update an existing candle — don't open a new one from just a quote
    const candle = this.candles.get(symbol);
    if (!candle) return;

    // Check the quote is for the current candle's minute
    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);
    if (candle.minuteTs !== minuteTs) return; // stale quote for a previous minute

    // Update high/low/close from mid
    if (mid > candle.high) candle.high = mid;
    if (mid < candle.low) candle.low = mid;
    candle.close = mid;
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

  /** Get the forming candle for a symbol (for diagnostics only — not for trading decisions) */
  getFormingCandle(symbol: string): FormingCandle | undefined {
    return this.candles.get(symbol);
  }
}
