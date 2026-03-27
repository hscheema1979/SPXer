/**
 * PositionManager: tracks open positions and monitors them for exit conditions.
 *
 * Exit logic delegates to src/core/position-manager.checkExit() so that
 * live agent and replay evaluate the same exit conditions.
 */
import axios from 'axios';
import type { OpenPosition, PositionClose } from './types';
import type { Config } from '../config/types';
import type { Position } from '../core/types';
import { checkExit, type ExitContext } from '../core/position-manager';
import { closePosition } from './trade-executor';
import { logClose } from './audit-log';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';

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

  /** Fetch current prices for all open positions and check exit conditions */
  async monitor(dailyLossCallback: (loss: number) => void): Promise<void> {
    if (this.positions.size === 0) return;

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
        hmaCrossDirection: null,  // TODO: pass live HMA cross state when available
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

        await closePosition(pos, exitCheck.reason, currentPrice, this.paper);
        logClose(closeRecord);
        dailyLossCallback(pnl);
        this.positions.delete(id);
      }
    }
  }

  private computeCloseCutoffTs(): number {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const datePart = etStr.split(', ')[0];
    const closeET = new Date(`${datePart} 16:00:00`);
    return Math.floor(closeET.getTime() / 1000);
  }
}
