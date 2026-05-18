/**
 * rebuild-brc.ts — Rebuild .brc cache files from parquet for given dates.
 * Dates that already have a .brc are skipped.
 *
 * Usage:
 *   npx tsx scripts/diag/rebuild-brc.ts 2025-04-07 2025-04-08   # specific dates
 *   npx tsx scripts/diag/rebuild-brc.ts --all                    # all parquet dates missing .brc
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';
import { loadBarCacheFromParquetSync } from '../../src/storage/parquet-reader-sync';
import { writeBarCacheFile, hasCacheFile } from '../../src/replay/bar-cache-file';
import { buildSymbolRange } from '../../src/replay/metrics';

const PARQUET_ROOT = path.resolve('data/parquet/bars/spx-0dte');
const TFS = ['1m', '3m', '5m'];

function allParquetDates(): string[] {
  return fs.readdirSync(PARQUET_ROOT)
    .filter(f => f.endsWith('.parquet') && !f.endsWith('.tmp'))
    .map(f => f.replace('.parquet', ''))
    .sort();
}

const args = process.argv.slice(2);
const all  = args.includes('--all');
const dates: string[] = all
  ? allParquetDates().filter(d => !hasCacheFile(d, '1m', false))
  : args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));

if (dates.length === 0) {
  console.log('Usage: npx tsx scripts/diag/rebuild-brc.ts [--all] [YYYY-MM-DD ...]');
  process.exit(0);
}

console.log(`Rebuilding .brc for ${dates.length} date(s): ${dates.join(', ')}\n`);

for (const date of dates) {
  const fp = path.join(PARQUET_ROOT, `${date}.parquet`);
  if (!fs.existsSync(fp)) { console.log(`  ${date}: no parquet — skip`); continue; }

  for (const tf of TFS) {
    if (hasCacheFile(date, tf, false)) { process.stdout.write(`  ${date} ${tf}: already exists\n`); continue; }

    process.stdout.write(`  ${date} ${tf}: loading from parquet ... `);
    try {
      const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
      const dayEnd   = dayStart + 86400 - 1;
      const symbolRange = buildSymbolRange(date, 'SPXW');

      const cache = loadBarCacheFromParquetSync({
        profileId: 'spx',
        date,
        underlyingSymbol: 'SPX',
        symbolRange,
        timeframe: tf,
        startTs: dayStart,
        endTs: dayEnd,
        skipContractIndicators: false,
      });

      if (!cache || cache.spxBars.length === 0) {
        console.log('no SPX bars — skip');
        continue;
      }

      writeBarCacheFile(cache, date, tf, false);
      console.log(`${cache.spxBars.length} SPX bars, ${cache.contractBars.size} contracts ✓`);
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
    }
  }
}
console.log('\nDone.');
