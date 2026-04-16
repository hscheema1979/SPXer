/**
 * purge-bars.ts — Purge old bars from the live `bars` table.
 *
 * Keeps only the last 3 trading days for active/sticky contracts.
 * Deletes all bars for expired contracts.
 * Runs VACUUM to reclaim disk space.
 *
 * Usage:
 *   npx tsx scripts/purge-bars.ts [--dry-run]
 */
import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../data/spxer.db');
const TRADING_DAYS_TO_KEEP = 3;

// Get last N trading days (excluding weekends)
function getTradingDaysBack(n: number): string[] {
  const days: string[] = [];
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0); // noon UTC to avoid DST edge cases
  
  while (days.length < n) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) { // not weekend
      days.push(d.toISOString().slice(0, 10));
    }
    d.setDate(d.getDate() - 1);
  }
  
  return days;
}

function dateToTsStart(date: string): number {
  // Start of day in UTC (00:00:00)
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  // Get the cutoff date (start of 3 trading days ago)
  const keepDays = getTradingDaysBack(TRADING_DAYS_TO_KEEP);
  const cutoffDate = keepDays[keepDays.length - 1]; // oldest day
  const cutoffTs = dateToTsStart(cutoffDate);

  console.log(`\n=== Purge Bars ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will delete)'}`);
  console.log(`Keeping bars from: ${keepDays.join(', ')}`);
  console.log(`Cutoff timestamp: ${cutoffTs} (${cutoffDate} 00:00:00 UTC)\n`);

  // Count current state
  const totalBars = db.prepare('SELECT count(*) as cnt FROM bars').get() as any;
  const expiredContracts = db.prepare("SELECT symbol FROM contracts WHERE state = 'EXPIRED'").all() as any[];
  const activeContracts = db.prepare("SELECT symbol FROM contracts WHERE state IN ('ACTIVE', 'STICKY')").all() as any[];
  const spxBars = db.prepare("SELECT count(*) as cnt FROM bars WHERE symbol = 'SPX'").get() as any;

  console.log(`Current state:`);
  console.log(`  Total bars:         ${totalBars.cnt.toLocaleString()}`);
  console.log(`  SPX bars:           ${spxBars.cnt.toLocaleString()}`);
  console.log(`  Expired contracts:  ${expiredContracts.length}`);
  console.log(`  Active contracts:   ${activeContracts.length}\n`);

  // Count bars to delete
  const expiredSymbols = expiredContracts.map(c => c.symbol);
  let expiredBarsCount = 0;
  if (expiredSymbols.length > 0) {
    const placeholders = expiredSymbols.map(() => '?').join(',');
    expiredBarsCount = (db.prepare(`SELECT count(*) as cnt FROM bars WHERE symbol IN (${placeholders})`).get(...expiredSymbols) as any).cnt;
  }

  const oldBarsCount = (db.prepare(`SELECT count(*) as cnt FROM bars WHERE ts < ?`).get(cutoffTs) as any).cnt;

  console.log(`Bars to delete:`);
  console.log(`  Expired contracts:  ${expiredBarsCount.toLocaleString()}`);
  console.log(`  Older than ${cutoffDate}: ${oldBarsCount.toLocaleString()}`);
  console.log(`  Total to delete:    ${(expiredBarsCount + oldBarsCount).toLocaleString()}\n`);

  if (dryRun) {
    console.log(`DRY RUN — no changes made.`);
    console.log(`Run without --dry-run to actually purge.\n`);
    db.close();
    return;
  }

  // Execute purge
  console.log(`Purging...\n`);

  // 1. Delete bars for expired contracts
  if (expiredSymbols.length > 0) {
    const placeholders = expiredSymbols.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM bars WHERE symbol IN (${placeholders})`).run(...expiredSymbols);
    console.log(`  Deleted ${result.changes.toLocaleString()} bars for expired contracts`);
  }

  // 2. Delete bars older than cutoff (except for active contracts - they may have recent data)
  // Actually, we want to delete ALL bars older than cutoff, regardless of contract state
  const oldResult = db.prepare(`DELETE FROM bars WHERE ts < ?`).run(cutoffTs);
  console.log(`  Deleted ${oldResult.changes.toLocaleString()} bars older than ${cutoffDate}`);

  // 3. Also delete expired contracts from contracts table
  const contractResult = db.prepare(`DELETE FROM contracts WHERE state = 'EXPIRED'`).run();
  console.log(`  Deleted ${contractResult.changes} expired contract records`);

  // 4. VACUUM to reclaim space
  console.log(`\nRunning VACUUM (this may take a minute)...\n`);
  db.pragma('journal_mode = DELETE'); // VACUUM requires DELETE mode
  db.exec('VACUUM');
  db.pragma('journal_mode = WAL');

  // Final count
  const finalBars = db.prepare('SELECT count(*) as cnt FROM bars').get() as any;
  const finalSize = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
  
  console.log(`\n=== Complete ===`);
  console.log(`  Final bar count:    ${finalBars.cnt.toLocaleString()}`);
  console.log(`  DB size:            ${(finalSize.size / 1024 / 1024).toFixed(1)} MB\n`);

  db.close();
}

main();
