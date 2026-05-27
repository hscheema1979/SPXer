/**
 * Integration test for flat-file-reader.ts against a REAL Polygon S3 day-file
 * slice (committed fixture: tests/diag/fixtures/ndxp-2025-05-15-sample.csv).
 *
 * The fixture is 20 authentic OPRA rows for 4 NDXP put strikes across two
 * expiries on 2025-05-15 — including two late rows (15:57 / 16:00 ET) that the
 * RTH filter must drop. This exercises parseDayCsv end-to-end on real data
 * (real ns timestamps, real OHLCV, real after-hours rows) without hitting the
 * network, so it is deterministic and CI-safe.
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
    const map = parseDayCsv(csv, DATE, symbols);
    expect(new Set(map.keys())).toEqual(new Set(symbols));
  });

  it('applies the RTH filter to real after-hours rows (15:57 & 16:00 ET dropped)', () => {
    // The 0516 P20000000 has 11 raw rows; the last two (15:57, 16:00 ET) are
    // past the 15:31 cutoff and must be excluded → 9 bars.
    const map = parseDayCsv(csv, DATE, symbols);
    const counts = Object.fromEntries(
      [...map.entries()].map(([s, bars]) => [s, bars.length])
    );
    expect(counts).toEqual({
      NDXP250515P19900000: 1,
      NDXP250515P20000000: 5,
      NDXP250515P20100000: 3,
      NDXP250516P20000000: 9,
    });
  });

  it('first ATM bar is the 09:30 ET session open with the real price', () => {
    const bars = parseDayCsv(csv, DATE, symbols).get('NDXP250515P20000000')!;
    expect(bars[0].ts).toBe(sessOpenTs(DATE)); // 09:30 ET
    expect(bars[0].close).toBe(0.05);          // real printed close
    expect(bars[0].volume).toBe(1);
  });

  it('bars are sorted ascending and all within RTH', () => {
    const open = sessOpenTs(DATE);
    const close = open + 6 * 3600 + 60;
    for (const [, bars] of parseDayCsv(csv, DATE, symbols)) {
      for (let i = 1; i < bars.length; i++) {
        expect(bars[i].ts).toBeGreaterThan(bars[i - 1].ts);
      }
      for (const b of bars) {
        expect(b.ts).toBeGreaterThanOrEqual(open);
        expect(b.ts).toBeLessThanOrEqual(close);
      }
    }
  });

  it('OHLC columns map correctly (real multi-print bar)', () => {
    // Row: O:NDXP250516P20000000,5,1.45,1.39,1.45,1.39,... → open 1.45, close 1.39
    const bars = parseDayCsv(csv, DATE, ['NDXP250516P20000000']).get('NDXP250516P20000000')!;
    const multi = bars.find(b => b.volume === 5);
    expect(multi).toBeDefined();
    expect(multi!).toMatchObject({ open: 1.45, close: 1.39, high: 1.45, low: 1.39 });
  });

  it('ignores symbols not requested', () => {
    const map = parseDayCsv(csv, DATE, ['NDXP250515P20000000']);
    expect([...map.keys()]).toEqual(['NDXP250515P20000000']);
  });
});
