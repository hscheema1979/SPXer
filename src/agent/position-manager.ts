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
import type { OpenPosition, PositionClose, BarSummary } from './types';
import type { Config } from '../config/types';
import type { Position, Direction } from '../core/types';
import { checkExit, type ExitContext } from '../core/position-manager';
import { closePosition } from './trade-executor';
import { logClose } from './audit-log';

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
    if (spxBars.length === 0) return;

    const latest = spxBars[spxBars.length - 1];
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

  private computeCloseCutoffTs(): number {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const datePart = etStr.split(', ')[0];
    const closeET = new Date(`${datePart} 16:00:00`);
    return Math.floor(closeET.getTime() / 1000);
  }
}
