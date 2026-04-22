/**
 * daily-backfill.ts — Scheduled daily backfill for live-tradable profiles.
 *
 * Designed to run as a PM2 cron process at 4:30 PM ET (20:30 UTC EDT / 21:30 UTC EST).
 * For each profile with can_go_live=1 (and the SPX/default fallback), copy the
 * live `bars` table into `replay_bars` for today's date, build MTFs, and
 * (for SPX only, for now) kick off replays via the backfill worker.
 *
 * Strategy per-profile:
 *   1. First, try to copy from the LIVE `bars` table (already collected by the data service)
 *      into `replay_bars` — this includes all contracts + all timeframes + indicators.
 *   2. Only if no live data exists, fall back to the backfill-worker which fetches
 *      the underlying from Polygon and the options from the profile-routed vendor.
 *   3. After populating replay_bars, run build-mtf-bars to ensure multi-TF bars + indicators.
 *
 * Usage:
 *   npx tsx scripts/backfill/daily-backfill.ts                              # today, all live profiles
 *   npx tsx scripts/backfill/daily-backfill.ts 2026-04-18                   # specific date
 *   npx tsx scripts/backfill/daily-backfill.ts --force                      # force re-backfill even if data exists
 *   npx tsx scripts/backfill/daily-backfill.ts --profile=spx-0dte           # single profile only
 *   npx tsx scripts/backfill/daily-backfill.ts --profiles=spx-0dte,ndx-0dte # explicit profile set
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { initDb, getDb, closeDb } from '../../src/storage/db';
import { listProfiles, loadProfile } from '../../src/instruments/profile-store';
import type { StoredInstrumentProfile } from '../../src/instruments/profile-store';

/** Day-scoped live DB: data/live/YYYY-MM-DD.db (resolved per-date below). */
function liveDbPath(date: string): string {
  const dir = path.resolve(__dirname, '../../data/live');
  return path.join(dir, `${date}.db`);
}

/** Fallback: old monolithic spxer.db (for dates before day-scoped migration). */
const LEGACY_LIVE_DB = path.resolve(__dirname, '../../data/spxer.db');

/** Replay metadata + replay_bars destination (always spxer.db). */
const DB_PATH = path.resolve(process.env.DB_PATH || path.resolve(__dirname, '../../data/spxer.db'));

/** Resolve the best live DB for a given date — day-scoped first, legacy fallback. */
function resolveLiveDb(date: string): string {
  const dayScoped = liveDbPath(date);
  if (fs.existsSync(dayScoped)) return dayScoped;
  return LEGACY_LIVE_DB;
}

// ── Determine today's date in ET ─────────────────────────────────────────────

function todayET(): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // 'YYYY-MM-DD'
}

function isWeekend(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  return d.getDay() === 0 || d.getDay() === 6;
}

/** Get timestamp range for a given date (UTC day boundaries that cover ET trading hours) */
function dateRange(date: string): { start: number; end: number } {
  return {
    start: Math.floor(new Date(date + 'T09:00:00Z').getTime() / 1000),
    end: Math.floor(new Date(date + 'T22:00:00Z').getTime() / 1000),
  };
}

/** Check if replay_bars has COMPLETE data for this profile on this date. */
function hasCompleteData(profile: StoredInstrumentProfile, date: string): boolean {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const { start, end } = dateRange(date);
    const optionLike = `${profile.optionPrefix}%`;

    const underlying = db.prepare(`
      SELECT COUNT(*) as cnt FROM replay_bars
      WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(profile.underlyingSymbol, start, end) as { cnt: number };
    if ((underlying?.cnt || 0) < 50) return false;

    // Need option 3m bars (the timeframe configs use for signals)
    const opt3m = db.prepare(`
      SELECT COUNT(*) as cnt FROM replay_bars
      WHERE symbol LIKE ? AND timeframe = '3m' AND ts >= ? AND ts <= ?
    `).get(optionLike, start, end) as { cnt: number };
    if ((opt3m?.cnt || 0) < 100) return false;

    // Need option contracts
    const contracts = db.prepare(`
      SELECT COUNT(DISTINCT symbol) as cnt FROM replay_bars
      WHERE symbol LIKE ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(optionLike, start, end) as { cnt: number };
    if ((contracts?.cnt || 0) < 100) return false;

    return true;
  } finally {
    db.close();
  }
}

