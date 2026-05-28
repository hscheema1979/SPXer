/**
 * Integration test for flat-file-reader.ts against a REAL Polygon S3 day-file
 * slice (committed fixture: tests/diag/fixtures/ndxp-2025-05-15-sample.csv).
 *
 * The fixture is 20 authentic OPRA rows for 4 NDXP put strikes across two
 * expiries on 2025-05-15 — including two late rows (15:57 / 16:00 ET) that the
 * data layer now RETAINS (full-day collection; the sweep engine owns any time
 * gating). Exercises parseDayCsv end-to-end on real data (real ns timestamps,
 * real OHLCV, real after-hours rows) without hitting the network — deterministic
 * and CI-safe.
 *
 * The live-S3 path (getOptionsForDay) is exercised separately by the e2e sweep.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parseDayCsv, sessOpenTs } from '../../scripts/diag/flat-file-reader';

const FIXTURE = path.join(__dirname, 'fixtures/ndxp-2025-05-15-sample.csv');
const DATE = '2025-05-15';

function loadFixture(): string {
  return fs.readFileSync(FIXTURE, 'utf-8');
}

describe('parseDayCsv — real NDXP day-file slice (2025-05-15)', () => {
  const csv = loadFixture();
  const symbols = [
    'NDXP250515P19900000',
    'NDXP250515P20000000',
    'NDXP250515P20100000',
    'NDXP250516P20000000',
  ];

  it('parses the requested NDXP symbols from real data', () => {
    const map = parseDayCsv(csv, symbols);
    expect(new Set(map.keys())).toEqual(new Set(symbols));
  });

  it('retains the FULL day incl. after-hours rows (15:57 & 16:00 ET kept)', () => {
    // The 0516 P20000000 has 11 raw rows incl. two after-hours prints; the data
    // layer keeps them all so a carried position can mark against the real close.
    const map = parseDayCsv(csv, symbols);
    const counts = Object.fromEntries(
      [...map.entries()].map(([s, bars]) => [s, bars.length])
    );
    expect(counts).toEqual({
      NDXP250515P19900000: 1,
      NDXP250515P20000000: 5,
      NDXP250515P20100000: 3,
      NDXP250516P20000000: 11, // all rows kept (no RTH cutoff)
    });
  });

  it('includes the after-hours 16:00 ET close print', () => {
    const bars = parseDayCsv(csv, symbols).get('NDXP250516P20000000')!;
    const close1600 = Math.floor(new Date('2025-05-15T20:00:00Z').getTime() / 1000); // 16:00 EDT
    const lateBar = bars.find(b => b.ts === close1600);
    expect(lateBar).toBeDefined();
  });

  it('first ATM bar is the 09:30 ET session open with the real price', () => {
    const bars = parseDayCsv(csv, symbols).get('NDXP250515P20000000')!;
    expect(bars[0].ts).toBe(sessOpenTs(DATE)); // 09:30 ET
    expect(bars[0].close).toBe(0.05);          // real printed close
    expect(bars[0].volume).toBe(1);
  });

  it('bars are sorted ascending by ts', () => {
    for (const [, bars] of parseDayCsv(csv, symbols)) {
      for (let i = 1; i < bars.length; i++) {
        expect(bars[i].ts).toBeGreaterThan(bars[i - 1].ts);
      }
    }
  });

  it('OHLC columns map correctly (real multi-print bar)', () => {
    // Row: O:NDXP250516P20000000,5,1.45,1.39,1.45,1.39,... → open 1.45, close 1.39
    const bars = parseDayCsv(csv, ['NDXP250516P20000000']).get('NDXP250516P20000000')!;
    const multi = bars.find(b => b.volume === 5);
    expect(multi).toBeDefined();
    expect(multi!).toMatchObject({ open: 1.45, close: 1.39, high: 1.45, low: 1.39 });
  });

  it('ignores symbols not requested', () => {
    const map = parseDayCsv(csv, ['NDXP250515P20000000']);
    expect([...map.keys()]).toEqual(['NDXP250515P20000000']);
  });
});
