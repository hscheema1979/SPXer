/**
 * PositionManager: tracks open positions and monitors them for
 * stop-loss / take-profit / time-exit conditions every ~30s.
 */
import axios from 'axios';
import type { OpenPosition, PositionClose } from './types';
import { closePosition } from './trade-executor';
import { logClose } from './audit-log';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

export class PositionManager {
  private positions: Map<string, OpenPosition> = new Map();
  private paper: boolean;

  constructor(paper: boolean) {
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

  /** Fetch current prices for all open positions and check exit conditions */
  async monitor(dailyLossCallback: (loss: number) => void): Promise<void> {
    if (this.positions.size === 0) return;

    const symbols = Array.from(this.positions.keys()).map(id => this.positions.get(id)!.symbol);

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
    const minutesToClose = this.minutesToClose();

    for (const [id, pos] of this.positions) {
      const currentPrice = priceMap.get(pos.symbol);
      if (currentPrice === undefined) continue;

      let reason: PositionClose['reason'] | null = null;

      // Stop loss
      if (currentPrice <= pos.stopLoss) {
        reason = 'stop_loss';
      }
      // Take profit
      else if (pos.takeProfit && currentPrice >= pos.takeProfit) {
        reason = 'take_profit';
      }
      // Time exit: close 15 minutes before market close to avoid expiry whipsaw
      else if (minutesToClose <= 15) {
        reason = 'time_exit';
      }

      if (reason) {
        const pnl = (currentPrice - pos.entryPrice) * pos.quantity * 100;
        const closeRecord: PositionClose = {
          position: pos,
          closePrice: currentPrice,
          reason,
          pnl,
          closedAt: now,
        };

        await closePosition(pos, reason, currentPrice, this.paper);
        logClose(closeRecord);
        dailyLossCallback(pnl);  // pnl negative = loss
        this.positions.delete(id);
      }
    }
  }

  private minutesToClose(): number {
    // Use Intl to correctly handle EST/EDT automatically
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const timePart = etStr.split(', ')[1];
    const [h, m] = timePart.split(':').map(Number);
    const minsNow = h * 60 + m;
    return Math.max(0, 16 * 60 - minsNow);
  }
}
