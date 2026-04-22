/**
 * migrate-to-parquet.ts — Export replay_bars from SQLite to per-date parquet files.
 *
 * Reads from spxer.db using better-sqlite3, writes parquet via DuckDB CLI.
 * One file per date per profile.
 *
 * Layout: data/parquet/bars/{profile}/{YYYY-MM-DD}.parquet
 *
 * Usage:
 *   npx tsx scripts/migrate-to-parquet.ts                    # all profiles, all dates
 *   npx tsx scripts/migrate-to-parquet.ts --profile=spx      # SPX only
 *   npx tsx scripts/migrate-to-parquet.ts --date=2026-03-20  # single date
 *   npx tsx scripts/migrate-to-parquet.ts --dry-run          # show what would be exported
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

const DB_PATH = process.env.DB_PATH || 'data/spxer.db';
const PARQUET_ROOT = path.resolve('data/parquet/bars');

interface ProfileDef {
  id: string;
  underlyingSymbol: string;
  symbolFilter: string;
}

const PROFILES: ProfileDef[] = [
  { id: 'spx', underlyingSymbol: 'SPX', symbolFilter: "symbol = 'SPX' OR symbol LIKE 'SPXW%'" },
  { id: 'ndx', underlyingSymbol: 'NDX', symbolFilter: "symbol = 'NDX' OR symbol LIKE 'NDXP%'" },
];

const COLUMNS = [
  'id', 'symbol', 'timeframe', 'ts', 'open', 'high', 'low', 'close', 'volume',
  'synthetic', 'gap_type', 'indicators', 'source',
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap', 'spread',
];

// ── CLI args ──
const args = process.argv.slice(2);
const profileFilter = args.find(a => a.startsWith('--profile='))?.split('=')[1];
const dateFilter = args.find(a => a.startsWith('--date='))?.split('=')[1];
const dryRun = args.includes('--dry-run');

function csvEscape(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }
  return String(v);
}

function writeCsv(rows: any[], outPath: string): void {
  const fd = fs.openSync(outPath, 'w');
  fs.writeSync(fd, COLUMNS.join(',') + '\n');
  for (const r of rows) {
    fs.writeSync(fd, COLUMNS.map(col => csvEscape(r[col])).join(',') + '\n');
  }
  fs.closeSync(fd);
}

function csvToParquet(csvPath: string, parquetPath: string): void {
  const sql = `COPY (SELECT * FROM read_csv('${csvPath}', header=true, auto_detect=true)) TO '${parquetPath}' (FORMAT PARQUET, COMPRESSION 'zstd');`;
  execFileSync('duckdb', ['-c', sql], { stdio: 'pipe', timeout: 120000 });
}

/** Get the start-of-day UTC timestamp for a date string like 2026-03-20 */
function dateToTsRange(dateStr: string): { start: number; end: number } {
  // Market hours: 9:30-16:00 ET → 13:30-20:00 UTC (EDT) or 14:30-21:00 UTC (EST)
  // Use a wide window (00:00-23:59 UTC for the date) to catch all bars
  const d = new Date(dateStr + 'T00:00:00Z');
  return { start: Math.floor(d.getTime() / 1000), end: Math.floor(d.getTime() / 1000) + 86399 };
}

function main(): void {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('busy_timeout = 10000');
  db.pragma('cache_size = -128000');

  const profiles = profileFilter
    ? PROFILES.filter(p => p.id === profileFilter)
    : PROFILES;

  let totalFiles = 0;
  let totalRows = 0;
  let totalBytes = 0;
  const startTime = Date.now();

  for (const profile of profiles) {
    // Get unique dates fast using the underlying symbol only (small scan)
    const dates = db.prepare(`
      SELECT DISTINCT date(ts, 'unixepoch') as d
      FROM replay_bars
      WHERE symbol = ? AND timeframe = '1m'
      ORDER BY d
    `).all(profile.underlyingSymbol) as { d: string }[];

    const filteredDates = dateFilter
      ? dates.filter(r => r.d === dateFilter)
      : dates;

    if (filteredDates.length === 0) {
      console.log(`  ${profile.id}: no dates found`);
      continue;
    }

    const profileDir = path.join(PARQUET_ROOT, profile.id);
    if (!dryRun) fs.mkdirSync(profileDir, { recursive: true });

    console.log(`\n${profile.id}: ${filteredDates.length} dates to export`);

    for (let i = 0; i < filteredDates.length; i++) {
      const date = filteredDates[i].d;
      const outFile = path.join(profileDir, `${date}.parquet`);

      // Skip if already exists and non-empty
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 100) {
        continue;
      }

      if (dryRun) {
        console.log(`  [${i + 1}/${filteredDates.length}] ${date} → ${outFile}`);
        totalFiles++;
        continue;
      }

      // Use timestamp range (fast, index-friendly) instead of date() function
      const { start, end } = dateToTsRange(date);

      const rows = db.prepare(`
        SELECT ${COLUMNS.join(', ')}
        FROM replay_bars
        WHERE (${profile.symbolFilter})
          AND ts >= ? AND ts <= ?
        ORDER BY symbol, ts
      `).all(start, end) as any[];

      if (rows.length === 0) continue;

      const tmpCsv = `/tmp/pq_${profile.id}_${date}.csv`;
      try {
        writeCsv(rows, tmpCsv);
        csvToParquet(tmpCsv, outFile);
      } catch (err: any) {
        console.error(`  ERROR ${date}: ${err.message}`);
        try { fs.unlinkSync(outFile); } catch {}
        continue;
      } finally {
        try { fs.unlinkSync(tmpCsv); } catch {}
      }

      const stat = fs.statSync(outFile);
      totalBytes += stat.size;
      totalRows += rows.length;
      totalFiles++;

      if (i % 10 === 0 || i === filteredDates.length - 1) {
        const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`  [${i + 1}/${filteredDates.length}] ${date}: ${rows.length.toLocaleString()} rows → ${sizeMB} MB (${elapsed}s)`);
      }
    }
  }

  db.close();

  const totalGB = (totalBytes / 1024 / 1024 / 1024).toFixed(2);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  console.log(`\nDone: ${totalFiles} files, ${totalRows.toLocaleString()} rows, ${totalGB} GB total (${elapsed}s)`);
}

main();
