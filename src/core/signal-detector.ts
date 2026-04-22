/**
 * Centralized signal detection — single source of truth for both replay and live agents.
 *
 * detectSignals() is the PRIMARY ENTRY trigger for all trading decisions.
 * It runs on OPTION CONTRACT bars (not SPX underlying), detecting HMA/EMA/RSI crosses
 * on each contract's own price series.
 *
 * Used by:
 *   - src/replay/machine.ts  — replay system (getContractBarsAt → detectSignals)
 *   - spx_agent.ts           — live SPX agent (buildContractBars → detectSignals)
 *
 * Config-driven: all thresholds, periods, and toggle flags come from Config.
 * Returns Signal[] using the canonical type from ./types.
 *
 * Supports: HMA crosses, EMA crosses, RSI crosses, Price-cross-HMA, Price-cross-EMA.
 * All signal types are independently togglable via config.signals.
 */

import type { CoreBar, Signal, SignalType, Direction } from './types';
import type { Config } from '../config/types';
import { registerHmaPeriod } from './indicator-engine';

/** EMA periods still use a fixed set — adding EMA periods requires changing
 *  the tier-1/tier-2 compute branches, not just registering a number. */
export const VALID_EMA_PERIODS = [9, 21, 50, 200] as const;

/**
 * Validate config signal periods AND register any requested HMA periods with
 * the indicator engine. Call this at agent/replay/data-service startup after
 * config load — ensures `ind['hma${period}']` is populated on every bar before
 * the signal detector tries to read it.
 *
 * HMA periods: registered dynamically (any integer ≥2 becomes valid).
 * EMA periods: still restricted to [9, 21, 50, 200] — fast-fail on misconfig.
 */
export function validateSignalConfig(config: Config): void {
  const sig = config.signals;
  const hmaFast = sig.hmaCrossFast ?? 5;
  const hmaSlow = sig.hmaCrossSlow ?? 19;
  const emaFast = sig.emaCrossFast ?? 9;
  const emaSlow = sig.emaCrossSlow ?? 21;

  if (sig.enableHmaCrosses) {
    if (hmaFast >= hmaSlow) {
      throw new Error(`[signal-detector] hmaCrossFast(${hmaFast}) must be < hmaCrossSlow(${hmaSlow})`);
    }
    // Teach the indicator engine about whatever periods this config needs.
    // registerHmaPeriod throws on non-integer / <2, giving us the fast-fail.
    registerHmaPeriod(hmaFast);
    registerHmaPeriod(hmaSlow);
  }

  if (sig.enableEmaCrosses) {
    if (!(VALID_EMA_PERIODS as readonly number[]).includes(emaFast)) {
      throw new Error(`[signal-detector] emaCrossFast=${emaFast} is not computed by the indicator engine. Valid periods: ${VALID_EMA_PERIODS.join(', ')}`);
    }
    if (!(VALID_EMA_PERIODS as readonly number[]).includes(emaSlow)) {
      throw new Error(`[signal-detector] emaCrossSlow=${emaSlow} is not computed by the indicator engine. Valid periods: ${VALID_EMA_PERIODS.join(', ')}`);
    }
    if (emaFast >= emaSlow) {
      throw new Error(`[signal-detector] emaCrossFast(${emaFast}) must be < emaCrossSlow(${emaSlow})`);
    }
  }
}

/**
 * Parse an option symbol to extract call/put side and strike price.
 * Matches trailing C or P followed by 4-5 digit strike, with optional trailing 000.
 * Examples: SPXW260318C05700000 → { isCall: true, strike: 5700 }
 */
