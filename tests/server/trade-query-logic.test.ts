import { describe, it, expect } from 'vitest';
import {
  etToMs,
  filterTradesByWindow,
  filterTradesByStrike,
  computeScaleFactor,
  getPnl,
  applySizingFilter,
  bucketTradesIntoChunks,
  aggregateChunkMetrics,
  chunkLabel,
  detectKillZones,
  findBestConfigsPerChunk,
  SESSION_START_MS,
  SESSION_END_MS,
  MIN_TRADES_THRESHOLD,
  MIN_CONFIGS_FOR_KILL_ZONE,
  type TradeLike,
  type ConfigChunkData,
} from '../../src/server/trade-query-helpers';

const trade = (overrides: Partial<TradeLike> & { entryET: string }): TradeLike => ({
  strike: 5900,
  qty: 5,
  entryPrice: 3.5,
  pnlPct: 10,
  'pnl$': 175,
  ...overrides,
});

describe('trade-query-helpers', () => {
  describe('etToMs', () => {
    it('converts HH:MM to ms from midnight', () => {
      expect(etToMs('09:30')).toBe((9 * 60 + 30) * 60 * 1000);
      expect(etToMs('16:00')).toBe(16 * 60 * 60 * 1000);
      expect(etToMs('00:00')).toBe(0);
    });

    it('returns 0 for unparseable inputs', () => {
      expect(etToMs('')).toBe(0);
      expect(etToMs('abc')).toBe(0);
    });
  });

  describe('filterTradesByWindow', () => {
    it('returns all trades when no window specified', () => {
      const trades = [trade({ entryET: '09:45' }), trade({ entryET: '14:30' })];
      expect(filterTradesByWindow(trades)).toHaveLength(2);
    });

    it('filters to activeStart..activeEnd range', () => {
      const trades = [
        trade({ entryET: '09:45' }),
        trade({ entryET: '10:30' }),
        trade({ entryET: '14:00' }),
      ];
      const filtered = filterTradesByWindow(trades, '10:00', '12:00');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].entryET).toBe('10:30');
    });

    it('keeps trades without entryET', () => {
      const trades = [trade({ entryET: '10:00' }), { strike: 5900, qty: 1, entryPrice: 1 }];
      const filtered = filterTradesByWindow(trades, '09:00', '12:00');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('filterTradesByStrike', () => {
    it('applies min and max filters', () => {
      const trades = [
        trade({ entryET: '10:00', strike: 5800 }),
        trade({ entryET: '10:00', strike: 5900 }),
        trade({ entryET: '10:00', strike: 6000 }),
      ];
      expect(filterTradesByStrike(trades, 5850, 5950)).toHaveLength(1);
    });

    it('returns all when no bounds specified', () => {
      const trades = [trade({ entryET: '10:00' })];
      expect(filterTradesByStrike(trades)).toHaveLength(1);
    });
  });

  describe('computeScaleFactor', () => {
    it('returns 1.0 when no constraints', () => {
      expect(computeScaleFactor(trade({ entryET: '10:00' }))).toBe(1.0);
    });

    it('scales by maxContracts', () => {
      const t = trade({ entryET: '10:00', qty: 10 });
      expect(computeScaleFactor(t, 5)).toBe(0.5);
    });

    it('scales by maxDollarsPerTrade', () => {
      const t = trade({ entryET: '10:00', qty: 10, entryPrice: 5.0 });
      // exposure = 5.0 * 10 * 100 = 5000, maxDollars = 2500 → factor = 0.5
      expect(computeScaleFactor(t, undefined, 2500)).toBe(0.5);
    });

    it('uses the tighter of both constraints', () => {
      const t = trade({ entryET: '10:00', qty: 10, entryPrice: 5.0 });
      // contracts: 5/10 = 0.5, dollars: 10000/5000 = 2.0 → min = 0.5
      expect(computeScaleFactor(t, 5, 10000)).toBe(0.5);
    });

    it('handles qty = 0 gracefully', () => {
      const t = trade({ entryET: '10:00', qty: 0, entryPrice: 5.0 });
      expect(computeScaleFactor(t, 5, 1000)).toBe(1.0);
    });
  });

  describe('getPnl', () => {
    it('reads pnl$ from quoted key', () => {
      expect(getPnl({ strike: 0, qty: 0, entryPrice: 0, 'pnl$': 100 })).toBe(100);
    });

    it('reads pnl$ from unquoted key', () => {
      expect(getPnl({ strike: 0, qty: 0, entryPrice: 0, pnl$: 200 })).toBe(200);
    });

    it('defaults to 0', () => {
      expect(getPnl({ strike: 0, qty: 0, entryPrice: 0 })).toBe(0);
    });
  });

  describe('applySizingFilter', () => {
    it('returns all trades with no constraints', () => {
      const trades = [trade({ entryET: '10:00', qty: 20 })];
      const result = applySizingFilter(trades, 'skip');
      expect(result.trades).toHaveLength(1);
      expect(result.totalPnl).toBe(175);
    });

    it('skip mode removes oversized trades', () => {
      const trades = [
        trade({ entryET: '10:00', qty: 3, 'pnl$': 100 }),
        trade({ entryET: '10:00', qty: 10, 'pnl$': 500 }),
      ];
      const result = applySizingFilter(trades, 'skip', 5);
      expect(result.trades).toHaveLength(1);
      expect(result.totalPnl).toBe(100);
    });

    it('scale mode keeps all but reduces pnl', () => {
      const trades = [
        trade({ entryET: '10:00', qty: 10, entryPrice: 5.0, 'pnl$': 500 }),
      ];
      const result = applySizingFilter(trades, 'scale', 5);
      expect(result.trades).toHaveLength(1);
      // scaleFactor = 5/10 = 0.5, pnl = 500 * 0.5 = 250
      expect(result.totalPnl).toBe(250);
    });
  });

  describe('bucketTradesIntoChunks', () => {
    it('buckets into 30-min windows', () => {
      const trades = [
        trade({ entryET: '09:45' }),
        trade({ entryET: '10:15' }),
        trade({ entryET: '11:00' }),
      ];
      const buckets = bucketTradesIntoChunks(trades, 30);
      expect(buckets.get('09:30-10:00')).toHaveLength(1);
      expect(buckets.get('10:00-10:30')).toHaveLength(1);
      expect(buckets.get('11:00-11:30')).toHaveLength(1);
    });

    it('buckets into 60-min windows', () => {
      const trades = [
        trade({ entryET: '09:45' }),
        trade({ entryET: '11:00' }),
      ];
      const buckets = bucketTradesIntoChunks(trades, 60);
      expect(buckets.get('09:30-10:30')).toHaveLength(1);
      expect(buckets.get('10:30-11:30')).toHaveLength(1);
    });

    it('skips trades before session start or after session end', () => {
      const trades = [
        trade({ entryET: '08:00' }),
        trade({ entryET: '17:00' }),
      ];
      const buckets = bucketTradesIntoChunks(trades, 30);
      expect(buckets.size).toBe(0);
    });
  });

  describe('aggregateChunkMetrics', () => {
    it('computes metrics from trades', () => {
      const trades = [
        trade({ entryET: '10:00', 'pnl$': 100, pnlPct: 10 }),
        trade({ entryET: '10:00', 'pnl$': -50, pnlPct: -5 }),
      ];
      const m = aggregateChunkMetrics(trades);
      expect(m.totalTrades).toBe(2);
      expect(m.wins).toBe(1);
      expect(m.winRate).toBe(0.5);
      expect(m.totalPnl).toBe(50);
      expect(m.avgPnlPerTrade).toBe(25);
    });

    it('uses __scaledPnl when present', () => {
      const trades = [
        { ...trade({ entryET: '10:00', 'pnl$': 500 }), __scaledPnl: 250 },
      ];
      const m = aggregateChunkMetrics(trades);
      expect(m.totalPnl).toBe(250);
    });

    it('handles empty array', () => {
      const m = aggregateChunkMetrics([]);
      expect(m.totalTrades).toBe(0);
      expect(m.winRate).toBe(0);
    });
  });

  describe('chunkLabel', () => {
    it('formats morning times with AM', () => {
      expect(chunkLabel('09:30-10:00')).toBe('9:30 AM');
    });

    it('formats afternoon times with PM', () => {
      expect(chunkLabel('13:00-13:30')).toBe('1:00 PM');
    });

    it('formats noon correctly', () => {
      expect(chunkLabel('12:00-12:30')).toBe('12:00 PM');
    });
  });

  describe('detectKillZones', () => {
    it('flags chunks where all configs are negative', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '12:00-12:30', avgPnlPerDay: -5, winRate: 0.3, tradeCount: 10 },
        { configId: 'b', name: 'B', chunk: '12:00-12:30', avgPnlPerDay: -3, winRate: 0.2, tradeCount: 8 },
        { configId: 'c', name: 'C', chunk: '12:00-12:30', avgPnlPerDay: -1, winRate: 0.4, tradeCount: 6 },
      ];
      expect(detectKillZones(data)).toEqual(['12:00-12:30']);
    });

    it('does NOT flag chunks with mixed results', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '10:00-10:30', avgPnlPerDay: 5, winRate: 0.6, tradeCount: 10 },
        { configId: 'b', name: 'B', chunk: '10:00-10:30', avgPnlPerDay: -2, winRate: 0.4, tradeCount: 8 },
        { configId: 'c', name: 'C', chunk: '10:00-10:30', avgPnlPerDay: 3, winRate: 0.55, tradeCount: 6 },
      ];
      expect(detectKillZones(data)).toEqual([]);
    });

    it('respects minimum configs threshold', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '12:00-12:30', avgPnlPerDay: -5, winRate: 0.3, tradeCount: 10 },
      ];
      expect(detectKillZones(data)).toEqual([]);
    });

    it('respects minimum trades threshold', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '12:00-12:30', avgPnlPerDay: -5, winRate: 0.3, tradeCount: 2 },
        { configId: 'b', name: 'B', chunk: '12:00-12:30', avgPnlPerDay: -3, winRate: 0.2, tradeCount: 1 },
        { configId: 'c', name: 'C', chunk: '12:00-12:30', avgPnlPerDay: -1, winRate: 0.4, tradeCount: 3 },
      ];
      expect(detectKillZones(data)).toEqual([]);
    });
  });

  describe('findBestConfigsPerChunk', () => {
    it('ranks top N configs per chunk', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '10:00-10:30', avgPnlPerDay: 3, winRate: 0.5, tradeCount: 10 },
        { configId: 'b', name: 'B', chunk: '10:00-10:30', avgPnlPerDay: 5, winRate: 0.6, tradeCount: 10 },
        { configId: 'c', name: 'C', chunk: '10:00-10:30', avgPnlPerDay: 1, winRate: 0.4, tradeCount: 10 },
      ];
      const best = findBestConfigsPerChunk(data, 2);
      expect(best).toHaveLength(2);
      expect(best[0].configId).toBe('b');
      expect(best[1].configId).toBe('a');
    });

    it('filters out configs below min trades threshold', () => {
      const data: ConfigChunkData[] = [
        { configId: 'a', name: 'A', chunk: '10:00-10:30', avgPnlPerDay: 10, winRate: 0.9, tradeCount: 2 },
        { configId: 'b', name: 'B', chunk: '10:00-10:30', avgPnlPerDay: 2, winRate: 0.5, tradeCount: 20 },
      ];
      const best = findBestConfigsPerChunk(data, 3, 5);
      expect(best).toHaveLength(1);
      expect(best[0].configId).toBe('b');
    });
  });
});
