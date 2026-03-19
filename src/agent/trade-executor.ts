/**
 * TradeExecutor: places orders via Tradier API.
 * In paper mode, logs the order without sending it.
 */
import axios from 'axios';
import { config, TRADIER_BASE } from '../config';
import type { AgentSignal, AgentDecision, OpenPosition } from './types';
import { randomUUID } from 'crypto';

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

export interface ExecutionResult {
  orderId?: number;
  fillPrice?: number;
  error?: string;
  paper: boolean;
}

export async function openPosition(
  signal: AgentSignal,
  decision: AgentDecision,
  paper: boolean,
): Promise<{ position: OpenPosition; execution: ExecutionResult }> {
  const qty = decision.positionSize;
  const entryPrice = signal.ask ?? signal.currentPrice;  // use ask for market buy

  const position: OpenPosition = {
    id: randomUUID(),
    symbol: signal.symbol,
    side: signal.side,
    strike: signal.strike,
    expiry: signal.expiry,
    entryPrice,
    quantity: qty,
    stopLoss: decision.stopLoss,
    takeProfit: decision.takeProfit,
    openedAt: Date.now(),
  };

  if (paper) {
    console.log(`[executor] PAPER BUY ${qty}x ${signal.symbol} @ $${entryPrice.toFixed(2)} | stop: $${decision.stopLoss.toFixed(2)}`);
    return { position, execution: { fillPrice: entryPrice, paper: true } };
  }

  // Live order via Tradier
  const body = qs({
    class: 'option',
    symbol: 'SPX',
    option_symbol: signal.symbol,
    side: 'buy_to_open',
    quantity: qty,
    type: 'limit',
    price: entryPrice.toFixed(2),
    duration: 'day',
  });

  try {
    const { data } = await axios.post(
      `${TRADIER_BASE}/accounts/${config.tradierAccountId}/orders`,
      body,
      { headers: headers(), timeout: 10000 },
    );
    const orderId = data?.order?.id;
    console.log(`[executor] LIVE BUY ${qty}x ${signal.symbol} @ $${entryPrice.toFixed(2)} — order #${orderId}`);
    position.tradierOrderId = orderId;
    return { position, execution: { orderId, fillPrice: entryPrice, paper: false } };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Order failed: ${err}`);
    return { position, execution: { error: String(err), paper: false } };
  }
}

export async function closePosition(
  position: OpenPosition,
  reason: string,
  currentPrice: number,
  paper: boolean,
): Promise<ExecutionResult> {
  if (paper) {
    console.log(`[executor] PAPER SELL ${position.quantity}x ${position.symbol} @ $${currentPrice.toFixed(2)} (${reason})`);
    return { fillPrice: currentPrice, paper: true };
  }

  const body = qs({
    class: 'option',
    symbol: 'SPX',
    option_symbol: position.symbol,
    side: 'sell_to_close',
    quantity: position.quantity,
    type: 'market',
    duration: 'day',
  });

  try {
    const { data } = await axios.post(
      `${TRADIER_BASE}/accounts/${config.tradierAccountId}/orders`,
      body,
      { headers: headers(), timeout: 10000 },
    );
    const orderId = data?.order?.id;
    console.log(`[executor] LIVE SELL ${position.quantity}x ${position.symbol} @ market (${reason}) — order #${orderId}`);
    return { orderId, fillPrice: currentPrice, paper: false };
  } catch (e: any) {
    const err = e?.response?.data?.errors?.error || e.message;
    console.error(`[executor] Close failed: ${err}`);
    return { error: String(err), paper: false };
  }
}
