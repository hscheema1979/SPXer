/**
 * Position Sizer — computes contract quantity for a trade.
 *
 * Extracted from replay/machine.ts (lines 917-918) into a pure function
 * usable by both replay and live agent.
 */

import type { Config } from '../config/types';

/**
 * Compute the number of contracts to trade given the entry price and config.
 *
 * Formula: rawQty = floor((baseDollarsPerTrade * sizeMultiplier) / (entryPrice * 100))
 * Clamped to [minContracts, maxContracts], minimum 1.
 */
export function computeQty(entryPrice: number, config: Config): number {
  const { baseDollarsPerTrade, sizeMultiplier, minContracts, maxContracts } = config.sizing;

  const rawQty = Math.floor((baseDollarsPerTrade * sizeMultiplier) / (entryPrice * 100)) || 1;

  return Math.max(minContracts, Math.min(maxContracts, Math.max(1, rawQty)));
}
