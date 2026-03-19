import type { OpenPosition } from './types';

export interface RiskConfig {
  maxDailyLoss: number;       // dollars — circuit breaker
  maxPositions: number;       // concurrent open positions
  maxRiskPerTrade: number;    // dollars at risk per trade
  cutoffTimeET: string;       // 'HH:MM' — no new entries after this (ET)
  minMinutesToClose: number;  // skip signals with fewer than this many minutes until 4 PM
  paperMode: boolean;
}

export function defaultRiskConfig(): RiskConfig {
  return {
    maxDailyLoss: parseFloat(process.env.AGENT_MAX_DAILY_LOSS || '2000'),
    maxPositions: parseInt(process.env.AGENT_MAX_POSITIONS || '2'),
    maxRiskPerTrade: parseFloat(process.env.AGENT_MAX_RISK_PER_TRADE || '500'),
    cutoffTimeET: process.env.AGENT_CUTOFF_ET || '15:45',
    minMinutesToClose: parseInt(process.env.AGENT_MIN_MINS_TO_CLOSE || '15'),
    paperMode: process.env.AGENT_PAPER !== 'false',  // paper by default
  };
}

export class RiskGuard {
  private dailyLoss = 0;
  private dailyDate = '';

  constructor(private cfg: RiskConfig) {}

  resetIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.dailyDate !== today) {
      this.dailyLoss = 0;
      this.dailyDate = today;
    }
  }

  recordLoss(amount: number): void {
    this.dailyLoss += amount;  // pass negative number for a loss
  }

  minutesToMarketClose(): number {
    // Convert now to ET (UTC-5 standard, UTC-4 DST — use fixed -5 for simplicity)
    const nowUTC = Date.now();
    const etOffset = 5 * 60 * 60 * 1000;
    const nowET = new Date(nowUTC - etOffset);
    const closeET = new Date(nowET);
    closeET.setUTCHours(16, 0, 0, 0);
    return Math.max(0, Math.floor((closeET.getTime() - nowET.getTime()) / 60000));
  }

  check(
    openPositions: OpenPosition[],
    minutesToClose: number,
  ): { allowed: boolean; reason?: string } {
    this.resetIfNewDay();

    if (this.dailyLoss <= -this.cfg.maxDailyLoss) {
      return { allowed: false, reason: `Daily loss limit reached ($${Math.abs(this.dailyLoss).toFixed(2)})` };
    }

    if (openPositions.length >= this.cfg.maxPositions) {
      return { allowed: false, reason: `Max positions (${this.cfg.maxPositions}) already open` };
    }

    if (minutesToClose < this.cfg.minMinutesToClose) {
      return { allowed: false, reason: `Only ${minutesToClose}m until close (min: ${this.cfg.minMinutesToClose}m)` };
    }

    // Check cutoff time
    const [cutH, cutM] = this.cfg.cutoffTimeET.split(':').map(Number);
    const nowUTC = new Date();
    const etOffset = 5 * 60; // simplified ET offset in minutes
    const nowET = new Date(nowUTC.getTime() - etOffset * 60000);
    const cutoffMins = cutH * 60 + cutM;
    const nowMins = nowET.getUTCHours() * 60 + nowET.getUTCMinutes();
    if (nowMins >= cutoffMins) {
      return { allowed: false, reason: `Past cutoff time ${this.cfg.cutoffTimeET} ET` };
    }

    return { allowed: true };
  }

  /** Maximum contracts given stop distance and max risk */
  maxContracts(entryPrice: number, stopLoss: number): number {
    const riskPerContract = (entryPrice - stopLoss) * 100; // 1 contract = 100 shares
    if (riskPerContract <= 0) return 0;
    return Math.max(1, Math.floor(this.cfg.maxRiskPerTrade / riskPerContract));
  }

  get isPaper(): boolean { return this.cfg.paperMode; }
  get currentDailyLoss(): number { return this.dailyLoss; }
  get config(): RiskConfig { return this.cfg; }
}
