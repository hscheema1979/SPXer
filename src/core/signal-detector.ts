/**
 * Centralized signal detection — single source of truth for both replay and live agent.
 *
 * Config-driven: all thresholds, periods, and toggle flags come from Config.
 * Returns Signal[] using the canonical type from ./types.
 *
 * Supports: HMA crosses, EMA crosses, RSI crosses, Price-cross-HMA, Price-cross-EMA.
 * All signal types are independently togglable via config.signals.
 */

import type { CoreBar, Signal, SignalType, Direction } from './types';
import type { Config } from '../config/types';

/**
 * Parse an option symbol to extract call/put side and strike price.
 * Matches trailing C or P followed by 4-5 digit strike, with optional trailing 000.
 * Examples: SPXW260318C05700000 → { isCall: true, strike: 5700 }
 */
function parseSymbol(sym: string): { isCall: boolean; strike: number } | null {
  const m = sym.replace(/\s+/g, '').match(/([CP])(\d{4,5})(?:000)?$/i);
  if (!m) return null;
  return { isCall: m[1].toUpperCase() === 'C', strike: parseInt(m[2]) };
}

/**
 * Build a Signal object with indicator snapshot for debugging/logging.
 */
function makeSignal(
  symbol: string,
  isCall: boolean,
  strike: number,
  signalType: SignalType,
  direction: Direction,
  indicators: Record<string, number | null>,
): Signal {
  return {
    symbol,
    side: isCall ? 'call' : 'put',
    strike,
    signalType,
    direction,
    indicators,
  };
}

/**
 * Detect trading signals across all option contracts.
 *
 * @param contractBars - Map of symbol → bars (ordered chronologically, newest last)
 * @param spxPrice - Current SPX underlying price (used for OTM filtering)
 * @param config - Full Config object (signals, strikeSelector sections used)
 * @returns Array of detected signals (may contain multiple signals per contract)
 */
