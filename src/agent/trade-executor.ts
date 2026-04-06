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

/**
 * Poll Tradier for an order's fill status.
 * Returns the actual fill price if filled, or null if rejected/expired/timeout.
 * Polls every 500ms for up to maxWaitMs (default 5s).
 */
async function waitForFill(
  orderId: number,
  accountId: string,
  maxWaitMs = 5000,
): Promise<{ status: string; fillPrice: number | null; rejectedReason?: string }> {
  const start = Date.now();
  const pollMs = 500;

  while (Date.now() - start < maxWaitMs) {
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders/${orderId}`,
        { headers: headers(), timeout: 5000 },
      );
      const order = data?.order;
      if (!order) break;

      if (order.status === 'filled') {
        const fill = parseFloat(order.avg_fill_price);
        return { status: 'filled', fillPrice: isNaN(fill) ? null : fill };
      }
      if (order.status === 'rejected') {
        return { status: 'rejected', fillPrice: null, rejectedReason: order.reason_description || 'unknown' };
      }
      if (order.status === 'canceled' || order.status === 'expired') {
        return { status: order.status, fillPrice: null };
      }
      // Still pending/open — check legs for OTOCO
      if (order.leg) {
        const legs = Array.isArray(order.leg) ? order.leg : [order.leg];
        const entryLeg = legs[0];
        if (entryLeg?.status === 'filled') {
          const fill = parseFloat(entryLeg.avg_fill_price);
          return { status: 'filled', fillPrice: isNaN(fill) ? null : fill };
        }
        if (entryLeg?.status === 'rejected') {
          return { status: 'rejected', fillPrice: null, rejectedReason: entryLeg.reason_description || order.reason_description || 'unknown' };
        }
      }
    } catch {
      // network error — retry
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  return { status: 'timeout', fillPrice: null };
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

  // Live order — try OTOCO bracket (entry + TP + SL) first, unless disabled
  const hasBracketPrices = decision.takeProfit != null && decision.takeProfit > 0 && decision.stopLoss > 0;
  const bracketDisabled = execCfg?.disableBracketOrders === true;

  if (hasBracketPrices && !bracketDisabled) {
    try {
      const result = await submitOtocoOrder(
        rootSymbol, executedSymbol, accountId, qty,
        order, entryPrice, decision.takeProfit!, decision.stopLoss, spreadStr,
      );
      position.tradierOrderId = result.entryOrderId;
      position.bracketOrderId = result.bracketOrderId;
      position.tpLegId = result.tpLegId;
      position.slLegId = result.slLegId;
      return { position, execution: { orderId: result.entryOrderId, fillPrice: entryPrice, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
    } catch (e: any) {
      console.warn(`[executor] OTOCO failed, falling back to single order: ${e.message}`);
      // Fall through to single order below
    }
  }

  // Fallback: single market/limit order (no server-side TP/SL)
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

    // Wait for actual fill from broker
    if (orderId) {
      const fill = await waitForFill(orderId, accountId);
      if (fill.status === 'filled' && fill.fillPrice != null) {
        console.log(`[executor] ✅ Filled @ $${fill.fillPrice.toFixed(2)} (expected $${entryPrice.toFixed(2)})`);
        position.entryPrice = fill.fillPrice;
        return { position, execution: { orderId, fillPrice: fill.fillPrice, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
      }
      if (fill.status === 'rejected') {
        console.error(`[executor] ❌ Order #${orderId} REJECTED: ${fill.rejectedReason}`);
        return { position, execution: { error: `Rejected: ${fill.rejectedReason}`, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
      }
      if (fill.status === 'timeout') {
        console.warn(`[executor] ⏳ Order #${orderId} still pending after 5s — using expected price`);
      }
    }

    return { position, execution: { orderId, fillPrice: entryPrice, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Order failed [${accountId}]: ${err}`);
    return { position, execution: { error: String(err), paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
  }
}

/**
 * Submit a Tradier OTOCO (One-Triggers-OCO) bracket order.
 * Leg 0: entry (buy_to_open market/limit)
 * Leg 1: TP (sell_to_close limit)
 * Leg 2: SL (sell_to_close stop)
 */
async function submitOtocoOrder(
  rootSymbol: string,
  optionSymbol: string,
  accountId: string,
  qty: number,
  order: { type: 'market' | 'limit'; price?: number; spread: number | null },
  entryPrice: number,
  tpPrice: number,
  slPrice: number,
  spreadStr: string,
): Promise<{ bracketOrderId: number; entryOrderId?: number; tpLegId?: number; slLegId?: number }> {
  // Build OTOCO params with indexed legs
  const params: Record<string, string | number> = {
    class: 'otoco',
    duration: 'day',
    // Leg 0: entry
    'type[0]': order.type,
    'option_symbol[0]': optionSymbol,
    'side[0]': 'buy_to_open',
    'quantity[0]': qty,
    // Leg 1: TP (limit sell)
    'type[1]': 'limit',
    'option_symbol[1]': optionSymbol,
    'side[1]': 'sell_to_close',
    'quantity[1]': qty,
    'price[1]': tpPrice.toFixed(2),
    // Leg 2: SL (stop sell)
    'type[2]': 'stop',
    'option_symbol[2]': optionSymbol,
    'side[2]': 'sell_to_close',
    'quantity[2]': qty,
    'stop[2]': slPrice.toFixed(2),
  };

  // Set entry price for limit orders
  if (order.type === 'limit' && entryPrice > 0) {
    params['price[0]'] = entryPrice.toFixed(2);
  }

  const body = qs(params);

  const { data } = await axios.post(
    `${TRADIER_BASE}/accounts/${accountId}/orders`,
    body,
    { headers: headers(), timeout: 10000 },
  );

  // Parse response: order.id = parent OTOCO, order.leg[].id = each leg
  const parentOrder = data?.order;
  const bracketOrderId = parentOrder?.id;
  const legs = parentOrder?.leg;

  let entryOrderId: number | undefined;
  let tpLegId: number | undefined;
  let slLegId: number | undefined;

  if (Array.isArray(legs)) {
    // Legs come back in order: [0] entry, [1] TP limit, [2] SL stop
    entryOrderId = legs[0]?.id;
    tpLegId = legs[1]?.id;
    slLegId = legs[2]?.id;
  }

  console.log(`[executor] LIVE OTOCO [${rootSymbol}→${accountId}] ${qty}x ${optionSymbol} @ ${order.type === 'market' ? 'MARKET' : '$' + entryPrice.toFixed(2)} (spread=${spreadStr}) | TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} — bracket #${bracketOrderId}`);

  return { bracketOrderId, entryOrderId, tpLegId, slLegId };
}

/**
 * Cancel outstanding OCO legs (TP + SL) for a bracket order.
 * Called when the agent exits a position early (e.g., scannerReverse).
 * Cancels the parent OTOCO which cancels all pending child legs.
 */
export async function cancelOcoLegs(
  bracketOrderId: number,
  execCfg?: Config['execution'],
): Promise<void> {
  const accountId = getAccountId(execCfg);

  try {
    await axios.delete(
      `${TRADIER_BASE}/accounts/${accountId}/orders/${bracketOrderId}`,
      { headers: headers(), timeout: 10000 },
    );
    console.log(`[executor] Cancelled bracket #${bracketOrderId} OCO legs [${accountId}]`);
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Failed to cancel bracket #${bracketOrderId} [${accountId}]: ${err}`);
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

  // Pre-flight: verify position exists at broker, cancel blocking OCO legs, then sell
  try {
    const hdrs = headers();

    // 1. Check position exists
    const { data: posData } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: hdrs, timeout: 5000 },
    );
    const rawPos = posData?.positions?.position;
    const brokerPositions = Array.isArray(rawPos) ? rawPos : rawPos ? [rawPos] : [];
    const found = brokerPositions.find((p: any) => p.symbol === position.symbol);
    if (!found) {
      console.warn(`[executor] ⚠️ Position ${position.symbol} not found at broker — skipping sell (already closed?)`);
      return { error: 'Position not at broker', paper: false, orderType: 'market' };
    }
    const brokerQty = Math.abs(found.quantity);
    if (brokerQty < position.quantity) {
      console.warn(`[executor] ⚠️ Broker has ${brokerQty}x ${position.symbol} but agent wants to sell ${position.quantity} — adjusting to ${brokerQty}`);
      position.quantity = brokerQty;
    }

    // 2. Cancel any open sell_to_close orders blocking the position (OCO/OTOCO legs)
    const { data: ordData } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      { headers: hdrs, timeout: 5000 },
    );
    const rawOrders = ordData?.orders?.order;
    const allOrders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];

    for (const order of allOrders) {
      if (order.status !== 'open' && order.status !== 'pending') continue;

      // Check top-level sell orders for this symbol
      if (order.option_symbol === position.symbol && order.side === 'sell_to_close') {
        try {
          await axios.delete(`${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`, { headers: hdrs, timeout: 5000 });
          console.log(`[executor] 🗑️ Cancelled blocking sell order #${order.id} for ${position.symbol}`);
        } catch { /* best effort */ }
        continue;
      }

      // Check OCO/OTOCO legs
      const legs = Array.isArray(order.leg) ? order.leg : order.leg ? [order.leg] : [];
      const hasBlockingSell = legs.some((l: any) =>
        (l.status === 'open' || l.status === 'pending') &&
        l.side === 'sell_to_close' &&
        l.option_symbol === position.symbol
      );
      if (hasBlockingSell) {
        try {
          await axios.delete(`${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`, { headers: hdrs, timeout: 5000 });
          console.log(`[executor] 🗑️ Cancelled blocking bracket #${order.id} with sell legs for ${position.symbol}`);
        } catch { /* best effort */ }
      }
    }
  } catch (e: any) {
    console.warn(`[executor] ⚠️ Pre-flight check failed: ${e.message} — proceeding with sell`);
    // Don't block the sell on a failed check — better to try and get rejected than not exit
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

    // Wait for actual fill from broker
    if (orderId) {
      const fill = await waitForFill(orderId, accountId);
      if (fill.status === 'filled' && fill.fillPrice != null) {
        console.log(`[executor] ✅ Sold @ $${fill.fillPrice.toFixed(2)} (expected ~$${currentPrice.toFixed(2)})`);
        return { orderId, fillPrice: fill.fillPrice, paper: false, orderType: 'market' };
      }
      if (fill.status === 'rejected') {
        console.error(`[executor] ❌ Sell #${orderId} REJECTED: ${fill.rejectedReason}`);
        return { error: `Sell rejected: ${fill.rejectedReason}`, paper: false, orderType: 'market' };
      }
      if (fill.status === 'timeout') {
        console.warn(`[executor] ⏳ Sell #${orderId} still pending after 5s — using expected price`);
      }
    }

    return { orderId, fillPrice: currentPrice, paper: false, orderType: 'market' };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Close failed [${accountId}]: ${err}`);
    return { error: String(err), paper: false, orderType: 'market' };
  }
}
