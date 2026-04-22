/**
 * Client-side HMA backfill — safety net for bars that arrive without the HMA
 * periods the live agent's config needs.
 *
 * The live data service registers HMA periods from every stored `replay_config`
 * at startup and computes `hma${period}` on every bar it serves. That covers
 * the normal path. But if a config is added (or its periods changed) while the
 * service is running, bars fetched before the next restart will be missing
 * those periods — the agent would read `undefined` and silently never fire a
 * cross. This helper plugs that gap: after fetching bars, the agent ensures
 * every required HMA period is present, computing it locally from close prices
 * if not.
 *
 * Replay does its own backfill server-side in `machine.ts::ensureHmaPeriods()`
 * (with cross-day warmup and DB write-back). This module is intentionally
 * simpler — it only seeds from the bars it's given.
 */

import type { CoreBar } from './types';
import { makeHMAState, hmaStep } from '../pipeline/indicators/tier1';

/**
 * Ensure each bar's `indicators` map contains values for every requested HMA
 * period. If `hma${period}` is already populated on at least one of the last
 * ~10 bars, the period is considered already-computed and skipped.
 *
 * Otherwise, computes incrementally from `bars` close prices. Early bars will
 * be `null` until the HMA warms up (~sqrt(period)+period bars); callers should
 * fetch enough history for the periods they need.
 *
 * Mutates `bar.indicators` in place. Handles frozen indicator maps by cloning.
 * No-ops on empty input. Invalid periods (non-integer, <2) are skipped silently
 * — the indicator engine validates periods at config-load time.
 */
export function ensureHmaOnBars(bars: CoreBar[], periods: Iterable<number>): void {
  if (!bars.length) return;

  const tailCount = Math.min(10, bars.length);
  const tailStart = bars.length - tailCount;

  for (const period of periods) {
    if (!Number.isInteger(period) || period < 2) continue;
    const key = `hma${period}`;

    // Consider the period already present if any recent bar has a non-null
    // value for it — avoids double-computing what the pipeline already emits.
    let hasValues = false;
    for (let i = tailStart; i < bars.length; i++) {
      if (bars[i].indicators && bars[i].indicators[key] != null) {
        hasValues = true;
        break;
      }
    }
    if (hasValues) continue;

    const state = makeHMAState(period);
    for (const bar of bars) {
      // Defensive copy if the indicators map is frozen (e.g. EMPTY_INDICATORS
      // singleton from replay price-only mode).
      if (!bar.indicators || Object.isFrozen(bar.indicators)) {
        (bar as { indicators: Record<string, number | null> }).indicators = {
          ...(bar.indicators ?? {}),
        };
      }
      bar.indicators[key] = hmaStep(state, bar.close);
    }
  }
}
