/**
 * sweep-dates.ts
 *
 * Trading-day helpers for the multi-DTE credit sweep. DTE is measured in
 * TRADING days (not calendar days), so a 5DTE position entered on a Monday
 * expires the following Monday (5 sessions later), skipping weekends AND
 * market holidays.
 *
 * Built on src/instruments/expiry-resolver primitives (holiday-aware,
 * pure, already unit-tested) rather than re-implementing weekend-only math —
 * a weekend-only expiry could land on a holiday and point at a missing S3 file.
 */
import {
  addDays,
  isTradingDay,
  nextTradingDay,
} from '../../src/instruments/expiry-resolver';

/**
 * Inclusive list of trading days from startDate to endDate.
 * Skips weekends and market holidays. Returns [] if endDate < startDate.
 */
export function tradingDaysBetween(
  startDate: string,
  endDate: string,
  holidays?: ReadonlySet<string>
): string[] {
  const days: string[] = [];
  let d = startDate;
  // addDays compares lexically-safe ISO strings; iterate day-by-day.
  while (d <= endDate) {
    if (isTradingDay(d, holidays)) days.push(d);
    d = addDays(d, 1);
  }
  return days;
}

/**
 * The expiry date for a position entered on `entryDate` held for `dte` TRADING
 * days. dte=0 → the entry day itself (must be a trading day on or after entry).
 * dte=N → N trading days strictly after the entry's reference trading day.
 */
export function expiryForDate(
  entryDate: string,
  dte: number,
  holidays?: ReadonlySet<string>
): string {
  if (dte <= 0) return entryDate;
  let d = entryDate;
  for (let i = 0; i < dte; i++) {
    d = nextTradingDay(d, holidays);
  }
  return d;
}
