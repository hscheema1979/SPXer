/**
 * Fake Broker - Simulates Tradier API and WebSocket events locally
 *
 * Used in SIMULATION mode to test strategies without broker interaction.
 * Provides realistic order execution, fill simulation, and WebSocket events.
 *
 * Key features:
 * - Accepts OTOCO bracket orders (entry + TP + SL)
 * - Monitors price ticks and triggers TP/SL fills
 * - Emits Tradier-style WebSocket events
 * - Full order lifecycle tracking
 */

import { EventEmitter } from 'events';
import type { AccountOrderEvent } from './account-stream';

export interface FakeOrder {
  id: number;
  clientOrderId: string;
  symbol: string;
  side: 'buy_to_open' | 'sell_to_close';
  type: 'market' | 'limit' | 'stop';
  status: 'pending' | 'open' | 'filled' | 'rejected';
  quantity: number;
  fillPrice: number | null;
  avgFillPrice: number;
  executedQuantity: number;
  remainingQuantity: number;
  stopPrice: number | null;
  limitPrice: number | null;
  createdAt: number;
  filledAt: number | null;
  // Bracket order tracking
  bracketId: number | null;
  isTpLeg: boolean;
  isSlLeg: boolean;
  parentId: number | null;
}

export interface FakePosition {
  symbol: string;
  quantity: number;
  avgEntryPrice: number;
  stopLoss: number;
  takeProfit: number;
  orders: FakeOrder[];
}

/**
 * FakeTradierBroker
 *
 * Simulates:
 * - Order API (POST /accounts/:id/orders)
 * - OTOCO bracket orders
 * - Price monitoring and fill execution
 * - WebSocket event stream
 */
export class FakeBroker extends EventEmitter {
  private nextOrderId: number = 1000;
  private orders: Map<number, FakeOrder> = new Map();
  private positions: Map<string, FakePosition> = new Map();
  private priceFeed: Map<string, number> = new Map();
  private fillDelayMs: number;

  constructor(fillDelayMs: number = 100) {
    super();
    this.fillDelayMs = fillDelayMs;
  }

  /**
   * Update current market price (simulates price ticks from data service)
   * Monitors for TP/SL triggers
   */
  updatePrice(symbol: string, price: number): void {
    this.priceFeed.set(symbol, price);

    // Check all open positions for TP/SL triggers
    for (const [sym, pos] of this.positions.entries()) {
      if (sym !== symbol) continue;

      for (const order of pos.orders) {
        if (order.status !== 'open') continue;

        // Check TP (limit order)
        if (order.isTpLeg && order.limitPrice) {
          if (order.side === 'sell_to_close' && price >= order.limitPrice) {
            this.executeOrder(order.id, price);
          }
        }

        // Check SL (stop order)
        if (order.isSlLeg && order.stopPrice) {
          if (order.side === 'sell_to_close' && price <= order.stopPrice) {
            this.executeOrder(order.id, price);
          }
        }

        // Check market orders (execute immediately)
        if (order.type === 'market' && order.status === 'open') {
          // Fill at current price with slight slippage
          const slippage = order.side === 'buy_to_open' ? 0.10 : -0.05;
          this.executeOrder(order.id, price + slippage);
        }
      }
    }
  }

