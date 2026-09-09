/** Rebuild ALL 1m price-only .po.brc caches to current loader version (v2) from parquet.
 *  Run ONCE before fanning out workers (avoids a write race). */
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';
import { writeBarCacheFile } from '../../src/replay/bar-cache-file';
import { buildSymbolRange } from '../../src/replay/metrics';
import * as fs from 'fs';
import * as path from 'path';

const PARQUET_ROOT = path.resolve('data/parquet/bars/spx-0dte');
const dates = fs.readdirSync(PARQUET_ROOT)
  .filter(f => f.endsWith('.parquet') && !f.endsWith('.tmp'))
  .map(f => f.replace('.parquet', '')).sort();

let ok = 0, fail = 0;
for (const date of dates) {
  try {
    const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const symbolRange = buildSymbolRange(date, 'SPXW');
    const cache = loadBarCacheFromParquetSync({
      profileId: 'spx', date, underlyingSymbol: 'SPX', symbolRange,
      timeframe: '1m', startTs: dayStart, endTs: dayStart + 86399, skipContractIndicators: true,
    });
    if (!cache || cache.spxBars.length === 0) { console.log(`${date}: 0 bars - skip`); fail++; continue; }
    writeBarCacheFile(cache, date, '1m', true);
    ok++;
  } catch (e: any) { console.log(`${date}: ERR ${e.message}`); fail++; }
}
console.log(`Rebuilt ${ok} po caches, ${fail} failed/skipped, of ${dates.length} parquet dates.`);