export function parseSymbol(sym: string): { isCall: boolean; strike: number; expiry?: string } | null {
  // SPXW format: SPXW + YYMMDD + C/P + strike*1000
  const spxwMatch = sym.match(/^SPXW(\d{6})([CP])(\d{8})$/);
  if (spxwMatch) {
    const [, expiryCode, type, strikeCode] = spxwMatch;
    const year = 2000 + parseInt(expiryCode.substring(0, 2));
    const month = parseInt(expiryCode.substring(2, 4));
    const day = parseInt(expiryCode.substring(4, 6));
    const expiry = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    return {
      isCall: type === 'C',
      strike: parseInt(strikeCode) / 1000,
      expiry
    };
  }

  // Legacy format: C or P followed by strike
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
 * Check bar quality for a contract. Returns true if the synthetic bar ratio
 * exceeds the threshold — meaning the data is too unreliable for signal detection.
 *
 * Bars without a `synthetic` field are treated as real (conservative — assumes
 * they came from a path that doesn't track synthetic status).
 *
 * @param bars - Contract bars (chronological, newest last)
 * @param maxSyntheticRatio - Maximum allowed synthetic ratio (0-1, default 0.5)
 * @param lookback - Number of recent bars to check (default 20)
 */
export function isBarDataUnhealthy(
  bars: CoreBar[],
  maxSyntheticRatio: number = 0.5,
  lookback: number = 20,
): boolean {
  if (bars.length < 5) return true; // too few bars to be reliable
  const recent = bars.slice(-lookback);
  const total = recent.length;
  const syntheticCount = recent.filter(b => b.synthetic === true).length;
  return (syntheticCount / total) > maxSyntheticRatio;
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
  const priceMax = config.strikeSelector?.contractPriceMax ?? 9999;
  const targetOtm = sig.targetOtmDistance ?? 0;

  // Resolve strike mode — 'otm' | 'atm' | 'itm' | 'any'
  const strikeMode = config.strikeSelector?.strikeMode ?? 'otm';
  const searchRange = config.strikeSelector?.strikeSearchRange ?? 100;

  // Warm-up bar guard — skip signal detection if not enough bars
  const minWarmupBars = sig.minWarmupBars ?? 0;

  for (const [symbol, bars] of contractBars) {
    if (bars.length < 2) continue;

    // Warm-up guard: require minimum bars for indicator stability
    if (minWarmupBars > 0 && bars.length < minWarmupBars) continue;

    // Bar quality gate — skip contracts with too many synthetic/filler bars.
    // If >50% of recent bars are synthetic, the HMA is computed on mostly
    // interpolated data and any detected cross is unreliable.
    if (isBarDataUnhealthy(bars)) continue;

    // Parse symbol for call/put and strike
    const parsed = parseSymbol(symbol);
    if (!parsed) continue;
    const { isCall, strike } = parsed;

    // Moneyness filter based on strikeMode
    const distFromSpx = Math.abs(strike - spxPrice);
    if (distFromSpx > searchRange) continue; // always limit to search range

    switch (strikeMode) {
      case 'otm': {
        // Legacy: allow ITM if targetOtmDistance < 0
        if (targetOtm >= 0) {
          if (isCall && strike <= spxPrice) continue;
          if (!isCall && strike >= spxPrice) continue;
        } else {
          const maxItm = Math.abs(targetOtm) + 10;
          if (isCall && strike < spxPrice - maxItm) continue;
          if (!isCall && strike > spxPrice + maxItm) continue;
        }
        break;
      }
      case 'atm':
        // Allow all — but only within searchRange (already filtered above)
        break;
      case 'itm': {
        // Only ITM + near-ATM (5pt buffer)
        if (isCall && strike > spxPrice + 5) continue;
        if (!isCall && strike < spxPrice - 5) continue;
        break;
      }
      case 'any':
        // No moneyness filter
        break;
    }

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

    // ── Synthetic bar filter ─────────────────────────────────────────────
    // Skip signal detection if the PREVIOUS bar was stale-filled (flat price for 60+ min).
    // Stale-filled bars pre-warm HMA state with artificial flat values, so crosses on
    // the bar immediately after a stale gap are unreliable. Interpolated gaps are allowed
    // since they represent gradual movement and are less likely to cause false crosses.
    // Note: synthetic/gapType exist on full Bar type; CoreBar may carry them at runtime.
    const prevAny = prev as any;
    if (prevAny.synthetic && prevAny.gapType === 'stale') continue;

    // ── HMA crosses ──────────────────────────────────────────────────────
    // Hysteresis: require a minimum price separation to confirm a cross — prevents
    // floating-point jitter (where HMA values oscillate around equality) from firing
    // phantom back-to-back signals. Threshold scales with contract price to stay
    // meaningful across both cheap (~$0.50) and expensive (~$8.00) contracts.
    const hmaCrossThreshold = Math.max(0.01, curr.close * 0.001); // 0.1% of price, min $0.01

    if (
      sig.enableHmaCrosses &&
      prevInd[hmaFastKey] != null && prevInd[hmaSlowKey] != null &&
      ind[hmaFastKey] != null && ind[hmaSlowKey] != null
    ) {
      // Fast crossed above slow → bullish (require curr fast > slow by threshold)
      if (prevInd[hmaFastKey]! < prevInd[hmaSlowKey]! &&
          ind[hmaFastKey]! > ind[hmaSlowKey]! + hmaCrossThreshold) {
        signals.push(makeSignal(symbol, isCall, strike, 'HMA_CROSS', 'bullish', {
          [hmaFastKey]: ind[hmaFastKey],
          [hmaSlowKey]: ind[hmaSlowKey],
        }));
      }

      // Fast crossed below slow → bearish (require curr slow > fast by threshold)
      if (prevInd[hmaFastKey]! > prevInd[hmaSlowKey]! &&
          ind[hmaSlowKey]! > ind[hmaFastKey]! + hmaCrossThreshold) {
        signals.push(makeSignal(symbol, isCall, strike, 'HMA_CROSS', 'bearish', {
          [hmaFastKey]: ind[hmaFastKey],
          [hmaSlowKey]: ind[hmaSlowKey],
        }));
      }
    }

    const emaCrossThreshold = Math.max(0.01, curr.close * 0.001);

    // ── EMA crosses ──────────────────────────────────────────────────────
    if (
      sig.enableEmaCrosses &&
      prevInd[emaFastKey] != null && prevInd[emaSlowKey] != null &&
      ind[emaFastKey] != null && ind[emaSlowKey] != null
    ) {
      // Fast crossed above slow → bullish
      if (prevInd[emaFastKey]! < prevInd[emaSlowKey]! &&
          ind[emaFastKey]! > ind[emaSlowKey]! + emaCrossThreshold) {
        signals.push(makeSignal(symbol, isCall, strike, 'EMA_CROSS', 'bullish', {
          [emaFastKey]: ind[emaFastKey],
          [emaSlowKey]: ind[emaSlowKey],
        }));
      }

      // Fast crossed below slow → bearish
      if (prevInd[emaFastKey]! > prevInd[emaSlowKey]! &&
          ind[emaSlowKey]! > ind[emaFastKey]! + emaCrossThreshold) {
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
