/**
 * Regime Gate — determines whether a trade direction is blocked by the current regime.
 *
 * Extracted from replay/machine.ts (lines 890-901) into a pure function
 * usable by both replay and live agent.
 */

import type { Config } from '../config/types';
import type { Direction } from './types';

/**
 * Check if the current regime blocks a trade in the given direction/side.
 *
 * @returns true if BLOCKED, false if ALLOWED
 */
export function isRegimeBlocked(
  regime: string,
  direction: Direction,
  side: 'call' | 'put',
  rsi: number | null,
  config: Config,
): boolean {
  // If regime system is disabled, never block
  if (config.regime.enabled === false) return false;

  // NO_TRADE regime always blocks
  if (regime === 'NO_TRADE') return true;

  const gate = config.regime.signalGates[regime];
  if (!gate) return false;

  // Bullish direction + call: check if oversold fade is allowed
  if (direction === 'bullish' && side === 'call') {
    return !gate.allowOversoldFade;
  }

  // Bearish direction + put: check if overbought fade is allowed
  if (direction === 'bearish' && side === 'put') {
    return !gate.allowOverboughtFade;
  }

  return false;
}
