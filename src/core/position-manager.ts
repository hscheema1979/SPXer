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
import { resolveSlippage, slipSellPrice } from './fill-model';

export interface ExitContext {
  ts: number;
  closeCutoffTs: number;
  hmaCrossDirection: Direction | null;
  /** True only on the cycle a new closed bar produced a cross (dedup guard).
   *  When false, signal_reversal is suppressed — prevents firing every poll cycle. */
  hmaCrossFresh?: boolean;
  /** High-water mark price (for trailing stop). Caller must track this. */
  highWaterPrice?: number;
  /** Bar high — used for intrabar TP detection. */
  barHigh?: number;
  /** Bar low — used for intrabar SL detection. */
  barLow?: number;
  /** Bar open — used for 'by_open' intrabar tie-breaker. Optional. */
  barOpen?: number;
  /** Bar-level bid-ask spread (option) — used by spread-scaled SL slippage. */
  barSpread?: number;
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

  // Resolve fill-model slippage (Phase 2). When config.fill.slippage is undefined
  // or all zero, slFillPrice(SL) === SL, so Phase 1 clamping behavior is preserved.
  const slip = resolveSlippage(config);
  const minutesToClose = Math.max(0, (context.closeCutoffTs - context.ts) / 60);
  const slFillCtx = { spread: context.barSpread, minutesToClose };
  const slFillPrice = (): number =>
    slipSellPrice(position.stopLoss, position.qty, slip, slFillCtx);

  // For intrabar pricing, use bar high/low to detect TP/SL breach within the candle.
  // When both TP and SL are breached in the same bar, use the configured tie-breaker.
  // Exit price is clamped to the exact TP/SL level, not the bar close.
  if (intrabar && context.barHigh != null && context.barLow != null) {
    const slHit = config.position.stopLossPercent > 0 && context.barLow <= position.stopLoss;
    const tpHit = context.barHigh >= position.takeProfit;

    if (slHit && tpHit) {
      // Both breached — resolve tie per config.position.intrabarTieBreaker.
      const mode = config.position.intrabarTieBreaker ?? 'sl_wins';
      if (mode === 'tp_wins') {
        return { shouldExit: true, reason: 'take_profit', exitPrice: position.takeProfit };
      }
      if (mode === 'by_open' && context.barOpen != null) {
        // Whichever target the open price is closer to, that one wins.
        const distToTp = Math.abs(context.barOpen - position.takeProfit);
        const distToSl = Math.abs(context.barOpen - position.stopLoss);
        if (distToTp < distToSl) {
          return { shouldExit: true, reason: 'take_profit', exitPrice: position.takeProfit };
        }
        return { shouldExit: true, reason: 'stop_loss', exitPrice: slFillPrice() };
      }
      // Default 'sl_wins' — conservative.
      return { shouldExit: true, reason: 'stop_loss', exitPrice: slFillPrice() };
    }
    if (slHit) {
      return { shouldExit: true, reason: 'stop_loss', exitPrice: slFillPrice() };
    }
    if (tpHit) {
      return { shouldExit: true, reason: 'take_profit', exitPrice: position.takeProfit };
    }
  }

  // Fallback: close-based checks (legacy behavior, also used for non-TP/SL exits).
  // TP is a limit order — fills AT takeProfit, never above (we conservatively assume
  // no price improvement). SL is a stop-market — fills BELOW stopLoss with
  // size-proportional slippage (Phase 2 fill-model). The existing friction.ts
  // half-spread is applied separately by computeRealisticPnl.

  // 1. Stop loss (disabled when stopLossPercent is 0)
  if (config.position.stopLossPercent > 0 && currentPrice <= position.stopLoss) {
    return { shouldExit: true, reason: 'stop_loss', exitPrice: slFillPrice() };
  }

  // 2. Take profit
  if (currentPrice >= position.takeProfit) {
    return { shouldExit: true, reason: 'take_profit', exitPrice: position.takeProfit };
  }

  // 3. Trailing stop (if enabled) — also a stop-market order, fills with slippage
  //    below the trail level. Phase 2: model the same size-based slippage as a hard SL,
  //    but anchored to the trail level rather than position.stopLoss.
  if (exitCfg?.trailingStopEnabled && context.highWaterPrice != null) {
    const trailPct = (exitCfg.trailingStopPercent ?? 20) / 100;
    const trailStop = context.highWaterPrice * (1 - trailPct);
    if (currentPrice <= trailStop && currentPrice > position.stopLoss) {
      const trailFillPrice = slipSellPrice(trailStop, position.qty, slip, slFillCtx);
      return { shouldExit: true, reason: 'stop_loss', exitPrice: trailFillPrice };
    }
  }

  // 4. Signal reversal: underlying HMA cross flipped against our position
  //    ONLY when exit strategy is 'scannerReverse' AND on a fresh closed-bar cross.
  //    hmaCrossFresh guards against firing every poll cycle — without it, any position
  //    entered when the exit cross already opposes it would exit 5 seconds later.
  if (exitCfg?.strategy === 'scannerReverse' &&
      context.hmaCrossDirection != null &&
      context.hmaCrossFresh === true) {
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
