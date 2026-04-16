/**
 * Trade friction — always-on realistic cost model for 0DTE SPX options.
 *
 * Bakes in bid-ask spread + commission so P&L numbers are inherently
 * close to reality without needing per-trade tuning.
 *
 * Assumptions (conservative but realistic for SPXW 0DTE):
 *   - Half-spread: $0.05 per side (you buy at ask, sell at bid)
 *   - Commission: $0.35 per contract per side (Tradier standard)
 *
 * Applied as:
 *   effectiveEntry = midPrice + HALF_SPREAD   (you pay more)
 *   effectiveExit  = midPrice - HALF_SPREAD   (you receive less)
 *   totalCommission = COMMISSION_PER_CONTRACT * qty * 2  (round trip)
 */

/** Half the bid-ask spread in dollars. Typical 0DTE SPX: $0.05-0.10 */
const HALF_SPREAD = 0.05;

/** Commission per contract per side (Tradier) */
const COMMISSION_PER_CONTRACT = 0.35;

/**
 * Adjust a raw entry price upward to simulate buying at the ask.
 */
export function frictionEntry(midPrice: number): number {
  return midPrice + HALF_SPREAD;
}

/**
 * Adjust a raw exit price downward to simulate selling at the bid.
 */
export function frictionExit(midPrice: number): number {
  return Math.max(0.01, midPrice - HALF_SPREAD);
}

/**
 * Round-trip commission cost in dollars for a given quantity.
 */
export function frictionCommission(qty: number): number {
  return COMMISSION_PER_CONTRACT * qty * 2;
}

/**
 * Compute realistic P&L for a closed trade.
 *
 * pnl$ = (effectiveExit - effectiveEntry) * qty * 100 - commission
 *
 * This is the single function to use everywhere instead of raw arithmetic.
 */
export function computeRealisticPnl(
  rawEntryPrice: number,
  rawExitPrice: number,
  qty: number,
): { pnlPct: number; pnl$: number; effectiveEntry: number; effectiveExit: number } {
  const effectiveEntry = frictionEntry(rawEntryPrice);
  const effectiveExit = frictionExit(rawExitPrice);
  const pnlPct = ((effectiveExit - effectiveEntry) / effectiveEntry) * 100;
  const pnl$ = (effectiveExit - effectiveEntry) * qty * 100 - frictionCommission(qty);
  return { pnlPct, 'pnl$': pnl$, effectiveEntry, effectiveExit };
}
