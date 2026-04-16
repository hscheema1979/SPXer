/**
 * Schwaber Agent Config — HMA3x17 ETF Trader (Schwab)
 *
 * Trades SPY/QQQ ETFs (and optionally others) via the Schwab API.
 * Uses the same HMA3×17 cross signal as the SPX agent, but executes
 * equity market/limit orders instead of options contracts.
 *
 * Start small — 1 share per trade until the OAuth flow is verified live.
 */

export interface SchwaberConfig {
  // Identity
  id: string;
  name: string;
  paper: boolean;              // true = log only, no real orders

  // Symbols to trade
  symbols: string[];           // e.g. ['SPY', 'QQQ']

  // Signal — HMA periods (same as SPX agent)
  hmaCrossFast: number;        // HMA(3)
  hmaCrossSlow: number;        // HMA(17)

  // Sizing
  sharesPerTrade: number;      // fixed shares per signal (start with 1)
  maxOpenPositions: number;    // max simultaneous positions

  // Exit
  takeProfitPct: number;       // e.g. 0.005 = 0.5%
  stopLossPct: number;         // e.g. 0.003 = 0.3%

  // Time windows (ET)
  activeStart: string;         // '09:45' — skip first 15 min
  activeEnd: string;           // '15:45'

  // Risk
  maxDailyLoss: number;        // stop trading for the day if exceeded

  // Data source — poll SPX bars from SPXer data service
  spxerBaseUrl: string;        // 'http://localhost:3600'
  pollIntervalSec: number;     // how often to check for new bars
}

export const SCHWABER_CONFIG: SchwaberConfig = {
  id: 'schwaber-hma3x17-etf-v1',
  name: 'Schwaber HMA3x17 ETF',
  paper: true,                 // ← flip to false when ready for live

  symbols: ['SPY', 'QQQ'],

  hmaCrossFast: 3,
  hmaCrossSlow: 17,

  sharesPerTrade: 1,           // start with 1 share — scale up once confident
  maxOpenPositions: 2,         // one per symbol

  takeProfitPct: 0.005,        // 0.5% TP
  stopLossPct: 0.003,          // 0.3% SL

  activeStart: '09:45',
  activeEnd: '15:45',

  maxDailyLoss: 500,

  spxerBaseUrl: process.env.SPXER_BASE_URL || 'http://localhost:3600',
  pollIntervalSec: 30,
};
