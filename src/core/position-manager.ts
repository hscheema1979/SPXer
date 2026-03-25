/**
 * Centralized position exit logic — single source of truth.
 * Used by both replay (src/replay/machine.ts) and live agent (src/agent/position-manager.ts).
 */

import type { Position, ExitCheck, ExitReason, Direction } from './types';
import type { Config } from '../config/types';

export interface ExitContext {
  ts: number;
  closeCutoffTs: number;
  hmaCrossDirection: Direction | null;
}

/**
 * Check whether a position should be exited.
 *
 * Conditions are evaluated in priority order:
 *   1. Stop loss   — price dropped by stopLossPercent (skipped when 0 = disabled)
 *   2. Take profit — price reached entryPrice * takeProfitMultiplier
 *   3. Signal reversal — underlying HMA cross flipped against position direction
 *   4. Time exit   — current timestamp >= close cutoff
 */
export function checkExit(
  position: Position,
  currentPrice: number,
  config: Config,
  context: ExitContext,
): ExitCheck {
  // 1. Stop loss (disabled when stopLossPercent is 0)
  if (config.position.stopLossPercent > 0 && currentPrice <= position.stopLoss) {
    return { shouldExit: true, reason: 'stop_loss' };
  }

  // 2. Take profit
  if (currentPrice >= position.takeProfit) {
    return { shouldExit: true, reason: 'take_profit' };
  }

  // 3. Signal reversal: underlying HMA cross flipped against our position
  if (context.hmaCrossDirection != null) {
    const crossAgainst =
      (position.side === 'call' && context.hmaCrossDirection === 'bearish') ||
      (position.side === 'put' && context.hmaCrossDirection === 'bullish');
    if (crossAgainst) {
      return { shouldExit: true, reason: 'signal_reversal' };
    }
  }

  // 4. Time exit: at or past close cutoff
  if (context.ts >= context.closeCutoffTs) {
    return { shouldExit: true, reason: 'time_exit' };
  }

  return { shouldExit: false, reason: null };
}