/** Check how much data the live `bars` table has for this profile on this date. */
function liveDataStats(profile: StoredInstrumentProfile, date: string): {
  underlyingBars: number; contracts: number; totalBars: number; timeframes: string[];
} {
  const livePath = resolveLiveDb(date);
  console.log(`  Live DB: ${livePath}`);
  const db = new Database(livePath, { readonly: true });
  try {
    const { start, end } = dateRange(date);
    const optionLike = `${profile.optionPrefix}%`;

    const underlying = db.prepare(`
      SELECT COUNT(*) as cnt FROM bars
      WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(profile.underlyingSymbol, start, end) as { cnt: number };

    const contracts = db.prepare(`
      SELECT COUNT(DISTINCT symbol) as cnt FROM bars
      WHERE symbol LIKE ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(optionLike, start, end) as { cnt: number };

    const totalBars = db.prepare(`
      SELECT COUNT(*) as cnt FROM bars
      WHERE (symbol = ? OR symbol LIKE ?) AND ts >= ? AND ts <= ?
    `).get(profile.underlyingSymbol, optionLike, start, end) as { cnt: number };

    const tfs = db.prepare(`
      SELECT DISTINCT timeframe FROM bars
      WHERE (symbol = ? OR symbol LIKE ?) AND ts >= ? AND ts <= ? ORDER BY timeframe
    `).all(profile.underlyingSymbol, optionLike, start, end) as { timeframe: string }[];

    return {
      underlyingBars: underlying?.cnt || 0,
      contracts: contracts?.cnt || 0,
      totalBars: totalBars?.cnt || 0,
      timeframes: tfs.map(t => t.timeframe),
    };
  } finally {
    db.close();
  }
}

/**
 * Copy data from the live `bars` table to `replay_bars` for a given profile + date.
 * We filter to the profile's underlying + its options chain so parallel copies
 * for different profiles don't stomp each other.
 */
function copyLiveToReplay(profile: StoredInstrumentProfile, date: string): {
  underlyingBars: number; contracts: number; totalBars: number;
} {
  // Open spxer.db for writes (replay_bars table), attach the day-scoped live DB
  const livePath = resolveLiveDb(date);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 10000');
  db.exec(`ATTACH DATABASE '${livePath}' AS live`);

  try {
    const { start, end } = dateRange(date);
    const optionLike = `${profile.optionPrefix}%`;

    // Ensure replay_bars table exists with indicator columns
    db.exec(`
      CREATE TABLE IF NOT EXISTS replay_bars (
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
        created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
        source      TEXT NOT NULL DEFAULT 'polygon'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_bars_symbol_tf_ts
        ON replay_bars(symbol, timeframe, ts);
    `);

    const replayColumns = new Set(
      (db.prepare("PRAGMA table_info(replay_bars)").all() as any[]).map(r => r.name),
    );
    const barsColumns = new Set(
      (db.prepare("PRAGMA table_info(live.bars)").all() as any[]).map(r => r.name),
    );

    const indicatorCols = ['hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
      'ema9', 'ema21', 'rsi14', 'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
      'atr14', 'atrPct', 'vwap', 'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
    ].filter(c => replayColumns.has(c) && barsColumns.has(c));

    const indColsSelect = indicatorCols.length > 0 ? ', ' + indicatorCols.join(', ') : '';

    // Delete existing rows for this profile in this date (clean slate for the profile's scope only)
    const deleted = db.prepare(`
      DELETE FROM replay_bars
      WHERE (symbol = ? OR symbol LIKE ?) AND ts >= ? AND ts <= ?
    `).run(profile.underlyingSymbol, optionLike, start, end);
    if (deleted.changes > 0) {
      console.log(`  Cleared ${deleted.changes} existing replay_bars rows for ${profile.id} ${date}`);
    }

    // Copy profile-scoped slice from live.bars → replay_bars
    const result = db.prepare(`
      INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source${indColsSelect})
      SELECT symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, 'live'${indColsSelect}
      FROM live.bars
      WHERE (symbol = ? OR symbol LIKE ?) AND ts >= ? AND ts <= ?
    `).run(profile.underlyingSymbol, optionLike, start, end);

    const u = db.prepare(`
      SELECT COUNT(*) as cnt FROM replay_bars
      WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(profile.underlyingSymbol, start, end) as { cnt: number };

    const c = db.prepare(`
      SELECT COUNT(DISTINCT symbol) as cnt FROM replay_bars
      WHERE symbol LIKE ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    `).get(optionLike, start, end) as { cnt: number };

    return {
      underlyingBars: u?.cnt || 0,
      contracts: c?.cnt || 0,
      totalBars: result.changes,
    };
  } finally {
    db.exec('DETACH DATABASE live');
    db.close();
  }
}

/** Run build-mtf-bars for the profile on this date. */
function runBuildMtfBars(profile: StoredInstrumentProfile, date: string): Promise<number> {
  return new Promise((resolve) => {
    const script = path.resolve(__dirname, 'build-mtf-bars.ts');
    console.log(`  Running build-mtf-bars for ${profile.id} ${date}...`);
    const child = spawn('npx', ['tsx', script, `--profile=${profile.id}`, date], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('close', (code) => resolve(code || 0));
  });
}

/**
 * Run the profile-aware backfill-worker (fallback when no live data exists).
 */
function runWorkerBackfill(profile: StoredInstrumentProfile, date: string): Promise<number> {
  return new Promise((resolve) => {
    const jobId = `daily-${profile.id}-${date}-${Date.now()}`;
    const jobDir = path.resolve(__dirname, '../../data/jobs');
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

    const jobFile = path.join(jobDir, `backfill-${jobId}.json`);
    const statusFile = path.join(jobDir, `backfill-${jobId}-status.json`);

    fs.writeFileSync(jobFile, JSON.stringify({
      jobId, date, dbPath: DB_PATH, statusFile, profileId: profile.id,
    }));

    const workerScript = path.resolve(__dirname, 'backfill-worker.ts');
    const child = spawn('npx', ['tsx', workerScript, jobFile], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'inherit',
      env: { ...process.env },
    });

    child.on('close', (code) => {
      try {
        const st = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
        console.log(`  ${profile.underlyingSymbol} bars: ${st.spxBars}`);
        console.log(`  Option contracts: ${st.optionContracts}`);
        console.log(`  Option bars: ${st.optionBars}`);
        console.log(`  MTF bars: ${st.mtfBarsWritten ?? 0}`);
      } catch {}
      resolve(code || 0);
    });
  });
}

// ── Profile selection ────────────────────────────────────────────────────────

function resolveProfilesToRun(): StoredInstrumentProfile[] {
  const args = process.argv.slice(2);
  // initDb opens spxer.db for instrument_profiles (profiles aren't in day-scoped DBs)
  initDb(DB_PATH);
  try {
    const oneFlag = args.find(a => a.startsWith('--profile='))?.split('=')[1];
    const manyFlag = args.find(a => a.startsWith('--profiles='))?.split('=')[1];

    if (oneFlag) {
      const p = loadProfile(getDb() as any, oneFlag);
      if (!p) { console.error(`Profile '${oneFlag}' not found`); process.exit(1); }
      return [p];
    }
    if (manyFlag) {
      const ids = manyFlag.split(',').map(s => s.trim()).filter(Boolean);
      const loaded: StoredInstrumentProfile[] = [];
      for (const id of ids) {
        const p = loadProfile(getDb() as any, id);
        if (!p) { console.error(`Profile '${id}' not found`); process.exit(1); }
        loaded.push(p);
      }
      return loaded;
    }
    // Default: ALL profiles that have replay data (underlying bars in replay_bars).
    // Backfilling is useful for backtesting even if not trading live yet.
    // Profiles with no data at all (e.g. TSLA with 0 bars) are skipped.
    const all = listProfiles(getDb() as any);
    const rdb = new Database(DB_PATH, { readonly: true });
    const withData = all.filter(p => {
      const row = rdb.prepare(
        `SELECT COUNT(*) as cnt FROM replay_bars WHERE symbol = ? AND timeframe = '1m' LIMIT 1`
      ).get(p.underlyingSymbol) as { cnt: number };
      return (row?.cnt || 0) > 0;
    });
    rdb.close();
    if (withData.length === 0) {
      // Safety net for fresh installs: fall back to SPX explicitly so daily-backfill
      // never no-ops silently on a pristine DB.
      const spx = loadProfile(getDb() as any, 'spx-0dte');
      return spx ? [spx] : [];
    }
    return withData;
  } finally {
    closeDb();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runForProfile(profile: StoredInstrumentProfile, date: string, force: boolean): Promise<void> {
  console.log(`\n━━━ [${profile.id}] ${profile.displayName} ━━━`);

  if (!force && hasCompleteData(profile, date)) {
    console.log(`  Skipping — already have complete replay data for ${profile.id} ${date}`);
    return;
  }

  // Strategy 1: Copy from live `bars` table.
  const live = liveDataStats(profile, date);
  console.log(`  Live bars table: ${live.underlyingBars} ${profile.underlyingSymbol} bars, ${live.contracts} contracts, ${live.totalBars} total, TFs: [${live.timeframes.join(', ')}]`);

  if (live.underlyingBars > 50 && live.contracts > 50) {
    console.log(`  Copying live data → replay_bars...`);
    const result = copyLiveToReplay(profile, date);
    console.log(`  ✓ Copied ${result.totalBars} bars (${result.underlyingBars} ${profile.underlyingSymbol}, ${result.contracts} contracts)`);

    if (!live.timeframes.includes('3m') || !live.timeframes.includes('5m')) {
      console.log(`  Building multi-TF bars (live data missing 3m/5m)...`);
      await runBuildMtfBars(profile, date);
    } else {
      console.log(`  Multi-TF bars already present in live data ✓`);
    }
    return;
  }

  // Strategy 2: Profile-aware backfill worker (Polygon + ThetaData as routed).
  console.log(`  No live data for ${profile.id} — falling back to backfill-worker...`);
  if (!process.env.POLYGON_API_KEY) {
    console.error('  POLYGON_API_KEY not set — cannot run backfill-worker');
    return;
  }
  const code = await runWorkerBackfill(profile, date);
  if (code !== 0) {
    console.error(`  ✗ backfill-worker failed for ${profile.id} (exit ${code})`);
    return;
  }
  // Worker already runs MTF build internally (Phase 2.5) — no extra step needed.
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || todayET();

  console.log(`[daily-backfill] ${new Date().toISOString()}`);
  console.log(`  Target date: ${date}${force ? ' (forced)' : ''}`);

  if (isWeekend(date)) {
    console.log(`  Skipping — ${date} is a weekend`);
    process.exit(0);
  }

  const profiles = resolveProfilesToRun();
  console.log(`  Profiles: ${profiles.map(p => p.id).join(', ')}`);

  for (const p of profiles) {
    try {
      await runForProfile(p, date, force);
    } catch (e: any) {
      console.error(`[daily-backfill] ✗ ${p.id}: ${e.message}`);
    }
  }

  // Run bar quality comparison (live vs backfill)
  console.log(`\n━━━ [quality-report] Comparing live bars vs backfill ━━━`);
  try {
    const reportScript = path.resolve(__dirname, 'bar-quality-report.ts');
    const { execFileSync } = require('child_process');
    execFileSync('npx', ['tsx', reportScript, date], {
      cwd: path.resolve(__dirname, '../..'),
      stdio: 'inherit',
      env: { ...process.env },
      timeout: 60_000,
    });
  } catch (e: any) {
    console.error(`[daily-backfill] Quality report failed: ${e.message}`);
  }

  console.log(`\n[daily-backfill] ✓ Done for ${date}`);
  process.exit(0);
}

main().catch(e => {
  console.error('[daily-backfill] Fatal:', e);
  process.exit(1);
});
