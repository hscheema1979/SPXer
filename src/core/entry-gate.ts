/**
 * Entry Gate — single source of truth for "may we open a new position now".
 *
 * Every entry path (fresh cross, flip-on-reversal, TP re-entry, judge-driven)
 * in both the live agent and the replay engine MUST call checkEntryGates()
 * before opening a position. This is the architectural invariant that keeps
 * live and replay behavior aligned on risk, time-window, and cooldown rules.
 *
 * Historical context: before this module existed, each entry path re-implemented
 * its own subset of gates. The flip block and TP re-entry block in
 * src/replay/machine.ts skipped the time-window check. The live-agent TP
 * re-entry block skipped the risk-guard entirely. `config.risk.cutoffTimeET`
 * was only honored by the live-agent main entry path — replay hardcoded 16:45
 * ET via buildSessionTimestamps(). This module collapses all of that into one
 * typed decision function.
 *
 * Pure: no I/O, no module-level state. Inputs fully describe the world.
 */

import type { Config } from '../config/types';
import { getEntryCooldownSec } from '../config/types';
import { etTimeToUnixTs } from '../utils/et-time';
import { isRiskBlocked, type RiskState } from './risk-guard';
import { isInActiveWindow } from './strategy-engine';

/**
 * What kind of entry is being attempted. Determines which gates apply:
 *   - fresh_cross         → risk + time-window + cooldown
 *   - flip_on_reversal    → risk + time-window + cooldown  (cooldown enforced —
 *                           on 2026-04-21 bypassing cooldown here allowed 18+
 *                           positions despite max=1, because exit→flip happened
 *                           atomically in a single cycle and the signal detector
 *                           fired on many contracts simultaneously)
 *   - tp_reentry          → risk + time-window  (cooldown handled by
 *                           evaluateReentry() with its own reentryOnTakeProfit
 *                           config — this gate does not second-guess it)
 *   - judge_buy           → risk + time-window + cooldown  (LLM judge-driven
 *                           entries in replay scanner mode; gated identically
 *                           to fresh_cross)
 */
export type EntryKind = 'fresh_cross' | 'flip_on_reversal' | 'tp_reentry' | 'judge_buy';

export interface EntryGateInput {
  /** Current unix timestamp in seconds (UTC). */
  ts: number;
  /** What kind of entry is being attempted. */
  kind: EntryKind;
  /** Open position count AFTER any pending exits this cycle have been applied. */
  openPositionsAfterExits: number;
  /** Completed-trade counter for the current day. */
  tradesCompleted: number;
  /** Running daily P&L in dollars (negative = loss). */
  dailyPnl: number;
  /** EOD close cutoff timestamp. Use computeCloseCutoffTs(config) to derive. */
  closeCutoffTs: number;
  /** Unix ts of the most recent entry (for cooldown). 0 if none today. */
  lastEntryTs: number;
  /** Total HMA cross signals detected this session (for circuit breaker). Optional for backward compat. */
  sessionSignalCount?: number;
}

export type EntryGateResult =
  | { allowed: true; kind: EntryKind }
  | { allowed: false; reason: string };

/**
 * Resolve the EOD trading cutoff timestamp from config.
 *
 * Single source of truth. Previously three different callers computed this
 * three different ways (see module header). All callers — live agent entry,
 * live agent risk-guard wrapper, replay engine — should call this function.
 *
 * @param config trading config; `config.risk.cutoffTimeET` is the sole source.
 * @param now optional reference date for DST resolution (defaults to today).
 */
export function computeCloseCutoffTs(config: Config, now: Date = new Date()): number {
  const timeET = config.risk?.cutoffTimeET || '16:00';
  return etTimeToUnixTs(timeET, now);
}

/**
 * Decide whether an entry is permitted right now.
 *
 * Gate order (cheapest / most common first):
 *   1. Risk guard  — positions cap, trades/day cap, daily loss, close cutoff
 *   2. Time window — activeStart/activeEnd from config.timeWindows
 *   3. Cooldown    — entry cooldown (all types except tp_reentry)
 *
 * Returns `{ allowed: true, kind }` on pass, or `{ allowed: false, reason }`
 * with a human-readable skip reason suitable for logs and audit trails.
 */
export function checkEntryGates(input: EntryGateInput, config: Config): EntryGateResult {
  // ── 1. Risk guard (positions, trades/day, daily loss, close cutoff) ─────
  // Note: isRiskBlocked() also applies its own cooldown via lastEscalationTs.
  // We deliberately pass 0 here so the risk-guard cooldown does not double-fire
  // with our cooldown gate below. The cooldown gate applies to all entry types
  // except tp_reentry (which has its own cooldown via evaluateReentry()).
  const riskState: RiskState = {
    openPositions: input.openPositionsAfterExits,
    tradesCompleted: input.tradesCompleted,
    dailyPnl: input.dailyPnl,
    currentTs: input.ts,
    closeCutoffTs: input.closeCutoffTs,
    lastEscalationTs: 0,
    sessionSignalCount: input.sessionSignalCount,
  };
  const risk = isRiskBlocked(riskState, config);
  if (risk.blocked) return { allowed: false, reason: risk.reason };

  // ── 2. Time window ──────────────────────────────────────────────────────
  // isInActiveWindow uses strict end-boundary (< activeEnd), so
  // activeEnd='15:45' blocks entries from 15:45:00 onward.
  if (!isInActiveWindow(input.ts, config)) {
    return { allowed: false, reason: `outside active window (${input.kind})` };
  }

  // ── 3. Cooldown ─────────────────────────────────────────────────────────
  // Only TP re-entries are exempt (they have their own cooldown via
  // evaluateReentry()). All other entry types — including flip_on_reversal —
  // must respect the global cooldown. On 2026-04-21 flip-exemption caused
  // 18+ simultaneous positions despite maxPositionsOpen=1.
  if (input.kind !== 'tp_reentry') {
    const cooldownSec = getEntryCooldownSec(config);
    const elapsed = input.ts - input.lastEntryTs;
    if (input.lastEntryTs > 0 && cooldownSec > 0 && elapsed < cooldownSec) {
      const remaining = cooldownSec - elapsed;
      return { allowed: false, reason: `cooldown (${remaining}s remaining)` };
    }
  }

  return { allowed: true, kind: input.kind };
}
