/**
 * Risk Guard — pure-function risk checks for both replay and live agent.
 *
 * Extracted from replay/machine.ts (lines 744-766) into a stateless function
 * that receives all state as input.
 */

import type { Config } from '../config/types';
import { getEntryCooldownSec } from '../config/types';

export interface RiskState {
  openPositions: number;
  tradesCompleted: number;
  dailyPnl: number;
  currentTs: number;
  closeCutoffTs: number;
  lastEscalationTs: number;
  /** Total HMA cross signals detected this session (for circuit breaker). */
  sessionSignalCount?: number;
}

/**
 * Check whether trading is blocked by any risk rule.
 * Checks are ordered by priority (cheapest/most common first).
 *
 * @returns { blocked, reason } — reason is empty string when not blocked
 */
export function isRiskBlocked(
  state: RiskState,
  config: Config,
): { blocked: boolean; reason: string } {
  // 1. Max open positions
  if (state.openPositions >= config.position.maxPositionsOpen) {
    return { blocked: true, reason: `Max positions (${config.position.maxPositionsOpen}) already open` };
  }

  // 2. Max trades per day
  if (state.tradesCompleted >= config.risk.maxTradesPerDay) {
    return { blocked: true, reason: `Max trades per day (${config.risk.maxTradesPerDay}) reached` };
  }

  // 3. Daily loss limit
  if (state.dailyPnl <= -config.risk.maxDailyLoss) {
    return { blocked: true, reason: `Daily loss limit reached ($${config.risk.maxDailyLoss})` };
  }

  // 3b. Signal rate circuit breaker
  const maxSignals = config.risk.maxSignalsPerSession ?? 0;
  if (maxSignals > 0 && (state.sessionSignalCount ?? 0) >= maxSignals) {
    return {
      blocked: true,
      reason: `Signal rate circuit breaker: ${state.sessionSignalCount} signals this session (max ${maxSignals}) — possible noisy/corrupted data`,
    };
  }

  // 4. Close cutoff
  if (state.currentTs >= state.closeCutoffTs) {
    return { blocked: true, reason: 'Past close cutoff time' };
  }

  // 5. Entry cooldown
  const cooldownSec = getEntryCooldownSec(config);
  const elapsed = state.currentTs - state.lastEscalationTs;
  if (elapsed < cooldownSec) {
    const remaining = cooldownSec - elapsed;
    return { blocked: true, reason: `Entry cooldown (${remaining}s remaining)` };
  }

  return { blocked: false, reason: '' };
}