  /**
   * Simulate Tradier POST /accounts/:id/orders
   * Accepts OTOCO bracket orders
   */
  submitOtocOrder(params: {
    symbol: string;
    side: 'buy_to_open' | 'sell_to_close';
    quantity: number;
    price: number;
    takeProfit: number;
    stopLoss: number;
  }): {
    entryId: number;
    tpLegId: number;
    slLegId: number;
    bracketId: number;
  } {
    const bracketId = this.nextOrderId++;

    // Entry order
    const entryResult = this.submitOrder({
      symbol: params.symbol,
      side: params.side,
      type: 'market',
      quantity: params.quantity,
    });

    const entryOrder = this.orders.get(entryResult.id)!;
    entryOrder.bracketId = bracketId;

    // TP leg (limit order)
    const tpResult = this.submitOrder({
      symbol: params.symbol,
      side: 'sell_to_close',
      type: 'limit',
      quantity: params.quantity,
      price: params.takeProfit,
    });

    const tpOrder = this.orders.get(tpResult.id)!;
    tpOrder.bracketId = bracketId;
    tpOrder.isTpLeg = true;
    tpOrder.parentId = entryOrder.id;
    tpOrder.status = 'pending'; // TP/SL legs wait for entry fill
    tpOrder.limitPrice = params.takeProfit;

    // SL leg (stop order)
    const slResult = this.submitOrder({
      symbol: params.symbol,
      side: 'sell_to_close',
      type: 'stop',
      quantity: params.quantity,
    });

    const slOrder = this.orders.get(slResult.id)!;
    slOrder.bracketId = bracketId;
    slOrder.isSlLeg = true;
    slOrder.parentId = entryOrder.id;
    slOrder.status = 'pending'; // TP/SL legs wait for entry fill
    slOrder.stopPrice = params.stopLoss;

    // Activate TP/SL legs when entry fills
    this.onOrderFilled(entryResult.id, () => {
      // Update position tracking
      const pos: FakePosition = {
        symbol: params.symbol,
        quantity: params.quantity,
        avgEntryPrice: params.price,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        orders: [entryOrder, tpOrder, slOrder],
      };
      this.positions.set(params.symbol, pos);

      // Activate TP and SL legs
      tpOrder.status = 'open';
      slOrder.status = 'open';
      this.emitOrderEvent(tpOrder);
      this.emitOrderEvent(slOrder);
    });

    return {
      entryId: entryResult.id,
      tpLegId: tpResult.id,
      slLegId: slResult.id,
      bracketId,
    };
  }

  /**
   * Submit a single order (internal helper)
   */
  private submitOrder(params: {
    symbol: string;
    side: 'buy_to_open' | 'sell_to_close';
    type: 'market' | 'limit' | 'stop';
    quantity: number;
    price?: number;
  }): { id: number; status: string } {
    const orderId = this.nextOrderId++;

    const order: FakeOrder = {
      id: orderId,
      clientOrderId: randomUUID(),
      symbol: params.symbol,
      side: params.side,
      type: params.type,
      status: 'pending',
      quantity: params.quantity,
      fillPrice: null,
      avgFillPrice: 0,
      executedQuantity: 0,
      remainingQuantity: params.quantity,
      stopPrice: null,
      limitPrice: params.price || null,
      createdAt: Date.now(),
      filledAt: null,
      bracketId: null,
      isTpLeg: false,
      isSlLeg: false,
      parentId: null,
    };

    this.orders.set(orderId, order);

    // Simulate order acceptance
    setTimeout(() => {
      order.status = 'open';
      this.emitOrderEvent(order);

      // Market orders fill immediately
      if (params.type === 'market') {
        const currentPrice = this.priceFeed.get(params.symbol) || 100;
        const slippage = params.side === 'buy_to_open' ? 0.10 : -0.05;
        this.executeOrder(orderId, currentPrice + slippage);
      }
    }, 50);

    return { id: orderId, status: 'pending' };
  }

  /**
   * Execute an order (fill it)
   */
  private executeOrder(orderId: number, fillPrice: number): void {
    const order = this.orders.get(orderId);
    if (!order || order.status !== 'open') return;

    order.status = 'filled';
    order.fillPrice = fillPrice;
    order.avgFillPrice = fillPrice;
    order.executedQuantity = order.quantity;
    order.remainingQuantity = 0;
    order.filledAt = Date.now();

    this.emitOrderEvent(order);
    this.emit('orderFilled', order);
  }

