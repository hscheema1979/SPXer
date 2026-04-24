/**
 * TradeExecutor: places orders via Tradier API or FakeBroker (simulation mode).
 * Supports SPX execution via Config.execution.
 *
 * Order type logic:
 *   - Market order if bid-ask spread ≤ maxSpreadForMarket (default $0.75)
 *   - Limit order at ask price if spread is wider
 *   - Exits always use market orders (speed > price on exit)
 *
 * In paper mode, logs the order without sending it.
 * In simulation mode, routes to FakeBroker locally.
 */
import axios from 'axios';
import { config, TRADIER_BASE, TRADIER_SANDBOX_BASE } from '../config';
import type { Config } from '../config/types';
import type { AgentSignal, AgentDecision, OpenPosition } from './types';
import { randomUUID } from 'crypto';
import { roundToOptionTick } from '../core/option-tick';
import {
  incrReentryAttempted,
  incrReentryProtected,
  incrReentryUnprotected,
} from './execution-counters';
import { isSimulationMode, getFakeBroker } from './execution-router';
import type { FakeBroker } from './fake-broker';

/** Maximum bid-ask spread to use a market order. Above this, use limit at ask. */
const DEFAULT_MAX_SPREAD_FOR_MARKET = 0.50;
/** Maximum bid-ask spread for a limit order. Above this, block the trade entirely. */
const DEFAULT_MAX_SPREAD_ABSOLUTE = 1.00;

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
  maxWaitMs = 60000,  // 1 minute - orders should fill within this time
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

/**
 * Poll Tradier for the leg statuses of an OTOCO parent order.
 * Returns per-leg status: 'open' | 'filled' | 'rejected' | 'canceled' | 'expired' | 'unknown'.
 *
 * Used by verifyOtocoProtection() to detect partial OTOCO acceptance
 * (entry filled but TP/SL rejected). Non-blocking — called with a short
 * timeout so the agent's main loop does not stall.
 */
export async function waitForOtocoLegs(
  bracketOrderId: number,
  accountId: string,
  timeoutMs = 3000,
): Promise<{ entry: string; tp: string; sl: string; raw?: any }> {
  const start = Date.now();
  const pollMs = 500;

  while (Date.now() - start < timeoutMs) {
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders/${bracketOrderId}`,
        { headers: headers(), timeout: 2000 },
      );
      const order = data?.order;
      if (!order) break;

      const legs = Array.isArray(order.leg) ? order.leg : (order.leg ? [order.leg] : []);
      const entry = legs[0]?.status || order.status || 'unknown';
      const tp = legs[1]?.status || 'unknown';
      const sl = legs[2]?.status || 'unknown';

      // Return early once entry has a terminal status (filled/rejected),
      // so we can decide whether to remediate.
      if (entry === 'filled' || entry === 'rejected') {
        return { entry, tp, sl, raw: order };
      }
    } catch {
      // network error — keep retrying until timeout
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  return { entry: 'timeout', tp: 'unknown', sl: 'unknown' };
}

/**
 * Verify that OTOCO protection is actually in place after submission.
 *
 * Design: non-blocking. Fires and forgets — the caller (openPosition)
 * returns immediately; this runs in background, and if it detects a
 * partial OTOCO accept (entry filled but TP/SL missing) it logs a loud
 * ALERT so the monitor agent / next reconcile cycle can attach protection.
 *
 * We do NOT submit the standalone OCO directly here to avoid tight coupling
 * — that path goes through PositionManager.submitStandaloneOco() which owns
 * the position map. This function's role is detection + alerting.
 *
 * Returns immediately (caller does not await the result).
 */
export function verifyOtocoProtection(
  bracketOrderId: number | undefined,
  positionSymbol: string,
  accountId: string,
): void {
  if (!bracketOrderId) return;
  // Fire and forget
  (async () => {
    try {
      const legs = await waitForOtocoLegs(bracketOrderId, accountId);
      const tpMissing = legs.tp === 'rejected' || legs.tp === 'canceled' || legs.tp === 'expired';
      const slMissing = legs.sl === 'rejected' || legs.sl === 'canceled' || legs.sl === 'expired';
      if (legs.entry === 'filled' && (tpMissing || slMissing)) {
        console.error(`[executor] 🚨 ALERT: OTOCO #${bracketOrderId} partial-accept for ${positionSymbol} — entry=filled TP=${legs.tp} SL=${legs.sl}. Position UNPROTECTED. Reconcile / monitor should attach standalone OCO.`);
      } else if (legs.entry === 'timeout') {
        console.warn(`[executor] ⏳ OTOCO #${bracketOrderId} leg verification timed out for ${positionSymbol} — check next cycle`);
      }
    } catch (e: any) {
      console.warn(`[executor] OTOCO verification error for ${positionSymbol}: ${e.message}`);
    }
  })();
}

