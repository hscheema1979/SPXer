/**
 * backfill-worker.ts — Detached worker that backfills a single date's SPX + options
 * data into replay_bars.
 *
 * Data sources:
 *   - SPX underlying: Polygon (I:SPX index aggregates)
 *   - Options: ThetaData (fetchOptionTimesales via local ThetaTerminal)
 *
 * Polygon options data was missing volume/trade detail; ThetaData delivers
 * OPRA-consolidated tick-level 1m OHLC which matches what the live stream
 * now collects.
 *
 * Spawned by the replay viewer's POST /replay/api/backfill endpoint.
 * Reads a JSON job spec from argv, writes progress to a status file.
 *
 * Usage: npx tsx scripts/backfill/backfill-worker.ts <job-file.json>
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import Database from 'better-sqlite3';
import { fetchOptionTimesales } from '../../src/providers/thetadata';
import { buildMtfForSymbol, SUPPORTED_TIMEFRAMES } from '../../src/pipeline/mtf-builder';
import { loadProfile } from '../../src/instruments/profile-store';

interface BackfillJobSpec {
  jobId: string;
  date: string;
  dbPath: string;
  statusFile: string;
  /**
   * Optional — defaults to SPX. When set, backfill runs for the named instrument
   * profile (e.g. "spx-0dte", "ndx-0dte"). Controls underlying source, options
   * root prefix, strike interval, and strike band width.
   */
  profileId?: string;
}

/** Per-instrument backfill config resolved from a profile id (or defaults). */
interface BackfillTarget {
  /** OCC root prefix for option symbols (SPXW, NDXP, SPY, QQQ, …). */
  prefix: string;
  /** Polygon ticker for underlying bars (I:SPX, I:NDX, SPY, QQQ). */
  underlyingPolygonTicker: string;
  /** Internal DB symbol for underlying (SPX, NDX, SPY, QQQ). */
  underlyingDbSymbol: string;
  /** Strike step in dollars (5 for SPXW, 10 for NDXP, 1 for SPY/QQQ). */
  strikeInterval: number;
  /** Half-width of strike band in dollars (±100 for SPX, ±500 for NDX, ±5 for SPY). */
  bandHalfWidthDollars: number;
}

function resolveTarget(profileId?: string): BackfillTarget {
  switch (profileId) {
    case 'ndx-0dte':
      return {
        prefix: 'NDXP',
        underlyingPolygonTicker: 'I:NDX',
        underlyingDbSymbol: 'NDX',
        strikeInterval: 10,
        bandHalfWidthDollars: 500,
      };
    case 'spy-1dte':
      return {
        prefix: 'SPY',
        underlyingPolygonTicker: 'SPY',
        underlyingDbSymbol: 'SPY',
        strikeInterval: 1,
        bandHalfWidthDollars: 10,
      };
    case 'qqq-1dte':
      return {
        prefix: 'QQQ',
        underlyingPolygonTicker: 'QQQ',
        underlyingDbSymbol: 'QQQ',
        strikeInterval: 1,
        bandHalfWidthDollars: 10,
      };
    case 'tsla':
      return {
        prefix: 'TSLA',
        underlyingPolygonTicker: 'TSLA',
        underlyingDbSymbol: 'TSLA',
        strikeInterval: 2.5,
        bandHalfWidthDollars: 10,
      };
    case 'nvda':
      return {
        prefix: 'NVDA',
        underlyingPolygonTicker: 'NVDA',
        underlyingDbSymbol: 'NVDA',
        strikeInterval: 2.5,
        bandHalfWidthDollars: 10,
      };
    case 'spx-0dte':
    case undefined:
    default:
      return {
        prefix: 'SPXW',
        underlyingPolygonTicker: 'I:SPX',
        underlyingDbSymbol: 'SPX',
        strikeInterval: 5,
        bandHalfWidthDollars: 100,
      };
  }
}

interface ReplayProgress {
  configId: string;
  configName: string;
  status: 'pending' | 'running' | 'done' | 'error';
  trades?: number;
  pnl?: number;
  error?: string;
}

