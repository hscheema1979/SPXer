import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { seedCodeProfiles } from '../instruments/seed-profiles';
import { refreshRegistryCache } from '../instruments/registry';
import { MARKET_HOLIDAYS } from '../config';

let db: DB;
let currentDbPath: string = '';
let walTimers: ReturnType<typeof setInterval>[] = [];

/** Returns the path of the currently opened DB (set by initDb). */
export function getDbPath(): string { return currentDbPath; }

export function initDb(dbPath: string): void {
  if (db) {
    try { db.close(); } catch {}
  }
  for (const t of walTimers) clearInterval(t);
  walTimers = [];

  currentDbPath = dbPath;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Auto-checkpoint every 1000 pages (~4MB): SQLite automatically runs a PASSIVE checkpoint
  // inline with writes once the WAL reaches this size. PASSIVE never blocks readers or writers.
  // better-sqlite3 is fully synchronous so there is no "event loop blocking" concern —
  // every DB call already blocks. This keeps WAL bounded without a manual interval.
  db.pragma('wal_autocheckpoint = 1000');
  db.pragma('synchronous = NORMAL');   // Faster writes, still durable with WAL
  db.pragma('busy_timeout = 5000');     // Wait 5s on lock instead of failing immediately
  db.pragma('cache_size = -64000');     // 64MB cache (negative = KB)
  db.pragma('temp_store = MEMORY');     // Temp tables in memory
  runMigrations();
  runInstrumentProfileMigrations();
  // Seed / refresh instrument profiles from code. Live-tradable profiles
  // (SPX today) are overwritten on every boot so behavior stays git-traceable;
  // backtest-only profiles are insert-if-absent so UI edits persist.
  try {
    seedCodeProfiles(db);
    refreshRegistryCache(db);
  } catch (err) {
    console.error('[db] seed instrument_profiles failed:', err);
  }

  // WAL management — two strategies:
  //
  // 1. Every 15 min: PASSIVE checkpoint (non-blocking, flushes committed pages)
  // 2. Every 2 hours: TRUNCATE checkpoint (resets WAL file to zero)
  //    Uses RESTART first to flush all pages, then TRUNCATE.
  //    If readers block TRUNCATE, falls back to RESTART (which still shrinks WAL).
  //
  // The old hourly TRUNCATE was always skipped because other processes (metrics,
  // dashboard, agents) hold open read connections. RESTART+TRUNCATE is more aggressive.

  walTimers.push(setInterval(() => {
    try {
      const d = getDb();
      const result = d.pragma('wal_checkpoint(PASSIVE)') as Array<{busy: number; log: number; checkpointed: number}>;
      const { log, checkpointed } = result[0] ?? { log: 0, checkpointed: 0 };
      if (log > 0) {
        console.log(`[db] WAL passive checkpoint: ${checkpointed}/${log} pages flushed`);
      }
    } catch (err) {
      console.error('[db] WAL passive checkpoint failed:', err);
    }
  }, 15 * 60 * 1000));

  walTimers.push(setInterval(() => {
    try {
      const d = getDb();
      const before = getDbStats();

      // Skip if WAL is already small
      if (before.walSizeMb < 50) {
        console.log(`[db] WAL is ${before.walSizeMb}MB — truncate not needed`);
        return;
      }

      // Try TRUNCATE directly (resets WAL file to zero)
      try {
        d.pragma('wal_checkpoint(TRUNCATE)');
        const after = getDbStats();
        console.log(`[db] WAL truncated: ${before.walSizeMb}MB → ${after.walSizeMb}MB`);
        return;
      } catch {
        // TRUNCATE failed (readers blocking) — fall back to RESTART
      }

      // RESTART flushes all pages and resets but doesn't truncate the file
      try {
        d.pragma('wal_checkpoint(RESTART)');
        const after = getDbStats();
        console.log(`[db] WAL restart checkpoint: ${before.walSizeMb}MB → ${after.walSizeMb}MB (truncate blocked by readers)`);
      } catch (err) {
        console.warn(`[db] WAL restart checkpoint failed: ${err}`);
      }
    } catch (err) {
      console.error('[db] WAL truncate cycle failed:', err);
    }
  }, 2 * 60 * 60 * 1000));

  // Backups disabled (2026-04-18) — at 41GB the source DB is too large for
  // better-sqlite3's online backup. A single run bloated the backup WAL to
  // 31GB and filled the disk, causing live writes to fail with "readonly
  // database". If reintroduced, do it out-of-process via `sqlite3 .backup`
  // to a different filesystem.
  // setInterval(() => backupDb(), 24 * 60 * 60 * 1000);
  // setTimeout(() => backupDb(), 10_000);
}

