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
    // Use Intl to correctly handle EST/EDT automatically
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const timePart = etStr.split(', ')[1];
    const [h, m] = timePart.split(':').map(Number);
    return Math.max(0, 16 * 60 - (h * 60 + m));
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

    // Check cutoff time — use Intl to handle EST/EDT correctly
    const [cutH, cutM] = this.cfg.cutoffTimeET.split(':').map(Number);
    const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    const timePart = etStr.split(', ')[1];
    const [nowH, nowM] = timePart.split(':').map(Number);
    const cutoffMins = cutH * 60 + cutM;
    const nowMins = nowH * 60 + nowM;
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
