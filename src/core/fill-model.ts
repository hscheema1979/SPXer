/**
 * Fill model — realistic execution pricing on top of the existing friction layer.
 *
 * Separation of concerns:
 *   - friction.ts applies the always-on half-spread ($0.05) + commission ($0.35/side).
 *     That's the minimum cost of crossing the bid-ask on any trade.
 *   - fill-model.ts adds ORDER-TYPE-SPECIFIC slippage on top.
 *     Currently models stop-market slippage (SL exits walk the book for size).
 *     Future phases will add entry slippage and liquidity caps here.
 *
 * Order-type semantics used by the backtest:
 *   - TP fills     : limit order at position.takeProfit. No extra slippage.
 *                    (friction.frictionExit still applies its $0.05 half-spread.)
 *   - SL fills     : stop-market. Additional size-proportional slippage below stop.
 *   - Signal/time  : market sell at whatever bar close exists. No extra slippage
 *                    modeled here in Phase 2 (could add in Phase 3).
 */
import type { Config } from '../config/types';

/** Resolved slippage settings with defaults applied. */
export interface ResolvedSlippage {
  slSlipPerContract: number;
  slSlipMax: number;
  entrySlipPerContract: number;
  entrySlipMax: number;
  /** Multiplier on bar spread added to SL slip. 0 = disabled. */
  slSpreadFactor: number;
  /** Extra $ penalty on SL fills inside the EOD window. 0 = disabled. */
  slEodPenalty: number;
  /** Window in minutes before cutoff during which slEodPenalty applies. */
  slEodWindowMin: number;
}

/** Read `config.fill.slippage` with safe fallbacks to zero (no slippage). */
export function resolveSlippage(config: Config): ResolvedSlippage {
  const s = config.fill?.slippage;
  return {
    slSlipPerContract: s?.slSlipPerContract ?? 0,
    slSlipMax: s?.slSlipMax ?? 0,
    entrySlipPerContract: s?.entrySlipPerContract ?? 0,
    entrySlipMax: s?.entrySlipMax ?? 0,
    slSpreadFactor: s?.slSpreadFactor ?? 0,
    slEodPenalty: s?.slEodPenalty ?? 0,
    slEodWindowMin: s?.slEodWindowMin ?? 15,
  };
}

/** Optional context for refining SL fill pricing. */
export interface SlFillContext {
  /** Observed bid-ask spread on the triggering bar, in dollars. */
  spread?: number;
  /** Minutes remaining until the session cutoff (risk.cutoffTimeET). */
  minutesToClose?: number;
}

/**
 * Compute the realistic fill price for a stop-market SELL order (stop-loss exit).
 *
 * Real-world behavior: when the stop triggers, broker sends a market sell. It
 * fills at the best bid, which for any non-trivial size walks the book.
 *
 * Model: `fillPrice = stopPrice - min(slSlipPerContract * qty, slSlipMax)`
 *
 * The caller is expected to apply friction.frictionSlExit() on top of this
 * for the half-spread; this function only models the EXTRA slippage beyond
 * a normal sell at the bid.
 *
 * Floor: never below $0.01 (options can't trade sub-penny).
 */
export function slipSellPrice(
  stopPrice: number,
  qty: number,
  cfg: ResolvedSlippage,
  context?: SlFillContext,
): number {
  // Base component: size-driven book-walk impact
  const sizeImpact = cfg.slSlipPerContract * Math.max(0, qty);

  // Spread-scaled impact: wider spreads → worse stop fills
  let spreadImpact = 0;
  if (cfg.slSpreadFactor > 0 && context?.spread != null && context.spread > 0) {
    spreadImpact = context.spread * cfg.slSpreadFactor;
  }

  // End-of-day penalty: terminal-hour liquidity drought on 0DTE
  let eodImpact = 0;
  if (
    cfg.slEodPenalty > 0 &&
    context?.minutesToClose != null &&
    context.minutesToClose >= 0 &&
    context.minutesToClose <= cfg.slEodWindowMin
  ) {
    eodImpact = cfg.slEodPenalty;
  }

  const rawImpact = sizeImpact + spreadImpact + eodImpact;
  // Cap total slippage at slSlipMax (0 means "no size-based slip"; when cap is
  // 0 but other impacts are configured, still honor them up to a reasonable
  // ceiling to avoid a zero-cap silently disabling spread/EOD terms).
  const cap = cfg.slSlipMax > 0 ? cfg.slSlipMax : (spreadImpact + eodImpact) + sizeImpact;
  const impact = Math.min(rawImpact, cap);
  return Math.max(0.01, stopPrice - impact);
}

/**
 * Compute the realistic fill price for a market BUY order (entry).
 *
 * Real-world behavior: a market buy sweeps asks up the book. Large orders
 * walk further into the book than the top-of-book ask.
 *
 * Model: `fillPrice = rawPrice + min(entrySlipPerContract * qty, entrySlipMax)`
 *
 * Like slipSellPrice, this stacks with the existing friction.frictionEntry
 * $0.05 half-spread. Caller passes the RAW mid/bar price; we add the size-
 * based slip here, then downstream friction adds the standing half-spread.
 *
 * Floor: never below $0.01.
 */
export function slipBuyPrice(
  rawPrice: number,
  qty: number,
  cfg: ResolvedSlippage,
): number {
  const rawImpact = cfg.entrySlipPerContract * Math.max(0, qty);
  const impact = Math.min(rawImpact, cfg.entrySlipMax);
  return Math.max(0.01, rawPrice + impact);
}
