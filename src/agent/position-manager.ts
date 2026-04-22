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
import { roundToOptionTick } from '../core/option-tick';

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
  /**
   * Reconcile open positions from broker on startup.
   * Fetches actual positions from Tradier, reconstructs OpenPosition objects,
   * checks for existing OCO legs, and submits new ones if missing.
   *
   * When agentTag is provided (basket mode), only adopts positions whose
   * entry order was tagged with this agent's ID. This prevents multiple
   * basket agents on the same account from adopting each other's positions.
   *
   * Returns count of reconciled positions.
   */
  async reconcileFromBroker(execCfg?: Config['execution'], agentTag?: string): Promise<number> {
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

    // 2. Fetch ALL orders (pending + today's filled) to find OCO legs and ownership tags
    let allOrders: any[] = [];
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${accountId}/orders`,
        { headers: hdrs, timeout: 10000 },
      );
      const rawOrders = data?.orders?.order;
      allOrders = Array.isArray(rawOrders) ? rawOrders : rawOrders ? [rawOrders] : [];
    } catch (e: any) {
      console.warn(`[reconcile] Failed to fetch orders [${accountId}]: ${e.message}`);
      // Continue without order info — we'll submit new OCO legs
    }

    const pendingOrders = allOrders.filter((o: any) => o.status === 'pending' || o.status === 'open');

    // 3. Build a set of option symbols owned by this agent from order tags.
    //    An order "owns" a symbol if it's a buy_to_open with our tag.
    //    Also check OTOCO legs — the tag is on the parent, buy_to_open is leg[0].
    //
    //    Transition handling: untagged orders are legacy (placed before tagging).
    //    Non-basket agents (agentTag without ':') adopt untagged positions as their own.
    //    Basket members (agentTag with ':') NEVER adopt untagged positions.
    const ownedSymbols = new Set<string>();
    // If ANY order on the account has a tag, we're in multi-agent mode.
    // Untagged orders are only adopted when NO tagged orders exist (pre-tagging legacy).
    const hasAnyTaggedOrders = allOrders.some((o: any) => o.tag);

    for (const order of allOrders) {
      const tag = order.tag as string | undefined;

      // Determine if this order belongs to us
      const isTaggedOurs = tag === agentTag;
      // Legacy untagged orders: adopt only if no tagged orders exist on account.
      // Basket members NEVER adopt untagged positions —
      // they must only manage positions they explicitly opened.
      // Basket members: any agent with an explicit AGENT_TAG env var.
      // These agents NEVER adopt untagged legacy positions — only their own tagged orders.
      const isBasketMember = !!process.env.AGENT_TAG;
      const isLegacyOurs = !tag && !hasAnyTaggedOrders && !isBasketMember;

      if (!isTaggedOurs && !isLegacyOurs) continue;

      // Simple order: buy_to_open on option_symbol
      if (order.side === 'buy_to_open' && order.option_symbol) {
        ownedSymbols.add(order.option_symbol);
      }

      // OTOCO/OCO: check legs for buy_to_open
      const legs = Array.isArray(order.leg) ? order.leg : order.leg ? [order.leg] : [];
      for (const leg of legs) {
        if (leg.side === 'buy_to_open' && leg.option_symbol) {
          ownedSymbols.add(leg.option_symbol);
        }
      }
    }
    if (agentTag) {
      console.log(`[reconcile] Agent tag="${agentTag}" owns symbols: [${[...ownedSymbols].join(', ')}]`);
    }

    let reconciled = 0;

    for (const pos of positions) {
      const symbol: string = pos.symbol;
      const quantity = Math.abs(pos.quantity);
      const costBasis = Math.abs(pos.cost_basis);
      const entryPrice = costBasis / (quantity * 100);

      // Skip positions not owned by this agent (multi-agent mode).
      // When agentTag is set, only adopt positions we tagged via orders.
      // When no agentTag and no tagged orders exist, adopt everything (legacy/test mode).
      if (agentTag && ownedSymbols.size > 0 && !ownedSymbols.has(symbol)) {
        console.log(`[reconcile] Skipping ${symbol} — not tagged for "${agentTag}"`);
        continue;
      }
      if (agentTag && hasAnyTaggedOrders && ownedSymbols.size === 0) {
        // Multi-agent account but none of our orders match — skip all
        console.log(`[reconcile] Skipping ${symbol} — agent "${agentTag}" has no orders on this account`);
        continue;
      }

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

      // Look for existing OCO legs for this symbol. Prefer broker-side TP/SL
      // (these were what the agent actually submitted at entry time) over
      // recomputing from config — config may have been tuned since then, and
      // recomputing from current config would rewrite the protection levels
      // in a way inconsistent with the broker's live orders.
      let tpLegId: number | undefined;
      let slLegId: number | undefined;
      let bracketOrderId: number | undefined;
      let brokerTp: number | null = null;
      let brokerSl: number | null = null;

      for (const order of pendingOrders) {
        if (order.option_symbol === symbol && order.side === 'sell_to_close') {
          if (order.type === 'limit') {
            tpLegId = order.id;
            bracketOrderId = order.id; // Use any leg to cancel the OCO group
            const p = parseFloat(order.price);
            if (Number.isFinite(p) && p > 0) brokerTp = p;
          } else if (order.type === 'stop') {
            slLegId = order.id;
            bracketOrderId = order.id;
            const s = parseFloat(order.stop_price ?? order.stop);
            if (Number.isFinite(s) && s > 0) brokerSl = s;
          }
        }
      }

      // Prefer broker-side TP/SL; fall back to config-derived values.
      // Tick-round defensively — brokers can accept any price but our own
      // downstream logic expects tick-aligned values.
      const stopLoss = brokerSl != null
        ? roundToOptionTick(brokerSl)
        : roundToOptionTick(entryPrice * (1 - this.cfg.position.stopLossPercent / 100));
      const takeProfit = brokerTp != null
        ? roundToOptionTick(brokerTp)
        : roundToOptionTick(entryPrice * this.cfg.position.takeProfitMultiplier);
      if (brokerTp != null || brokerSl != null) {
        console.log(`[reconcile] Using broker TP/SL for ${symbol}: TP=${brokerTp != null ? '$' + brokerTp.toFixed(2) : '(recomputed)'} SL=${brokerSl != null ? '$' + brokerSl.toFixed(2) : '(recomputed)'}`);
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
   *
   * Retries with exponential backoff (500ms → 2000ms → 5000ms) to survive
   * transient broker errors. After all attempts fail, logs a CRITICAL alert
   * so the position is surfaced as unprotected — the agent's reconciliation
   * loop will retry on the next pass.
   */
  private async submitStandaloneOco(
    pos: OpenPosition,
    accountId: string,
    execCfg?: Config['execution'],
  ): Promise<boolean> {
    const rootSymbol = execCfg?.symbol || 'SPX';
    const hdrs = {
      Authorization: `Bearer ${appConfig.tradierToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    const tp = pos.takeProfit ?? pos.entryPrice * this.cfg.position.takeProfitMultiplier;
    const sl = pos.stopLoss;
    const tpRounded = roundToOptionTick(tp);
    const slRounded = roundToOptionTick(sl);

    const body = [
      'class=oco',
      'duration=day',
      `symbol=${rootSymbol}`,
      // Leg 0: TP limit — round to valid option tick (Tradier rejects off-tick)
      `type[0]=limit`,
      `option_symbol[0]=${pos.symbol}`,
      `side[0]=sell_to_close`,
      `quantity[0]=${pos.quantity}`,
      `price[0]=${tpRounded.toFixed(2)}`,
      // Leg 1: SL stop — round to valid option tick
      `type[1]=stop`,
      `option_symbol[1]=${pos.symbol}`,
      `side[1]=sell_to_close`,
      `quantity[1]=${pos.quantity}`,
      `stop[1]=${slRounded.toFixed(2)}`,
    ].join('&');

    const backoffs = [500, 2000, 5000];
    let lastErr: string | undefined;
    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      try {
        const { data } = await axios.post(
          `${TRADIER_BASE}/accounts/${accountId}/orders`,
          body,
          { headers: hdrs, timeout: 10000 },
        );
        const orderId = data?.order?.id;
        if (!orderId) {
          throw new Error(`Tradier accepted OCO but returned no order id: ${JSON.stringify(data)}`);
        }
        pos.bracketOrderId = orderId;
        const label = attempt === 0 ? '' : ` (attempt ${attempt + 1})`;
        console.log(`[reconcile] Submitted OCO protection for ${pos.symbol}: TP=$${tpRounded.toFixed(2)} SL=$${slRounded.toFixed(2)} — order #${orderId}${label}`);
        return true;
      } catch (e: any) {
        lastErr = e?.response?.data?.errors?.error || e.message;
        console.warn(`[reconcile] OCO attempt ${attempt + 1}/${backoffs.length} failed for ${pos.symbol}: ${lastErr}`);
        if (attempt < backoffs.length - 1) {
          await new Promise(r => setTimeout(r, backoffs[attempt]));
        }
      }
    }

    console.error(`[reconcile] 🚨 CRITICAL: Failed to submit OCO for ${pos.symbol} after ${backoffs.length} attempts: ${lastErr}. Position is UNPROTECTED at broker.`);
    return false;
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
