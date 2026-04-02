/**
 * PositionManager: tracks open positions and handles broker interactions.
 *
 * Trading decisions (HMA cross detection, exit monitoring) are handled by
 * src/core/strategy-engine.ts tick(). This class manages broker-side state:
 * position tracking, bracket order management, and reconciliation.
 */
import axios from 'axios';
import type { OpenPosition, OptionSide } from './types';
import type { Config } from '../config/types';
import { cancelOcoLegs } from './trade-executor';
import { config as appConfig, TRADIER_BASE } from '../config';
import { randomUUID } from 'crypto';

export interface PositionCloseEvent {
  position: OpenPosition;
  closePrice: number;
  reason: string;
  pnl: number;
}

export class PositionManager {
  private positions: Map<string, OpenPosition> = new Map();
  private paper: boolean;
  private cfg: Config;

  constructor(config: Config, paper: boolean) {
    this.cfg = config;
    this.paper = paper;
  }

  add(position: OpenPosition): void {
    this.positions.set(position.id, position);
    console.log(`[positions] Opened ${position.symbol} x${position.quantity} @ $${position.entryPrice.toFixed(2)} | stop: $${position.stopLoss.toFixed(2)}`);
  }

  getAll(): OpenPosition[] {
    return Array.from(this.positions.values());
  }

  count(): number {
    return this.positions.size;
  }

  /** Remove a position by ID (e.g., phantom position detected during reconciliation) */
  remove(id: string): void {
    this.positions.delete(id);
  }

  // NOTE: updateHmaCross() and monitor() have been removed.
  // HMA cross detection and exit monitoring are now handled by
  // src/core/strategy-engine.ts tick() — the single source of truth
  // for both replay and live agents.

