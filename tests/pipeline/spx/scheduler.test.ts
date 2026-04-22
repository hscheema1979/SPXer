// tests/pipeline/spx/scheduler.test.ts
import { describe, it, expect } from 'vitest';
import { getMarketMode, isMarketHoliday, getActiveExpirations } from '../../../src/pipeline/spx/scheduler';

describe('scheduler', () => {
  it('detects holiday', () => {
    expect(isMarketHoliday('2026-01-01')).toBe(true);
    expect(isMarketHoliday('2026-03-18')).toBe(false);
  });

  it('returns correct mode for overnight (2 AM ET)', () => {
    // Simulate 2 AM ET on a weekday
    const mode = getMarketMode(new Date('2026-03-18T07:00:00Z')); // 2 AM ET = 7 AM UTC
    expect(mode).toBe('overnight');
  });

  it('returns rth mode during market hours', () => {
    const mode = getMarketMode(new Date('2026-03-18T15:00:00Z')); // 10 AM ET
    expect(mode).toBe('rth');
  });

  it('returns correct DTE expirations for a Wednesday', () => {
    const exps = getActiveExpirations('2026-03-18', ['2026-03-18','2026-03-20','2026-03-23','2026-03-25']);
    expect(exps).toContain('2026-03-18'); // 0DTE
    expect(exps).toContain('2026-03-20'); // 2DTE
    expect(exps).not.toContain('2026-03-25'); // 7DTE — excluded
  });
});
