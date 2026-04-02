/**
 * Centralized position exit logic — single source of truth.
 * Used by both replay (src/replay/machine.ts) and live agent (src/agent/position-manager.ts).
 *
 * Now respects config.exit settings:
 *   - exit.strategy: 'takeProfit' (SL/TP only) or 'scannerReverse' (exit on HMA reversal)
 *   - exit.trailingStopEnabled / exit.trailingStopPercent
 *   - exit.timeBasedExitEnabled / exit.timeBasedExitMinutes
 */

import type { Position, ExitCheck, ExitReason, Direction } from './types';
import type { Config } from '../config/types';

export interface ExitContext {
  ts: number;
  closeCutoffTs: number;
  hmaCrossDirection: Direction | null;
  /** High-water mark price (for trailing stop). Caller must track this. */
  highWaterPrice?: number;
  /** Bar high — used for intrabar TP detection. */
  barHigh?: number;
  /** Bar low — used for intrabar SL detection. */
  barLow?: number;
}

/**
 * Check whether a position should be exited.
 *
 * Conditions are evaluated in priority order:
 *   1. Stop loss   — price dropped by stopLossPercent (skipped when 0 = disabled)
 *   2. Take profit — price reached entryPrice * takeProfitMultiplier
 *   3. Trailing stop — price dropped trailingStopPercent from high-water (if enabled)
 *   4. Signal reversal — underlying HMA cross flipped against position direction
 *      (ONLY when exit.strategy === 'scannerReverse')
 *   5. Time-based exit — position held longer than timeBasedExitMinutes (if enabled)
 *   6. Time exit   — current timestamp >= close cutoff (always active — EOD safety)
 */
export function checkExit(
  position: Position,
  currentPrice: number,
  config: Config,
  context: ExitContext,
): ExitCheck {
  const exitCfg = config.exit;
  const intrabar = exitCfg?.exitPricing === 'intrabar';

  // For intrabar pricing, use bar high/low to detect TP/SL breach within the candle.
  // When both TP and SL are breached in the same bar, SL takes priority (conservative).
  // Exit price is clamped to the exact TP/SL level, not the bar close.
  if (intrabar && context.barHigh != null && context.barLow != null) {
    const slHit = config.position.stopLossPercent > 0 && context.barLow <= position.stopLoss;
    const tpHit = context.barHigh >= position.takeProfit;

    if (slHit && tpHit) {
      // Both breached in same bar — assume SL hit first (conservative)
      return { shouldExit: true, reason: 'stop_loss', exitPrice: position.stopLoss };
    }
    if (slHit) {
      return { shouldExit: true, reason: 'stop_loss', exitPrice: position.stopLoss };
    }
    if (tpHit) {
      return { shouldExit: true, reason: 'take_profit', exitPrice: position.takeProfit };
    }
  }

  // Fallback: close-based checks (legacy behavior, also used for non-TP/SL exits)

  // 1. Stop loss (disabled when stopLossPercent is 0)
  if (config.position.stopLossPercent > 0 && currentPrice <= position.stopLoss) {
    return { shouldExit: true, reason: 'stop_loss' };
  }

  // 2. Take profit
  if (currentPrice >= position.takeProfit) {
    return { shouldExit: true, reason: 'take_profit' };
  }

  // 3. Trailing stop (if enabled)
  if (exitCfg?.trailingStopEnabled && context.highWaterPrice != null) {
    const trailPct = (exitCfg.trailingStopPercent ?? 20) / 100;
    const trailStop = context.highWaterPrice * (1 - trailPct);
    if (currentPrice <= trailStop && currentPrice > position.stopLoss) {
      return { shouldExit: true, reason: 'stop_loss' };
    }
  }

  // 4. Signal reversal: underlying HMA cross flipped against our position
  //    ONLY when exit strategy is 'scannerReverse'
  if (exitCfg?.strategy === 'scannerReverse' && context.hmaCrossDirection != null) {
    const crossAgainst =
      (position.side === 'call' && context.hmaCrossDirection === 'bearish') ||
      (position.side === 'put' && context.hmaCrossDirection === 'bullish');
    if (crossAgainst) {
      return { shouldExit: true, reason: 'signal_reversal' };
    }
  }

  // 5. Time-based exit: position held too long (if enabled)
  if (exitCfg?.timeBasedExitEnabled) {
    const maxHoldSec = (exitCfg.timeBasedExitMinutes ?? 5) * 60;
    if (context.ts - position.entryTs >= maxHoldSec) {
      return { shouldExit: true, reason: 'time_exit' };
    }
  }

  // 6. Time exit: at or past close cutoff (EOD safety — always active)
  if (context.ts >= context.closeCutoffTs) {
    return { shouldExit: true, reason: 'time_exit' };
  }

  return { shouldExit: false, reason: null };
}
