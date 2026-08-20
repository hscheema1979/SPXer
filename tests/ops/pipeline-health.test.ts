/**
 * pipeline-health.test.ts — EOD-freshness pure functions (FR-001).
 *
 * The nightly eod-pipeline hung silently for three weeks (2026-07-31 →
 * 2026-08-19); these helpers make "when did it last complete?" a number the
 * ops check can alert on instead of something you discover from a leak.
 */
import { describe, it, expect } from 'vitest';
import {
  parseEodDoneTimestamp,
  eodStalenessDays,
  eodFreshnessStatus,
} from '../../src/ops/pipeline-health';

const DAY = 86_400_000;

describe('parseEodDoneTimestamp', () => {
  it('parses a real done line from eod-pipeline.log', () => {
    const line = '[2026-07-30T21:25:19Z] === EOD pipeline done ===';
    expect(parseEodDoneTimestamp(line)).toBe(Date.parse('2026-07-30T21:25:19Z'));
  });

  it('rejects non-done lines (start/abort/skip)', () => {
    expect(parseEodDoneTimestamp('[2026-08-19T20:15:01Z] === EOD pipeline start (ET 16:15 | today=2026-08-19) ===')).toBeNull();
    expect(parseEodDoneTimestamp('[2026-08-19T20:15:01Z] skip — ET 1715 not in close window (use --now)')).toBeNull();
    expect(parseEodDoneTimestamp('[2026-08-18T20:15:03Z] [PHASE 2] sweep aggregation start')).toBeNull();
    expect(parseEodDoneTimestamp('random log noise')).toBeNull();
  });
});

describe('eodStalenessDays', () => {
  it('computes fractional days and clamps future timestamps to 0', () => {
    const t0 = Date.parse('2026-08-19T21:00:00Z');
    expect(eodStalenessDays(t0 - 2.5 * DAY, t0)).toBeCloseTo(2.5, 6);
    expect(eodStalenessDays(t0 + DAY, t0)).toBe(0);
  });
});

describe('eodFreshnessStatus', () => {
  const t0 = Date.parse('2026-08-19T21:00:00Z');

  it('fresh up to 3 days (Friday-night run checked Monday morning)', () => {
    expect(eodFreshnessStatus(t0 - 2.6 * DAY, t0)).toBe('fresh');   // weekend gap
    expect(eodFreshnessStatus(t0 - 3 * DAY, t0)).toBe('fresh');
  });

  it('stale 3–4 days (tolerates a Monday holiday after a Friday run)', () => {
    expect(eodFreshnessStatus(t0 - 3.6 * DAY, t0)).toBe('stale');
  });

  it('failed-stale beyond 4 days — the leak condition', () => {
    expect(eodFreshnessStatus(t0 - 20 * DAY, t0)).toBe('failed-stale');  // Jul-30 last done
  });
});