interface BackfillStatus {
  jobId: string;
  date: string;
  status: 'running' | 'completed' | 'failed';
  phase: string;
  spxBars: number;
  optionContracts: number;
  optionBars: number;
  /** Bars written by the MTF + indicator build (aggregates + 1m denorm cols). */
  mtfBarsWritten: number;
  errors: string[];
  replay: {
    total: number;
    completed: number;
    configs: ReplayProgress[];
  };
  startedAt: number;
  completedAt?: number;
}

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';

if (!POLYGON_KEY) {
  console.error('POLYGON_API_KEY not set in .env');
  process.exit(1);
}

// ── Read job spec ────────────────────────────────────────────────────────────

const jobFile = process.argv[2];
if (!jobFile || !fs.existsSync(jobFile)) {
  console.error('[backfill-worker] Missing or invalid job file:', jobFile);
  process.exit(1);
}

const spec: BackfillJobSpec = JSON.parse(fs.readFileSync(jobFile, 'utf-8'));
const { jobId, date, dbPath, statusFile } = spec;
const target = resolveTarget(spec.profileId);

const status: BackfillStatus = {
  jobId,
  date,
  status: 'running',
  phase: 'starting',
  spxBars: 0,
  optionContracts: 0,
  optionBars: 0,
  mtfBarsWritten: 0,
  errors: [],
  replay: { total: 0, completed: 0, configs: [] },
  startedAt: Date.now(),
};

function writeStatus() {
  fs.writeFileSync(statusFile, JSON.stringify(status));
}

// ── DST handling ─────────────────────────────────────────────────────────────

function isDST(d: string): boolean {
  const dt = new Date(d + 'T12:00:00Z');
  const month = dt.getMonth();
  const day = dt.getDate();
  if (month < 2 || month > 10) return false;
  if (month > 2 && month < 10) return true;
  if (month === 2) return day >= 8;
  return day < 1;
}

// ── Polygon API ──────────────────────────────────────────────────────────────

interface PolygonBar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
}

