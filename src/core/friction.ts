/**
 * Trade friction — always-on realistic cost model for 0DTE SPX options.
 *
 * Bakes in bid-ask spread + commission so P&L numbers are inherently
 * close to reality without needing per-trade tuning.
 *
 * Two spread modes (controlled by config.fill.spreadModel):
 *
 *   'flat'   (legacy) — constant $0.05 half-spread for all contracts.
 *   'scaled' — halfSpread = max(spreadFloor, optionPrice × spreadPct)
 *              Captures the real-world pattern where ITM/expensive options
 *              have wider spreads while cheap OTM options stay at the minimum.
 *
 * Commission: $0.35 per contract per side (Tradier standard).
 *
 * Applied as:
 *   effectiveEntry = midPrice + halfSpread   (you pay more)
 *   effectiveExit  = midPrice - halfSpread   (you receive less)
 *   totalCommission = COMMISSION_PER_CONTRACT * qty * 2  (round trip)
 */

import type { Config } from '../config/types';

// ── Spread model types ──────────────────────────────────────────────────────

export interface SpreadModel {
  mode: 'flat' | 'scaled';
  /** Minimum half-spread in dollars. */
  spreadFloor: number;
  /** Fraction of option price used as half-spread in 'scaled' mode. */
  spreadPct: number;
}

const DEFAULT_SPREAD_MODEL: SpreadModel = {
  mode: 'flat',
  spreadFloor: 0.05,
  spreadPct: 0.01,
};

/** Resolve spread model from config, with backward-compatible defaults. */
export function resolveSpreadModel(config?: Config | null): SpreadModel {
  const sm = config?.fill?.spreadModel;
  if (!sm) return DEFAULT_SPREAD_MODEL;
  return {
    mode: sm.mode ?? 'flat',
    spreadFloor: sm.spreadFloor ?? 0.05,
    spreadPct: sm.spreadPct ?? 0.01,
  };
}

// ── Core spread computation ─────────────────────────────────────────────────

/** Half the bid-ask spread constant (legacy flat mode). */
const FLAT_HALF_SPREAD = 0.05;

/** Commission per contract per side (Tradier) */
const COMMISSION_PER_CONTRACT = 0.35;

/**
 * Estimate half-spread for a given option price and spread model.
 *
 * 'flat' mode:  always spreadFloor (default $0.05).
 * 'scaled' mode: max(spreadFloor, optionPrice × spreadPct).
 *
 * Examples with default scaled params (floor=$0.05, pct=1%):
 *   $2 OTM option  → $0.05  (floor)
 *   $5 ATM option  → $0.05  (floor)
 *   $10 ITM option → $0.10
 *   $15 ITM option → $0.15
 *   $25 deep ITM   → $0.25
 */
export function estimateHalfSpread(optionPrice: number, model?: SpreadModel): number {
  const m = model ?? DEFAULT_SPREAD_MODEL;
  if (m.mode === 'flat') return m.spreadFloor;
  return Math.max(m.spreadFloor, optionPrice * m.spreadPct);
}

// ── Entry / exit friction functions ─────────────────────────────────────────

/**
 * Adjust a raw entry price upward to simulate buying at the ask.
 *
 * @param midPrice - option mid price
 * @param model - spread model (pass resolveSpreadModel(config) or omit for flat default)
 */
export function frictionEntry(midPrice: number, model?: SpreadModel): number {
  return midPrice + estimateHalfSpread(midPrice, model);
}

/**
 * Exit-kind taxonomy — determines which friction model applies.
 *   - 'tp'     : limit sell at takeProfit. Fills at limit or better.
 *                You provide liquidity → NO half-spread cost.
 *   - 'sl'     : stop triggered → market sell. Full half-spread.
 *   - 'market' : signal_reversal / time_exit / scannerReverse. Full half-spread.
 */
export type ExitKind = 'tp' | 'sl' | 'market';

/**
 * TP limit sell: no half-spread (you're providing liquidity).
 * Commission is applied separately via frictionCommission().
 */
export function frictionTpExit(limitPrice: number): number {
  return Math.max(0.01, limitPrice);
}

/**
 * SL stop→market sell: full half-spread paid.
 * The caller may additionally apply size-based slippage via fill-model.slipSellPrice.
 *
 * @param stopPrice - stop level
 * @param model - spread model (pass resolveSpreadModel(config) or omit for flat default)
 */
export function frictionSlExit(stopPrice: number, model?: SpreadModel): number {
  return Math.max(0.01, stopPrice - estimateHalfSpread(stopPrice, model));
}

/**
 * Market sell (signal reversal, time exit, scannerReverse): full half-spread.
 *
 * @param midPrice - current option price
 * @param model - spread model (pass resolveSpreadModel(config) or omit for flat default)
 */
export function frictionMarketExit(midPrice: number, model?: SpreadModel): number {
  return Math.max(0.01, midPrice - estimateHalfSpread(midPrice, model));
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
 * @param rawEntryPrice - raw fill price at entry
 * @param rawExitPrice - raw fill price at exit
 * @param qty - contract quantity
 * @param exitKind - 'tp' | 'sl' | 'market' — determines exit friction model
 * @param model - spread model for half-spread estimation (omit for flat $0.05 default)
 */
export function computeRealisticPnl(
  rawEntryPrice: number,
  rawExitPrice: number,
  qty: number,
  exitKind: ExitKind = 'market',
  model?: SpreadModel,
): { pnlPct: number; pnl$: number; effectiveEntry: number; effectiveExit: number } {
  const effectiveEntry = frictionEntry(rawEntryPrice, model);
  const effectiveExit =
    exitKind === 'tp' ? frictionTpExit(rawExitPrice) :
    exitKind === 'sl' ? frictionSlExit(rawExitPrice, model) :
    frictionMarketExit(rawExitPrice, model);
  const pnlPct = ((effectiveExit - effectiveEntry) / effectiveEntry) * 100;
  const pnl$ = (effectiveExit - effectiveEntry) * qty * 100 - frictionCommission(qty);
  return { pnlPct, 'pnl$': pnl$, effectiveEntry, effectiveExit };
}
