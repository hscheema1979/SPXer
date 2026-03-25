import * as dotenv from 'dotenv';
dotenv.config();

import { runReplay } from '../src/replay/machine';
import { ReplayStore } from '../src/replay/store';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config/defaults';

const timeframes = ['1m', '3m', '5m'] as const;

async function runForTf(tf: typeof timeframes[number]) {
  const config = mergeConfig(DEFAULT_CONFIG, {
    id: `hma-otm25-tp3-${tf}`,
    name: `HMA Cross | +/-$25 OTM | TP 3x | No SL | ${tf}`,
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
      stopLossPercent: 0,          // disabled — close on signal reversal instead
      takeProfitMultiplier: 3,     // 3x entry
    },
    risk: {
      ...DEFAULT_CONFIG.risk,
      maxTradesPerDay: 20,
    },
    timeWindows: {
      ...DEFAULT_CONFIG.timeWindows,
      activeEnd: '15:15',          // no new entries within 30 min of close
    },
    regime: { ...DEFAULT_CONFIG.regime, enabled: false, mode: 'disabled' as const },
    scanners: { ...DEFAULT_CONFIG.scanners, enabled: false },
    judges: { ...DEFAULT_CONFIG.judges, enabled: false },
    pipeline: { ...DEFAULT_CONFIG.pipeline, timeframe: tf },
  });

  const store = new ReplayStore();
  store.saveConfig(config);
  store.close();

  const result = await runReplay(config, '2026-03-24', { verbose: tf === '1m', noJudge: true });
  return { tf, ...result };
}

async function main() {
  console.log('HMA Cross | +/-$25 OTM | TP 3x | No SL (reversal exit) | 2026-03-24\n');

  for (const tf of timeframes) {
    const r = await runForTf(tf);
    console.log(`${tf.padEnd(3)} | Trades: ${r.trades} | Wins: ${r.wins} | WR: ${(r.winRate * 100).toFixed(0)}% | P&L: $${r.totalPnl.toFixed(0)}`);
    if (tf !== '1m') continue;
    console.log('');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
