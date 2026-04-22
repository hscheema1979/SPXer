/**
 * Option tick-size helper.
 *
 * Rounds a raw price to a valid exchange tick increment. Tradier rejects
 * option orders whose price (or stop) doesn't land on a valid tick, and
 * without this helper `toFixed(2)` emits prices like $3.04 that SPXW does
 * not honor — the submission fails and the fallback path leaves the
 * position unprotected.
 *
 * Tick schedule for SPX / SPXW options (verify against Tradier docs or a
 * paper order before first live use — rules change occasionally):
 *   - price <  $3.00 → $0.05 ticks
 *   - price >= $3.00 → $0.10 ticks (SPXW is NOT penny-pilot; keep $0.10)
 *
 * Rounds to NEAREST tick (not floor/ceil) to preserve TP/SL intent.
 * Never returns below the minimum tick ($0.05) — option prices cannot be
 * zero or sub-tick.
 */

const MIN_TICK_CENTS = 5;
const LOW_PRICE_TICK_CENTS = 5;
const HIGH_PRICE_TICK_CENTS = 10;
const TICK_BOUNDARY = 3.00;

/**
 * Round `price` to the nearest valid option tick.
 * Returns at least MIN_TICK ($0.05). Handles NaN / negative input
 * defensively by returning MIN_TICK.
 *
 * Works in integer cents to avoid floating-point drift
 * (e.g. `3.05 / 0.10` evaluates to 30.499999... in IEEE 754).
 */
export function roundToOptionTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return MIN_TICK_CENTS / 100;
  const priceCents = Math.round(price * 100);
  const tickCents = price >= TICK_BOUNDARY ? HIGH_PRICE_TICK_CENTS : LOW_PRICE_TICK_CENTS;
  const roundedCents = Math.round(priceCents / tickCents) * tickCents;
  const floored = Math.max(MIN_TICK_CENTS, roundedCents);
  return floored / 100;
}

/**
 * Return true if `price` already sits on a valid tick.
 * Useful in tests and audit logs.
 */
export function isValidOptionTick(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  return Math.abs(roundToOptionTick(price) - price) < 1e-9;
}
