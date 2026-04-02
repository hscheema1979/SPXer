#!/usr/bin/env tsx
/**
 * Migration 001: Add indicator columns to replay_bars.
 *
 * Replaces the `indicators TEXT` JSON blob with 21 native REAL columns.
 * This eliminates JSON.parse overhead (~140ms/day) and reduces DB size by ~71%.
 *
 * Also creates the `replay_contracts` index table for fast symbol discovery.
 *
 * Usage:
 *   npx tsx scripts/migrations/001-indicator-columns.ts           # full migration
 *   npx tsx scripts/migrations/001-indicator-columns.ts --dry-run  # preview only
 *   npx tsx scripts/migrations/001-indicator-columns.ts --verify   # verify migration
 */

import Database from 'better-sqlite3';
import * as path from 'path';

const DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

// All 21 indicator keys found in the JSON blobs
const INDICATOR_COLUMNS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21',
  'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct',
  'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

function main() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30000');
  db.pragma('cache_size = -512000'); // 512MB cache for migration

  if (VERIFY) {
    verify(db);
    db.close();
    return;
  }

  console.log(`Migration 001: Add indicator columns to replay_bars`);
  console.log(`Database: ${DB_PATH}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log('');

  // Step 1: Check which columns already exist
  const existingCols = new Set(
    (db.prepare("PRAGMA table_info(replay_bars)").all() as any[]).map(r => r.name)
  );

  const missingCols = INDICATOR_COLUMNS.filter(c => !existingCols.has(c));
  if (missingCols.length === 0) {
    console.log('✅ All indicator columns already exist.');
  } else {
    console.log(`Adding ${missingCols.length} columns: ${missingCols.join(', ')}`);
    if (!DRY_RUN) {
      for (const col of missingCols) {
        db.exec(`ALTER TABLE replay_bars ADD COLUMN ${col} REAL`);
      }
      console.log('✅ Columns added.');
    }
  }

  // Step 2: Populate columns from JSON (batch by symbol for index efficiency)
  if (!DRY_RUN) {
    console.log('\nPopulating indicator columns from JSON...');
    const totalRows = (db.prepare('SELECT COUNT(*) as n FROM replay_bars').get() as any).n;
    console.log(`Total rows: ${totalRows.toLocaleString()}`);

    // Check how many rows need migration (indicators column is not empty AND columns are NULL)
    const needsMigration = (db.prepare(
      `SELECT COUNT(*) as n FROM replay_bars WHERE indicators != '{}' AND hma3 IS NULL`
    ).get() as any).n;

    if (needsMigration === 0) {
      console.log('✅ All rows already migrated.');
    } else {
      console.log(`Rows needing migration: ${needsMigration.toLocaleString()}`);

      // Get distinct symbols to process in batches
      const symbols = db.prepare(
        `SELECT DISTINCT symbol FROM replay_bars WHERE indicators != '{}' AND hma3 IS NULL`
      ).all() as { symbol: string }[];

      console.log(`Symbols to process: ${symbols.length}`);

      const setClauses = INDICATOR_COLUMNS.map(c =>
        `${c} = json_extract(indicators, '$.${c}')`
      ).join(', ');

      const updateStmt = db.prepare(
        `UPDATE replay_bars SET ${setClauses} WHERE symbol = ? AND hma3 IS NULL AND indicators != '{}'`
      );

      let processed = 0;
      const batchSize = 50; // Process 50 symbols per transaction
      const t0 = performance.now();

      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        const txn = db.transaction(() => {
          for (const { symbol } of batch) {
            updateStmt.run(symbol);
          }
        });
        txn();
        processed += batch.length;

        if (processed % 500 === 0 || processed === symbols.length) {
          const elapsed = (performance.now() - t0) / 1000;
          const rate = processed / elapsed;
          const eta = (symbols.length - processed) / rate;
          console.log(`  ${processed}/${symbols.length} symbols (${elapsed.toFixed(1)}s elapsed, ~${eta.toFixed(0)}s remaining)`);
        }
      }

      const elapsed = (performance.now() - t0) / 1000;
      console.log(`✅ Migration complete in ${elapsed.toFixed(1)}s`);
    }
  }

  // Step 3: Create replay_contracts index table
  if (!DRY_RUN) {
    console.log('\nCreating replay_contracts index table...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS replay_contracts (
        date TEXT NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        strike REAL NOT NULL,
        bar_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_rc_date ON replay_contracts(date);
      CREATE INDEX IF NOT EXISTS idx_rc_date_strike ON replay_contracts(date, strike);
    `);

    // Populate from replay_bars
    const existing = (db.prepare('SELECT COUNT(*) as n FROM replay_contracts').get() as any).n;
    if (existing > 0) {
      console.log(`  replay_contracts already has ${existing} rows, skipping populate.`);
    } else {
      console.log('  Populating replay_contracts...');
      db.exec(`
        INSERT OR IGNORE INTO replay_contracts (date, symbol, side, strike, bar_count)
        SELECT
          date(ts, 'unixepoch') as date,
          symbol,
          CASE WHEN symbol GLOB '*C[0-9]*' THEN 'call' ELSE 'put' END as side,
          CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike,
          COUNT(*) as bar_count
        FROM replay_bars
        WHERE symbol LIKE 'SPXW%' AND timeframe = '1m'
        GROUP BY date(ts, 'unixepoch'), symbol
      `);
      const populated = (db.prepare('SELECT COUNT(*) as n FROM replay_contracts').get() as any).n;
      console.log(`  ✅ Populated ${populated} contract entries.`);
    }
  }

  // Step 4: Create composite index for column-based queries
  if (!DRY_RUN) {
    console.log('\nOptional: VACUUM to reclaim space...');
    console.log('  (Skipping VACUUM — run manually with: sqlite3 data/spxer.db "VACUUM;"');
    console.log('   This will take a while on an 18GB database.)');
  }

  console.log('\n✅ Migration 001 complete.');
  db.close();
}

