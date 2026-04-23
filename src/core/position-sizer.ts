/**
 * Position Sizer — computes contract quantity for a trade.
 *
 * Three sizing modes (set via config.sizing.sizingMode):
 *   'fixed_dollars'       — sizingValue = dollars per trade (e.g. 500)
 *   'fixed_contracts'     — sizingValue = exact contract count (e.g. 10)
 *   'percent_of_account'  — sizingValue = % of account value (e.g. 15 for 15%)
 *
 * All modes clamp to [minContracts, maxContracts], minimum 1.
 */

import type { Config } from '../config/types';

/**
 * Resolve the effective sizing mode and value from config,
 * handling backward compat with legacy fields.
 */
function resolveSizing(config: Config): { mode: string; value: number } {
  const s = config.sizing;

  // New explicit mode
  if (s.sizingMode && s.sizingValue != null) {
    return { mode: s.sizingMode, value: s.sizingValue };
  }

  // Legacy: accountPercentPerTrade
  const pct = s.accountPercentPerTrade;
  if (pct && pct > 0) {
    return { mode: 'percent_of_account', value: pct };
  }

  // Legacy: baseDollarsPerTrade * sizeMultiplier
  return { mode: 'fixed_dollars', value: (s.baseDollarsPerTrade ?? 250) * (s.sizeMultiplier ?? 1) };
}

/**
 * Compute the number of contracts to trade.
 *
 * @param entryPrice - option price per share (cost = entryPrice * 100)
 * @param config - trading config with sizing parameters
 * @param accountValue - current account value for percent_of_account mode.
 *   Live agents pass Tradier buying power; replay passes simulated account.
 *   Ignored for other modes.
 */
export function computeQty(entryPrice: number, config: Config, accountValue?: number | null): number {
  const { minContracts, maxContracts } = config.sizing;
  const { mode, value } = resolveSizing(config);

  let qty: number;

  switch (mode) {
    case 'fixed_contracts':
      // Directly use the value as contract count
      qty = Math.max(1, Math.round(value));
      break;

    case 'percent_of_account': {
      const acct = accountValue && accountValue > 0
        ? accountValue
        : config.sizing.startingAccountValue ?? 10000;
      const dollars = Math.max(100, Math.floor(acct * value / 100));
      qty = Math.floor(dollars / (entryPrice * 100)) || 1;
      break;
    }

    case 'fixed_dollars':
    default: {
      const dollars = value > 0 ? value : 250;
      qty = Math.floor(dollars / (entryPrice * 100)) || 1;
      break;
    }
  }

  return Math.max(minContracts ?? 1, Math.min(maxContracts ?? 99, Math.max(1, qty)));
}
