/**
 * Re-entry evaluator — pure decision function for take-profit re-entries.
 *
 * Used by both the replay engine (src/replay/machine.ts) and the live agent
 * (spx_agent.ts). When a position closes via `take_profit`, this
 * function decides whether to immediately open a follow-on position in the
 * same direction.
 *
 * Pure: no I/O, no side effects. State is passed in.
 */

import type { Config } from '../config/types';
import type { Direction, ExitReason } from './types';
import { checkEntryGates } from './entry-gate';

/** Mutable counters tracked by caller across the session. */
export interface ReentryState {
  /** Total TP re-entries opened today (resets at session boundary). */
  reentriesToday: number;
  /** Re-entries chained from the most recent original entry.
   *  Resets to 0 whenever a non-reentry entry occurs. */
  reentriesThisChain: number;
  /** Unix seconds of the last re-entry executed (0 if none). */
  lastReentryTs: number;
  /** Reason the position that just closed exited with. */
  closedExitReason: ExitReason;
  /** Side of the position that just closed. */
  closedSide: Direction;
  /** Optional: current option contract HMA direction (for fresh_signal_required mode). */
  optionHmaDirection?: Direction | null;
}

/**
 * Additional context needed by the shared entry gate (risk guard, time window,
 * close cutoff). Required — omitting it would re-open the bug where TP
 * re-entries fired past the active-window / close-cutoff boundary.
 */
export interface ReentryGateContext {
  /** Open positions AFTER any pending exits this cycle have been applied. */
  openPositions: number;
  /** Completed trades today. */
  tradesCompleted: number;
  /** Running daily P&L in dollars (negative = loss). */
  dailyPnl: number;
  /** EOD close cutoff timestamp — derive via computeCloseCutoffTs(config). */
  closeCutoffTs: number;
  /** Unix ts of most recent entry of any kind (cooldown reference). */
  lastEntryTs: number;
  /** Total HMA cross signals this session (for circuit breaker). Optional for backward compat. */
  sessionSignalCount?: number;
}

export interface ReentryDecision {
  allowed: boolean;
  /** Human-readable reason — useful for audit logs and skip-reason fields. */
  reason: string;
  /** Side to re-enter on if allowed. Always equals closedSide. */
  side?: Direction;
  /** Multiplier to apply to computeQty() result. */
  sizeMultiplier?: number;
}

/**
 * Evaluate whether to open a TP re-entry.
 *
 * Returns `{ allowed: false, reason }` whenever any gate fails — caller logs
 * the skip and continues normal entry evaluation.
 *
 * Gate order: feature-enabled → exit-reason match → shared entry gate
 * (risk / time-window / close-cutoff) → daily cap → chain cap → TP-reentry
 * cooldown → optional HMA confirm. The shared entry gate runs BEFORE the
 * reentry-specific counters so a re-entry past activeEnd or cutoffTimeET is
 * blocked without consuming a "daily cap" slot.
 */
export function evaluateReentry(
  state: ReentryState,
  config: Config,
  currentTs: number,
  gateContext: ReentryGateContext,
): ReentryDecision {
  const cfg = config.exit?.reentryOnTakeProfit;

  if (!cfg || !cfg.enabled) {
    return { allowed: false, reason: 'disabled' };
  }

  if (state.closedExitReason !== 'take_profit') {
    return { allowed: false, reason: `not a TP exit (${state.closedExitReason})` };
  }

  // ── Shared entry gate: risk, time window, close cutoff ──
  // TP re-entries own their own cooldown (cfg.cooldownSec below), so the
  // shared gate does not apply the fresh-cross cooldown to kind='tp_reentry'.
  const gate = checkEntryGates({
    ts: currentTs,
    kind: 'tp_reentry',
    openPositionsAfterExits: gateContext.openPositions,
    tradesCompleted: gateContext.tradesCompleted,
    dailyPnl: gateContext.dailyPnl,
    closeCutoffTs: gateContext.closeCutoffTs,
    lastEntryTs: gateContext.lastEntryTs,
    sessionSignalCount: gateContext.sessionSignalCount,
  }, config);
  if (!gate.allowed) {
    return { allowed: false, reason: gate.reason };
  }

  // Daily cap
  if (cfg.maxReentriesPerDay > 0 && state.reentriesToday >= cfg.maxReentriesPerDay) {
    return {
      allowed: false,
      reason: `daily cap reached (${state.reentriesToday}/${cfg.maxReentriesPerDay})`,
    };
  }

  // Per-chain cap
  if (cfg.maxReentriesPerSignal > 0 && state.reentriesThisChain >= cfg.maxReentriesPerSignal) {
    return {
      allowed: false,
      reason: `chain cap reached (${state.reentriesThisChain}/${cfg.maxReentriesPerSignal})`,
    };
  }

  // Cooldown
  if (cfg.cooldownSec > 0 && state.lastReentryTs > 0) {
    const elapsed = currentTs - state.lastReentryTs;
    if (elapsed < cfg.cooldownSec) {
      const remaining = cfg.cooldownSec - elapsed;
      return { allowed: false, reason: `cooldown (${remaining}s remaining)` };
    }
  }

  // Optional: require option-contract HMA still confirms the side
  if (cfg.strategy === 'fresh_signal_required' || cfg.requireOptionHmaConfirm) {
    if (!state.optionHmaDirection) {
      return { allowed: false, reason: 'option HMA direction unknown' };
    }
    if (state.optionHmaDirection !== state.closedSide) {
      return {
        allowed: false,
        reason: `option HMA flipped (${state.optionHmaDirection} vs ${state.closedSide})`,
      };
    }
  }

  return {
    allowed: true,
    reason: 'all gates passed',
    side: state.closedSide,
    sizeMultiplier: cfg.sizeMultiplier,
  };
}

/** Initial state — call once per session. */
export function createInitialReentryState(): Omit<ReentryState, 'closedExitReason' | 'closedSide' | 'optionHmaDirection'> {
  return {
    reentriesToday: 0,
    reentriesThisChain: 0,
    lastReentryTs: 0,
  };
}
