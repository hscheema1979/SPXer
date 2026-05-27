/**
 * Unit tests for flat-file-reader.ts pure helpers (no S3 / no network).
 *
 * Covers the deterministic logic that getOptionsForDay relies on:
 *   - s3KeyForDate path construction,
 *   - nsToSec nanosecond -> second conversion,
 *   - isDST DST boundary handling (2nd Sun Mar / 1st Sun Nov),
 *   - sessOpenTs 09:30 ET in both EDT and EST,
 *   - withinRth 09:30-15:31 ET window inclusion/exclusion,
 *   - parseDayCsv symbol filtering, RTH filtering, ordering, and the
 *     ticker,volume,open,close,high,low,window_start,transactions column map.
 */
import { describe, it, expect } from 'vitest';
import {
  s3KeyForDate,
  nsToSec,
  isDST,
  sessOpenTs,
  withinRth,
  parseDayCsv,
} from '../../scripts/diag/flat-file-reader';

describe('s3KeyForDate', () => {
  it('builds the OPRA minute-aggs key with year/month partition', () => {
    expect(s3KeyForDate('2026-01-12')).toBe(
      'us_options_opra/minute_aggs_v1/2026/01/2026-01-12.csv.gz'
    );
  });
  it('keeps zero-padded month', () => {
    expect(s3KeyForDate('2025-09-05')).toBe(
      'us_options_opra/minute_aggs_v1/2025/09/2025-09-05.csv.gz'
    );
  });
});

describe('nsToSec', () => {
  it('converts whole-second nanoseconds exactly', () => {
    expect(nsToSec(1_700_000_000_000_000_000n)).toBe(1_700_000_000);
  });
  it('floors sub-second nanosecond remainder', () => {
    // 1.999s of ns -> 1s after integer division
    expect(nsToSec(1_999_000_000n)).toBe(1);
  });
});

describe('isDST', () => {
  it('is EST (false) in mid-January', () => {
    expect(isDST('2026-01-15')).toBe(false);
  });
  it('is EDT (true) in mid-July', () => {
    expect(isDST('2026-07-15')).toBe(true);
  });
  it('flips to EDT on/after the 2nd Sunday of March (2026-03-08)', () => {
    expect(isDST('2026-03-07')).toBe(false); // Saturday before
    expect(isDST('2026-03-08')).toBe(true);  // 2nd Sunday — EDT begins
    expect(isDST('2026-03-09')).toBe(true);
  });
  it('flips to EST on/after the 1st Sunday of November (2026-11-01)', () => {
    expect(isDST('2026-10-31')).toBe(true);  // still EDT
    expect(isDST('2026-11-01')).toBe(false); // 1st Sunday — EST begins
    expect(isDST('2026-11-02')).toBe(false);
  });

  // 2026 is the edge year where both Mar 1 and Nov 1 land on Sunday — the
  // off-by-one (|| 7) bug that mislabeled these days lived here. Lock it down.
  it('handles 2026 where Mar 1 IS the first Sunday (2nd Sunday = Mar 8)', () => {
    expect(isDST('2026-03-01')).toBe(false); // 1st Sunday, still EST
    expect(isDST('2026-03-07')).toBe(false); // Sat before 2nd Sunday
    expect(isDST('2026-03-08')).toBe(true);  // 2nd Sunday — EDT begins
  });

  it('handles 2027 where Mar 1 and Nov 1 are Monday', () => {
    // 2027: 2nd Sunday of March = Mar 14; 1st Sunday of Nov = Nov 7
    expect(isDST('2027-03-13')).toBe(false);
    expect(isDST('2027-03-14')).toBe(true);
    expect(isDST('2027-11-06')).toBe(true);
    expect(isDST('2027-11-07')).toBe(false);
  });
});

describe('sessOpenTs', () => {
  it('09:30 ET in summer (EDT) = 13:30 UTC', () => {
    // 2026-07-15 09:30 EDT == 13:30Z
    const expected = Math.floor(new Date('2026-07-15T13:30:00Z').getTime() / 1000);
    expect(sessOpenTs('2026-07-15')).toBe(expected);
  });
  it('09:30 ET in winter (EST) = 14:30 UTC', () => {
    // 2026-01-15 09:30 EST == 14:30Z
    const expected = Math.floor(new Date('2026-01-15T14:30:00Z').getTime() / 1000);
    expect(sessOpenTs('2026-01-15')).toBe(expected);
  });
});

