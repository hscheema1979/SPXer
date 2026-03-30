/**
 * PositionManager: tracks open positions and monitors them for exit conditions.
 *
 * Exit logic delegates to src/core/position-manager.checkExit() so that
 * live agent and replay evaluate the same exit conditions.
 *
 * Supports scannerReverse: when a position exits via signal_reversal,
 * the close reason is surfaced so the agent loop can flip to opposite side.
 */
import axios from 'axios';
import type { OpenPosition, PositionClose, BarSummary, OptionSide } from './types';
import type { Config } from '../config/types';
import type { Position, Direction } from '../core/types';
import { checkExit, type ExitContext } from '../core/position-manager';
import { closePosition, cancelOcoLegs } from './trade-executor';
import { logClose } from './audit-log';
import { etTimeToUnixTs } from '../utils/et-time';
import { config as appConfig, TRADIER_BASE } from '../config';
import { randomUUID } from 'crypto';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

export interface PositionCloseEvent {
  position: OpenPosition;
  closePrice: number;
  reason: string;
  pnl: number;
}

export class PositionManager {
  private positions: Map<string, OpenPosition> = new Map();
  private highWaterPrices: Map<string, number> = new Map();
  private paper: boolean;
  private cfg: Config;
  private hmaCrossDirection: Direction | null = null;

  // Tracks previous HMA values for cross detection
  private prevHmaFast: number | null = null;
  private prevHmaSlow: number | null = null;

  constructor(config: Config, paper: boolean) {
    this.cfg = config;
    this.paper = paper;
  }

  add(position: OpenPosition): void {
    this.positions.set(position.id, position);
    this.highWaterPrices.set(position.id, position.entryPrice);
    console.log(`[positions] Opened ${position.symbol} x${position.quantity} @ $${position.entryPrice.toFixed(2)} | stop: $${position.stopLoss.toFixed(2)}`);
  }

  getAll(): OpenPosition[] {
    return Array.from(this.positions.values());
  }

  count(): number {
    return this.positions.size;
  }

  /** Get the current HMA cross direction (for agent.ts to use in entry decisions) */
  getHmaCrossDirection(): Direction | null {
    return this.hmaCrossDirection;
  }

  /**
   * Update HMA cross state from SPX bars.
   * Called each cycle by the agent loop with fresh SPX bar data.
   * Uses the configured hmaCrossFast/hmaCrossSlow periods.
   */
  updateHmaCross(spxBars: BarSummary[]): void {
    // Need at least 2 bars: use the second-to-last (last closed candle),
    // since the final bar is the currently forming candle with unstable values
    if (spxBars.length < 2) return;

    const latest = spxBars[spxBars.length - 2];
    const fast = this.cfg.signals.hmaCrossFast;
    const slow = this.cfg.signals.hmaCrossSlow;

    // Pick the right HMA values based on config periods
    const hmaFast = fast === 3 ? latest.hma3 : latest.hma5;
    const hmaSlow = slow === 17 ? latest.hma17 : latest.hma19;

    if (hmaFast == null || hmaSlow == null) return;

    // Detect crossover: compare prev state to current
    if (this.prevHmaFast != null && this.prevHmaSlow != null) {
      const wasFastAbove = this.prevHmaFast > this.prevHmaSlow;
      const isFastAbove = hmaFast > hmaSlow;

      if (!wasFastAbove && isFastAbove) {
        this.hmaCrossDirection = 'bullish';
        console.log(`[hma] 🔼 Bullish cross: HMA(${fast})=${hmaFast.toFixed(2)} > HMA(${slow})=${hmaSlow.toFixed(2)}`);
      } else if (wasFastAbove && !isFastAbove) {
        this.hmaCrossDirection = 'bearish';
        console.log(`[hma] 🔽 Bearish cross: HMA(${fast})=${hmaFast.toFixed(2)} < HMA(${slow})=${hmaSlow.toFixed(2)}`);
      }
      // If no cross, keep existing direction
    } else {
      // First update — set initial direction from current state
      this.hmaCrossDirection = hmaFast > hmaSlow ? 'bullish' : 'bearish';
    }

    this.prevHmaFast = hmaFast;
    this.prevHmaSlow = hmaSlow;
  }

  /**
   * Fetch current prices for all open positions and check exit conditions.
   * Returns array of close events so the agent can handle flip-on-reversal.
   */
  async monitor(dailyLossCallback: (loss: number) => void): Promise<PositionCloseEvent[]> {
    const closeEvents: PositionCloseEvent[] = [];
    if (this.positions.size === 0) return closeEvents;

    // Fetch latest bars from SPXer for current prices
    const priceMap = new Map<string, number>();
    await Promise.allSettled(
      [...this.positions.values()].map(async pos => {
        try {
          const { data } = await axios.get(`${SPXER_BASE}/contracts/${pos.symbol}/latest`, { timeout: 5000 });
          if (data?.close) priceMap.set(pos.symbol, data.close);
        } catch {
          // ignore — keep position open if price unavailable
        }
      })
    );

    const now = Date.now();
    const closeCutoffTs = this.computeCloseCutoffTs();

    for (const [id, pos] of this.positions) {
      const currentPrice = priceMap.get(pos.symbol);
      if (currentPrice === undefined) continue;

      // Update high-water mark
      const prevHigh = this.highWaterPrices.get(id) ?? pos.entryPrice;
      if (currentPrice > prevHigh) {
        this.highWaterPrices.set(id, currentPrice);
      }

      // Map OpenPosition → core Position for checkExit
      const corePosition: Position = {
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        strike: pos.strike,
        qty: pos.quantity,
        entryPrice: pos.entryPrice,
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit ?? pos.entryPrice * this.cfg.position.takeProfitMultiplier,
        entryTs: pos.openedAt,
        entryET: '',
      };

      const context: ExitContext = {
        ts: Math.floor(now / 1000),
        closeCutoffTs,
        hmaCrossDirection: this.hmaCrossDirection,
        highWaterPrice: this.highWaterPrices.get(id),
      };

      const exitCheck = checkExit(corePosition, currentPrice, this.cfg, context);

      if (exitCheck.shouldExit && exitCheck.reason) {
        const pnl = (currentPrice - pos.entryPrice) * pos.quantity * 100;
        const closeRecord: PositionClose = {
          position: pos,
          closePrice: currentPrice,
          reason: exitCheck.reason,
          pnl,
          closedAt: now,
        };

        // Cancel server-side OCO legs before closing (if they exist)
        if (!this.paper) {
          await this.cancelBracketLegs(pos);
        }

        await closePosition(pos, exitCheck.reason, currentPrice, this.paper, this.cfg.execution);
        logClose(closeRecord);
        dailyLossCallback(pnl);
        this.positions.delete(id);
        this.highWaterPrices.delete(id);

        closeEvents.push({
          position: pos,
          closePrice: currentPrice,
          reason: exitCheck.reason,
          pnl,
        });
      }
    }

    return closeEvents;
  }

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
   * Tries each known leg ID. Failures are logged but don't block the close.
   */
  private async cancelBracketLegs(pos: OpenPosition): Promise<void> {
    const legIds = [pos.bracketOrderId, pos.tpLegId, pos.slLegId].filter(Boolean) as number[];
    if (legIds.length === 0) return;

    // Deduplicate — bracketOrderId might equal one of the leg IDs
    const unique = [...new Set(legIds)];
    for (const legId of unique) {
      try {
        await cancelOcoLegs(legId, this.cfg.execution);
      } catch {
        // cancelOcoLegs already logs errors
      }
    }
  }

  private computeCloseCutoffTs(): number {
    return etTimeToUnixTs('16:00');
  }
}
