/**
 * Pins the two live-capture ownership rules from docs/DATA-STORES.md:
 * no capture on non-trading days, and bars are never written unless
 * explicitly opted in (the EOD backfill owns data/parquet/bars/).
 */
import { describe, it, expect } from 'vitest';
import { captureSkipReason, barWritesEnabled } from '../../src/live/capture-guard';
import { MARKET_HOLIDAYS } from '../../src/config';

describe('captureSkipReason', () => {
  it('captures on an ordinary weekday', () => {
    expect(captureSkipReason('2026-09-10')).toBeNull(); // Thursday
  });

  it('skips Saturday and Sunday', () => {
    expect(captureSkipReason('2026-09-12')).toMatch(/weekend/);
    expect(captureSkipReason('2026-09-13')).toMatch(/weekend/);
  });

  it('skips Labor Day 2026 (Mon 2026-09-07) and treats Mon 2026-08-31 as a trading day', () => {
    // The config listed Labor Day as 2026-08-31 — a week early. 2026-09-07 is
    // the day the daemon wrote the quarantined junk file.
    expect(captureSkipReason('2026-09-07')).toMatch(/market holiday/);
    expect(captureSkipReason('2026-08-31')).toBeNull();
  });

  it('skips every configured holiday', () => {
    for (const d of MARKET_HOLIDAYS) expect(captureSkipReason(d), d).not.toBeNull();
  });

  it('honours an injected holiday set', () => {
    const custom = new Set(['2026-09-10']);
    expect(captureSkipReason('2026-09-10', custom)).toMatch(/market holiday/);
    expect(captureSkipReason('2026-09-11', custom)).toBeNull();
  });
});

describe('barWritesEnabled', () => {
  it('is OFF by default (EOD backfill owns bars)', () => {
    expect(barWritesEnabled({})).toBe(false);
    expect(barWritesEnabled({ LIVE_CAPTURE_WRITE_BARS: '' })).toBe(false);
  });

  it('requires the exact value "1" — "true"/"yes" do not count', () => {
    expect(barWritesEnabled({ LIVE_CAPTURE_WRITE_BARS: 'true' })).toBe(false);
    expect(barWritesEnabled({ LIVE_CAPTURE_WRITE_BARS: 'yes' })).toBe(false);
    expect(barWritesEnabled({ LIVE_CAPTURE_WRITE_BARS: '1' })).toBe(true);
  });
});