describe('withinRth', () => {
  const date = '2026-07-15';
  const open = sessOpenTs(date);
  it('includes the open bar (09:30)', () => {
    expect(withinRth(open, date)).toBe(true);
  });
  it('includes a midday bar (12:00)', () => {
    expect(withinRth(open + 2.5 * 3600, date)).toBe(true);
  });
  it('excludes a pre-open bar (09:29)', () => {
    expect(withinRth(open - 60, date)).toBe(false);
  });
  it('includes up to 15:31 but excludes 15:32+', () => {
    expect(withinRth(open + 6 * 3600 + 60, date)).toBe(true);   // 15:31
    expect(withinRth(open + 6 * 3600 + 120, date)).toBe(false); // 15:32
  });
});

describe('parseDayCsv (full-day, no time filter)', () => {
  const date = '2026-07-15';
  const open = sessOpenTs(date);
  const openNs = (sec: number) => `${BigInt(sec) * 1_000_000_000n}`;
  const header = 'ticker,volume,open,close,high,low,window_start,transactions';

  it('keeps only requested symbols and maps columns correctly', () => {
    const csv = [
      header,
      // ticker,volume,open,close,high,low,window_start,transactions
      `O:NDXP260720P19000000,12,1.50,1.40,1.60,1.30,${openNs(open)},5`,
      `O:NDXP260720P18000000,3,0.50,0.55,0.60,0.45,${openNs(open + 60)},2`,
    ].join('\n');

    const map = parseDayCsv(csv, ['NDXP260720P19000000']);
    expect([...map.keys()]).toEqual(['NDXP260720P19000000']);
    const bars = map.get('NDXP260720P19000000')!;
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({
      ts: open, open: 1.50, close: 1.40, high: 1.60, low: 1.30, volume: 12,
    });
  });

  it('strips the O: prefix when matching symbols', () => {
    const csv = [header, `O:NDXP260720P19000000,1,1,1,1,1,${openNs(open)},1`].join('\n');
    const map = parseDayCsv(csv, ['NDXP260720P19000000']);
    expect(map.get('NDXP260720P19000000')).toHaveLength(1);
  });

  it('KEEPS bars outside RTH — full session incl. pre-market & after-hours', () => {
    // The data layer no longer applies a time cutoff; the sweep engine owns
    // any strategy-level time gating. A multi-day position must see the real
    // 16:00 ET close, so after-hours rows are retained.
    const csv = [
      header,
      `O:NDXP260720P19000000,1,1,1,1,1,${openNs(open - 600)},1`,        // pre-open 09:20
      `O:NDXP260720P19000000,2,2,2,2,2,${openNs(open + 3600)},1`,        // 10:30
      `O:NDXP260720P19000000,3,3,3,3,3,${openNs(open + 6 * 3600 + 1800)},1`, // ~16:00
    ].join('\n');
    const bars = parseDayCsv(csv, ['NDXP260720P19000000']).get('NDXP260720P19000000')!;
    expect(bars).toHaveLength(3); // none dropped
    expect(bars.map(b => b.ts)).toEqual([open - 600, open + 3600, open + 6 * 3600 + 1800]);
  });

  it('sorts bars ascending by ts even when CSV rows are out of order', () => {
    const csv = [
      header,
      `O:NDXP260720P19000000,1,1,1,1,1,${openNs(open + 120)},1`,
      `O:NDXP260720P19000000,2,2,2,2,2,${openNs(open)},1`,
      `O:NDXP260720P19000000,3,3,3,3,3,${openNs(open + 60)},1`,
    ].join('\n');
    const bars = parseDayCsv(csv, ['NDXP260720P19000000']).get('NDXP260720P19000000')!;
    expect(bars.map(b => b.ts)).toEqual([open, open + 60, open + 120]);
  });

  it('returns no entry for a symbol with no prints (deep-OTM legs)', () => {
    const csv = [header, `O:NDXP260720P19000000,1,1,1,1,1,${openNs(open)},1`].join('\n');
    const map = parseDayCsv(csv, ['NDXP260720P99999000']);
    expect(map.has('NDXP260720P99999000')).toBe(false);
  });

  it('skips malformed rows with fewer than 8 columns', () => {
    const csv = [
      header,
      'O:NDXP260720P19000000,1,2,3', // too few columns
      `O:NDXP260720P19000000,1,1,1,1,1,${openNs(open)},1`,
    ].join('\n');
    const bars = parseDayCsv(csv, ['NDXP260720P19000000']).get('NDXP260720P19000000')!;
    expect(bars).toHaveLength(1);
  });

  it('handles an empty / header-only file', () => {
    expect(parseDayCsv('', ['X']).size).toBe(0);
    expect(parseDayCsv(header, ['X']).size).toBe(0);
  });
});
