import * as dotenv from 'dotenv';
dotenv.config();

import { runReplay } from '../src/replay/machine';
import { ReplayStore } from '../src/replay/store';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config/defaults';

const date = process.argv[2] || '2026-03-16';

const config = mergeConfig(DEFAULT_CONFIG, {
  id: `hma-otm25-tp3-${date}`,
  name: `HMA Cross | +/-$25 OTM | TP 3x | ${date}`,
  signals: {
    ...DEFAULT_CONFIG.signals,
    enableRsiCrosses: false,
    enableHmaCrosses: true,
    enablePriceCrossHma: false,
    enableEmaCrosses: false,
    requireUnderlyingHmaCross: true,
    targetOtmDistance: 25,
  },
  position: {
    ...DEFAULT_CONFIG.position,
    stopLossPercent: 0,
    takeProfitMultiplier: 3,
  },
  risk: {
    ...DEFAULT_CONFIG.risk,
    maxTradesPerDay: 20,
  },
  timeWindows: {
    ...DEFAULT_CONFIG.timeWindows,
    activeEnd: '15:15',
  },
  regime: { ...DEFAULT_CONFIG.regime, enabled: false, mode: 'disabled' as const },
  scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
  judges: { ...DEFAULT_CONFIG.judges, enabled: false },
});

async function main() {
  const store = new ReplayStore();
  store.saveConfig(config);
  store.close();

  const result = await runReplay(config, date, { verbose: true, noJudge: true });
  console.log('\nTrades: ' + result.trades + ' | Wins: ' + result.wins + ' | WR: ' + (result.winRate * 100).toFixed(0) + '% | P&L: $' + result.totalPnl.toFixed(0));
}
main().catch(e => { console.error(e); process.exit(1); });