async function fetchBars(ticker: string, fetchDate: string, retries = 3): Promise<PolygonBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${fetchDate}/${fetchDate}?adjusted=true&sort=asc&limit=50000&apiKey=${POLYGON_KEY}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

      if (res.status === 429) {
        const wait = attempt * 5000;
        console.warn(`  ⚠ Rate limited on ${ticker}, waiting ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json() as any;
      if (!data.results || data.results.length === 0) return [];

      const edt = isDST(fetchDate);
      const utcOffset = edt ? 4 : 5;
      const dayStartMs = new Date(fetchDate + 'T00:00:00Z').getTime();
      const rthStartMs = dayStartMs + (9.5 + utcOffset) * 3600000;
      const rthEndMs = dayStartMs + (16 + utcOffset) * 3600000;

      return data.results
        .filter((b: any) => b.t >= rthStartMs && b.t <= rthEndMs)
        .map((b: any) => ({
          ts: Math.floor(b.t / 1000),
          open: b.o, high: b.h, low: b.l, close: b.c,
          volume: b.v || 0,
        }));
    } catch (e: any) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  return [];
}

// ── Symbol helpers ───────────────────────────────────────────────────────────

function makeDbSymbol(prefix: string, expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4);
  const mm = expiry.slice(5, 7);
  const dd = expiry.slice(8, 10);
  return `${prefix}${yy}${mm}${dd}${side}${(strike * 1000).toString().padStart(8, '0')}`;
}

// ── ThetaData strike-list preflight ──────────────────────────────────────────

/**
 * Fetch the actual listed strikes Theta has for a given root+expiration.
 * Used to intersect with the band-generated strike list so we don't hammer
 * non-existent strikes — those return HTTP 472, trip the circuit breaker after
 * 3 failures, and then every subsequent real strike short-circuits to null,
 * leaving a day with 0 contracts even though the data is available.
 *
 * Bypasses the CB deliberately — single preflight per day; its failure mode
 * should be "fall back to full band", not "open the breaker".
 */
async function fetchThetaStrikes(root: string, expISO: string): Promise<Set<number> | null> {
  const THETA_REST = process.env.THETADATA_REST_URL || 'http://127.0.0.1:25503';
  const url = `${THETA_REST}/v3/option/list/strikes?symbol=${encodeURIComponent(root)}&expiration=${expISO}&format=json`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const arr = data?.response;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const out = new Set<number>();
    for (const row of arr) {
      const s = typeof row?.strike === 'number' ? row.strike : parseFloat(row?.strike);
      if (Number.isFinite(s)) out.add(s);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

// ── ThetaData option fetch (RTH-filtered) ────────────────────────────────────

/**
 * Fetch 1m option OHLC bars from ThetaData, filtered to RTH (9:30-16:00 ET).
 * Mirrors the Polygon fetchBars shape so the rest of the worker is unchanged.
 * Kept available for SPX paths; NDX/SPY/QQQ use the Polygon path below.
 */
async function fetchThetaOptionBars(dbSymbol: string, fetchDate: string): Promise<PolygonBar[]> {
  const raws = await fetchOptionTimesales(dbSymbol, fetchDate);
  if (raws.length === 0) return [];

  const edt = isDST(fetchDate);
  const utcOffset = edt ? 4 : 5;
  const dayStartMs = new Date(fetchDate + 'T00:00:00Z').getTime();
  const rthStartSec = Math.floor((dayStartMs + (9.5 + utcOffset) * 3600_000) / 1000);
  const rthEndSec = Math.floor((dayStartMs + (16 + utcOffset) * 3600_000) / 1000);

  return raws
    .filter((b) => b.ts >= rthStartSec && b.ts <= rthEndSec)
    .map((b) => ({
      ts: b.ts,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume || 0,
    }));
}

// ── Polygon option fetch (RTH-filtered) ──────────────────────────────────────

/**
 * Fetch 1m option OHLC bars from Polygon aggregates.
 * DB format mirrors Polygon's OCC ticker with an 'O:' prefix — e.g.
 *   DB: 'NDXP260417C26500000' → Polygon: 'O:NDXP260417C26500000'
 * Used for NDX/SPY/QQQ backfill; SPX options still use ThetaData.
 */
async function fetchPolygonOptionBars(dbSymbol: string, fetchDate: string): Promise<PolygonBar[]> {
  return fetchBars(`O:${dbSymbol}`, fetchDate);
}

// ── Parallel executor ────────────────────────────────────────────────────────

async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const idx = nextIndex++;
      results[idx] = await fn(items[idx]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill-worker] Starting backfill for ${date}`);
  writeStatus();

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // Ensure replay_bars table exists
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

  // SPX bars → source='polygon' (from I:SPX index aggregates)
  const upsertSpx = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', 'polygon')
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, source='polygon'
  `);

  // Option bars — `source` is parameterized ('thetadata' for SPX, 'polygon' for NDX/SPY/QQQ)
  const upsertOpt = db.prepare(`
    INSERT INTO replay_bars (symbol, timeframe, ts, open, high, low, close, volume, synthetic, gap_type, indicators, source)
    VALUES (?, '1m', ?, ?, ?, ?, ?, ?, 0, NULL, '{}', ?)
    ON CONFLICT(symbol, timeframe, ts) DO UPDATE SET
      open=excluded.open, high=excluded.high, low=excluded.low,
      close=excluded.close, volume=excluded.volume, source=excluded.source
  `);

  // ── Phase 1: SPX underlying ────────────────────────────────────────────────

  status.phase = 'fetching SPX';
  writeStatus();
  console.log(`  Phase 1: Fetching ${target.underlyingDbSymbol} bars for ${date} (profile=${spec.profileId ?? 'spx-0dte'})...`);

  try {
    const spxBars = await fetchBars(target.underlyingPolygonTicker, date);
    if (spxBars.length > 0) {
      db.transaction(() => {
        for (const b of spxBars) {
          upsertSpx.run(target.underlyingDbSymbol, b.ts, b.open, b.high, b.low, b.close, b.volume);
        }
      })();
      status.spxBars = spxBars.length;
      console.log(`  ✓ ${target.underlyingDbSymbol}: ${spxBars.length} bars, close=${spxBars[spxBars.length - 1].close.toFixed(0)}`);
    } else {
      throw new Error(`No ${target.underlyingDbSymbol} data returned for ${date} — may be a holiday`);
    }
  } catch (e: any) {
    status.status = 'failed';
    status.phase = `${target.underlyingDbSymbol} fetch failed`;
    status.errors.push(e.message);
    status.completedAt = Date.now();
    writeStatus();
    db.close();
    console.error(`  ✗ SPX fetch failed: ${e.message}`);
    process.exit(1);
  }

  // ── Phase 2: Options ───────────────────────────────────────────────────────

  status.phase = 'fetching options';
  writeStatus();

  // Get underlying close to determine strike range
  const spxRow = db.prepare(`
    SELECT close FROM replay_bars
    WHERE symbol = ? AND timeframe = '1m' AND ts >= ? AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).get(
    target.underlyingDbSymbol,
    Math.floor(new Date(date + 'T09:00:00Z').getTime() / 1000),
    Math.floor(new Date(date + 'T22:00:00Z').getTime() / 1000),
  ) as { close: number } | undefined;

  if (!spxRow) {
    status.status = 'failed';
    status.phase = `no ${target.underlyingDbSymbol} data found after insert`;
    status.completedAt = Date.now();
    writeStatus();
    db.close();
    process.exit(1);
  }

  const spxClose = spxRow.close;
  const baseStrike = Math.round(spxClose / target.strikeInterval) * target.strikeInterval;
  const minStrike = baseStrike - target.bandHalfWidthDollars;
  const maxStrike = baseStrike + target.bandHalfWidthDollars;

  const strikes: number[] = [];
  for (let s = minStrike; s <= maxStrike; s += target.strikeInterval) strikes.push(s);

  console.log(`  Phase 2: Fetching ${target.prefix} options (${target.underlyingDbSymbol}=${spxClose.toFixed(0)}, strikes=${minStrike}-${maxStrike} step ${target.strikeInterval})...`);

  type Task = { dbSymbol: string };
  const tasks: Task[] = [];
  for (const side of ['C', 'P'] as const) {
    for (const strike of strikes) {
      tasks.push({
        dbSymbol: makeDbSymbol(target.prefix, date, side, strike),
      });
    }
  }

  const CONCURRENCY = 10;

  // Option data source routing:
  //   - SPX (spx-0dte): ThetaData preferred, falls back to Polygon if unavailable
  //   - NDX/SPY/QQQ:    Polygon (covered by existing options subscription)
  let useTheta = (spec.profileId ?? 'spx-0dte') === 'spx-0dte';
  if (useTheta) {
    // Probe ThetaData connectivity — fall back to Polygon if terminal isn't running
    try {
      const net = await import('net');
      await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection(25503, '127.0.0.1');
        sock.setTimeout(2000);
        sock.on('connect', () => { sock.destroy(); resolve(); });
        sock.on('error', reject);
        sock.on('timeout', () => { sock.destroy(); reject(new Error('timeout')); });
      });
    } catch {
      console.log('  [info] ThetaData terminal not available — falling back to Polygon for options');
      useTheta = false;
    }
  }
  const optionSourceLabel = useTheta ? 'thetadata' : 'polygon';
  console.log(`  Options source: ${optionSourceLabel}`);

  await parallelMap(tasks, async (task) => {
    try {
      const bars = useTheta
        ? await fetchThetaOptionBars(task.dbSymbol, date)
        : await fetchPolygonOptionBars(task.dbSymbol, date);
      if (bars.length > 0) {
        db.transaction(() => {
          for (const b of bars) {
            upsertOpt.run(task.dbSymbol, b.ts, b.open, b.high, b.low, b.close, b.volume, optionSourceLabel);
          }
        })();
        status.optionBars += bars.length;
        status.optionContracts++;
      }
    } catch (e: any) {
      status.errors.push(`${task.dbSymbol}: ${e.message}`);
    }
    // Update status periodically
    writeStatus();
  }, CONCURRENCY);

  // ── Phase 2.5: MTF build + indicators (symbol-agnostic) ────────────────────
  //
  // Runs for every profile now. Pre-refactor this was a separate manual step
  // (scripts/backfill/build-mtf-bars.ts) which meant NDX dates got raw 1m
  // bars but never MTFs or denormalized indicator columns. Fold it into the
  // worker so a single job produces fully-replayable coverage.
  status.phase = 'building MTFs + indicators';
  writeStatus();
  console.log(`\n  Phase 2.5: Building MTFs + indicators for ${target.underlyingDbSymbol} + ${status.optionContracts} option contracts...`);

  // Load profile so we know the indicator tier. Falls back to tier 2 for
  // the underlying and tier 1 for options when the profile isn't found
  // (e.g. running against a DB initialized before the seeds existed).
  let profileTier: 1 | 2 = spec.profileId === 'spx-0dte' || spec.profileId === 'ndx-0dte' ? 2 : 2;
  try {
    const profile = loadProfile(db, spec.profileId ?? 'spx-0dte');
    if (profile) profileTier = profile.tier;
  } catch (e: any) {
    console.warn(`  ⚠ could not load profile, defaulting tier=2 for underlying: ${e.message}`);
  }

  // Prior trading day — previous date that has 1m bars for the underlying.
  const priorDateRow = db.prepare(`
    SELECT date(ts, 'unixepoch') AS d
    FROM replay_bars
    WHERE symbol=? AND timeframe='1m' AND date(ts, 'unixepoch') < ?
    ORDER BY ts DESC LIMIT 1
  `).get(target.underlyingDbSymbol, date) as { d: string } | undefined;
  const priorDate = priorDateRow?.d ?? null;

  // Enumerate every symbol with 1m bars on this date that belongs to this
  // profile — underlying + option chain matching the profile's prefix.
  const dayStartSec = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
  const dayEndSec = dayStartSec + 86400 + 3600;
  const symbolsThisDate = (db.prepare(`
    SELECT DISTINCT symbol FROM replay_bars
    WHERE timeframe='1m' AND ts >= ? AND ts < ? AND (symbol=? OR symbol LIKE ?)
    ORDER BY symbol
  `).all(dayStartSec, dayEndSec, target.underlyingDbSymbol, `${target.prefix}%`) as { symbol: string }[])
    .map(r => r.symbol);

  console.log(`  MTF build: ${symbolsThisDate.length} symbols (priorDate=${priorDate ?? 'none'})`);

  for (const symbol of symbolsThisDate) {
    const tier: 1 | 2 = symbol === target.underlyingDbSymbol ? profileTier : 1;
    try {
      const r = buildMtfForSymbol({
        db, symbol, tier, date, priorDate,
        timeframes: SUPPORTED_TIMEFRAMES, recompute1m: true,
      });
      status.mtfBarsWritten += r.barsWritten;
    } catch (e: any) {
      status.errors.push(`mtf:${symbol}: ${e.message}`);
    }
  }
  writeStatus();
  console.log(`  ✓ MTFs built: ${status.mtfBarsWritten} bars written`);

  // ── Phase 3: Run configs (profile-scoped) ──────────────────────────────────
  //
  // Phase 3 runs replays for configs associated with this profile. Today
  // replay_configs has no profile_id column, so we keep the legacy behavior:
  // only SPX gets automated post-backfill replays. Non-SPX profiles finish
  // cleanly here — once Phase 3 of UNIVERSAL-BACKFILL wires profile_id into
  // configs, this gate widens naturally.
  if (spec.profileId && spec.profileId !== 'spx-0dte') {
    status.phase = 'done (no profile-scoped configs registered)';
    status.status = 'completed';
    status.completedAt = Date.now();
    writeStatus();
    db.close();
    const elapsed = ((status.completedAt - status.startedAt) / 1000).toFixed(1);
    console.log(`\n  ✓ Backfill complete for ${target.underlyingDbSymbol} ${date}:`);
    console.log(`    ${target.underlyingDbSymbol}: ${status.spxBars} bars`);
    console.log(`    Options: ${status.optionContracts} contracts, ${status.optionBars} bars`);
    console.log(`    MTFs + indicators: ${status.mtfBarsWritten} bars`);
    console.log(`    Errors: ${status.errors.length}`);
    console.log(`    Elapsed: ${elapsed}s`);
    try { fs.unlinkSync(jobFile); } catch {}
    return;
  }

  status.phase = 'running replays';
  writeStatus();

  console.log(`\n  Phase 3: Running replays for all configs...`);

  // Load configs with 200+ days of results
  const configRows = db.prepare(`
    SELECT c.id, c.name, c.config_json
    FROM replay_configs c
    INNER JOIN replay_results r ON c.id = r.configId
    GROUP BY c.id
    HAVING COUNT(DISTINCT r.date) >= 200
  `).all() as { id: string; name: string; config_json: string }[];

  console.log(`  Found ${configRows.length} configs to replay`);

  status.replay.total = configRows.length;
  status.replay.configs = configRows.map(c => ({
    configId: c.id,
    configName: c.name || c.id,
    status: 'pending' as const,
  }));
  writeStatus();

  db.close(); // Close before replay — runReplay opens its own connections

  // Import runReplay (lazy — avoids loading replay engine during data fetch)
  const { runReplay } = await import('../../src/replay/machine');

  for (let i = 0; i < configRows.length; i++) {
    const row = configRows[i];
    const replayConfig = JSON.parse(row.config_json);
    replayConfig.id = row.id;
    replayConfig.name = row.name;

    status.replay.configs[i].status = 'running';
    status.phase = `replaying ${i + 1}/${configRows.length}: ${row.name || row.id}`;
    writeStatus();

    try {
      const result = await runReplay(replayConfig, date, {
        dataDbPath: dbPath,
        storeDbPath: dbPath,
        verbose: false,
        noJudge: true,
      });

      status.replay.configs[i].status = 'done';
      status.replay.configs[i].trades = result.trades;
      status.replay.configs[i].pnl = result.totalPnl;
      status.replay.completed++;

      console.log(`    [${i + 1}/${configRows.length}] ${row.name || row.id}: ${result.trades} trades, $${result.totalPnl.toFixed(0)}`);
    } catch (e: any) {
      status.replay.configs[i].status = 'error';
      status.replay.configs[i].error = e.message;
      status.replay.completed++;
      console.error(`    [${i + 1}/${configRows.length}] ${row.name || row.id}: ERROR — ${e.message}`);
    }
    writeStatus();
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  status.status = 'completed';
  status.phase = 'done';
  status.completedAt = Date.now();
  writeStatus();

  const elapsed = ((status.completedAt - status.startedAt) / 1000).toFixed(1);
  console.log(`\n  ✓ Backfill + replay complete for ${date}:`);
  console.log(`    SPX: ${status.spxBars} bars`);
  console.log(`    Options: ${status.optionContracts} contracts, ${status.optionBars} bars`);
  console.log(`    MTFs + indicators: ${status.mtfBarsWritten} bars`);
  console.log(`    Replays: ${status.replay.completed}/${status.replay.total} configs`);
  console.log(`    Errors: ${status.errors.length}`);
  console.log(`    Elapsed: ${elapsed}s`);

  // Clean up job file
  try { fs.unlinkSync(jobFile); } catch {}
}

main().catch(e => {
  status.status = 'failed';
  status.phase = 'unexpected error';
  status.errors.push(e.message);
  status.completedAt = Date.now();
  writeStatus();
  console.error('[backfill-worker] Fatal:', e);
  process.exit(1);
});
