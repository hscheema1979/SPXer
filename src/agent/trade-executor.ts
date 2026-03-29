/**
 * TradeExecutor: places orders via Tradier API.
 * Supports multiple execution targets (SPX, XSP, SPY) via Config.execution.
 *
 * Order type logic:
 *   - Market order if bid-ask spread ≤ maxSpreadForMarket (default $0.75)
 *   - Limit order at ask price if spread is wider
 *   - Exits always use market orders (speed > price on exit)
 *
 * In paper mode, logs the order without sending it.
 */
import axios from 'axios';
import { config, TRADIER_BASE } from '../config';
import type { Config } from '../config/types';
import type { AgentSignal, AgentDecision, OpenPosition } from './types';
import { randomUUID } from 'crypto';

/** Maximum bid-ask spread to use a market order. Above this, use limit at ask. */
const DEFAULT_MAX_SPREAD_FOR_MARKET = 0.75;

function headers() {
  return {
    Authorization: `Bearer ${config.tradierToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

function qs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Get the Tradier account ID — uses execution config override or default .env */
function getAccountId(execCfg?: Config['execution']): string {
  return execCfg?.accountId || config.tradierAccountId;
}

/** Get the root symbol for Tradier orders (e.g., 'SPX', 'XSP', 'SPY') */
function getRootSymbol(execCfg?: Config['execution']): string {
  return execCfg?.symbol || 'SPX';
}

/**
 * Convert an SPXW option symbol to the target product.
 * e.g., SPXW260401C05700000 → XSP260401C00570000 (strike / 10)
 *
 * Option symbol format: PREFIX + YYMMDD + C/P + strike*1000 (8 digits, zero-padded)
 */
export function convertOptionSymbol(
  spxwSymbol: string,
  execCfg?: Config['execution'],
): string {
  if (!execCfg || execCfg.optionPrefix === 'SPXW') return spxwSymbol;

  const match = spxwSymbol.match(/^SPXW(\d{6})([CP])(\d{8})$/);
  if (!match) return spxwSymbol;

  const [, dateStr, callPut, strikeStr] = match;
  const spxStrike = parseInt(strikeStr) / 1000;
  const targetStrike = spxStrike / (execCfg.strikeDivisor || 1);

  const interval = execCfg.strikeInterval || 1;
  const rounded = Math.round(targetStrike / interval) * interval;
  const targetStrikeStr = (rounded * 1000).toString().padStart(8, '0');

  return `${execCfg.optionPrefix}${dateStr}${callPut}${targetStrikeStr}`;
}

/**
 * Get the expiry date for the target product.
 * 0DTE = today, 1DTE = next trading day.
 */
function getTargetExpiry(execCfg?: Config['execution']): string {
  const now = new Date();
  const todayET = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  if (!execCfg?.use1dte) return todayET;

  const date = new Date(todayET + 'T12:00:00');
  date.setDate(date.getDate() + 1);
  while (date.getDay() === 0 || date.getDay() === 6) {
    date.setDate(date.getDate() + 1);
  }
  return date.toISOString().split('T')[0];
}

/**
 * Determine order type based on bid-ask spread.
 * Market order for tight spreads (fast fill), limit at ask for wide spreads (price protection).
 */
function chooseOrderType(
  bid: number | null,
  ask: number | null,
  maxSpread: number = DEFAULT_MAX_SPREAD_FOR_MARKET,
): { type: 'market' | 'limit'; price?: number; spread: number | null } {
  if (bid == null || ask == null || bid <= 0 || ask <= 0) {
    // No quote data — use limit at last known price for safety
    return { type: 'limit', price: ask ?? undefined, spread: null };
  }

  const spread = ask - bid;

  if (spread <= maxSpread) {
    return { type: 'market', spread };
  } else {
    return { type: 'limit', price: ask, spread };
  }
}

export interface ExecutionResult {
  orderId?: number;
  fillPrice?: number;
  error?: string;
  paper: boolean;
  executedSymbol?: string;
  orderType?: 'market' | 'limit';
  spread?: number | null;
}

export async function openPosition(
  signal: AgentSignal,
  decision: AgentDecision,
  paper: boolean,
  execCfg?: Config['execution'],
): Promise<{ position: OpenPosition; execution: ExecutionResult }> {
  const qty = decision.positionSize;

  // Determine order type from spread
  const order = chooseOrderType(signal.bid, signal.ask);
  const entryPrice = signal.ask ?? signal.currentPrice;

  // Convert SPX symbol to target product
  const executedSymbol = convertOptionSymbol(signal.symbol, execCfg);
  const rootSymbol = getRootSymbol(execCfg);
  const accountId = getAccountId(execCfg);

  const spreadStr = order.spread != null ? `$${order.spread.toFixed(2)}` : '?';

  const position: OpenPosition = {
    id: randomUUID(),
    symbol: executedSymbol,
    side: signal.side,
    strike: signal.strike / (execCfg?.strikeDivisor || 1),
    expiry: getTargetExpiry(execCfg),
    entryPrice,
    quantity: qty,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    openedAt: Date.now(),
  };

  if (paper) {
    const label = execCfg ? `[${rootSymbol}→${accountId}]` : '';
    console.log(`[executor] PAPER BUY ${label} ${qty}x ${executedSymbol} @ $${entryPrice.toFixed(2)} (${order.type}, spread=${spreadStr}) | stop: $${decision.stopLoss.toFixed(2)}`);
    return { position, execution: { fillPrice: entryPrice, paper: true, executedSymbol, orderType: order.type, spread: order.spread } };
  }

  // Live order via Tradier
  const orderParams: Record<string, string | number> = {
    class: 'option',
    symbol: rootSymbol,
    option_symbol: executedSymbol,
    side: 'buy_to_open',
    quantity: qty,
    type: order.type,
    duration: 'day',
  };

  // Only set price for limit orders
  if (order.type === 'limit' && entryPrice > 0) {
    orderParams.price = entryPrice.toFixed(2);
  }

  const body = qs(orderParams);

  try {
    const { data } = await axios.post(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      body,
      { headers: headers(), timeout: 10000 },
    );
    const orderId = data?.order?.id;
    console.log(`[executor] LIVE BUY [${rootSymbol}→${accountId}] ${qty}x ${executedSymbol} @ ${order.type === 'market' ? 'MARKET' : '$' + entryPrice.toFixed(2)} (spread=${spreadStr}) — order #${orderId}`);
    position.tradierOrderId = orderId;
    return { position, execution: { orderId, fillPrice: entryPrice, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Order failed [${accountId}]: ${err}`);
    return { position, execution: { error: String(err), paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
  }
}

export async function closePosition(
  position: OpenPosition,
  reason: string,
  currentPrice: number,
  paper: boolean,
  execCfg?: Config['execution'],
): Promise<ExecutionResult> {
  const rootSymbol = getRootSymbol(execCfg);
  const accountId = getAccountId(execCfg);

  // Exits always use market orders — speed matters more than price on exit
  if (paper) {
    console.log(`[executor] PAPER SELL ${position.quantity}x ${position.symbol} @ $${currentPrice.toFixed(2)} MARKET (${reason})`);
    return { fillPrice: currentPrice, paper: true, orderType: 'market' };
  }

  const body = qs({
    class: 'option',
    symbol: rootSymbol,
    option_symbol: position.symbol,
    side: 'sell_to_close',
    quantity: position.quantity,
    type: 'market',
    duration: 'day',
  });

  try {
    const { data } = await axios.post(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      body,
      { headers: headers(), timeout: 10000 },
    );
    const orderId = data?.order?.id;
    console.log(`[executor] LIVE SELL [${rootSymbol}→${accountId}] ${position.quantity}x ${position.symbol} @ MARKET (${reason}) — order #${orderId}`);
    return { orderId, fillPrice: currentPrice, paper: false, orderType: 'market' };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Close failed [${accountId}]: ${err}`);
    return { error: String(err), paper: false, orderType: 'market' };
  }
}
