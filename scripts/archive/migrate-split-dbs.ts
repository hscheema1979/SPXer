#!/usr/bin/env npx tsx
/**
 * migrate-split-dbs.ts — One-time migration to split spxer.db into two databases.
 *
 * Strategy (disk-efficient — no full copy of 40GB replay data):
 *   1. Stop all PM2 processes (live pipeline, agents, viewer)
 *   2. Force WAL checkpoint on spxer.db
 *   3. Rename spxer.db → replay.db  (instant — same filesystem)
 *   4. Create fresh spxer.db with only live tables (bars, contracts, instrument_profiles, schwab_tokens)
 *   5. Copy live data from replay.db into new spxer.db (~2GB, fast)
 *   6. Drop live-only tables from replay.db to save space
 *   7. Verify both databases
 *
 * After migration:
 *   - spxer.db  (~2GB) = bars, contracts, instrument_profiles, schwab_tokens
 *   - replay.db (~38GB) = replay_bars, replay_configs, replay_runs, replay_results, replay_jobs, etc.
 *
 * Usage:
 *   npx tsx scripts/migrate-split-dbs.ts              # dry run (default)
 *   npx tsx scripts/migrate-split-dbs.ts --execute     # actually run the migration
 *   npx tsx scripts/migrate-split-dbs.ts --skip-pm2    # skip PM2 stop/start (if already stopped)
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const DATA_DIR = path.resolve(__dirname, '../data');
const SPXER_DB = path.join(DATA_DIR, 'spxer.db');
const REPLAY_DB = path.join(DATA_DIR, 'replay.db');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');
const SKIP_PM2 = args.includes('--skip-pm2');

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

function fileSize(p: string): string {
  try {
    const s = fs.statSync(p).size;
    if (s > 1e9) return `${(s / 1e9).toFixed(2)} GB`;
    return `${(s / 1e6).toFixed(1)} MB`;
  } catch {
    return 'not found';
  }
}

function main() {
  log(`=== DB Split Migration ===`);
  log(`Mode: ${DRY_RUN ? 'DRY RUN (pass --execute to run for real)' : 'EXECUTING'}`);
  log('');

  // Pre-flight checks
  if (!fs.existsSync(SPXER_DB)) {
    console.error(`ERROR: ${SPXER_DB} not found`);
    process.exit(1);
  }
  if (fs.existsSync(REPLAY_DB)) {
    console.error(`ERROR: ${REPLAY_DB} already exists. Delete it first if re-running migration.`);
    process.exit(1);
  }

  log(`Source: ${SPXER_DB} (${fileSize(SPXER_DB)})`);
  log(`WAL:   ${SPXER_DB}-wal (${fileSize(SPXER_DB + '-wal')})`);
  log('');

  // Check disk space
  try {
    const df = execSync(`df -B1 ${DATA_DIR}`).toString();
    const parts = df.split('\n')[1]?.split(/\s+/) || [];
    const availBytes = parseInt(parts[3] || '0');
    const availGB = availBytes / 1e9;
    log(`Available disk: ${availGB.toFixed(1)} GB`);
    if (availGB < 5) {
      console.error('ERROR: Less than 5 GB free. Need space for new spxer.db (~2GB).');
      process.exit(1);
    }
  } catch (e) {
    log('WARNING: Could not check disk space');
  }

  // Step 1: Stop PM2 processes
  if (!SKIP_PM2) {
    log('Step 1: Stopping PM2 processes...');
    if (!DRY_RUN) {
      try {
        execSync('pm2 stop spxer spxer-agent replay-viewer 2>/dev/null', { stdio: 'pipe' });
        log('  Stopped spxer, spxer-agent, replay-viewer');
      } catch {
        log('  Some processes were already stopped (ok)');
      }
      // Wait a moment for file handles to close
      execSync('sleep 2');
    } else {
      log('  [dry-run] Would stop spxer, spxer-agent, replay-viewer');
    }
  } else {
    log('Step 1: Skipping PM2 (--skip-pm2)');
  }

  // Step 2: Force WAL checkpoint
  log('Step 2: Checkpointing WAL...');
  if (!DRY_RUN) {
    const db = new Database(SPXER_DB);
    const result = db.pragma('wal_checkpoint(TRUNCATE)') as any[];
    db.close();
    log(`  Checkpoint result: ${JSON.stringify(result[0])}`);
    log(`  WAL after: ${fileSize(SPXER_DB + '-wal')}`);
  } else {
    log('  [dry-run] Would checkpoint WAL');
  }

  // Step 3: Rename spxer.db → replay.db
  log('Step 3: Renaming spxer.db → replay.db...');
  if (!DRY_RUN) {
    // Move all WAL/SHM files too
    fs.renameSync(SPXER_DB, REPLAY_DB);
    for (const ext of ['-wal', '-shm']) {
      const src = SPXER_DB + ext;
      const dst = REPLAY_DB + ext;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
    log(`  Done. replay.db: ${fileSize(REPLAY_DB)}`);
  } else {
    log('  [dry-run] Would rename spxer.db → replay.db');
  }

  // Step 4: Create fresh spxer.db with live tables
  log('Step 4: Creating fresh spxer.db...');
  if (!DRY_RUN) {
    const newDb = new Database(SPXER_DB);
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('foreign_keys = ON');
    newDb.pragma('wal_autocheckpoint = 1000');
    newDb.pragma('synchronous = NORMAL');
    newDb.pragma('busy_timeout = 5000');
    newDb.pragma('cache_size = -64000');

    // Create live tables
    newDb.exec(`
      CREATE TABLE IF NOT EXISTS bars (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol      TEXT NOT NULL,
        timeframe   TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        open        REAL NOT NULL,
        high        REAL NOT NULL,
        low         REAL NOT NULL,
        close       REAL NOT NULL,
        volume      INTEGER NOT NULL DEFAULT 0,
        synthetic   INTEGER NOT NULL DEFAULT 0,
        gap_type    TEXT,
        indicators  TEXT NOT NULL DEFAULT '{}',
        spread      REAL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_bars_symbol_tf_ts
        ON bars(symbol, timeframe, ts);

      CREATE TABLE IF NOT EXISTS contracts (
        symbol      TEXT PRIMARY KEY,
        type        TEXT NOT NULL,
        underlying  TEXT NOT NULL DEFAULT 'SPX',
        strike      REAL NOT NULL,
        expiry      TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'UNSEEN',
        first_seen  INTEGER,
        last_bar_ts INTEGER,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS instrument_profiles (
        id                      TEXT PRIMARY KEY,
        display_name            TEXT NOT NULL,
        underlying_symbol       TEXT NOT NULL,
        asset_class             TEXT NOT NULL CHECK(asset_class IN ('index','equity','etf')),
        option_prefix           TEXT NOT NULL,
        strike_divisor          INTEGER NOT NULL DEFAULT 1,
        strike_interval         REAL NOT NULL,
        band_half_width_dollars REAL NOT NULL,
        avg_daily_range         REAL,
        expiry_cadence_json     TEXT NOT NULL DEFAULT '[]',
        session_json            TEXT NOT NULL,
        vendor_routing_json     TEXT NOT NULL,
        tier                    INTEGER NOT NULL DEFAULT 1 CHECK(tier IN (1,2)),
        can_go_live             INTEGER NOT NULL DEFAULT 0,
        execution_account_id    TEXT,
        source                  TEXT NOT NULL CHECK(source IN ('seed','ui-discovered','manual')),
        created_at              INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at              INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_underlying
        ON instrument_profiles(underlying_symbol);
      CREATE INDEX IF NOT EXISTS idx_profiles_live
        ON instrument_profiles(can_go_live);

      CREATE TABLE IF NOT EXISTS schwab_tokens (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    log('  Created live tables (bars, contracts, instrument_profiles, schwab_tokens)');

    // Step 5: Copy live data from replay.db
    log('Step 5: Copying live data from replay.db...');
    newDb.exec(`ATTACH DATABASE '${REPLAY_DB}' AS old`);

    // Copy bars
    const barResult = newDb.exec(`
      INSERT INTO bars (id, symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, spread, created_at)
      SELECT id, symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, spread, created_at
      FROM old.bars
    `);
    const barCount = newDb.prepare('SELECT COUNT(*) as cnt FROM bars').get() as { cnt: number };
    log(`  Copied ${barCount.cnt} bars`);

    // Copy contracts
    newDb.exec(`INSERT INTO contracts SELECT * FROM old.contracts`);
    const contractCount = newDb.prepare('SELECT COUNT(*) as cnt FROM contracts').get() as { cnt: number };
    log(`  Copied ${contractCount.cnt} contracts`);

    // Copy instrument_profiles
    newDb.exec(`INSERT INTO instrument_profiles SELECT * FROM old.instrument_profiles`);
    const profileCount = newDb.prepare('SELECT COUNT(*) as cnt FROM instrument_profiles').get() as { cnt: number };
    log(`  Copied ${profileCount.cnt} instrument_profiles`);

    // Copy schwab_tokens if they exist
    try {
      newDb.exec(`INSERT INTO schwab_tokens SELECT * FROM old.schwab_tokens`);
      log('  Copied schwab_tokens');
    } catch {
      log('  No schwab_tokens to copy (ok)');
    }

    newDb.exec('DETACH DATABASE old');
    newDb.close();

    log(`  New spxer.db: ${fileSize(SPXER_DB)}`);
  } else {
    log('  [dry-run] Would create fresh spxer.db and copy live data');
  }

  // Step 6: Drop live-only tables from replay.db
  log('Step 6: Dropping live tables from replay.db...');
  if (!DRY_RUN) {
    const rdb = new Database(REPLAY_DB);
    rdb.pragma('busy_timeout = 10000');
    for (const table of ['bars', 'contracts', 'schwab_tokens']) {
      try {
        rdb.exec(`DROP TABLE IF EXISTS ${table}`);
        log(`  Dropped ${table} from replay.db`);
      } catch (e) {
        log(`  Could not drop ${table}: ${e}`);
      }
    }
    // Keep instrument_profiles in replay.db too — backfill scripts need it
    // (or they can read from live DB via ATTACH). For now, keep a copy.
    rdb.close();
    log(`  replay.db after cleanup: ${fileSize(REPLAY_DB)}`);
  } else {
    log('  [dry-run] Would drop bars, contracts, schwab_tokens from replay.db');
  }

  // Step 7: Verify
  log('Step 7: Verification...');
  if (!DRY_RUN) {
    // Verify spxer.db
    const liveDb = new Database(SPXER_DB, { readonly: true });
    const liveTables = liveDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const liveBars = (liveDb.prepare('SELECT COUNT(*) as cnt FROM bars').get() as { cnt: number }).cnt;
    liveDb.close();
    log(`  spxer.db tables: ${liveTables.map(t => t.name).join(', ')}`);
    log(`  spxer.db bars: ${liveBars}`);

    // Verify replay.db
    const replayDb = new Database(REPLAY_DB, { readonly: true });
    const replayTables = replayDb.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const configCount = (replayDb.prepare('SELECT COUNT(*) as cnt FROM replay_configs').get() as { cnt: number }).cnt;
    replayDb.close();
    log(`  replay.db tables: ${replayTables.map(t => t.name).join(', ')}`);
    log(`  replay.db configs: ${configCount}`);

    log('');
    log(`RESULT:`);
    log(`  spxer.db: ${fileSize(SPXER_DB)} (live trading)`);
    log(`  replay.db: ${fileSize(REPLAY_DB)} (replay/backfill)`);
  }

  // Step 8: Restart PM2
  if (!SKIP_PM2 && !DRY_RUN) {
    log('Step 8: Restarting PM2 processes...');
    try {
      execSync('pm2 start spxer replay-viewer', { stdio: 'pipe' });
      log('  Started spxer, replay-viewer');
      log('  NOTE: spxer-agent left stopped — start manually when ready');
    } catch (e) {
      log(`  PM2 restart failed: ${e}. Start manually: pm2 start spxer replay-viewer`);
    }
  }

  log('');
  log(DRY_RUN
    ? 'Dry run complete. Pass --execute to perform the migration.'
    : 'Migration complete!'
  );
}

main();
