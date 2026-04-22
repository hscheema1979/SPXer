/**
 * migrate-sqlite-to-parquet.ts — One-time migration of replay_bars from
 * SQLite to per-date parquet files.
 *
 * Usage:
 *   npx tsx scripts/migrate-sqlite-to-parquet.ts                    # all profiles, all dates
 *   npx tsx scripts/migrate-sqlite-to-parquet.ts --profile=spx      # SPX only
 *   npx tsx scripts/migrate-sqlite-to-parquet.ts --dry-run           # show what would be done
 *   npx tsx scripts/migrate-sqlite-to-parquet.ts --skip-existing     # skip dates with existing parquet
 *   npx tsx scripts/migrate-sqlite-to-parquet.ts --delete-after      # DELETE from SQLite after verify
 */

import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import * as path from 'path';
import Database from 'better-sqlite3';
import { flushToParquet, profileSymbolFilter, getParquetRoot } from '../src/storage/parquet-writer';
import { hasParquetDate, countParquetRows } from '../src/storage/parquet-reader';

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string): boolean { return args.includes(`--${name}`); }
function flagVal(name: string): string | undefined {
  const a = args.find(f => f.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

const profileFilter = flagVal('profile');
const dryRun = flag('dry-run');
const skipExisting = flag('skip-existing');
const deleteAfter = flag('delete-after');

// ── Profile definitions ──────────────────────────────────────────────────────

interface MigrationProfile {
  id: string;              // parquet directory name
  underlyingSymbol: string;
  optionPrefix: string;
}

const PROFILES: MigrationProfile[] = [
  { id: 'spx', underlyingSymbol: 'SPX', optionPrefix: 'SPXW' },
  { id: 'ndx', underlyingSymbol: 'NDX', optionPrefix: 'NDXP' },
  // Add more as they get data
];

// ── Main ─────────────────────────────────────────────────────────────────────

const DB_PATH = path.resolve(process.env.DB_PATH || path.resolve(__dirname, '../data/spxer.db'));

async function main(): Promise<void> {
  const db = new Database(DB_PATH, { readonly: true });

  const profiles = profileFilter
    ? PROFILES.filter(p => p.id === profileFilter)
    : PROFILES;

  if (profiles.length === 0) {
    console.error(`Unknown profile: ${profileFilter}`);
    console.error(`Available: ${PROFILES.map(p => p.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`\n━━━ SQLite → Parquet Migration ━━━`);
  console.log(`  DB: ${DB_PATH}`);
  console.log(`  Out: ${getParquetRoot()}`);
  console.log(`  Profiles: ${profiles.map(p => p.id).join(', ')}`);
  console.log(`  Dry run: ${dryRun}`);
  console.log(`  Skip existing: ${skipExisting}`);
  console.log(`  Delete after: ${deleteAfter}\n`);

  let totalFiles = 0;
  let totalRows = 0;
  let totalBytes = 0;
  let skipped = 0;
  let errors = 0;

  for (const profile of profiles) {
    // Find all dates for this profile's underlying symbol
    const filter = profileSymbolFilter(profile.id + '-0dte', profile.underlyingSymbol);
    // Simpler: just query by the underlying symbol
    const dateRows = db.prepare(`
      SELECT DISTINCT date(ts, 'unixepoch') as d
      FROM replay_bars
      WHERE symbol = ?
        AND timeframe = '1m'
      ORDER BY d
    `).all(profile.underlyingSymbol) as { d: string }[];

    const dates = dateRows.map(r => r.d);
    console.log(`[${profile.id}] ${dates.length} dates in SQLite`);

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const tag = `[${profile.id}] ${date} (${i + 1}/${dates.length})`;

      // Skip if parquet already exists
      if (skipExisting && hasParquetDate(profile.id, date)) {
        const existing = await countParquetRows(profile.id, date);
        if (existing > 0) {
          skipped++;
          continue;
        }
      }

      if (dryRun) {
        // Count rows that would be exported (use ts range for speed)
        const dayStart = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
        const dayEnd = dayStart + 86400 - 1;
        const { cnt } = db.prepare(`
          SELECT COUNT(*) as cnt FROM replay_bars
          WHERE ts >= ? AND ts <= ?
            AND (symbol = ? OR symbol LIKE ?)
        `).get(dayStart, dayEnd, profile.underlyingSymbol, `${profile.optionPrefix}%`) as { cnt: number };
        console.log(`  ${tag}: ${cnt} rows (dry run)`);
        totalRows += cnt;
        totalFiles++;
        continue;
      }

      try {
        const symbolFilter = `(symbol = '${profile.underlyingSymbol}' OR symbol LIKE '${profile.optionPrefix}%')`;
        const result = await flushToParquet({
          sqliteDbPath: DB_PATH,
          profileId: profile.id,
          date,
          symbolFilter,
        });

        const sizeMB = (result.fileSize / 1024 / 1024).toFixed(1);
        console.log(`  ${tag}: ${result.rowCount} rows → ${sizeMB} MB`);
        totalFiles++;
        totalRows += result.rowCount;
        totalBytes += result.fileSize;
      } catch (err: any) {
        console.error(`  ${tag}: ERROR: ${err.message}`);
        errors++;
      }
    }
  }

  db.close();

  console.log(`\n━━━ Migration Summary ━━━`);
  console.log(`  Files written: ${totalFiles}`);
  console.log(`  Rows exported: ${totalRows.toLocaleString()}`);
  console.log(`  Total size: ${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors: ${errors}`);

  if (deleteAfter) {
    console.log(`\n  ⚠️  --delete-after is DISABLED. Never delete from or VACUUM a live SQLite DB.`);
    console.log(`  SQLite rows are kept as-is. Parquet is the replay read path — SQLite stays untouched.`);
  }
}

// listMigratedDates removed — no longer deleting from SQLite after migration

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
