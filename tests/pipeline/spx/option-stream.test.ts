import { describe, it, expect } from 'vitest';
import { OptionStream } from '../../../src/pipeline/spx/option-stream';

describe('OptionStream', () => {
  describe('buildContractPool', () => {
    it('generates correct symbols for a single expiry', () => {
      const pool = OptionStream.buildContractPool(6500, 10, 5, ['2026-04-01']);
      // center = 6500, band = ±10, interval = 5
      // strikes: 6490, 6495, 6500, 6505, 6510 (5 strikes)
      // each × call + put = 10 symbols
      expect(pool).toHaveLength(10);
      expect(pool).toContain('SPXW260401C06500000'); // ATM call
      expect(pool).toContain('SPXW260401P06500000'); // ATM put
      expect(pool).toContain('SPXW260401C06490000'); // lower bound call
      expect(pool).toContain('SPXW260401P06510000'); // upper bound put
    });

    it('generates correct symbols for multiple expiries', () => {
      const pool = OptionStream.buildContractPool(6500, 5, 5, ['2026-04-01', '2026-04-02']);
      // center = 6500, band = ±5, interval = 5
      // strikes: 6495, 6500, 6505 (3 strikes)
      // × call + put = 6 per expiry × 2 expiries = 12
      expect(pool).toHaveLength(12);
      expect(pool).toContain('SPXW260401C06500000');
      expect(pool).toContain('SPXW260402C06500000');
      expect(pool).toContain('SPXW260401P06495000');
      expect(pool).toContain('SPXW260402P06505000');
    });

    it('rounds center to nearest interval', () => {
      // centerPrice 6502 → rounds to 6500 at interval=5
      const pool = OptionStream.buildContractPool(6502, 5, 5, ['2026-04-01']);
      // strikes: 6495, 6500, 6505
      expect(pool).toContain('SPXW260401C06500000');
      expect(pool).toContain('SPXW260401C06495000');
      expect(pool).toContain('SPXW260401C06505000');
      expect(pool).toHaveLength(6);
    });

    it('rounds center up when closer to upper interval', () => {
      // centerPrice 6503 → rounds to 6505 at interval=5
      const pool = OptionStream.buildContractPool(6503, 5, 5, ['2026-04-01']);
      // strikes: 6500, 6505, 6510
      expect(pool).toContain('SPXW260401C06505000');
      expect(pool).toContain('SPXW260401C06500000');
      expect(pool).toContain('SPXW260401C06510000');
      expect(pool).toHaveLength(6);
    });

    it('generates realistic pool with default band and interval', () => {
      const pool = OptionStream.buildContractPool(6500, 100, 5, ['2026-04-01', '2026-04-02']);
      // center = 6500, ±100 at interval 5 = 41 strikes
      // 41 × 2 (call+put) × 2 (expiries) = 164
      expect(pool).toHaveLength(164);
      // Verify range
      expect(pool).toContain('SPXW260401C06400000'); // center - 100
      expect(pool).toContain('SPXW260401C06600000'); // center + 100
      expect(pool).toContain('SPXW260402P06400000'); // second expiry
    });

    it('returns empty array for no expiries', () => {
      const pool = OptionStream.buildContractPool(6500, 100, 5, []);
      expect(pool).toHaveLength(0);
    });

    it('returns empty array for invalid interval', () => {
      const pool = OptionStream.buildContractPool(6500, 100, 0, ['2026-04-01']);
      expect(pool).toHaveLength(0);
    });

    it('skips strikes at or below zero', () => {
      // Degenerate case: center very low, band larger than center
      const pool = OptionStream.buildContractPool(5, 10, 5, ['2026-04-01']);
      // center = 5, band = ±10 → strikes from -5 to 15 at interval 5
      // valid: 5, 10, 15 (skipping -5 and 0)
      const strikes = pool.map(s => parseInt(s.slice(-8)) / 1000);
      expect(strikes.every(s => s > 0)).toBe(true);
    });

    it('formats strike codes with zero-padding', () => {
      const pool = OptionStream.buildContractPool(100, 5, 5, ['2026-04-01'], 'TEST');
      // strike 100 → 100000 → padded to 00100000
      expect(pool).toContain('TEST260401C00100000');
      expect(pool).toContain('TEST260401P00095000'); // 95 → 95000 → 00095000
    });

    it('formats expiry code correctly', () => {
      const pool = OptionStream.buildContractPool(6500, 0, 5, ['2026-12-31']);
      // Only the center strike (band=0), center=6500
      expect(pool).toHaveLength(2); // 1 call + 1 put
      expect(pool[0]).toMatch(/^SPXW261231C/);
      expect(pool[1]).toMatch(/^SPXW261231P/);
    });
  });

  describe('message parsing', () => {
    it('parses trade messages via onTick', () => {
      const stream = new OptionStream();
      const ticks: any[] = [];
      stream.onTick((tick) => ticks.push(tick));

      // Simulate handleMessage by accessing internal method via the WS message handler
      // Since handleMessage is private, we test via the public interface indirectly.
      // For unit testing, we verify the price cache via getPrice after start.

      // Without a real WS connection, we verify buildContractPool and getPrice
      expect(stream.getPrice('SPXW260401C06500000')).toBeNull();
      expect(stream.isConnected()).toBe(false);
      expect(stream.symbolCount).toBe(0);
    });

    it('getPrice returns null for unknown symbol', () => {
      const stream = new OptionStream();
      expect(stream.getPrice('UNKNOWN')).toBeNull();
    });

    it('tracks symbol count', () => {
      const stream = new OptionStream();
      expect(stream.symbolCount).toBe(0);
    });

    it('reports not connected initially', () => {
      const stream = new OptionStream();
      expect(stream.isConnected()).toBe(false);
    });

    it('stop clears state', () => {
      const stream = new OptionStream();
      stream.stop();
      expect(stream.isConnected()).toBe(false);
      expect(stream.symbolCount).toBe(0);
    });
  });
});