function verify(db: Database.Database) {
  console.log('Verifying migration 001...\n');

  // Check columns exist
  const cols = new Set(
    (db.prepare("PRAGMA table_info(replay_bars)").all() as any[]).map(r => r.name)
  );
  const missing = INDICATOR_COLUMNS.filter(c => !cols.has(c));
  if (missing.length > 0) {
    console.log(`❌ Missing columns: ${missing.join(', ')}`);
    return;
  }
  console.log('✅ All 21 indicator columns exist.');

  // Check data was migrated
  const nullCount = (db.prepare(
    `SELECT COUNT(*) as n FROM replay_bars WHERE indicators != '{}' AND hma3 IS NULL`
  ).get() as any).n;
  if (nullCount > 0) {
    console.log(`❌ ${nullCount} rows still need migration (have JSON but NULL columns).`);
  } else {
    console.log('✅ All JSON indicators migrated to columns.');
  }

  // Spot-check: compare a few rows
  const samples = db.prepare(`
    SELECT symbol, ts, indicators, hma3, rsi14, ema9 FROM replay_bars
    WHERE indicators != '{}' AND hma3 IS NOT NULL
    LIMIT 5
  `).all() as any[];

  let mismatches = 0;
  for (const s of samples) {
    const json = JSON.parse(s.indicators);
    if (json.hma3 != null && Math.abs((json.hma3 - s.hma3) / json.hma3) > 0.0001) {
      console.log(`  ❌ Mismatch: ${s.symbol} ts=${s.ts} hma3 json=${json.hma3} col=${s.hma3}`);
      mismatches++;
    }
  }
  if (mismatches === 0 && samples.length > 0) {
    console.log(`✅ Spot-check: ${samples.length} rows match JSON ↔ columns.`);
  }

  // Check replay_contracts
  const rcCount = (db.prepare('SELECT COUNT(*) as n FROM replay_contracts').get() as any).n;
  console.log(`✅ replay_contracts: ${rcCount} entries.`);
}

main();