/** Get the Tradier account ID — uses execution config override or default .env */
function getAccountId(execCfg?: Config['execution']): string {
  return execCfg?.accountId || config.tradierAccountId;
}

/** Get the root symbol for Tradier orders (e.g., 'SPX') */
function getRootSymbol(execCfg?: Config['execution']): string {
  return execCfg?.symbol || 'SPX';
}

/**
 * Convert an SPXW option symbol to the target product.
 * Returns the input unchanged for SPXW (the default and only active product).
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
 * ≤ maxSpreadForMarket  → market order (fast fill)
 * ≤ maxSpreadAbsolute   → limit order at ask (price protection)
 * > maxSpreadAbsolute   → BLOCKED (spread too wide)
 */
export function chooseOrderType(
  bid: number | null,
  ask: number | null,
  maxSpreadForMarket: number = DEFAULT_MAX_SPREAD_FOR_MARKET,
  maxSpreadAbsolute: number = DEFAULT_MAX_SPREAD_ABSOLUTE,
): { type: 'market' | 'limit' | 'blocked'; price?: number; spread: number | null; reason?: string } {
  if (bid == null || ask == null || bid <= 0 || ask <= 0) {
    // No quote data — use limit at last known price for safety
    return { type: 'limit', price: ask ?? undefined, spread: null };
  }

  const spread = ask - bid;

  if (spread <= maxSpreadForMarket) {
    return { type: 'market', spread };
  } else if (spread <= maxSpreadAbsolute) {
    return { type: 'limit', price: ask, spread };
  } else {
    return { type: 'blocked', spread, reason: `Spread $${spread.toFixed(2)} exceeds max $${maxSpreadAbsolute.toFixed(2)}` };
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
  blocked?: boolean;
}

export async function openPosition(
  signal: AgentSignal,
  decision: AgentDecision,
  paper: boolean,
  execCfg?: Config['execution'],
  reentryDepth?: number,
  agentTag?: string,
): Promise<{ position: OpenPosition; execution: ExecutionResult }> {
  const qty = decision.positionSize;
  const isReentry = (reentryDepth ?? 0) >= 1;
  if (isReentry) incrReentryAttempted();

  // ── SIMULATION MODE: Route to FakeBroker ────────────────────────────────
  if (isSimulationMode()) {
    const fakeBroker = getFakeBroker();
    if (!fakeBroker) {
      return {
        position: {
          id: randomUUID(),
          symbol: signal.symbol,
          side: signal.side,
          strike: signal.strike,
          expiry: signal.expiry || new Date().toISOString().split('T')[0],
          entryPrice: 0,
          quantity: 0,
          stopLoss: decision.stopLoss,
          takeProfit: decision.takeProfit,
          openedAt: Date.now(),
        },
        execution: { error: 'FakeBroker not initialized', paper: true },
      };
    }

    const side = signal.side === 'call' ? 'buy_to_open' : 'buy_to_open'; // Calls and puts both buy_to_open
    const result = fakeBroker.submitOtocOrder({
      symbol: signal.symbol,
      side,
      quantity: qty,
      price: signal.ask ?? signal.currentPrice,
      takeProfit: decision.takeProfit ?? signal.ask ?? signal.currentPrice,
      stopLoss: decision.stopLoss,
    });

    console.log(`[executor] SIMULATION: OTOCO ${side} ${qty}x ${signal.symbol} @ $${(signal.ask ?? signal.currentPrice).toFixed(2)}`);
    console.log(`[executor]             TP: $${decision.takeProfit?.toFixed(2)} | SL: $${decision.stopLoss.toFixed(2)}`);
    console.log(`[executor]             Bracket: #${result.bracketId} | Entry: #${result.entryId} | TP: #${result.tpLegId} | SL: #${result.slLegId}`);

    return {
      position: {
        id: randomUUID(),
        symbol: signal.symbol,
        side: signal.side,
        strike: signal.strike,
        expiry: signal.expiry || new Date().toISOString().split('T')[0],
        entryPrice: signal.ask ?? signal.currentPrice,
        quantity: qty,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
        openedAt: Date.now(),
        bracketOrderId: result.bracketId,
        tpLegId: result.tpLegId,
        slLegId: result.slLegId,
      },
      execution: {
        orderId: result.entryId,
        fillPrice: signal.ask ?? signal.currentPrice,
        paper: true,
        executedSymbol: signal.symbol,
        orderType: 'market',
      },
    };
  }

  // ── PAPER / LIVE MODE: Tradier API ───────────────────────────────────────

  // Determine order type from spread
  const order = chooseOrderType(signal.bid, signal.ask);

  // Block trade if spread too wide
  if (order.type === 'blocked') {
    const executedSymbol = convertOptionSymbol(signal.symbol, execCfg);
    console.warn(`[executor] 🚫 BLOCKED: ${executedSymbol} — ${order.reason}`);
    const emptyPosition: OpenPosition = {
      id: randomUUID(),
      symbol: executedSymbol,
      side: signal.side,
      strike: signal.strike / (execCfg?.strikeDivisor || 1),
      expiry: getTargetExpiry(execCfg),
      entryPrice: 0,
      quantity: 0,
      stopLoss: decision.stopLoss,
      takeProfit: decision.takeProfit,
      openedAt: Date.now(),
    };
    return { position: emptyPosition, execution: { error: order.reason, paper, executedSymbol, spread: order.spread } };
  }

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

  // Paper mode: route to Tradier sandbox with real OTOCO orders
  const paperAccountId = config.tradierPaperAccountId;
  const paperBaseUrl = TRADIER_SANDBOX_BASE;
  const paperHeaders = {
    Authorization: `Bearer ${config.tradierPaperToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (paper && paperAccountId) {
    const label = `[${rootSymbol}→${paperAccountId} SANDBOX]`;
    const hasBracketPrices = decision.takeProfit != null && decision.takeProfit > 0 && decision.stopLoss > 0;
    const bracketDisabled = execCfg?.disableBracketOrders === true;

    if (hasBracketPrices && !bracketDisabled) {
      try {
        const result = await submitOtocoOrder(
          rootSymbol, executedSymbol, paperAccountId, qty,
          order, entryPrice, decision.takeProfit!, decision.stopLoss, spreadStr, agentTag,
          paperBaseUrl, paperHeaders, 'PAPER',
        );
        position.bracketOrderId = result.bracketOrderId;
        console.log(`[executor] PAPER OTOCO ${label} ${qty}x ${executedSymbol} @ $${entryPrice.toFixed(2)} | TP=$${decision.takeProfit!.toFixed(2)} SL=$${decision.stopLoss.toFixed(2)} — bracket #${result.bracketOrderId}`);
        return { position, execution: { orderId: result.entryOrderId, fillPrice: entryPrice, paper: true, executedSymbol, orderType: order.type, spread: order.spread } };
      } catch (e: any) {
        console.error(`[executor] PAPER OTOCO FAILED ${label}: ${e.message} — falling back to bare order`);
      }
    }

    // Bare market/limit order to sandbox
    const orderParams: Record<string, string | number> = {
      class: 'option', symbol: rootSymbol, option_symbol: executedSymbol,
      side: 'buy_to_open', quantity: qty, type: order.type, duration: 'day',
    };
    if (order.type === 'limit' && entryPrice > 0) orderParams.price = entryPrice.toFixed(2);
    try {
      const { data } = await axios.post(`${paperBaseUrl}/accounts/${paperAccountId}/orders`, new URLSearchParams(orderParams as any).toString(), { headers: paperHeaders, timeout: 10000 });
      const orderId = data?.order?.id;
      console.log(`[executor] PAPER BUY ${label} ${qty}x ${executedSymbol} @ $${entryPrice.toFixed(2)} — order #${orderId}`);
      return { position, execution: { orderId, fillPrice: entryPrice, paper: true, executedSymbol, orderType: order.type, spread: order.spread } };
    } catch (e: any) {
      console.error(`[executor] PAPER ORDER FAILED ${label}: ${e.message}`);
      return { position, execution: { error: e.message, paper: true, executedSymbol, orderType: order.type, spread: order.spread } };
    }
  }

  if (paper) {
    const label = execCfg ? `[${rootSymbol}→${accountId}]` : '';
    console.log(`[executor] PAPER BUY (no sandbox) ${label} ${qty}x ${executedSymbol} @ $${entryPrice.toFixed(2)} (${order.type}, spread=${spreadStr}) | stop: $${decision.stopLoss.toFixed(2)}`);
    return { position, execution: { fillPrice: entryPrice, paper: true, executedSymbol, orderType: order.type, spread: order.spread } };
  }

  // Live order — try OTOCO bracket (entry + TP + SL) first, unless disabled
  const hasBracketPrices = decision.takeProfit != null && decision.takeProfit > 0 && decision.stopLoss > 0;
  const bracketDisabled = execCfg?.disableBracketOrders === true;

  if (hasBracketPrices && !bracketDisabled) {
    try {
      const result = await submitOtocoOrder(
        rootSymbol, executedSymbol, accountId, qty,
        order, entryPrice, decision.takeProfit!, decision.stopLoss, spreadStr, agentTag,
      );
      position.tradierOrderId = result.entryOrderId;
      position.bracketOrderId = result.bracketOrderId;
      position.tpLegId = result.tpLegId;
      position.slLegId = result.slLegId;

      // Task 1.2: verify legs actually accepted in background. If Tradier
      // accepted the parent OTOCO but one OCO leg rejects (partial accept),
      // this fires an ALERT so reconcile / monitor can attach standalone OCO.
      // Non-blocking — does not delay the entry return.
      verifyOtocoProtection(result.bracketOrderId, executedSymbol, accountId);

      // Task 3.3: count TP re-entry protection outcome. "Protected" here
      // means Tradier accepted the parent OTOCO; verifyOtocoProtection() may
      // still downgrade individual legs in the background, but that's a
      // partial-accept alert path, not the counter's concern.
      if (isReentry) incrReentryProtected();

      return { position, execution: { orderId: result.entryOrderId, fillPrice: entryPrice, paper: false, executedSymbol, orderType: order.type, spread: order.spread } };
    } catch (e: any) {
      // Task 1.3: loud-fail — this path leaves the position without
      // server-side protection until reconcile runs. The monitor agent
      // should surface this immediately.
      const otocoErr = e?.response?.data?.errors?.error || e?.response?.data || e.message;
      console.error(`[executor] 🚨 ALERT: OTOCO SUBMISSION FAILED for ${executedSymbol}: ${typeof otocoErr === 'string' ? otocoErr : JSON.stringify(otocoErr)} — falling back to bare entry order.`);
      // Task 3.3: re-entry fell back to bare order — UNPROTECTED until reconcile.
      if (isReentry) incrReentryUnprotected();
      // Fall through to single order below
    }
  } else if (isReentry) {
    // Re-entry path skipped OTOCO entirely (brackets disabled or no TP/SL) —
    // bare entry order has no server-side protection.
    incrReentryUnprotected();
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
  order: { type: 'market' | 'limit' | 'blocked'; price?: number; spread: number | null },
  entryPrice: number,
  tpPrice: number,
  slPrice: number,
  spreadStr: string,
  agentTag?: string,
  baseUrl: string = TRADIER_BASE,
  hdrs: Record<string, string> = headers(),
  mode: 'LIVE' | 'PAPER' = 'LIVE',
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
    // Leg 1: TP (limit sell) — round to valid option tick (Tradier rejects off-tick prices)
    'type[1]': 'limit',
    'option_symbol[1]': optionSymbol,
    'side[1]': 'sell_to_close',
    'quantity[1]': qty,
    'price[1]': roundToOptionTick(tpPrice).toFixed(2),
    // Leg 2: SL (stop sell) — round to valid option tick
    'type[2]': 'stop',
    'option_symbol[2]': optionSymbol,
    'side[2]': 'sell_to_close',
    'quantity[2]': qty,
    'stop[2]': roundToOptionTick(slPrice).toFixed(2),
  };

  // Set entry price for limit orders — round to valid option tick
  if (order.type === 'limit' && entryPrice > 0) {
    params['price[0]'] = roundToOptionTick(entryPrice).toFixed(2);
  }

  const body = qs(params);

  const { data } = await axios.post(
    `${baseUrl}/accounts/${accountId}/orders`,
    body,
    { headers: hdrs, timeout: 10000 },
  );

  // Parse response: order.id = parent OTOCO, order.leg[].id = each leg
  const parentOrder = data?.order;

  // DEBUG: check if tag came back in response
  const responseTag = parentOrder?.tag;
  console.log(`[executor] 🏷️  Response tag='${responseTag || 'NONE'}' (order ${parentOrder?.id})`);
  if (agentTag && responseTag !== agentTag && mode === 'LIVE') {
    console.error(`[executor] 🚨 TAG MISMATCH: sent '${agentTag}' got '${responseTag || 'NONE'}'`);
  }
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

  console.log(`[executor] ${mode} OTOCO [${rootSymbol}→${accountId}] ${qty}x ${optionSymbol} @ ${order.type === 'market' ? 'MARKET' : '$' + entryPrice.toFixed(2)} (spread=${spreadStr}) | TP=$${tpPrice.toFixed(2)} SL=$${slPrice.toFixed(2)} — bracket #${bracketOrderId}`);

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

  // ── SIMULATION MODE: Log close (FakeBroker handles TP/SL fills automatically) ──
  if (isSimulationMode()) {
    const fakeBroker = getFakeBroker();
    if (fakeBroker) {
      // In simulation mode, FakeBroker monitors prices and executes TP/SL fills automatically
      // We just need to log that the position was closed
      console.log(`[executor] SIMULATION: Close ${position.quantity}x ${position.symbol} @ $${currentPrice.toFixed(2)} (${reason})`);
      return { fillPrice: currentPrice, paper: true, orderType: 'market' };
    }
    return { error: 'FakeBroker not initialized', paper: true, orderType: 'market' };
  }

  // ── PAPER / LIVE MODE: Tradier API ───────────────────────────────────────

  // Exits always use market orders — speed matters more than price on exit
  if (paper) {
    const paperAccountId = config.tradierPaperAccountId;
    if (paperAccountId) {
      try {
        const params: Record<string, string | number> = {
          class: 'option', symbol: rootSymbol, option_symbol: position.symbol,
          side: 'sell_to_close', quantity: position.quantity, type: 'market', duration: 'day',
        };
        const { data } = await axios.post(
          `${TRADIER_SANDBOX_BASE}/accounts/${paperAccountId}/orders`,
          new URLSearchParams(params as any).toString(),
          { headers: { Authorization: `Bearer ${config.tradierPaperToken}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
        );
        console.log(`[executor] PAPER SELL [SANDBOX→${paperAccountId}] ${position.quantity}x ${position.symbol} @ $${currentPrice.toFixed(2)} MARKET (${reason}) — order #${data?.order?.id}`);
        return { orderId: data?.order?.id, fillPrice: currentPrice, paper: true, orderType: 'market' };
      } catch (e: any) {
        console.error(`[executor] PAPER SELL FAILED (sandbox): ${e.message} — simulating`);
      }
    }
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