  /**
   * Reconcile open positions from broker on startup.
   * Fetches actual positions from Tradier, reconstructs OpenPosition objects,
   * checks for existing OCO legs, and submits new ones if missing.
   * Returns count of reconciled positions.
   */
  async reconcileFromBroker(execCfg?: Config['execution']): Promise<number> {
    if (this.paper) {
      console.log('[reconcile] Paper mode — skipping broker reconciliation');
      return 0;
    }

    const accountId = execCfg?.accountId || appConfig.tradierAccountId;
    const hdrs = {
      Authorization: `Bearer ${appConfig.tradierToken}`,
      Accept: 'application/json',
    };

    // 1. Fetch open positions from Tradier
    let positions: any[] = [];
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/positions`,
        { headers: hdrs, timeout: 10000 },
      );
      const raw = data?.positions?.position;
      positions = Array.isArray(raw) ? raw : raw ? [raw] : [];
    } catch (e: any) {
      console.error(`[reconcile] Failed to fetch positions [${accountId}]: ${e.message}`);
      return 0;
    }

    if (positions.length === 0) {
      console.log(`[reconcile] No open positions at broker [${accountId}]`);
      return 0;
    }

    // 2. Fetch pending orders to find existing OCO legs
    let pendingOrders: any[] = [];
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders`,
        { headers: hdrs, timeout: 10000 },
      );
      const rawOrders = data?.orders?.order;
      const allOrders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];
      pendingOrders = allOrders.filter((o: any) => o.status === 'pending' || o.status === 'open');
    } catch (e: any) {
      console.warn(`[reconcile] Failed to fetch orders [${accountId}]: ${e.message}`);
      // Continue without order info — we'll submit new OCO legs
    }

    let reconciled = 0;

    for (const pos of positions) {
      const symbol: string = pos.symbol;
      const quantity = Math.abs(pos.quantity);
      const costBasis = Math.abs(pos.cost_basis);
      const entryPrice = costBasis / (quantity * 100);

      // Parse option symbol: PREFIX + YYMMDD + C/P + 8-digit strike
      const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      if (!match) {
        console.warn(`[reconcile] Skipping unrecognized symbol: ${symbol}`);
        continue;
      }

      const [, , dateStr, callPut, strikeStr] = match;
      const side: OptionSide = callPut === 'C' ? 'call' : 'put';
      const strike = parseInt(strikeStr) / 1000;
      const expiry = `20${dateStr.slice(0, 2)}-${dateStr.slice(2, 4)}-${dateStr.slice(4, 6)}`;

      // Compute TP/SL from config
      const stopLoss = entryPrice * (1 - this.cfg.position.stopLossPercent / 100);
      const takeProfit = entryPrice * this.cfg.position.takeProfitMultiplier;

      // Look for existing OCO legs for this symbol
      let tpLegId: number | undefined;
      let slLegId: number | undefined;
      let bracketOrderId: number | undefined;

      for (const order of pendingOrders) {
        if (order.option_symbol === symbol && order.side === 'sell_to_close') {
          if (order.type === 'limit') {
            tpLegId = order.id;
            bracketOrderId = order.id; // Use any leg to cancel the OCO group
          } else if (order.type === 'stop') {
            slLegId = order.id;
            bracketOrderId = order.id;
          }
        }
      }

      const openPos: OpenPosition = {
        id: randomUUID(),
        symbol,
        side,
        strike,
        expiry,
        entryPrice,
        quantity,
        stopLoss,
        takeProfit,
        openedAt: pos.date_acquired ? new Date(pos.date_acquired).getTime() : Date.now(),
        bracketOrderId,
        tpLegId,
        slLegId,
      };

      this.add(openPos);
      reconciled++;

      const hasOco = tpLegId || slLegId;
      if (hasOco) {
        console.log(`[reconcile] Adopted ${symbol} x${quantity} @ $${entryPrice.toFixed(2)} | existing OCO: TP=#${tpLegId} SL=#${slLegId}`);
      } else {
        console.log(`[reconcile] Adopted ${symbol} x${quantity} @ $${entryPrice.toFixed(2)} | no OCO found — submitting protection orders`);
        await this.submitStandaloneOco(openPos, accountId, execCfg);
      }
    }

    console.log(`[reconcile] Reconciled ${reconciled} position(s) from broker [${accountId}]`);
    return reconciled;
  }

  /**
   * Submit standalone OCO legs (TP limit + SL stop) for a position
   * that has no server-side protection. Uses Tradier class=oco order type.
   */
  private async submitStandaloneOco(
    pos: OpenPosition,
    accountId: string,
    execCfg?: Config['execution'],
  ): Promise<void> {
    const rootSymbol = execCfg?.symbol || 'SPX';
    const hdrs = {
      Authorization: `Bearer ${appConfig.tradierToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const tp = pos.takeProfit ?? pos.entryPrice * this.cfg.position.takeProfitMultiplier;
    const sl = pos.stopLoss;

    const body = [
      'class=oco',
      'duration=day',
      `symbol=${rootSymbol}`,
      // Leg 0: TP limit
      `type[0]=limit`,
      `option_symbol[0]=${pos.symbol}`,
      `side[0]=sell_to_close`,
      `quantity[0]=${pos.quantity}`,
      `price[0]=${tp.toFixed(2)}`,
      // Leg 1: SL stop
      `type[1]=stop`,
      `option_symbol[1]=${pos.symbol}`,
      `side[1]=sell_to_close`,
      `quantity[1]=${pos.quantity}`,
      `stop[1]=${sl.toFixed(2)}`,
    ].join('&');

    try {
      const { data } = await axios.post(
        `${TRADIER_BASE}/accounts/${accountId}/orders`,
        body,
        { headers: hdrs, timeout: 10000 },
      );
      const orderId = data?.order?.id;
      pos.bracketOrderId = orderId;
      console.log(`[reconcile] Submitted OCO protection for ${pos.symbol}: TP=$${tp.toFixed(2)} SL=$${sl.toFixed(2)} — order #${orderId}`);
    } catch (e: any) {
      const err = e?.response?.data?.errors?.error || e.message;
      console.error(`[reconcile] Failed to submit OCO for ${pos.symbol}: ${err}`);
    }
  }

  /**
   * Cancel server-side bracket/OCO legs before agent-side close.
   * Retries once on failure, then checks order status to determine if the
   * legs are actually cleared (filled/expired/canceled = safe to proceed).
   *
   * Returns true if all bracket legs are cleared, false if any are still active.
   */
  private async cancelBracketLegs(pos: OpenPosition): Promise<boolean> {
    const legIds = [pos.bracketOrderId, pos.tpLegId, pos.slLegId].filter(Boolean) as number[];
    if (legIds.length === 0) return true;

    // Deduplicate — bracketOrderId might equal one of the leg IDs
    const unique = [...new Set(legIds)];
    let allCleared = true;

    for (const legId of unique) {
      let cancelled = false;

      // Attempt 1
      try {
        await cancelOcoLegs(legId, this.cfg.execution);
        cancelled = true;
      } catch {
        // Retry after 500ms
        await new Promise(r => setTimeout(r, 500));
        try {
          await cancelOcoLegs(legId, this.cfg.execution);
          cancelled = true;
        } catch {
          // Both attempts failed — check order status
        }
      }

      if (!cancelled) {
        // Query order status to determine if cancel was even necessary
        const status = await this.queryOrderStatus(legId);
        if (status && ['filled', 'expired', 'canceled', 'rejected'].includes(status)) {
          console.log(`[positions] Bracket #${legId} already ${status} — cancel unnecessary`);
        } else {
          console.error(`[positions] 🚨 CRITICAL: Bracket #${legId} still ${status ?? 'unknown'} after retry — sell may fail`);
          allCleared = false;
        }
      }
    }

    return allCleared;
  }

  /**
   * Query a single order's status from Tradier.
   * Returns the status string ('pending', 'open', 'filled', 'expired', 'canceled', 'rejected')
   * or null if the query fails.
   */
  private async queryOrderStatus(orderId: number): Promise<string | null> {
    const accountId = this.cfg.execution?.accountId || appConfig.tradierAccountId;
    const hdrs = {
      Authorization: `Bearer ${appConfig.tradierToken}`,
      Accept: 'application/json',
    };

    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders/${orderId}`,
        { headers: hdrs, timeout: 5000 },
      );
      return data?.order?.status ?? null;
    } catch (e: any) {
      console.warn(`[positions] Failed to query order #${orderId} status: ${e.message}`);
      return null;
    }
  }

  /**
   * Cancel any open/pending orders with sell_to_close legs for a given symbol.
   * Catches the case where a separate bracket order (not tracked on the position)
   * has open TP/SL legs that block new sell orders.
   */
  private async cancelOpenSellOrders(optionSymbol: string): Promise<void> {
    const accountId = this.cfg.execution?.accountId || appConfig.tradierAccountId;
    const hdrs = {
      Authorization: `Bearer ${appConfig.tradierToken}`,
      Accept: 'application/json',
    };

    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders`,
        { headers: hdrs, timeout: 10000 },
      );
      const raw = data?.orders?.order;
      const orders = Array.isArray(raw) ? raw : raw ? [raw] : [];

      for (const order of orders) {
        if (order.status !== 'open' && order.status !== 'pending') continue;

        // Check top-level order
        if (order.option_symbol === optionSymbol && order.side === 'sell_to_close') {
          try {
            await axios.delete(`${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`, { headers: hdrs, timeout: 10000 });
            console.log(`[positions] 🗑️ Cancelled sell order #${order.id} for ${optionSymbol}`);
          } catch { /* logged elsewhere */ }
          continue;
        }

        // Check legs (OTOCO/OCO)
        const legs = Array.isArray(order.leg) ? order.leg : order.leg ? [order.leg] : [];
        const hasOpenSellLeg = legs.some((l: any) =>
          (l.status === 'open' || l.status === 'pending') &&
          l.side === 'sell_to_close' &&
          l.option_symbol === optionSymbol
        );
        if (hasOpenSellLeg) {
          try {
            await axios.delete(`${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`, { headers: hdrs, timeout: 10000 });
            console.log(`[positions] 🗑️ Cancelled bracket #${order.id} with sell legs for ${optionSymbol}`);
          } catch { /* logged elsewhere */ }
        }
      }
    } catch (e: any) {
      console.warn(`[positions] ⚠️ Failed to scan open orders for ${optionSymbol}: ${e.message}`);
    }
  }
}
