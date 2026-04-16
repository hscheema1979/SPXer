/**
 * RiskGuard — stateful wrapper around core risk-guard logic.
 *
 * Maintains daily loss state and position tracking.
 * Delegates core risk evaluation to src/core/risk-guard.isRiskBlocked()
 * so that live agent and replay use the same risk rules.
 */
import type { Config } from '../config/types';
import { isRiskBlocked, type RiskState } from '../core/risk-guard';
import { etTimeToUnixTs, nowET, todayET } from '../utils/et-time';

export class RiskGuard {
  private dailyLoss = 0;
  private dailyDate = '';
  private lastEscalationTs = 0;
  private tradesCompleted = 0;
  private paperMode: boolean;

  constructor(private cfg: Config) {
    this.paperMode = process.env.AGENT_PAPER !== 'false';
  }

  resetIfNewDay(): void {
    const today = todayET();
    if (this.dailyDate !== today) {
      this.dailyLoss = 0;
      this.tradesCompleted = 0;
      this.dailyDate = today;
    }
  }

  recordLoss(amount: number): void {
    this.dailyLoss += amount;
  }

  recordTrade(): void {
    this.tradesCompleted++;
  }

  recordEscalation(): void {
    this.lastEscalationTs = Math.floor(Date.now() / 1000);
  }

  minutesToMarketClose(): number {
    const { h, m } = nowET();
    return Math.max(0, 16 * 60 - (h * 60 + m));
  }

  /**
   * Check whether trading is blocked by any risk rule.
   * Delegates to core isRiskBlocked() for consistent behavior with replay.
   */
  check(
    openPositions: { id: string }[],
    minutesToClose: number,
  ): { allowed: boolean; reason?: string } {
    this.resetIfNewDay();

    // Build core RiskState from internal state
    const closeCutoffTs = this.computeCloseCutoffTs();
    const state: RiskState = {
      openPositions: openPositions.length,
      tradesCompleted: this.tradesCompleted,
      dailyPnl: this.dailyLoss,
      currentTs: Math.floor(Date.now() / 1000),
      closeCutoffTs,
      lastEscalationTs: this.lastEscalationTs,
    };

    const result = isRiskBlocked(state, this.cfg);
    if (result.blocked) {
      return { allowed: false, reason: result.reason };
    }

    // Live-agent specific: minutes-to-close check (not in core — replay uses bar timestamps)
    if (minutesToClose < this.cfg.risk.minMinutesToClose) {
      return { allowed: false, reason: `Only ${minutesToClose}m until close (min: ${this.cfg.risk.minMinutesToClose}m)` };
    }

    // Live-agent specific: cutoff time check (core uses closeCutoffTs)
    const [cutH, cutM] = this.cfg.risk.cutoffTimeET.split(':').map(Number);
    const et = nowET();
    if (et.h * 60 + et.m >= cutH * 60 + cutM) {
      return { allowed: false, reason: `Past cutoff time ${this.cfg.risk.cutoffTimeET} ET` };
    }

    return { allowed: true };
  }

  /** Maximum contracts given stop distance and max risk */
  maxContracts(entryPrice: number, stopLoss: number): number {
    const riskPerContract = (entryPrice - stopLoss) * 100;
    if (riskPerContract <= 0) return 0;
    return Math.max(1, Math.floor(this.cfg.risk.maxRiskPerTrade / riskPerContract));
  }

  private computeCloseCutoffTs(): number {
    return etTimeToUnixTs('16:00');
  }

  /**
   * Override daily state from broker data (called on startup to sync with reality).
   * This ensures the risk guard reflects actual broker P&L, not just what the agent tracked.
   */
  syncFromBroker(pnl: number, trades: number): void {
    this.dailyLoss = pnl;
    this.tradesCompleted = trades;
    this.dailyDate = todayET();
  }

  get isPaper(): boolean { return this.paperMode; }
  get currentDailyLoss(): number { return this.dailyLoss; }
  get config(): Config { return this.cfg; }
}
