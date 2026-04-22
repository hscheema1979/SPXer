/**
 * PriceLine — Minimal Price Tracker for Live HMA Calculation
 *
 * Tracks the last price per symbol per minute. At minute boundary, validates
 * against REST quote mid and records the close. Produces clean 1m bars with
 * only the fields needed for HMA signals.
 *
 * For replay: bars come from historical parquet/SQLite — no streaming needed.
 * For live: this is the single source of truth.
 *
 * Usage:
 *   const line = new PriceLine();
 *
 *   // On tick (trade or quote mid)
 *   line.processTick('SPXW260401C06500000', 3.50, Date.now(), 5);
 *   line.processQuote('SPXW260401C06500000', 3.40, 3.60, Date.now());
 *
 *   // At minute boundary — validate + snapshot
 *   const bars = line.snapshotAndFlush(restMids, 5);
 *   for (const bar of bars) upsertBars([bar]);
 */

export interface PricePoint {
  price: number;
  ts: number;       // unix seconds
  volume: number;
  source: 'trade' | 'quote';
}

export interface Bar {
  symbol: string;
  timeframe: '1m';
  ts: number;       // minute timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  indicators?: Record<string, number | null>;
}

/**
 * Minimal price tracker — one price point per symbol per minute.
 * Trade ticks override quote mids; quote mids fill in when no trade arrives.
 */
export class PriceLine {
  /** Per-symbol current minute price state */
  private points = new Map<string, PricePoint>();
  /** Per-symbol previous minute closed bar (for H/L computation) */
  private prevBars = new Map<string, { high: number; low: number }>();

  /**
   * Process a trade tick. Trade prices take priority over quote mids.
   * @param symbol — option contract symbol
   * @param price — trade price
   * @param tsMs — unix milliseconds
   * @param volume — trade volume
   */
  processTick(symbol: string, price: number, tsMs: number, volume: number): void {
    if (price <= 0) return;
    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);

    const existing = this.points.get(symbol);
    if (existing && existing.ts === minuteTs && existing.source === 'trade') {
      // Already have a trade this minute — update if price changed
      if (price !== existing.price) {
        this.points.set(symbol, { price, ts: minuteTs, volume: existing.volume + volume, source: 'trade' });
      } else {
        existing.volume += volume;
      }
    } else {
      this.points.set(symbol, { price, ts: minuteTs, volume, source: 'trade' });
    }
  }

  /**
   * Process a quote tick (bid/ask midpoint). Only used if no trade arrived this minute.
   * @param symbol — option contract symbol
   * @param bid — bid price
   * @param ask — ask price
   * @param tsMs — unix milliseconds
   */
  processQuote(symbol: string, bid: number, ask: number, tsMs: number): void {
    if (bid <= 0 || ask <= 0) return;
    const ts = Math.floor(tsMs / 1000);
    const minuteTs = ts - (ts % 60);

    const mid = (bid + ask) / 2;
    const existing = this.points.get(symbol);

    // Only update if no trade yet this minute (quotes can't open new candles)
    if (existing && existing.ts === minuteTs) return;

    this.points.set(symbol, { price: mid, ts: minuteTs, volume: 0, source: 'quote' });
  }

  /**
   * Validate all forming price points against REST quote mids, then build
   * closed 1m bars. Call this at each minute boundary.
   *
   * @param restMids — Map of symbol → REST quote bid/ask midpoint
   * @param maxDivergencePct — Override close if stream price diverges >X% from REST mid (default 5%)
   * @returns Array of closed Bar objects ready to store
   */
  snapshotAndFlush(
    restMids: Map<string, number>,
    maxDivergencePct = 5,
  ): Bar[] {
    const bars: Bar[] = [];
    const threshold = maxDivergencePct / 100;
    const now = Math.floor(Date.now() / 1000);
    const currentMinute = now - (now % 60);

    // Collect symbols to delete AFTER processing all bars
    const toDelete: string[] = [];

    for (const [symbol, point] of this.points) {
      // Only close bars for past minutes (point.ts <= currentMinute - 1)
      // Never close the CURRENT forming minute
      if (point.ts >= currentMinute) continue;

      const prev = this.prevBars.get(symbol);
      let close = point.price;
      let high = point.price;
      let low = point.price;
      const volume = point.volume;
      const source = point.source;

      // REST validation — override close if stream diverges >threshold
      const restMid = restMids.get(symbol);
      if (restMid !== undefined && close > 0) {
        const divergence = Math.abs(close - restMid) / close;
        if (divergence > threshold) {
          close = restMid;
          if (source === 'quote') {
            high = restMid;
            low = restMid;
          }
        }
      }

      // Carry forward H/L from previous bar for context
      if (prev) {
        high = Math.max(high, prev.high);
        low = Math.min(low, prev.low);
      }

      // Quote-only bars with no trades: set H=L=close to avoid corrupting HMA
      if (source === 'quote' && volume === 0) {
        high = close;
        low = close;
      }

      bars.push({
        symbol,
        timeframe: '1m',
        ts: point.ts,
        open: close,
        high,
        low,
        close,
        volume,
      });

      // Save H/L for next minute's context
      this.prevBars.set(symbol, { high, low });
      toDelete.push(symbol);
    }

    // Remove ONLY the bars we just closed (not all points)
    for (const sym of toDelete) {
      this.points.delete(sym);
    }

    return bars;
  }

  /** Number of symbols currently tracking */
  get activeCount(): number {
    return this.points.size;
  }

  /** Get current forming price for a symbol (diagnostics only) */
  getPrice(symbol: string): number | null {
    return this.points.get(symbol)?.price ?? null;
  }
}
