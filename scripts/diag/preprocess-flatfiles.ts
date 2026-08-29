/**
 * preprocess-flatfiles.ts
 *
 * Download + extract Polygon S3 option flat files into the local persistent
 * disk cache (data/flatfile-cache/{prefix}/...), ONCE, for a date range and a
 * set of OCC roots (e.g. NDXP, SPXW). Every multi-DTE sweep then reads the
 * local extracts instead of re-downloading 158MB day-files per profile/shard.
 *
 * Idempotent: skips (prefix,date) pairs already cached on disk unless --force.
 * Sequential by design (one S3 stream at a time) to be gentle on the box.
 *
 * Run: npx tsx scripts/diag/preprocess-flatfiles.ts 2025-01-01 2026-08-31 NDXP SPXW
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { getOptionsForDay, readDiskCache } from './flat-file-reader';
import { tradingDaysBetween } from './sweep-dates';

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter(a => !a.startsWith('--'));
  const start = positional[0];
  const end = positional[1];
  const prefixes = positional.slice(2);
  if (!start || !end || prefixes.length === 0) {
    console.error('Usage: preprocess-flatfiles.ts <start> <end> <PREFIX...> [--force]');
    console.error('  e.g. preprocess-flatfiles.ts 2025-01-01 2026-08-31 NDXP SPXW');
    process.exit(2);
  }

  const days = tradingDaysBetween(start, end);
  console.error(`Preprocessing ${prefixes.join(',')} over ${days.length} trading days ${start}→${end}${force ? ' [--force]' : ''}`);

  // One probe symbol per prefix forces getOptionsForDay to fetch+cache the whole
  // product-day (it caches ALL contracts of that prefix regardless of symbol).
  const probe: Record<string, string> = {};
  for (const p of prefixes) probe[p] = `${p}000101P00000000`; // any well-formed OCC of this root

  let downloaded = 0, skipped = 0, failed = 0;
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    for (const prefix of prefixes) {
      if (!force && readDiskCache(date, prefix)) { skipped++; continue; }
      try {
        const t0 = Date.now();
        const m = await getOptionsForDay(date, [probe[prefix]]);
        // getOptionsForDay caches the full prefix-day; confirm the disk file landed.
        const onDisk = readDiskCache(date, prefix);
        const nSyms = onDisk ? onDisk.size : 0;
        downloaded++;
        if (downloaded % 10 === 0 || nSyms === 0) {
          console.error(`  [${i + 1}/${days.length}] ${date} ${prefix}: ${nSyms} contracts (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        }
      } catch (e) {
        failed++;
        console.error(`  [${i + 1}/${days.length}] ${date} ${prefix}: FAILED ${(e as any).message}`);
      }
    }
  }
  console.error(`Done. downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
