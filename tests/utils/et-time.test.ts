import { describe, it, expect } from 'vitest';
import { getETOffsetMs, todayET, nowET, etTimeToUnixTs } from '../../src/utils/et-time';

describe('et-time', () => {
  describe('getETOffsetMs', () => {
    it('returns 4h (EDT) or 5h (EST)', () => {
      const offset = getETOffsetMs();
      const offsetHours = Math.round(offset / 3_600_000);
      expect([4, 5]).toContain(offsetHours);
    });

    it('handles a known EDT date (July)', () => {
      const july = new Date('2026-07-15T12:00:00Z');
      const offset = getETOffsetMs(july);
      expect(offset / 3_600_000).toBe(4);
    });

    it('handles a known EST date (January)', () => {
      const jan = new Date('2026-01-15T12:00:00Z');
      const offset = getETOffsetMs(jan);
      expect(offset / 3_600_000).toBe(5);
    });
  });

  describe('todayET', () => {
    it('returns YYYY-MM-DD format', () => {
      const d = todayET();
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('returns correct date for a known timestamp', () => {
      // 2026-03-15 at 03:00 UTC = 2026-03-14 at 23:00 ET (EDT)
      const lateNight = new Date('2026-03-15T03:00:00Z');
      expect(todayET(lateNight)).toBe('2026-03-14');
    });
  });

  describe('nowET', () => {
    it('returns valid h/m/s', () => {
      const { h, m, s } = nowET();
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(23);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(59);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(59);
    });

    it('returns correct ET hour for a known UTC time', () => {
      // 20:00 UTC during EDT = 16:00 ET
      const d = new Date('2026-07-15T20:00:00Z');
      const { h } = nowET(d);
      expect(h).toBe(16);
    });

    it('returns correct ET hour for a known UTC time in EST', () => {
      // 21:00 UTC during EST = 16:00 ET
      const d = new Date('2026-01-15T21:00:00Z');
      const { h } = nowET(d);
      expect(h).toBe(16);
    });
  });

  describe('etTimeToUnixTs', () => {
    it('returns correct UTC timestamp for 16:00 ET', () => {
      const ts = etTimeToUnixTs('16:00');
      const d = new Date(ts * 1000);
      const etHour = Number(
        d.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          hour12: false,
        })
      );
      expect(etHour).toBe(16);
    });

    it('16:00 ET in July = 20:00 UTC', () => {
      const ref = new Date('2026-07-15T12:00:00Z');
      const ts = etTimeToUnixTs('16:00', ref);
      const d = new Date(ts * 1000);
      expect(d.getUTCHours()).toBe(20);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('16:00 ET in January = 21:00 UTC', () => {
      const ref = new Date('2026-01-15T12:00:00Z');
      const ts = etTimeToUnixTs('16:00', ref);
      const d = new Date(ts * 1000);
      expect(d.getUTCHours()).toBe(21);
      expect(d.getUTCMinutes()).toBe(0);
    });

    it('09:30 ET in EDT = 13:30 UTC', () => {
      const ref = new Date('2026-07-15T12:00:00Z');
      const ts = etTimeToUnixTs('09:30', ref);
      const d = new Date(ts * 1000);
      expect(d.getUTCHours()).toBe(13);
      expect(d.getUTCMinutes()).toBe(30);
    });
  });
});
