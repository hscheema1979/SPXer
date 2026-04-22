/**
 * Execution counters — tracks OTOCO bracket protection outcomes for TP re-entries.
 *
 * Task 3.3: Surface TP re-entry protection state via /agent/status so monitors
 * can detect unprotected re-entry chains quickly (the original motivating bug:
 * re-entries going through openPosition() could fall back to a bare order if
 * OTOCO submission fails, leaving a growing chain of unprotected positions).
 *
 * Counters reset at process start. Consumers read a snapshot via
 * getExecutionCounters().
 */

export interface ExecutionCounters {
  /** Total re-entry attempts (reentryDepth >= 1) that entered openPosition. */
  tpReentriesAttempted: number;
  /** Re-entry attempts where OTOCO bracket succeeded (TP + SL legs at broker). */
  tpReentriesProtected: number;
  /** Re-entry attempts that fell back to a bare order (no server-side TP/SL). */
  tpReentriesUnprotected: number;
}

const state: ExecutionCounters = {
  tpReentriesAttempted: 0,
  tpReentriesProtected: 0,
  tpReentriesUnprotected: 0,
};

export function incrReentryAttempted(): void {
  state.tpReentriesAttempted++;
}

export function incrReentryProtected(): void {
  state.tpReentriesProtected++;
}

export function incrReentryUnprotected(): void {
  state.tpReentriesUnprotected++;
}

export function getExecutionCounters(): ExecutionCounters {
  return { ...state };
}

/** Reset counters (tests only). */
export function _resetExecutionCounters(): void {
  state.tpReentriesAttempted = 0;
  state.tpReentriesProtected = 0;
  state.tpReentriesUnprotected = 0;
}