export function getDb(): DB {
  if (!db) throw new Error('DB not initialized');
  return db;
}

export function getCurrentDbPath(): string {
  return currentDbPath;
}

export function closeDb(): void {
  for (const t of walTimers) clearInterval(t);
  walTimers = [];
  if (db) db.close();
  db = undefined as any;
}

// ── Day-scoped live DB helpers ──

/** Returns `data/live/YYYY-MM-DD.db` and ensures the directory exists. */
export function dayDbPath(dateET: string): string {
  const dir = path.resolve('data', 'live');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${dateET}.db`);
}

/** Walk backward from dateET skipping weekends + holidays to find the previous trading day. */
export function previousTradingDay(dateET: string): string {
  const d = new Date(dateET + 'T12:00:00Z'); // noon UTC to avoid DST edge
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6 && !MARKET_HOLIDAYS.has(iso)) {
      return iso;
    }
  }
  // Fallback — just return 1 day prior (shouldn't happen with 10-day lookback)
  return new Date(new Date(dateET + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
}

/**
 * Copy the last N bars per symbol/timeframe from a previous day's DB into the
 * current (freshly-created) DB. This primes indicator warmup so HMA/RSI/EMA
 * start from a meaningful state instead of zero.
 *
 * Uses ATTACH + INSERT OR IGNORE — safe to call multiple times (mid-day restarts).
 */
export function copyWarmupBars(prevDbPath: string, n = 50): number {
  if (!fs.existsSync(prevDbPath)) {
    console.warn(`[db] No previous DB at ${prevDbPath} — indicators will warm from scratch`);
    return 0;
  }

  const d = getDb();
  try {
    d.exec(`ATTACH DATABASE '${prevDbPath}' AS prev`);
    const result = d.exec(`
      INSERT OR IGNORE INTO bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, spread)
      SELECT symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, spread
      FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol, timeframe ORDER BY ts DESC) AS rn
        FROM prev.bars
      ) ranked
      WHERE rn <= ${n}
    `);
    d.exec('DETACH DATABASE prev');

    // Count what we copied
    const count = (d.prepare('SELECT COUNT(*) as c FROM bars').get() as any).c;
    console.log(`[db] Warmup: copied up to ${n} bars/series from ${path.basename(prevDbPath)} → ${count} total rows`);
    return count;
  } catch (err) {
    console.error('[db] copyWarmupBars failed:', err);
    try { d.exec('DETACH DATABASE prev'); } catch {}
    return 0;
  }
}

/** @deprecated ConfigManager removed — configs live in replay_configs via ReplayStore */

export function backupDb(): void {
  try {
    const d = getDb();
    const backupPath = (currentDbPath || './data/spxer.db') + '.backup';
    d.backup(backupPath);
    console.log(`[db] backup complete: ${backupPath}`);
  } catch (err) {
    console.error('[db] backup failed:', err);
  }
}

export function getDbStats(): { sizeMb: number; walSizeMb: number } {
  const dbPath = currentDbPath || process.env.DB_PATH || './data/spxer.db';
  const sizeMb = fs.existsSync(dbPath) ? fs.statSync(dbPath).size / (1024 * 1024) : 0;
  const walPath = dbPath + '-wal';
  const walSizeMb = fs.existsSync(walPath) ? fs.statSync(walPath).size / (1024 * 1024) : 0;
  return { sizeMb: Math.round(sizeMb * 10) / 10, walSizeMb: Math.round(walSizeMb * 10) / 10 };
}

function runMigrations(): void {
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS signals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol          TEXT NOT NULL,
      strike          REAL NOT NULL,
      expiry          TEXT NOT NULL,
      side            TEXT NOT NULL,
      direction       TEXT NOT NULL,
      offset_label    TEXT NOT NULL,
      hma_fast        INTEGER NOT NULL,
      hma_slow        INTEGER NOT NULL,
      hma_fast_val    REAL NOT NULL,
      hma_slow_val    REAL NOT NULL,
      timeframe       TEXT NOT NULL DEFAULT '1m',
      price           REAL NOT NULL,
      ts              INTEGER NOT NULL,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_signals_ts
      ON signals(ts);
    CREATE INDEX IF NOT EXISTS idx_signals_offset_tf
      ON signals(offset_label, timeframe, ts);
  `);

  // Additive migration: bar-level bid-ask spread for friction modeling (Task 2.3a).
  // SQLite ALTER TABLE ADD COLUMN is idempotent-safe only via try/catch.
  try {
    const cols = db.prepare(`PRAGMA table_info(bars)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'spread')) {
      db.exec(`ALTER TABLE bars ADD COLUMN spread REAL`);
    }
  } catch (err) {
    console.error('[db] migration: failed to add bars.spread column', err);
  }
}

let accountDb: DB | null = null;
const ACCOUNT_DB_PATH = path.resolve('data', 'account.db');

export function initAccountDb(dbPath?: string): void {
  const p = dbPath || ACCOUNT_DB_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  accountDb = new Database(p);
  accountDb.pragma('journal_mode = WAL');
  accountDb.pragma('foreign_keys = ON');
  accountDb.pragma('wal_autocheckpoint = 1000');
  accountDb.pragma('synchronous = NORMAL');
  accountDb.pragma('busy_timeout = 5000');
  accountDb.pragma('cache_size = -16000');
  runAccountMigrations();
}

export function getAccountDb(): DB {
  if (!accountDb) throw new Error('Account DB not initialized — call initAccountDb() first');
  return accountDb;
}

export function closeAccountDb(): void {
  if (accountDb) { accountDb.close(); accountDb = null; }
}

function runAccountMigrations(): void {
  if (!accountDb) return;
  accountDb.exec(`
    CREATE TABLE IF NOT EXISTS positions (
      id              TEXT PRIMARY KEY,
      config_id       TEXT NOT NULL,
      symbol          TEXT NOT NULL,
      side            TEXT NOT NULL,
      strike          REAL NOT NULL,
      expiry          TEXT NOT NULL,
      entry_price     REAL NOT NULL DEFAULT 0,
      quantity        INTEGER NOT NULL DEFAULT 0,
      stop_loss       REAL NOT NULL DEFAULT 0,
      take_profit     REAL NOT NULL DEFAULT 0,
      high_water      REAL NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'OPENING',
      opened_at       INTEGER NOT NULL,
      closed_at       INTEGER,
      close_reason    TEXT,
      close_price     REAL,
      basket_member   TEXT,
      reentry_depth   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_positions_config_status
      ON positions(config_id, status);
    CREATE INDEX IF NOT EXISTS idx_positions_status
      ON positions(status);
    CREATE INDEX IF NOT EXISTS idx_positions_symbol_status
      ON positions(symbol, status);

    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      position_id     TEXT NOT NULL,
      tradier_id      INTEGER,
      bracket_id      INTEGER,
      tp_leg_id       INTEGER,
      sl_leg_id       INTEGER,
      side            TEXT NOT NULL,
      order_type      TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      fill_price      REAL,
      quantity        INTEGER NOT NULL DEFAULT 0,
      error           TEXT,
      submitted_at    INTEGER NOT NULL,
      filled_at       INTEGER,
      created_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_orders_position_id
      ON orders(position_id);
    CREATE INDEX IF NOT EXISTS idx_orders_tradier_id
      ON orders(tradier_id);

    CREATE TABLE IF NOT EXISTS config_state (
      config_id       TEXT PRIMARY KEY,
      daily_pnl       REAL NOT NULL DEFAULT 0,
      trades_completed INTEGER NOT NULL DEFAULT 0,
      last_entry_ts   INTEGER NOT NULL DEFAULT 0,
      session_signal_count INTEGER NOT NULL DEFAULT 0,
      updated_at      INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

// Replay tables (replay_configs, replay_runs, replay_results, replay_jobs,
// leaderboard_reports, optimizer_results) are managed by src/storage/replay-db.ts
// which provides migrations and connection helpers. All tables live in spxer.db.

/**
 * instrument_profiles — DB-backed store of tradable-instrument metadata.
 *
 * See docs/UNIVERSAL-BACKFILL.md. Profiles in src/instruments/profiles/*.ts
 * are seeds — on first boot they're written into this table. Runtime code
 * reads from the DB. Live-tradable profiles (can_go_live=1) are overwritten
 * from code on every boot to keep live behavior git-traceable.
 *
 * Vendor routing (underlying + options) is stored as JSON so we can extend
 * without further migrations as new vendors are added.
 */
function runInstrumentProfileMigrations(): void {
  db.exec(`
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
  `);
}

// replay_jobs migrations removed — now handled by replay-db.ts