export function detectSignals(
  contractBars: Map<string, CoreBar[]>,
  spxPrice: number,
  config: Config,
): Signal[] {
  const signals: Signal[] = [];
  const sig = config.signals;

  // Pre-compute indicator key names from config periods
  const hmaFast = sig.hmaCrossFast ?? 5;
  const hmaSlow = sig.hmaCrossSlow ?? 19;
  const hmaFastKey = `hma${hmaFast}`;
  const hmaSlowKey = `hma${hmaSlow}`;

  const emaFast = sig.emaCrossFast ?? 9;
  const emaSlow = sig.emaCrossSlow ?? 21;
  const emaFastKey = `ema${emaFast}`;
  const emaSlowKey = `ema${emaSlow}`;

  const priceMin = config.strikeSelector?.contractPriceMin ?? 0.2;
  const priceMax = config.strikeSelector?.contractPriceMax ?? 8.0;

  for (const [symbol, bars] of contractBars) {
    if (bars.length < 2) continue;

    // Parse symbol for call/put and strike
    const parsed = parseSymbol(symbol);
    if (!parsed) continue;
    const { isCall, strike } = parsed;

    // OTM-only filter: calls must have strike > spxPrice, puts must have strike < spxPrice
    if (isCall && strike <= spxPrice) continue;
    if (!isCall && strike >= spxPrice) continue;

    const curr = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const ind = curr.indicators;
    const prevInd = prev.indicators;

    // Contract price filter — skip contracts outside the configured price band
    if (curr.close < priceMin || curr.close > priceMax) continue;

    // ── RSI crosses ───────────────────────────────────────────────────────
    if (sig.enableRsiCrosses && ind.rsi14 != null && prevInd.rsi14 != null) {
      const osLevel = sig.optionRsiOversold;
      const obLevel = sig.optionRsiOverbought;

      // Crossed below oversold → bullish (oversold bounce entry)
      if (prevInd.rsi14 >= osLevel && ind.rsi14 < osLevel) {
        signals.push(makeSignal(symbol, isCall, strike, 'RSI_CROSS', 'bullish', {
          rsi14: ind.rsi14,
          prevRsi14: prevInd.rsi14,
        }));
      }

      // Crossed above overbought → bearish (overbought fade entry)
      if (prevInd.rsi14 <= obLevel && ind.rsi14 > obLevel) {
        signals.push(makeSignal(symbol, isCall, strike, 'RSI_CROSS', 'bearish', {
          rsi14: ind.rsi14,
          prevRsi14: prevInd.rsi14,
        }));
      }
    }

    // ── HMA crosses ──────────────────────────────────────────────────────
    if (
      sig.enableHmaCrosses &&
      prevInd[hmaFastKey] != null && prevInd[hmaSlowKey] != null &&
      ind[hmaFastKey] != null && ind[hmaSlowKey] != null
    ) {
      // Fast crossed above slow → bullish
      if (prevInd[hmaFastKey]! < prevInd[hmaSlowKey]! && ind[hmaFastKey]! >= ind[hmaSlowKey]!) {
        signals.push(makeSignal(symbol, isCall, strike, 'HMA_CROSS', 'bullish', {
          [hmaFastKey]: ind[hmaFastKey],
          [hmaSlowKey]: ind[hmaSlowKey],
        }));
      }

      // Fast crossed below slow → bearish
      if (prevInd[hmaFastKey]! >= prevInd[hmaSlowKey]! && ind[hmaFastKey]! < ind[hmaSlowKey]!) {
        signals.push(makeSignal(symbol, isCall, strike, 'HMA_CROSS', 'bearish', {
          [hmaFastKey]: ind[hmaFastKey],
          [hmaSlowKey]: ind[hmaSlowKey],
        }));
      }
    }

    // ── EMA crosses ──────────────────────────────────────────────────────
    if (
      sig.enableEmaCrosses &&
      prevInd[emaFastKey] != null && prevInd[emaSlowKey] != null &&
      ind[emaFastKey] != null && ind[emaSlowKey] != null
    ) {
      // Fast crossed above slow → bullish
      if (prevInd[emaFastKey]! < prevInd[emaSlowKey]! && ind[emaFastKey]! >= ind[emaSlowKey]!) {
        signals.push(makeSignal(symbol, isCall, strike, 'EMA_CROSS', 'bullish', {
          [emaFastKey]: ind[emaFastKey],
          [emaSlowKey]: ind[emaSlowKey],
        }));
      }

      // Fast crossed below slow → bearish
      if (prevInd[emaFastKey]! >= prevInd[emaSlowKey]! && ind[emaFastKey]! < ind[emaSlowKey]!) {
        signals.push(makeSignal(symbol, isCall, strike, 'EMA_CROSS', 'bearish', {
          [emaFastKey]: ind[emaFastKey],
          [emaSlowKey]: ind[emaSlowKey],
        }));
      }
    }

    // ── Price crosses HMA ────────────────────────────────────────────────
    // Price crossing HMA5 (noisy but useful for scalp entries — separate toggle)
    if (
      sig.enablePriceCrossHma &&
      prevInd.hma5 != null && ind.hma5 != null
    ) {
      // Price crossed above HMA5 → bullish
      if (prev.close <= prevInd.hma5 && curr.close > ind.hma5!) {
        signals.push(makeSignal(symbol, isCall, strike, 'PRICE_CROSS_HMA', 'bullish', {
          hma5: ind.hma5,
          close: curr.close,
        }));
      }

      // Price crossed below HMA5 → bearish
      if (prev.close >= prevInd.hma5 && curr.close < ind.hma5!) {
        signals.push(makeSignal(symbol, isCall, strike, 'PRICE_CROSS_HMA', 'bearish', {
          hma5: ind.hma5,
          close: curr.close,
        }));
      }
    }

    // ── Price crosses EMA ────────────────────────────────────────────────
    // Price crossing EMA21 (trend confirmation — uses enableEmaCrosses toggle)
    if (
      sig.enableEmaCrosses &&
      prevInd.ema21 != null && ind.ema21 != null
    ) {
      // Price crossed above EMA21 → bullish
      if (prev.close <= prevInd.ema21 && curr.close > ind.ema21!) {
        signals.push(makeSignal(symbol, isCall, strike, 'PRICE_CROSS_EMA', 'bullish', {
          ema21: ind.ema21,
          close: curr.close,
        }));
      }

      // Price crossed below EMA21 → bearish
      if (prev.close >= prevInd.ema21 && curr.close < ind.ema21!) {
        signals.push(makeSignal(symbol, isCall, strike, 'PRICE_CROSS_EMA', 'bearish', {
          ema21: ind.ema21,
          close: curr.close,
        }));
      }
    }
  }

  return signals;
}
