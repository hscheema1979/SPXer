/**
 * capture-guard.ts — pure session / ownership rules for the live-capture
 * daemon (scripts/live/live-capture.ts). They live here, not in the script,
 * because the script starts its poll loop on import and cannot be unit-tested.
 *
 * Two rules, both from docs/DATA-STORES.md:
 *   1. Never capture on a non-trading day. Labor Day 2026 produced 154,224
 *      "bars" with one distinct close because the daemon only checked the
 *      time of day (data/parquet/quarantine/ keeps the evidence).
 *   2. Bars are owned by the EOD backfill. The daemon writes snapshots only,
 *      unless LIVE_CAPTURE_WRITE_BARS=1 is set explicitly.
 */
import { MARKET_HOLIDAYS } from '../config';
import { dayOfWeek } from '../instruments/expiry-resolver';

/** Why today's capture should NOT run, or null if it should. */
export function captureSkipReason(
  date: string,
  holidays: ReadonlySet<string> = MARKET_HOLIDAYS,
): string | null {
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return `weekend (${date})`;
  if (holidays.has(date)) return `market holiday (${date})`;
  return null;
}

/** Bar writes are opt-in and require the exact value '1'. */
export function barWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_CAPTURE_WRITE_BARS === '1';
}
