/**
 * SignalDetector: finds tradeable pattern candidates from bar summaries.
 * Returns AgentSignal objects only when a meaningful pattern fires.
 * No execution logic here — purely observational.
 */
import type { AgentSignal, BarSummary, SpxContext } from './types';
import type { ContractMeta } from './market-feed';

// Track previous bar RSI/EMA per symbol to detect crossovers
const prevState = new Map<string, { rsi14: number | null; ema9: number | null; ema21: number | null }>();

export interface ContractQuote {
  last: number | null;
  bid: number | null;
  ask: number | null;
}

export function detectSignals(
  contracts: ContractMeta[],
  barsBySymbol: Map<string, BarSummary[]>,
  quotes: Map<string, ContractQuote>,
  spxContext: SpxContext,
): AgentSignal[] {
  const signals: AgentSignal[] = [];

  for (const contract of contracts) {
    const bars = barsBySymbol.get(contract.symbol);
    if (!bars || bars.length < 3) continue;

    const curr = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const stored = prevState.get(contract.symbol);

    // Use stored previous state if available (more accurate than prev bar for cross-session)
    const prevRsi = stored?.rsi14 ?? prev.rsi14;
    const prevEma9 = stored?.ema9 ?? prev.ema9;
    const prevEma21 = stored?.ema21 ?? prev.ema21;

    // Update stored state
    prevState.set(contract.symbol, {
      rsi14: curr.rsi14,
      ema9: curr.ema9,
      ema21: curr.ema21,
    });

    const quote = quotes.get(contract.symbol);
    const currentPrice = quote?.last ?? curr.close;
    if (!currentPrice || currentPrice <= 0) continue;

    const signalBarLow = Math.min(...bars.slice(-3).map(b => b.close)) * 0.98;

    const baseSignal = {
      symbol: contract.symbol,
      side: contract.side,
      strike: contract.strike,
      expiry: contract.expiry,
      currentPrice,
      bid: quote?.bid ?? null,
      ask: quote?.ask ?? null,
      indicators: {
        rsi14: curr.rsi14,
        ema9: curr.ema9,
        ema21: curr.ema21,
        hma5: curr.hma5,
        hma19: curr.hma19,
      },
      recentBars: bars.slice(-10),
      signalBarLow,
      spxContext,
      ts: Date.now(),
    };

    // Signal 1: RSI crossed above 40 (momentum awakening)
    if (
      prevRsi !== null && curr.rsi14 !== null &&
      prevRsi < 40 && curr.rsi14 >= 40
    ) {
      signals.push({ ...baseSignal, type: 'RSI_BREAK_40' });
      continue; // one signal per contract per cycle
    }

    // Signal 2: RSI crossed above 50 (momentum confirmation — stronger)
    if (
      prevRsi !== null && curr.rsi14 !== null &&
      prevRsi < 50 && curr.rsi14 >= 50
    ) {
      signals.push({ ...baseSignal, type: 'RSI_BREAK_50' });
      continue;
    }

    // Signal 3: EMA9 crossed above EMA21 (trend flip)
    if (
      prevEma9 !== null && prevEma21 !== null &&
      curr.ema9 !== null && curr.ema21 !== null &&
      prevEma9 < prevEma21 && curr.ema9 >= curr.ema21
    ) {
      signals.push({ ...baseSignal, type: 'EMA_CROSS' });
      continue;
    }

    // Signal 4: HMA5 crossed above HMA19 (Hull momentum flip)
    if (
      bars.length >= 2 &&
      prev.hma5 !== null && prev.hma19 !== null &&
      curr.hma5 !== null && curr.hma19 !== null &&
      prev.hma5 < prev.hma19 && curr.hma5 >= curr.hma19
    ) {
      signals.push({ ...baseSignal, type: 'HMA_CROSS' });
    }
  }

  return signals;
}

export function clearState(): void {
  prevState.clear();
}