  /**
   * Register callback for order fill
   */
  private onOrderFilled(orderId: number, callback: () => void): void {
    const checkFill = () => {
      const order = this.orders.get(orderId);
      if (order && order.status === 'filled') {
        callback();
      } else {
        setTimeout(checkFill, 50);
      }
    };
    checkFill();
  }

  /**
   * Emit WebSocket event (what AccountStream receives)
   */
  private emitOrderEvent(order: FakeOrder): void {
    const event: AccountOrderEvent = {
      id: order.id,
      event: 'order',
      status: order.status as any,
      type: 'option',
      price: order.fillPrice || 0,
      stop_price: order.stopPrice || 0,
      avg_fill_price: order.avgFillPrice,
      executed_quantity: order.executedQuantity,
      last_fill_quantity: order.executedQuantity,
      remaining_quantity: order.remainingQuantity,
      transaction_date: new Date(order.filledAt || order.createdAt).toISOString(),
      create_date: new Date(order.createdAt).toISOString(),
      account: 'SIMULATION',
      option_symbol: order.symbol,
      side: order.side === 'buy_to_open' ? 'buy' : 'sell',
      class: 'option',
    };

    this.emit('accountEvent', event);
  }

  /**
   * Get account stream for PositionOrderManager
   */
  getAccountStream() {
    return {
      onEvent: (callback: (event: AccountOrderEvent) => void) => {
        this.on('accountEvent', callback);
      },
      stop: () => {
        this.removeAllListeners();
      },
    };
  }

  /**
   * Get statistics about simulation
   */
  getStats() {
    const allOrders = Array.from(this.orders.values());
    const positions = Array.from(this.positions.values());

    return {
      active: true,
      mode: 'SIMULATION',
      ordersSubmitted: allOrders.length,
      ordersFilled: allOrders.filter(o => o.status === 'filled').length,
      pendingOrders: allOrders.filter(o => o.status === 'open' || o.status === 'pending').length,
      positions: positions.map(pos => ({
        symbol: pos.symbol,
        quantity: pos.quantity,
        avgEntryPrice: pos.avgEntryPrice,
        unrealizedPnl: this.calculateUnrealizedPnl(pos),
        status: this.getPositionStatus(pos),
      })),
    };
  }

  /**
   * Calculate unrealized P&L for a position
   */
  private calculateUnrealizedPnl(pos: FakePosition): number {
    const currentPrice = this.priceFeed.get(pos.symbol) || pos.avgEntryPrice;
    const pnlPerContract = currentPrice - pos.avgEntryPrice;
    return pnlPerContract * pos.quantity * 100; // Options are for 100 shares
  }

  /**
   * Get position status
   */
  private getPositionStatus(pos: FakePosition): 'OPEN' | 'CLOSED' {
    const entryOrder = pos.orders.find(o => o.side === 'buy_to_open');
    if (entryOrder?.status === 'filled') {
      // Check if TP/SL legs filled
      const exitOrders = pos.orders.filter(o => o.side === 'sell_to_close');
      if (exitOrders.some(o => o.status === 'filled')) {
        return 'CLOSED';
      }
      return 'OPEN';
    }
    return 'OPEN';
  }

  /**
   * Get all simulated positions
   */
  getSimulatedPositions() {
    return Array.from(this.positions.entries()).map(([symbol, pos]) => ({
      symbol,
      quantity: pos.quantity,
      entryPrice: pos.avgEntryPrice,
      currentPrice: this.priceFeed.get(symbol) || pos.avgEntryPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      unrealizedPnl: this.calculateUnrealizedPnl(pos),
      status: this.getPositionStatus(pos),
      orders: pos.orders.map(o => ({
        id: o.id,
        side: o.side,
        type: o.type,
        status: o.status,
        fillPrice: o.fillPrice,
        quantity: o.executedQuantity,
      })),
    }));
  }

  /**
   * Clear all simulated data (for testing)
   */
  clear(): void {
    this.orders.clear();
    this.positions.clear();
    this.removeAllListeners();
  }
}

// Helper function
import { randomUUID } from 'crypto';
