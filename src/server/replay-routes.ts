/**
 * Replay viewer API routes — serves replay data for the chart viewer.
 * Mounted on the existing Express app at /replay/api/*
 */

import { Router, type Request, type Response } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import http from 'http';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { runReplay } from '../replay/machine';
import { runBasketReplay, deriveMemberConfig } from '../replay/basket-runner';
import { DEFAULT_CONFIG, mergeConfig } from '../config/defaults';
import type { Config, BasketMember } from '../config/types';
import { listProfiles, loadProfile, saveProfile, deleteProfile } from '../instruments/profile-store';
import type { StoredInstrumentProfile } from '../instruments/profile-store';
import { discoverProfile, DiscoveryError } from '../instruments/discovery';
import { findMissingDates, hasWorkPending } from '../backfill/missing-dates';
import {
  createBackfillJob, attachPid, getJob, listJobs, markCancelled,
} from '../backfill/job-store';
import type { ListJobsFilters } from '../backfill/job-store';
import {
  etToMs, filterTradesByWindow, filterTradesByStrike,
  applySizingFilter, bucketTradesIntoChunks, aggregateChunkMetrics,
  chunkLabel, detectKillZones, findBestConfigsPerChunk,
  getPnl, SESSION_START_MS, SESSION_END_MS,
  type TradeLike, type ConfigChunkData,
} from './trade-query-helpers';

import { REPLAY_DB_DEFAULT, REPLAY_META_DB } from '../storage/replay-db';
import { listParquetDates, symbolToProfileId, anySymbolToProfileId, hasParquetDate } from '../storage/parquet-reader';
import { execFileSync } from 'child_process';

const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';
/** All replay data — bars, configs, results, runs (spxer.db) */
const DB_PATH = REPLAY_DB_DEFAULT;
/** Alias for DB_PATH — same spxer.db */
const META_DB_PATH = REPLAY_META_DB;
const PARQUET_ROOT = path.resolve(process.cwd(), process.env.PARQUET_ROOT || 'data/parquet/bars');


/** Run a DuckDB CLI query synchronously, return parsed JSON rows. */
function duckQuery(sql: string): any[] {
  try {
    const result = execFileSync('duckdb', ['-json', '-c', sql], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const text = result.toString().trim();
    if (!text || text === '[]') return [];
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// ── Job tracking in SQLite (survives process restarts) ─────────────────────
const MAX_CONCURRENT_JOBS = 3;

function ensureJobsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_jobs (
      id TEXT PRIMARY KEY,
      configId TEXT NOT NULL,
      configName TEXT NOT NULL,
      dates_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      completed INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL,
      currentDate TEXT,
      results_json TEXT DEFAULT '[]',
      error TEXT,
      pid INTEGER,
      startedAt INTEGER NOT NULL,
      completedAt INTEGER
    )
  `);
}

/** Mark any jobs whose worker process has died as failed.
 *  The `db` arg is used only for the initial SELECT (may be readonly).
 *  UPDATE runs through a short-lived writable handle so callers can pass
 *  either a readonly or writable handle without crashing on SQLITE_READONLY. */
function reapDeadJobs(db: Database.Database) {
  const running = db.prepare("SELECT id, pid FROM replay_jobs WHERE status = 'running'").all() as { id: string; pid: number }[];
  const dead: { id: string; pid: number }[] = [];
  for (const job of running) {
    if (!job.pid) continue;
    try {
      // Signal 0 checks if process exists without killing it
      process.kill(job.pid, 0);
    } catch {
      dead.push(job);
    }
  }
  if (dead.length === 0) return;
  const writeDb = new Database(META_DB_PATH);
  try {
    const stmt = writeDb.prepare("UPDATE replay_jobs SET status = 'failed', error = 'Worker process died (PID ' || pid || ')', completedAt = ? WHERE id = ?");
    const now = Date.now();
    for (const job of dead) stmt.run(now, job.id);
  } finally {
    writeDb.close();
  }
}

/** Metadata DB (configs, results, runs, jobs, leaderboard) — readonly */
function getDb(): Database.Database {
  return new Database(META_DB_PATH, { readonly: true });
}

/** Metadata DB — writable */
function getWriteDb(): Database.Database {
  return new Database(META_DB_PATH);
}

/** Bar data DB (replay_bars) — readonly */
function getDataDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

/**
 * Normalize config JSON for comparison — strip fields that differ between
 * saves but don't represent actual config changes (id, name, timestamps).
 */
function configFingerprint(config: Config): string {
  const { id, name, description, createdAt, ...rest } = config as any;
  return JSON.stringify(rest);
}

/**
 * Save a config with automatic versioning. If a config with the same ID
 * already exists and has DIFFERENT settings, auto-create a new version
 * (base-v2, base-v3, etc.) instead of overwriting the original.
 *
 * Returns the actual ID used (may differ from input if versioned).
 */
function saveConfigVersioned(db: Database.Database, config: Config, id: string, name: string): string {
  // Check if this ID already exists with different content
  const existing = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
    .get(id) as { config_json: string } | undefined;

  if (existing) {
    const existingConfig = JSON.parse(existing.config_json) as Config;
    const existingFp = configFingerprint(existingConfig);

    // Build fingerprint for the new config (temporarily set id/name to compare fairly)
    const newConfig = { ...config, id, name };
    const newFp = configFingerprint(newConfig);

    if (existingFp !== newFp) {
      // Config changed — find next available version
      const base = id.replace(/-v\d+$/, '');
      let v = 2;
      while (db.prepare('SELECT 1 FROM replay_configs WHERE id = ?').get(`${base}-v${v}`)) {
        v++;
      }
      id = `${base}-v${v}`;
      name = name.replace(/ v\d+$/, '') + ` v${v}`;
      console.log(`[replay] Config changed, auto-versioned to: ${id}`);
    }
    // If fingerprints match, reuse the same ID (just update timestamp)
  }

  config.id = id;
  config.name = name;

  db.prepare(`
    INSERT INTO replay_configs (id, name, description, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, config_json=excluded.config_json, updatedAt=excluded.updatedAt
  `).run(id, name, config.description || '', JSON.stringify(config), Date.now(), Date.now());

  return id;
}

export function createReplayRoutes(): Router {
  const router = Router();

  // ── Serve the HTML viewer ────────────────────────────────────────────────
  const envBasePath = process.env.BASE_PATH || '';

  function serveWithBasePath(htmlPath: string, req: Request, res: Response) {
    const basePath = req.headers['x-forwarded-prefix'] as string || envBasePath;
    if (!basePath) {
      res.sendFile(htmlPath);
      return;
    }
    try {
      let html = fs.readFileSync(htmlPath, 'utf-8');
      html = html.replace('<head>', `<head>\n  <meta name="base-path" content="${basePath}">`);
      res.type('html').send(html);
    } catch {
      res.sendFile(htmlPath);
    }
  }

  router.get('/', (req, res) => {
    const htmlPath = path.resolve(__dirname, 'replay-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/replay-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── GET /replay/api/dates?instrument=SPX|NDX — available replay dates ───
  router.get('/api/dates', (req, res) => {
    const instrument = ((req.query.instrument as string) || 'SPX').toUpperCase();
    const profileId = symbolToProfileId(instrument);

    // Try parquet first (preferred — no 42GB SQLite scan)
    const parquetDates = listParquetDates(profileId);
    if (parquetDates.length > 0) {
      return res.json(parquetDates);
    }

    // Fallback to SQLite (bar data DB)
    const dataDb = getDataDb();
    try {
      const rows = dataDb.prepare(`
        SELECT DISTINCT date(ts, 'unixepoch') as d
        FROM ${REPLAY_DATA_SOURCE} WHERE symbol=? AND timeframe='1m'
        ORDER BY d
      `).all(instrument) as { d: string }[];
      res.json(rows.map(r => r.d));
    } finally {
      dataDb.close();
    }
  });

  // ── GET /replay/api/configs — saved configs ──────────────────────────────
  // Only returns configs with ≥200 days of results (use ?all=1 to bypass)
  router.get('/api/configs', (req, res) => {
    const db = getDb();
    try {
      // CTE pre-computes day counts from replay_results without reading blob columns.
      // Direct LEFT JOIN was scanning 82K trades_json blobs (~480MB I/O) → 5-6s.
      // CTE approach: 0.15s.
      const showAll = req.query.all === '1';
      const sql = `
        WITH dc AS (SELECT configId, COUNT(*) as cnt FROM replay_results GROUP BY configId)
        SELECT c.id, c.name, c.description,
               json_extract(c.config_json, '$.timeWindows.activeStart') as activeStart,
               COALESCE(
                 json_extract(c.config_json, '$.execution.symbol'),
                 CASE
                   WHEN LOWER(c.id) LIKE 'ndx%' OR LOWER(c.id) LIKE '%-ndx-%' OR LOWER(c.id) LIKE '%-ndx' THEN 'NDX'
                   WHEN LOWER(c.id) LIKE 'spx%' OR LOWER(c.id) LIKE '%-spx-%' OR LOWER(c.id) LIKE '%-spx' THEN 'SPX'
                   ELSE 'SPX'
                 END
               ) as symbol,
               COALESCE(dc.cnt, 0) as dayCount
        FROM replay_configs c
        LEFT JOIN dc ON c.id = dc.configId
        ${showAll ? '' : `WHERE COALESCE(dc.cnt, 0) >= 200
              OR c.id LIKE '%-default'
              OR c.id LIKE '%-default-v%'`}
        ORDER BY c.createdAt DESC
      `;
      const rows = db.prepare(sql).all();
      res.json(rows);
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/results?date=&configId= — trades for a day/config ──
  router.get('/api/results', (req, res) => {
    const { date, configId } = req.query as { date?: string; configId?: string };
    if (!date || !configId) {
      return res.status(400).json({ error: 'date and configId required' });
    }

    const db = getDb();
    try {
      const row = db.prepare(`
        SELECT trades, wins, winRate, totalPnl, avgPnlPerTrade, maxWin, maxLoss,
               sharpeRatio, trades_json
        FROM replay_results WHERE date = ? AND configId = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(date, configId) as any;

      if (!row) {
        return res.json({ summary: null, trades: [] });
      }

      const trades = JSON.parse(row.trades_json || '[]');
      res.json({
        summary: {
          trades: row.trades,
          wins: row.wins,
          winRate: row.winRate,
          totalPnl: row.totalPnl,
          avgPnlPerTrade: row.avgPnlPerTrade,
          maxWin: row.maxWin,
          maxLoss: row.maxLoss,
          sharpeRatio: row.sharpeRatio,
        },
        trades,
      });
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/bars?date=&symbol=&tf=&warmup=N — OHLCV bars ────────
  // warmup=N includes N bars from the prior trading day for indicator seeding
  router.get('/api/bars', (req, res) => {
    const { date, symbol, tf, warmup } = req.query as { date?: string; symbol?: string; tf?: string; warmup?: string };
    if (!date || !symbol) {
      return res.status(400).json({ error: 'date and symbol required' });
    }
    const timeframe = tf || '1m';
    const warmupBars = parseInt(warmup || '0');
    const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const dayEnd = dayStart + 86400 + 3600;

    // ── Try parquet first ──
    const profileId = anySymbolToProfileId(symbol);
    if (hasParquetDate(profileId, date)) {
      const pqFile = path.join(PARQUET_ROOT, profileId, `${date}.parquet`);
      let sql: string;
      if (warmupBars > 0) {
        // Warmup: grab last N bars before dayStart + all bars in range
        sql = `SELECT * FROM (
          (SELECT ts, open, high, low, close, volume, indicators
           FROM read_parquet('${pqFile}')
           WHERE symbol = '${symbol}' AND timeframe = '${timeframe}' AND ts < ${dayStart}
           ORDER BY ts DESC LIMIT ${warmupBars})
          UNION ALL
          (SELECT ts, open, high, low, close, volume, indicators
           FROM read_parquet('${pqFile}')
           WHERE symbol = '${symbol}' AND timeframe = '${timeframe}' AND ts >= ${dayStart} AND ts <= ${dayEnd})
        ) ORDER BY ts ASC`;
      } else {
        sql = `SELECT ts, open, high, low, close, volume, indicators
               FROM read_parquet('${pqFile}')
               WHERE symbol = '${symbol}' AND timeframe = '${timeframe}' AND ts >= ${dayStart} AND ts <= ${dayEnd}
               ORDER BY ts ASC`;
      }
      const rows = duckQuery(sql);
      if (rows.length > 0) {
        return res.json(rows.map((r: any) => ({
          ts: r.ts,
          o: r.open,
          h: r.high,
          l: r.low,
          c: r.close,
          v: r.volume,
          ind: typeof r.indicators === 'string' ? JSON.parse(r.indicators || '{}') : (r.indicators || {}),
        })));
      }
      // Fall through to SQLite if parquet returned empty
    }

    // ── Fallback to SQLite (bar data DB) ──
    const dataDb = getDataDb();
    try {
      let rows: any[];

      if (warmupBars > 0) {
        rows = dataDb.prepare(`
          SELECT ts, open, high, low, close, volume, indicators FROM (
            SELECT ts, open, high, low, close, volume, indicators
            FROM ${REPLAY_DATA_SOURCE}
            WHERE symbol = ? AND timeframe = ? AND ts < ?
            ORDER BY ts DESC LIMIT ?
          )
          UNION ALL
          SELECT ts, open, high, low, close, volume, indicators
          FROM ${REPLAY_DATA_SOURCE}
          WHERE symbol = ? AND timeframe = ? AND ts >= ? AND ts <= ?
          ORDER BY ts ASC
        `).all(symbol, timeframe, dayStart, warmupBars, symbol, timeframe, dayStart, dayEnd) as any[];
      } else {
        rows = dataDb.prepare(`
          SELECT ts, open, high, low, close, volume, indicators
          FROM ${REPLAY_DATA_SOURCE}
          WHERE symbol = ? AND timeframe = ? AND ts >= ? AND ts <= ?
          ORDER BY ts ASC
        `).all(symbol, timeframe, dayStart, dayEnd) as any[];
      }

      res.json(rows.map(r => ({
        ts: r.ts,
        o: r.open,
        h: r.high,
        l: r.low,
        c: r.close,
        v: r.volume,
        ind: JSON.parse(r.indicators || '{}'),
      })));
    } finally {
      dataDb.close();
    }
  });

  // ── GET /replay/api/contracts?date=&instrument=SPX|NDX — contracts ──────
  router.get('/api/contracts', (req, res) => {
    const { date } = req.query as { date?: string };
    const instrument = ((req.query.instrument as string) || 'SPX').toUpperCase();
    if (!date) {
      return res.status(400).json({ error: 'date required' });
    }
    const contractPrefix = instrument === 'NDX' ? 'NDXP' : 'SPXW';
    const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
    const dayEnd = dayStart + 86400 + 3600;

    // ── Try parquet first ──
    const profileId = symbolToProfileId(instrument);
    if (hasParquetDate(profileId, date)) {
      const pqFile = path.join(PARQUET_ROOT, profileId, `${date}.parquet`);
      const sql = `SELECT symbol,
               CASE WHEN symbol LIKE '%C0%' OR symbol LIKE '%C1%' THEN 'call' ELSE 'put' END as type,
               CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike,
               COUNT(*) as "barCount",
               MIN(close) as "minPrice",
               MAX(close) as "maxPrice",
               AVG(volume) as "avgVolume"
        FROM read_parquet('${pqFile}')
        WHERE timeframe='1m' AND ts >= ${dayStart} AND ts <= ${dayEnd} AND symbol LIKE '${contractPrefix}%'
        GROUP BY symbol
        ORDER BY strike ASC, type ASC`;
      const rows = duckQuery(sql);
      if (rows.length > 0) {
        return res.json(rows);
      }
    }

    // ── Fallback to SQLite (bar data DB) ──
    const dataDb = getDataDb();
    try {
      const rows = dataDb.prepare(`
        SELECT DISTINCT symbol,
               CASE WHEN symbol GLOB '*C[0-9]*' THEN 'call' ELSE 'put' END as type,
               CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike,
               COUNT(*) as barCount,
               MIN(close) as minPrice,
               MAX(close) as maxPrice,
               AVG(volume) as avgVolume
        FROM ${REPLAY_DATA_SOURCE}
        WHERE timeframe='1m' AND ts >= ? AND ts <= ? AND symbol LIKE ?
        GROUP BY symbol
        ORDER BY strike ASC, type ASC
      `).all(dayStart, dayEnd, `${contractPrefix}%`) as any[];

      res.json(rows);
    } finally {
      dataDb.close();
    }
  });

  // ── GET /replay/api/config/:id — full config JSON for a saved config ────
  router.get('/api/config/:id', (req, res) => {
    const db = getDb();
    try {
      const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
        .get(req.params.id) as { config_json: string } | undefined;
      if (!row) return res.status(404).json({ error: 'Config not found' });
      res.json(JSON.parse(row.config_json));
    } finally {
      db.close();
    }
  });

  // ── PUT /replay/api/config/:id — update config in-place (no versioning) ──
  router.put('/api/config/:id', (req, res) => {
    const id = req.params.id;
    const config = req.body as Partial<Config>;
    if (!config) return res.status(400).json({ error: 'Config body required' });

    const db = getWriteDb();
    try {
      const existing = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
        .get(id) as { config_json: string } | undefined;
      if (!existing) return res.status(404).json({ error: `Config '${id}' not found` });

      // Merge with existing config to preserve fields not sent by client
      const existingConfig = JSON.parse(existing.config_json) as Config;
      const merged = mergeConfig(existingConfig, config);
      merged.id = id;
      merged.name = config.name || existingConfig.name;

      db.prepare(`
        UPDATE replay_configs SET config_json = ?, name = ?, updatedAt = ? WHERE id = ?
      `).run(JSON.stringify(merged), merged.name, Date.now(), id);

      res.json({ ok: true, id, name: merged.name });
    } finally {
      db.close();
    }
  });

  // ── POST /replay/api/set-live-config — update AGENT_CONFIG_ID in ecosystem.config.js
  router.post('/api/set-live-config', async (req, res) => {
    const { configId } = req.body as { configId?: string };
    if (!configId) return res.status(400).json({ error: 'configId required' });

    // Verify config exists in DB
    const db = getDb();
    try {
      const row = db.prepare('SELECT 1 FROM replay_configs WHERE id = ?').get(configId);
      if (!row) return res.status(404).json({ error: `Config '${configId}' not found in DB` });
    } finally {
      db.close();
    }

    // Update ecosystem.config.js — replace all AGENT_CONFIG_ID values
    const ecoPath = path.resolve(process.cwd(), 'ecosystem.config.js');
    try {
      let content = fs.readFileSync(ecoPath, 'utf-8');
      const regex = /AGENT_CONFIG_ID:\s*'[^']*'/g;
      const matches = content.match(regex);
      if (!matches || matches.length === 0) {
        return res.status(500).json({ error: 'AGENT_CONFIG_ID not found in ecosystem.config.js' });
      }
      content = content.replace(regex, `AGENT_CONFIG_ID: '${configId}'`);
      content = content.replace(/AGENT_PAPER:\s*'[^']*'/g, `AGENT_PAPER: 'false'`);
      fs.writeFileSync(ecoPath, content, 'utf-8');

      // Also update the current process env so /agent/config reflects it immediately
      process.env.AGENT_CONFIG_ID = configId;

      // Restart the event handler to pick up the new config
      let restarted = false;
      let restartError: string | null = null;
      try {
        const { execSync } = await import('child_process');
        execSync('pm2 delete event-handler 2>/dev/null; pm2 start ecosystem.config.js --only event-handler', {
          cwd: process.cwd(),
          timeout: 15000,
          stdio: 'pipe',
        });
        restarted = true;
        console.log(`[set-live-config] Restarted event-handler with config '${configId}'`);
      } catch (restartErr: any) {
        restartError = restartErr.message;
        console.error(`[set-live-config] Failed to restart event-handler: ${restartErr.message}`);
      }

      console.log(`[set-live-config] Updated AGENT_CONFIG_ID to '${configId}' (${matches.length} occurrences)`);
      res.json({ ok: true, configId, updated: matches.length, restarted, restartError });
    } catch (err: any) {
      console.error('[set-live-config] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Basket deploy (multi-agent live) ─────────────────────────────────────
  // Unlike set-live-config (single config → single spxer-agent), this fans
  // out a basket config into N PM2 agent apps — one per member — each with
  // its own derived AGENT_CONFIG_ID. Agents are written LIVE (AGENT_PAPER=
  // 'false'); "paused" means the block is present in ecosystem.config.js
  // but not pm2-started. Operator brings them up with the returned pm2
  // start command when ready. There is no paper mode in this system.
  //
  // The basket agent block in ecosystem.config.js is wrapped in markers:
  //   // ── SPXER BASKET AGENTS START (managed by /api/set-live-basket) ──
  //   ...app entries...
  //   // ── SPXER BASKET AGENTS END ──
  // so subsequent deploys are idempotent: the region is deleted and rewritten.

  const BASKET_MARK_START = '// ── SPXER BASKET AGENTS START (managed by /api/set-live-basket) ──';
  const BASKET_MARK_END = '// ── SPXER BASKET AGENTS END ──';

  function renderBasketAppBlock(args: {
    basketConfigId: string;
    memberConfigId: string;
    memberId: string;
    strikeOffset: number;
  }): string {
    const { basketConfigId, memberConfigId, memberId, strikeOffset } = args;
    const offsetLabel = strikeOffset === 0 ? 'ATM' : strikeOffset > 0 ? `OTM${strikeOffset}` : `ITM${-strikeOffset}`;
    const nameSafe = `spxer-agent-${basketConfigId}-${memberId}`.replace(/[^A-Za-z0-9_-]/g, '-');
    return `    {
      name: '${nameSafe}',
      script: 'npx',
      args: 'tsx spx_agent.ts',
      cwd: '/home/ubuntu/SPXer',
      watch: false,
      autorestart: false,
      max_restarts: 0,
      min_uptime: '10s',
      restart_delay: 30000,
      kill_timeout: 5000,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        AGENT_PAPER: 'false',
        AGENT_CONFIG_ID: '${memberConfigId}', // ${offsetLabel}, strikeOffset=${strikeOffset}
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/ubuntu/.pm2/logs/${nameSafe}-error.log',
      out_file: '/home/ubuntu/.pm2/logs/${nameSafe}-out.log',
      merge_logs: true,
    },`;
  }

  function splitEcosystem(content: string): { before: string; after: string; middle: string } {
    const startIdx = content.indexOf(BASKET_MARK_START);
    const endIdx = content.indexOf(BASKET_MARK_END);
    if (startIdx >= 0 && endIdx > startIdx) {
      return {
        before: content.slice(0, startIdx),
        middle: content.slice(startIdx, endIdx + BASKET_MARK_END.length + 1),
        after: content.slice(endIdx + BASKET_MARK_END.length + 1),
      };
    }
    // Inject before final `  ],` that closes the apps array.
    // Match the LAST occurrence of `\n  ],` so we insert inside apps[].
    const lastClose = content.lastIndexOf('\n  ],');
    if (lastClose < 0) {
      return { before: content, middle: '', after: '' };
    }
    return {
      before: content.slice(0, lastClose + 1), // include the \n
      middle: '',
      after: content.slice(lastClose + 1),     // starts with `  ],`
    };
  }

  // ── POST /replay/api/set-live-basket ─────────────────────────────────────
  // Derives N single-strike member configs from a basket config, persists
  // them in replay_configs, and inserts N PM2 app definitions into
  // ecosystem.config.js (between markers, idempotent across deploys).
  //
  // All agents are written LIVE (AGENT_PAPER='false'). There is no paper
  // mode in this system. "Paused" = deployed in ecosystem.config.js but
  // not pm2-started. Operator runs the returned pm2StartCmd to activate.
  //
  // Body: { configId: string }
  // Returns: {
  //   ok, basketConfigId, memberCount, members: [{ configId, strikeOffset, agentName }],
  //   pm2StartCmd, pm2StopCmd, pm2StatusCmd,
  // }
  //
  // This endpoint does NOT invoke pm2 itself — it mirrors set-live-config's
  // pattern of editing the file and leaving restart to the operator.
  router.post('/api/set-live-basket', (req, res) => {
    const { configId } = req.body as { configId?: string };
    if (!configId) return res.status(400).json({ error: 'configId required' });

    const db = getWriteDb();
    try {
      // Load basket config.
      const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
        .get(configId) as { config_json: string } | undefined;
      if (!row) {
        return res.status(404).json({ error: `Config '${configId}' not found in DB` });
      }
      const basketCfg = JSON.parse(row.config_json) as Config;
      if (!basketCfg.basket?.enabled || !basketCfg.basket.members?.length) {
        return res.status(400).json({
          error: `Config '${configId}' is not a basket. Use /api/set-live-config for single-strike configs.`,
        });
      }

      // Derive and persist per-member configs. deriveMemberConfig sets
      // strikeMode='atm-offset', disables basket, and applies overrides.
      const members: BasketMember[] = basketCfg.basket.members;
      const deployedMembers: { configId: string; strikeOffset: number; agentName: string; memberId: string }[] = [];

      for (const m of members) {
        const derived = deriveMemberConfig(basketCfg, m);
        const existing = db.prepare('SELECT id FROM replay_configs WHERE id = ?').get(derived.id);
        const now = Date.now();
        if (existing) {
          db.prepare(`UPDATE replay_configs SET config_json = ?, name = ?, description = ?, updatedAt = ? WHERE id = ?`)
            .run(JSON.stringify(derived), derived.name, derived.description ?? '', now, derived.id);
        } else {
          db.prepare(`INSERT INTO replay_configs (id, name, description, config_json, createdAt, updatedAt)
                      VALUES (?, ?, ?, ?, ?, ?)`)
            .run(derived.id, derived.name, derived.description ?? '', JSON.stringify(derived), now, now);
        }
        const nameSafe = `spxer-agent-${configId}-${m.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
        deployedMembers.push({
          configId: derived.id,
          strikeOffset: m.strikeOffset,
          agentName: nameSafe,
          memberId: m.id,
        });
      }

      // Mutate ecosystem.config.js — replace the marker region with the new basket app block.
      const ecoPath = path.resolve(process.cwd(), 'ecosystem.config.js');
      let content = fs.readFileSync(ecoPath, 'utf-8');

      const appBlocks = members.map(m => renderBasketAppBlock({
        basketConfigId: configId,
        memberConfigId: `${configId}:${m.id}`,
        memberId: m.id,
        strikeOffset: m.strikeOffset,
      })).join('\n');

      const newRegion = `${BASKET_MARK_START}\n${appBlocks}\n    ${BASKET_MARK_END}\n`;
      const parts = splitEcosystem(content);
      if (parts.after === '') {
        return res.status(500).json({ error: 'Could not locate apps array in ecosystem.config.js' });
      }
      content = parts.before + newRegion + parts.after;
      fs.writeFileSync(ecoPath, content, 'utf-8');

      const agentNames = deployedMembers.map(m => m.agentName);
      const onlyArg = agentNames.join(',');

      res.json({
        ok: true,
        basketConfigId: configId,
        memberCount: members.length,
        members: deployedMembers,
        pm2StartCmd: `pm2 start ecosystem.config.js --only ${onlyArg}`,
        pm2StopCmd: `pm2 delete ${onlyArg}`,
        pm2StatusCmd: `pm2 list | grep ${configId}`,
        note: 'Agents written LIVE (AGENT_PAPER=false). Deployed paused — run pm2StartCmd to activate.',
      });
      console.log(`[set-live-basket] Wrote ${members.length} LIVE agents for basket '${configId}' (paused — pm2 start to activate)`);
    } catch (err: any) {
      console.error('[set-live-basket] Error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // ── POST /replay/api/stop-live-basket ────────────────────────────────────
  // Removes the basket agent block from ecosystem.config.js (idempotent).
  // Does not invoke pm2 — returns the stop command for the operator to run.
  router.post('/api/stop-live-basket', (_req, res) => {
    try {
      const ecoPath = path.resolve(process.cwd(), 'ecosystem.config.js');
      let content = fs.readFileSync(ecoPath, 'utf-8');

      const startIdx = content.indexOf(BASKET_MARK_START);
      const endIdx = content.indexOf(BASKET_MARK_END);
      if (startIdx < 0 || endIdx <= startIdx) {
        return res.json({ ok: true, removed: 0, message: 'No basket agents deployed.' });
      }

      // Collect names before deletion, so the UI can show a stop command.
      const middle = content.slice(startIdx, endIdx + BASKET_MARK_END.length);
      const names = Array.from(middle.matchAll(/name:\s*'([^']+)'/g)).map(m => m[1]);

      content = content.slice(0, startIdx) + content.slice(endIdx + BASKET_MARK_END.length + 1);
      fs.writeFileSync(ecoPath, content, 'utf-8');

      res.json({
        ok: true,
        removed: names.length,
        removedAgents: names,
        pm2StopCmd: names.length ? `pm2 delete ${names.join(',')}` : null,
      });
      console.log(`[stop-live-basket] Removed ${names.length} agent entries from ecosystem.config.js`);
    } catch (err: any) {
      console.error('[stop-live-basket] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /replay/api/live/basket ──────────────────────────────────────────
  // Returns the currently deployed basket (parsed from ecosystem.config.js
  // markers). Used by the UI to badge baskets as LIVE.
  router.get('/api/live/basket', (_req, res) => {
    try {
      const ecoPath = path.resolve(process.cwd(), 'ecosystem.config.js');
      const content = fs.readFileSync(ecoPath, 'utf-8');
      const startIdx = content.indexOf(BASKET_MARK_START);
      const endIdx = content.indexOf(BASKET_MARK_END);
      if (startIdx < 0 || endIdx <= startIdx) {
        return res.json({ deployed: false });
      }
      const region = content.slice(startIdx, endIdx);
      const agentNames = Array.from(region.matchAll(/name:\s*'([^']+)'/g)).map(m => m[1]);
      const configIds = Array.from(region.matchAll(/AGENT_CONFIG_ID:\s*'([^']+)'/g)).map(m => m[1]);
      const paperFlags = Array.from(region.matchAll(/AGENT_PAPER:\s*'([^']+)'/g)).map(m => m[1]);
      // Basket ID = the prefix shared by all member configIds ("basketId:memberId")
      const basketId = configIds[0]?.split(':')[0] ?? null;
      // There is no paper mode. If any stale AGENT_PAPER='true' shows up, surface a warning.
      const stalePaperCount = paperFlags.filter(p => p === 'true').length;
      res.json({
        deployed: true,
        basketConfigId: basketId,
        memberCount: agentNames.length,
        agentNames,
        memberConfigIds: configIds,
        ...(stalePaperCount > 0 ? { warning: `${stalePaperCount} agent(s) have stale AGENT_PAPER='true' — re-deploy to fix.` } : {}),
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /replay/api/defaults — return DEFAULT_CONFIG (instrument-aware) ──
  // Accepts ?instrument=SPX|NDX. When a seed `<symbol>-default` config exists
  // in the DB, that's returned directly (so NDX pulls its NDXP/$10-interval
  // routing and any tuned fields). Otherwise DEFAULT_CONFIG is returned with
  // the execution block overridden for the requested instrument.
  router.get('/api/defaults', (req, res) => {
    const instrument = ((req.query.instrument as string) || 'SPX').toUpperCase();
    const seedId = `${instrument.toLowerCase()}-default`;
    const db = getDb();
    try {
      const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(seedId) as { config_json?: string } | undefined;
      if (row?.config_json) {
        try {
          const cfg = JSON.parse(row.config_json);
          return res.json(cfg);
        } catch { /* fall through to synthesized default */ }
      }
    } finally {
      db.close();
    }
    // Synthesize: DEFAULT_CONFIG + execution block for the requested instrument
    const execByInstrument: Record<string, any> = {
      SPX: { symbol: 'SPX', optionPrefix: 'SPXW', strikeDivisor: 1, strikeInterval: 5 },
      NDX: { symbol: 'NDX', optionPrefix: 'NDXP', strikeDivisor: 1, strikeInterval: 10 },
    };
    const exec = execByInstrument[instrument] || execByInstrument.SPX;
    res.json({ ...DEFAULT_CONFIG, execution: { ...(DEFAULT_CONFIG as any).execution, ...exec } });
  });

  // ── POST /replay/api/run — run replay with config, store results ─────────
  router.post('/api/run', async (req, res) => {
    const { date, config, configId, configName } = req.body as {
      date?: string;
      config?: Partial<Config>;
      configId?: string;
      configName?: string;
    };

    if (!date) return res.status(400).json({ error: 'date required' });

    try {
      // Build the full config
      let fullConfig: Config;

      if (config) {
        // Client sent a full config object — use it directly.
        // mergeConfig with DEFAULT_CONFIG ensures any missing keys get defaults,
        // but the client's values always win (no stale DB bleed-through).
        fullConfig = mergeConfig(DEFAULT_CONFIG, config as Partial<Config>);
      } else if (configId) {
        // No config body — load existing config from DB (re-run scenario)
        const db = getDb();
        try {
          const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
            .get(configId) as { config_json: string } | undefined;
          if (!row) return res.status(404).json({ error: `Config '${configId}' not found` });
          fullConfig = JSON.parse(row.config_json) as Config;
        } finally {
          db.close();
        }
      } else {
        fullConfig = { ...DEFAULT_CONFIG };
      }

      // Generate or use provided ID/name
      let id = configId || `custom-${Date.now()}`;
      let name = configName || fullConfig.name || 'Custom Config';

      // Save config with auto-versioning: if the config body differs from
      // what's stored under this ID, create a new version (base-v2, -v3, etc.)
      // Plain re-runs (configId only, no config body) skip saving entirely.
      if (config || !configId) {
        const wdb = getWriteDb();
        try {
          id = saveConfigVersioned(wdb, fullConfig, id, name);
          name = fullConfig.name; // may have been updated by versioning
        } finally {
          wdb.close();
        }
      } else {
        fullConfig.id = id;
        fullConfig.name = name;
      }

      // Basket fan-out: run N isolated per-member replays, aggregate in storage.
      if (fullConfig.basket?.enabled && fullConfig.basket.members?.length) {
        const basketRun = await runBasketReplay(fullConfig, date, {
          dataDbPath: DB_PATH,
          storeDbPath: META_DB_PATH,
          verbose: false,
          noJudge: true,
        });
        const agg = basketRun.aggregate;
        return res.json({
          configId: id,
          configName: name,
          date,
          basket: true,
          memberCount: basketRun.memberResults.length,
          summary: {
            trades: agg.trades,
            wins: agg.wins,
            winRate: agg.winRate,
            totalPnl: agg.totalPnl,
            avgPnlPerTrade: agg.avgPnlPerTrade,
            maxWin: agg.maxWin,
            maxLoss: agg.maxLoss,
          },
          members: basketRun.memberResults.map(m => ({
            memberId: m.member.id,
            strikeOffset: m.member.strikeOffset,
            configId: m.result.configId,
            trades: m.result.trades,
            wins: m.result.wins,
            winRate: m.result.winRate,
            totalPnl: m.result.totalPnl,
            maxWin: m.result.maxWin,
            maxLoss: m.result.maxLoss,
          })),
        });
      }

      // Run the replay (no judge by default — deterministic, fast)
      const result = await runReplay(fullConfig, date, {
        dataDbPath: DB_PATH,
        storeDbPath: DB_PATH,
        verbose: false,
        noJudge: true,
      });

      res.json({
        configId: id,
        configName: name,
        date,
        summary: {
          trades: result.trades,
          wins: result.wins,
          winRate: result.winRate,
          totalPnl: result.totalPnl,
          avgPnlPerTrade: result.avgPnlPerTrade,
          maxWin: result.maxWin,
          maxLoss: result.maxLoss,
        },
      });
    } catch (err: any) {
      console.error('[replay-run] Error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /replay/api/run-batch — background multi-day replay ─────────────
  // Spawns a detached child process so replays survive viewer restarts.
  // Job state is persisted in SQLite (replay_jobs table).
  router.post('/api/run-batch', (req, res) => {
    const { dates, config, configId, configName } = req.body as {
      dates?: string[];
      config?: Partial<Config>;
      configId?: string;
      configName?: string;
    };

    if (!dates || !dates.length) {
      return res.status(400).json({ error: 'dates[] required' });
    }

    const db = getWriteDb();
    try {
      ensureJobsTable(db);
      reapDeadJobs(db);

      // Enforce max concurrent jobs
      const runningJobs = db.prepare("SELECT id, configName, completed, total, currentDate FROM replay_jobs WHERE status = 'running'")
        .all() as { id: string; configName: string; completed: number; total: number; currentDate: string }[];
      if (runningJobs.length >= MAX_CONCURRENT_JOBS) {
        return res.status(429).json({
          error: `Max ${MAX_CONCURRENT_JOBS} concurrent jobs. ${runningJobs.length} running.`,
          runningJobs: runningJobs.map(j => ({ id: j.id, configName: j.configName, progress: { completed: j.completed, total: j.total, currentDate: j.currentDate } })),
        });
      }

      // Build the full config (same logic as /api/run)
      let fullConfig: Config;
      if (config) {
        fullConfig = mergeConfig(DEFAULT_CONFIG, config as Partial<Config>);
      } else if (configId) {
        const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
          .get(configId) as { config_json: string } | undefined;
        if (!row) return res.status(404).json({ error: `Config '${configId}' not found` });
        fullConfig = JSON.parse(row.config_json) as Config;
      } else {
        fullConfig = { ...DEFAULT_CONFIG };
      }

      let id = configId || `custom-${Date.now()}`;
      let name = configName || fullConfig.name || 'Custom Config';

      // Save config with auto-versioning (same as /api/run)
      if (config || !configId) {
        id = saveConfigVersioned(db, fullConfig, id, name);
        name = fullConfig.name;
      } else {
        fullConfig.id = id;
        fullConfig.name = name;
      }

      // Create the job record in SQLite
      const jobId = randomUUID();
      db.prepare(`
        INSERT INTO replay_jobs (id, configId, configName, dates_json, status, total, currentDate, startedAt)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(jobId, id, name, JSON.stringify(dates), dates.length, dates[0], Date.now());

      // Write job spec to temp file for the worker
      const jobDir = path.resolve(process.cwd(), 'data', 'jobs');
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      const jobFile = path.join(jobDir, `${jobId}.json`);
      fs.writeFileSync(jobFile, JSON.stringify({
        jobId, configId: id, configName: name, dates, config: fullConfig,
        dbPath: DB_PATH, metaDbPath: META_DB_PATH, noJudge: true,
      }));

      // Spawn detached worker process
      const workerScript = path.resolve(__dirname, '..', 'replay', 'batch-worker.ts');
      const logFile = fs.openSync(path.join(jobDir, `${jobId}.log`), 'a');

      const child = spawn('npx', ['tsx', workerScript, jobFile], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', logFile, logFile],
        env: { ...process.env },
      });

      // Record PID and let the child run independently
      child.unref();
      db.prepare("UPDATE replay_jobs SET pid = ? WHERE id = ?").run(child.pid, jobId);

      console.log(`[replay-batch] Spawned worker PID ${child.pid} for job ${jobId}: ${dates.length} dates, config ${name}`);

      res.json({ jobId, configId: id, configName: name, totalDates: dates.length });
    } catch (err: any) {
      console.error('[replay-batch] Setup error:', err.message);
      res.status(500).json({ error: err.message });
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/job/:jobId — poll job status ─────────────────────────
  router.get('/api/job/:jobId', (req, res) => {
    const db = getDb();
    try {
      ensureJobsTable(db);
      reapDeadJobs(db);
      const row = db.prepare('SELECT * FROM replay_jobs WHERE id = ?').get(req.params.jobId) as any;
      if (!row) return res.status(404).json({ error: 'Job not found' });

      // Return in the same shape the frontend expects
      res.json({
        id: row.id,
        configId: row.configId,
        configName: row.configName,
        dates: JSON.parse(row.dates_json || '[]'),
        status: row.status,
        progress: { completed: row.completed, total: row.total, currentDate: row.currentDate },
        results: JSON.parse(row.results_json || '[]'),
        error: row.error,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        pid: row.pid,
      });
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/jobs — list recent jobs ──────────────────────────────
  router.get('/api/jobs', (_req, res) => {
    const db = getDb();
    try {
      ensureJobsTable(db);
      reapDeadJobs(db);
      const rows = db.prepare('SELECT * FROM replay_jobs ORDER BY startedAt DESC LIMIT 50').all() as any[];
      const all = rows.map(row => ({
        id: row.id,
        configId: row.configId,
        configName: row.configName,
        dates: JSON.parse(row.dates_json || '[]'),
        status: row.status,
        progress: { completed: row.completed, total: row.total, currentDate: row.currentDate },
        results: JSON.parse(row.results_json || '[]'),
        error: row.error,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        pid: row.pid,
      }));
      res.json(all);
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/sweep — leaderboard aggregated from replay_results ───
  // Supports ?maxEntryPrice=N to recompute metrics using only trades with entry ≤ $N
  router.get('/api/sweep', (req, res) => {
    const { sort, limit, dir, minDays, maxEntryPrice, maxConcurrent, maxTradesPerDay } = req.query as Record<string, string | undefined>;
    const allowedSorts = ['edge', 'rMultiple', 'ev', 'winRate', 'totalPnl', 'worstDay', 'profitDays', 'trades', 'avgDailyPnl', 'bestDay', 'days', 'avgEntryPrice', 'avgPnlPerTrade', 'breakEvenWR'];
    const sortCol = allowedSorts.includes(sort || '') ? sort : 'edge';
    const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
    const maxRows = Math.min(parseInt(limit || '2500'), 5000);
    const entryPriceCap = maxEntryPrice ? parseFloat(maxEntryPrice) : 0;  // 0 = no filter
    const concurrentCap = maxConcurrent ? parseInt(maxConcurrent) : 0;    // 0 = no filter
    const dailyTradeCap = maxTradesPerDay ? parseInt(maxTradesPerDay) : 0; // 0 = no filter

    const db = getDb();
    const needsTradeFilter = entryPriceCap > 0 || concurrentCap > 0 || dailyTradeCap > 0;
    const minDaysVal = Math.max(1, parseInt(minDays || '2'));

    try {
      const enriched: any[] = [];

      if (!needsTradeFilter) {
        // ── FAST PATH: use SQL aggregation, skip trades_json parsing ───────
        const configRows = db.prepare(`
          SELECT
            r.configId,
            c.name,
            c.config_json,
            COUNT(*) as days,
            SUM(r.trades) as totalTrades,
            SUM(r.wins) as totalWins,
            SUM(r.totalPnl) as totalPnl,
            MIN(r.totalPnl) as worstDay,
            MAX(r.totalPnl) as bestDay,
            GROUP_CONCAT(r.totalPnl) as pnlList,
            SUM(r.sumWinPct) as totalSumWinPct,
            SUM(r.cntWins) as totalCntWins,
            SUM(r.sumLossPct) as totalSumLossPct,
            SUM(r.cntLosses) as totalCntLosses
          FROM replay_results r
          JOIN replay_configs c ON c.id = r.configId
          GROUP BY r.configId
          HAVING COUNT(*) >= ?
        `).all(minDaysVal) as any[];

        for (const row of configRows) {
          const dailyPnls = row.pnlList.split(',').map(Number);
          const days = row.days;
          const totalTrades = row.totalTrades;
          const totalWins = row.totalWins;
          const totalPnl = row.totalPnl;
          const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
          const avgDailyPnl = days > 0 ? totalPnl / days : 0;
          const worstDay = row.worstDay;
          const bestDay = row.bestDay;
          const profitDays = dailyPnls.filter((p: number) => p > 0).length;

          // ── Statistical edge metrics (R-multiple, EV, breakeven WR, edge) ──
          const avgWinPct = row.totalCntWins > 0 ? row.totalSumWinPct / row.totalCntWins : 0;
          const avgLossPct = row.totalCntLosses > 0 ? row.totalSumLossPct / row.totalCntLosses : 0; // negative
          const rMultiple = avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : 0;
          const ev = (winRate * avgWinPct) + ((1 - winRate) * avgLossPct);  // expected value per trade in %
          const breakEvenWR = (avgWinPct + Math.abs(avgLossPct)) > 0
            ? Math.abs(avgLossPct) / (avgWinPct + Math.abs(avgLossPct))
            : 0.5;
          const edge = winRate - breakEvenWR;  // positive = profitable strategy

          let params: any = {};
          try {
            const cfg = JSON.parse(row.config_json);
            params = {
              hmaFast: cfg.signals?.hmaCrossFast ?? 5,
              hmaSlow: cfg.signals?.hmaCrossSlow ?? 19,
              dirTf: cfg.signals?.directionTimeframe ?? '1m',
              exitTf: cfg.signals?.exitTimeframe || cfg.signals?.directionTimeframe || '1m',
              signalTf: cfg.signals?.signalTimeframe ?? '1m',
              exitStrategy: cfg.exit?.strategy ?? 'takeProfit',
              stopLoss: cfg.position?.stopLossPercent ?? 80,
              tpMult: cfg.position?.takeProfitMultiplier ?? 5,
              requireDir: cfg.signals?.requireUnderlyingHmaCross ?? false,
              enableHma: cfg.signals?.enableHmaCrosses ?? true,
              enableRsi: cfg.signals?.enableRsiCrosses ?? true,
              enablePxHma: cfg.signals?.enablePriceCrossHma ?? true,
              enableEma: cfg.signals?.enableEmaCrosses ?? false,
              regimeEnabled: cfg.regime?.enabled ?? false,
              scannersEnabled: cfg.scanners?.enabled ?? false,
              maxPositions: cfg.position?.maxPositionsOpen ?? 3,
              strikeRange: cfg.strikeSelector?.strikeSearchRange ?? 80,
              contractPriceMax: cfg.strikeSelector?.contractPriceMax ?? 8,
              activeStart: cfg.timeWindows?.activeStart ?? '09:30',
              baseDollarsPerTrade: cfg.sizing?.baseDollarsPerTrade ?? 250,
              maxContracts: cfg.sizing?.maxContracts ?? 99,
              sizingMode: cfg.sizing?.sizingMode ?? 'fixed_dollars',
              sizingValue: cfg.sizing?.sizingValue ?? cfg.sizing?.baseDollarsPerTrade ?? 250,
              startingAccountValue: cfg.sizing?.startingAccountValue ?? 10000,
              isBasket: !!(cfg.basket?.enabled && cfg.basket?.members?.length),
              isBasketMember: row.configId.includes(':'),
              memberCount: cfg.basket?.members?.length ?? 0,
              symbol: (cfg.execution?.symbol ?? (row.configId.startsWith('ndx-') ? 'NDX' : 'SPX')),
              reverseSignals: cfg.signals?.reverseSignals ? true : false,
              strikeOffset: (() => {
                const d = cfg.signals?.targetOtmDistance;
                if (d === undefined || d === null) return 'OTM';
                if (d === 0) return 'ATM';
                if (d > 0) return `OTM${d}`;
                return `ITM${Math.abs(d)}`;
              })(),
            };
          } catch {}

          const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;

          enriched.push({
            configId: row.configId, name: row.name, params,
            days, trades: totalTrades, wins: totalWins, winRate,
            totalPnl, avgDailyPnl, worstDay, bestDay,
            profitDays, avgEntryPrice: 0,
            avgPnlPerTrade,
            avgWinPct, avgLossPct, rMultiple, ev, breakEvenWR, edge,
            isBasket: params.isBasket ?? false,
            isBasketMember: params.isBasketMember ?? false,
            memberCount: params.memberCount ?? 0,
          });
        }
      } else {
        // ── SLOW PATH: parse trades_json for entry price / concurrent / daily cap filters ──
        const configRows = db.prepare(`
          SELECT
            r.configId,
            c.name,
            c.config_json,
            r.date,
            r.trades_json
          FROM replay_results r
          JOIN replay_configs c ON c.id = r.configId
          ORDER BY r.configId, r.date
        `).all() as { configId: string; name: string; config_json: string; date: string; trades_json: string }[];

        const configMap = new Map<string, {
          name: string; config_json: string;
          dailyResults: { date: string; trades: any[] }[];
        }>();

        for (const row of configRows) {
          if (!configMap.has(row.configId)) {
            configMap.set(row.configId, { name: row.name, config_json: row.config_json, dailyResults: [] });
          }
          let trades: any[] = [];
          try { trades = JSON.parse(row.trades_json || '[]'); } catch {}
          configMap.get(row.configId)!.dailyResults.push({ date: row.date, trades });
        }

        for (const [configId, data] of configMap) {
          if (data.dailyResults.length < minDaysVal) continue;

          const dailyPnls: number[] = [];
          let totalTrades = 0, totalWins = 0, totalPnl = 0;
          let entryPriceSum = 0, entryPriceCount = 0;
          let totalSumWinPct = 0, totalCntWins = 0, totalSumLossPct = 0, totalCntLosses = 0;

          for (const day of data.dailyResults) {
            let filtered = entryPriceCap > 0
              ? day.trades.filter((t: any) => t.entryPrice <= entryPriceCap)
              : [...day.trades];

            filtered.sort((a: any, b: any) => (a.entryTs || 0) - (b.entryTs || 0));

            if (concurrentCap > 0) {
              const accepted: any[] = [];
              for (const t of filtered) {
                const openAtEntry = accepted.filter((a: any) => a.exitTs > t.entryTs).length;
                if (openAtEntry < concurrentCap) accepted.push(t);
              }
              filtered = accepted;
            }

            if (dailyTradeCap > 0 && filtered.length > dailyTradeCap) {
              filtered = filtered.slice(0, dailyTradeCap);
            }

            let dayPnl = 0;
            for (const t of filtered) {
              const pnl = t['pnl$'] ?? t.pnl$ ?? 0;
              const pnlPct = t.pnlPct ?? 0;
              dayPnl += pnl;
              totalTrades++;
              if (pnl > 0) totalWins++;
              if (pnlPct > 0) { totalSumWinPct += pnlPct; totalCntWins++; }
              else if (pnlPct < 0) { totalSumLossPct += pnlPct; totalCntLosses++; }
              entryPriceSum += t.entryPrice || 0;
              entryPriceCount++;
            }
            totalPnl += dayPnl;
            dailyPnls.push(dayPnl);
          }

          const days = dailyPnls.length;
          const winRate = totalTrades > 0 ? totalWins / totalTrades : 0;
          const avgDailyPnl = days > 0 ? totalPnl / days : 0;
          const worstDay = dailyPnls.length > 0 ? Math.min(...dailyPnls) : 0;
          const bestDay = dailyPnls.length > 0 ? Math.max(...dailyPnls) : 0;
          const profitDays = dailyPnls.filter(p => p > 0).length;
          const avgEntryPrice = entryPriceCount > 0 ? entryPriceSum / entryPriceCount : 0;

          // ── Statistical edge metrics ──
          const avgWinPct = totalCntWins > 0 ? totalSumWinPct / totalCntWins : 0;
          const avgLossPct = totalCntLosses > 0 ? totalSumLossPct / totalCntLosses : 0;
          const rMultiple = avgLossPct !== 0 ? avgWinPct / Math.abs(avgLossPct) : 0;
          const ev = (winRate * avgWinPct) + ((1 - winRate) * avgLossPct);
          const breakEvenWR = (avgWinPct + Math.abs(avgLossPct)) > 0
            ? Math.abs(avgLossPct) / (avgWinPct + Math.abs(avgLossPct))
            : 0.5;
          const edge = winRate - breakEvenWR;

          let params: any = {};
          try {
            const cfg = JSON.parse(data.config_json);
            params = {
              hmaFast: cfg.signals?.hmaCrossFast ?? 5,
              hmaSlow: cfg.signals?.hmaCrossSlow ?? 19,
              dirTf: cfg.signals?.directionTimeframe ?? '1m',
              exitTf: cfg.signals?.exitTimeframe || cfg.signals?.directionTimeframe || '1m',
              signalTf: cfg.signals?.signalTimeframe ?? '1m',
              exitStrategy: cfg.exit?.strategy ?? 'takeProfit',
              stopLoss: cfg.position?.stopLossPercent ?? 80,
              tpMult: cfg.position?.takeProfitMultiplier ?? 5,
              requireDir: cfg.signals?.requireUnderlyingHmaCross ?? false,
              enableHma: cfg.signals?.enableHmaCrosses ?? true,
              enableRsi: cfg.signals?.enableRsiCrosses ?? true,
              enablePxHma: cfg.signals?.enablePriceCrossHma ?? true,
              enableEma: cfg.signals?.enableEmaCrosses ?? false,
              regimeEnabled: cfg.regime?.enabled ?? false,
              scannersEnabled: cfg.scanners?.enabled ?? false,
              maxPositions: cfg.position?.maxPositionsOpen ?? 3,
              strikeRange: cfg.strikeSelector?.strikeSearchRange ?? 80,
              contractPriceMax: cfg.strikeSelector?.contractPriceMax ?? 8,
              activeStart: cfg.timeWindows?.activeStart ?? '09:30',
              isBasket: !!(cfg.basket?.enabled && cfg.basket?.members?.length),
              isBasketMember: configId.includes(':'),
              memberCount: cfg.basket?.members?.length ?? 0,
              symbol: (cfg.execution?.symbol ?? (configId.startsWith('ndx-') ? 'NDX' : 'SPX')),
              reverseSignals: cfg.signals?.reverseSignals ? true : false,
              strikeOffset: (() => {
                const d = cfg.signals?.targetOtmDistance;
                if (d === undefined || d === null) return 'OTM';
                if (d === 0) return 'ATM';
                if (d > 0) return `OTM${d}`;
                return `ITM${Math.abs(d)}`;
              })(),
            };
        } catch {}

          const avgPnlPerTrade = totalTrades > 0 ? totalPnl / totalTrades : 0;

          enriched.push({
            configId, name: data.name, params,
            days, trades: totalTrades, wins: totalWins, winRate,
            totalPnl, avgDailyPnl, worstDay, bestDay,
            profitDays, avgEntryPrice,
            avgPnlPerTrade,
            avgWinPct, avgLossPct, rMultiple, ev, breakEvenWR, edge,
            isBasket: params.isBasket ?? false,
            isBasketMember: params.isBasketMember ?? false,
            memberCount: params.memberCount ?? 0,
          });
        }
      } // end needsTradeFilter else

      // Sort
      const validSort = allowedSorts.includes(sortCol!) ? sortCol! : 'edge';
      enriched.sort((a: any, b: any) => {
        const av = a[validSort] ?? 0, bv = b[validSort] ?? 0;
        return sortDir === 'DESC' ? bv - av : av - bv;
      });

      const trimmed = enriched.slice(0, maxRows);
      res.json({ rows: trimmed, total: enriched.length });
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/config/:configId/analysis — rich strategy analysis ───
  router.get('/api/config/:configId/analysis', (req, res) => {
    const { configId } = req.params;
    const db = getDb();
    try {
      // Get config details
      const cfgRow = db.prepare('SELECT config_json, name FROM replay_configs WHERE id = ?').get(configId) as any;
      
      // Get all daily results with trades
      const results = db.prepare(`
        SELECT date, trades, wins, winRate, totalPnl, trades_json
        FROM replay_results WHERE configId = ? ORDER BY date ASC
      `).all(configId) as any[];

      if (!results.length) return res.json({ error: 'No results for this config' });

      // Parse config
      let params: any = {};
      if (cfgRow?.config_json) {
        try {
          const cfg = JSON.parse(cfgRow.config_json);
          params = {
            hmaFast: cfg.signals?.hmaCrossFast ?? '?',
            hmaSlow: cfg.signals?.hmaCrossSlow ?? '?',
            dirTf: cfg.signals?.directionTimeframe ?? '1m',
            exitTf: cfg.signals?.exitTimeframe ?? '1m',
            signalTf: cfg.signals?.signalTimeframe ?? '1m',
            enableHma: cfg.signals?.enableHmaCrosses ?? true,
            enableRsi: cfg.signals?.enableRsiCrosses ?? false,
            enablePxHma: cfg.signals?.enablePriceCrossHma ?? false,
            enableEma: cfg.signals?.enableEmaCrosses ?? false,
            enableKc: cfg.signals?.enableKeltnerGate ?? false,
            requireUndHma: cfg.signals?.requireUnderlyingHmaCross ?? false,
            targetOtmDistance: cfg.signals?.targetOtmDistance,
            stopLoss: cfg.position?.stopLossPercent ?? 0,
            tpMult: cfg.position?.takeProfitMultiplier ?? 5,
            maxPositions: cfg.position?.maxPositionsOpen ?? 3,
            contractPriceMax: cfg.strikeSelector?.contractPriceMax ?? 8,
            exitStrategy: cfg.exit?.strategy ?? 'takeProfit',
            baseDollarsPerTrade: cfg.sizing?.baseDollarsPerTrade ?? 250,
            maxContracts: cfg.sizing?.maxContracts ?? 99,
            sizingMode: cfg.sizing?.sizingMode ?? 'fixed_dollars',
            sizingValue: cfg.sizing?.sizingValue ?? cfg.sizing?.baseDollarsPerTrade ?? 250,
            startingAccountValue: cfg.sizing?.startingAccountValue ?? 10000,
          };
        } catch {}
      }

      // Aggregate all trades
      const allTrades: any[] = [];
      const dailyPnls: number[] = [];
      for (const r of results) {
        dailyPnls.push(r.totalPnl);
        try {
          const trades = JSON.parse(r.trades_json || '[]');
          for (const t of trades) { t._date = r.date; }
          allTrades.push(...trades);
        } catch {}
      }

      const wins = allTrades.filter((t: any) => t['pnl$'] > 0);
      const losses = allTrades.filter((t: any) => t['pnl$'] < 0);
      const breakeven = allTrades.filter((t: any) => t['pnl$'] === 0);

      const totalPnl = dailyPnls.reduce((s, v) => s + v, 0);
      const days = results.length;
      const greenDays = dailyPnls.filter(p => p > 0).length;
      const worstDay = Math.min(...dailyPnls);
      const bestDay = Math.max(...dailyPnls);

      // Win/loss stats
      const avgWin = wins.length > 0 ? wins.reduce((s: number, t: any) => s + t['pnl$'], 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((s: number, t: any) => s + t['pnl$'], 0) / losses.length : 0;
      const avgWinPct = wins.length > 0 ? wins.reduce((s: number, t: any) => s + (t.pnlPct || 0), 0) / wins.length : 0;
      const avgLossPct = losses.length > 0 ? losses.reduce((s: number, t: any) => s + (t.pnlPct || 0), 0) / losses.length : 0;
      const winLossRatio = losses.length > 0 && avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

      // Hold times
      const holdMins = allTrades.map((t: any) => ((t.exitTs || 0) - (t.entryTs || 0)) / 60).filter((h: number) => h > 0);
      const avgHold = holdMins.length > 0 ? holdMins.reduce((s: number, v: number) => s + v, 0) / holdMins.length : 0;
      const medianHold = holdMins.length > 0 ? holdMins.sort((a: number, b: number) => a - b)[Math.floor(holdMins.length / 2)] : 0;

      // Entry prices
      const entryPrices = allTrades.map((t: any) => t.entryPrice || 0).filter((p: number) => p > 0);
      const avgEntry = entryPrices.length > 0 ? entryPrices.reduce((s: number, v: number) => s + v, 0) / entryPrices.length : 0;

      // Exit reasons
      const exitReasons: Record<string, number> = {};
      for (const t of allTrades) {
        const r = t.reason || 'unknown';
        exitReasons[r] = (exitReasons[r] || 0) + 1;
      }

      // Sharpe
      let sharpe = 0;
      if (dailyPnls.length > 1) {
        const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
        const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
        sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
      }

      // Max drawdown (equity curve)
      let equity = 0, peak = 0, maxDrawdown = 0;
      const equityCurve: { date: string; equity: number }[] = [];
      for (const r of results) {
        equity += r.totalPnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
        equityCurve.push({ date: r.date, equity });
      }

      // Consecutive losing days
      let worstStreak = 0, streak = 0;
      for (const p of dailyPnls) {
        if (p < 0) { streak++; if (streak > worstStreak) worstStreak = streak; }
        else streak = 0;
      }

      // Buying power needed
      let peakBP = 0;
      for (const t of allTrades) {
        const cost = (t.entryPrice || 0) * (t.qty || 1) * 100;
        if (cost > peakBP) peakBP = cost;
      }

      // Build setup description
      const signals: string[] = [];
      if (params.enableHma) signals.push('HMA');
      if (params.enableRsi) signals.push('RSI');
      if (params.enablePxHma) signals.push('PxHMA');
      if (params.enableEma) signals.push('EMA');
      if (params.enableKc) signals.push('KC');
      if (params.requireUndHma) signals.push('UndHMA');

      let otmLabel = 'auto';
      if (params.targetOtmDistance != null) {
        otmLabel = params.targetOtmDistance < 0
          ? `ITM $${Math.abs(params.targetOtmDistance)}`
          : params.targetOtmDistance === 0 ? 'ATM' : `OTM $${params.targetOtmDistance}`;
      }

      // Strengths & explore suggestions
      const strengths: string[] = [];
      if (greenDays >= 22) strengths.push(`${greenDays}/${days} green days`);
      else if (greenDays >= 19) strengths.push(`${greenDays}/${days} green days`);
      if (sharpe >= 1.4) strengths.push(`Elite Sharpe ${sharpe.toFixed(2)}`);
      else if (sharpe >= 1.0) strengths.push(`Strong Sharpe ${sharpe.toFixed(2)}`);
      if (wins.length / allTrades.length >= 0.60) strengths.push(`${(wins.length / allTrades.length * 100).toFixed(0)}% win rate`);
      if (worstDay >= 0) strengths.push('Zero losing days');
      if (winLossRatio >= 2.5) strengths.push(`${winLossRatio.toFixed(1)}x win/loss ratio`);
      if (maxDrawdown === 0) strengths.push('No drawdown');

      const explore: string[] = [];
      if (params.stopLoss === 0 || params.stopLoss >= 80) explore.push('Sweep SL 25–50%');
      if (params.targetOtmDistance == null) explore.push('Test OTM -10 to +10');
      if (params.maxPositions > 1) explore.push('Try maxPos=1');
      if (sharpe < 1.0) explore.push('Add KC gate');
      if (allTrades.length > 400) explore.push('Cap trades/day');
      if (maxDrawdown > 2000) explore.push('Add trailing stop');
      if (params.tpMult >= 5) explore.push('Try TP 1.4–2x');
      if (params.tpMult <= 1.1) explore.push('Try TP 1.4–3x');
      if (!params.enableRsi && !params.enablePxHma) explore.push('Try adding RSI+PxHMA');
      if (params.enableRsi && params.enablePxHma) explore.push('Try HMA-only');

      res.json({
        configId,
        name: cfgRow?.name || configId,
        setup: {
          hma: `${params.hmaFast}×${params.hmaSlow}`,
          timeframes: `${params.dirTf}D/${params.exitTf}E`,
          signals,
          otm: otmLabel,
          stopLoss: params.stopLoss,
          tpMult: params.tpMult,
          maxPositions: params.maxPositions,
          exitStrategy: params.exitStrategy,
          contractPriceMax: params.contractPriceMax,
          baseDollarsPerTrade: params.baseDollarsPerTrade,
          maxContracts: params.maxContracts,
        },
        performance: {
          totalPnl, days, trades: allTrades.length,
          wins: wins.length, losses: losses.length, breakeven: breakeven.length,
          winRate: allTrades.length > 0 ? wins.length / allTrades.length : 0,
          avgWin, avgLoss, avgWinPct, avgLossPct, winLossRatio,
          expectancy: allTrades.length > 0 ? totalPnl / allTrades.length : 0,
          sharpe, greenDays, worstDay, bestDay,
          maxDrawdown, worstStreak,
          avgHoldMin: avgHold, medianHoldMin: medianHold,
          avgEntryPrice: avgEntry,
          peakBuyingPower: peakBP,
        },
        exitReasons,
        equityCurve,
        strengths,
        explore,
      });
    } finally {
      db.close();
    }
  });

router.get('/api/sweep/:configId/daily', (req, res) => {
    const { configId } = req.params;
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT date, trades, wins, winRate, totalPnl, avgPnlPerTrade, maxWin, maxLoss, sharpeRatio
        FROM replay_results WHERE configId = ? ORDER BY date ASC
      `).all(configId);
      res.json(rows);
    } finally { db.close(); }
  });

router.get('/api/sweep/chunks', (req, res) => {
    const { configId, minDays } = req.query as Record<string, string | undefined>;
    const db = getDb();
    const minDaysVal = Math.max(2, parseInt(minDays || '2'));
    const CHUNK_MS = 30 * 60 * 1000;
    const SESSION_START_MS = (9 * 60 + 30) * 60 * 1000;
    const SESSION_END_MS = 16 * 60 * 60 * 1000;

    interface ChunkResult {
      chunk: string;
      chunkLabel: string;
      avgPnlPerDay: number;
      winRate: number;
      totalPnl: number;
      tradeCount: number;
      dayCount: number;
      avgPnlPerTrade: number;
    }

    interface ConfigChunkResult {
      configId: string;
      name: string;
      chunk: string;
      chunkLabel: string;
      avgPnlPerDay: number;
      winRate: number;
      totalPnl: number;
      tradeCount: number;
      dayCount: number;
      avgPnlPerTrade: number;
      edge: number;
    }

    try {
      const rows = db.prepare(`
        SELECT r.configId, r.date, r.trades_json, c.name
        FROM replay_results r
        JOIN replay_configs c ON c.id = r.configId
      `).all() as any[];

      const configDays = new Map<string, number>();
      for (const row of rows) {
        configDays.set(row.configId, (configDays.get(row.configId) ?? 0) + 1);
      }
      const validSet = new Set([...configDays.entries()].filter(([, n]) => n >= minDaysVal).map(([id]) => id));

      const dayChunkPnls = new Map<string, Map<string, number>>();
      const dayChunkWins = new Map<string, Map<string, number>>();
      const dayChunkTrades = new Map<string, Map<string, number>>();

      const configDayChunkPnls = new Map<string, Map<string, Map<string, number>>>();
      const configDayChunkWins = new Map<string, Map<string, Map<string, number>>>();
      const configDayChunkTrades = new Map<string, Map<string, Map<string, number>>>();
      const configNames = new Map<string, string>();

      for (const row of rows) {
        if (!validSet.has(row.configId)) continue;
        if (configId && row.configId !== configId) continue;
        configNames.set(row.configId, row.name || row.configId);
        let trades: any[] = [];
        try { trades = JSON.parse(row.trades_json || '[]'); } catch { continue; }

        const dayChunks = new Map<string, number>();
        const dayWins = new Map<string, number>();
        const dayTrades = new Map<string, number>();

        for (const t of trades) {
          const entryET = t.entryET || t.exitET;
          if (!entryET) continue;
          const [h, m] = entryET.split(':').map(Number);
          const entryMs = (h * 60 + m) * 60 * 1000;
          if (entryMs < SESSION_START_MS || entryMs >= SESSION_END_MS) continue;

          const offset = entryMs - SESSION_START_MS;
          const chunkIdx = Math.floor(offset / CHUNK_MS);
          const chunkStart = SESSION_START_MS + chunkIdx * CHUNK_MS;
          const cs = Math.floor(chunkStart / (60 * 60 * 1000));
          const cm = Math.floor((chunkStart % (60 * 60 * 1000)) / (60 * 1000));
          const ce = Math.floor((chunkStart + CHUNK_MS) / (60 * 60 * 1000));
          const cem = Math.floor(((chunkStart + CHUNK_MS) % (60 * 60 * 1000)) / (60 * 1000));
          const chunk = `${String(cs).padStart(2,'0')}:${String(cm).padStart(2,'0')}-${String(ce).padStart(2,'0')}:${String(cem).padStart(2,'0')}`;
          const pnl = t['pnl$'] ?? t.pnl$ ?? 0;

          dayChunks.set(chunk, (dayChunks.get(chunk) ?? 0) + pnl);
          dayTrades.set(chunk, (dayTrades.get(chunk) ?? 0) + 1);
          if (pnl > 0) dayWins.set(chunk, (dayWins.get(chunk) ?? 0) + 1);
        }

        for (const [chunk, pnl] of dayChunks) {
          if (!dayChunkPnls.has(chunk)) dayChunkPnls.set(chunk, new Map());
          const dm = dayChunkPnls.get(chunk)!;
          dm.set(row.date, (dm.get(row.date) ?? 0) + pnl);

          if (!dayChunkTrades.has(chunk)) dayChunkTrades.set(chunk, new Map());
          const dt = dayChunkTrades.get(chunk)!;
          dt.set(row.date, (dt.get(row.date) ?? 0) + (dayTrades.get(chunk) ?? 0));

          if (!dayChunkWins.has(chunk)) dayChunkWins.set(chunk, new Map());
          const dw = dayChunkWins.get(chunk)!;
          dw.set(row.date, (dw.get(row.date) ?? 0) + (dayWins.get(chunk) ?? 0));

          if (!configDayChunkPnls.has(row.configId)) configDayChunkPnls.set(row.configId, new Map());
          const cdm = configDayChunkPnls.get(row.configId)!;
          if (!cdm.has(chunk)) cdm.set(chunk, new Map());
          cdm.get(chunk)!.set(row.date, (cdm.get(chunk)!.get(row.date) ?? 0) + pnl);

          if (!configDayChunkTrades.has(row.configId)) configDayChunkTrades.set(row.configId, new Map());
          const cdt = configDayChunkTrades.get(row.configId)!;
          if (!cdt.has(chunk)) cdt.set(chunk, new Map());
          cdt.get(chunk)!.set(row.date, (cdt.get(chunk)!.get(row.date) ?? 0) + (dayTrades.get(chunk) ?? 0));

          if (!configDayChunkWins.has(row.configId)) configDayChunkWins.set(row.configId, new Map());
          const cdw = configDayChunkWins.get(row.configId)!;
          if (!cdw.has(chunk)) cdw.set(chunk, new Map());
          cdw.get(chunk)!.set(row.date, (cdw.get(chunk)!.get(row.date) ?? 0) + (dayWins.get(chunk) ?? 0));
        }
      }

      const results: ChunkResult[] = [];
      for (const chunk of [...dayChunkPnls.keys()].sort()) {
        const dateMap = dayChunkPnls.get(chunk)!;
        const tradeDateMap = dayChunkTrades.get(chunk)!;
        const winDateMap = dayChunkWins.get(chunk)!;

        const pnls = [...dateMap.values()];
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const dayCount = pnls.length;
        const avgPnlPerDay = dayCount > 0 ? totalPnl / dayCount : 0;

        let tradeCount = 0, wins = 0;
        for (const [, cnt] of tradeDateMap) tradeCount += cnt;
        for (const [, cnt] of winDateMap) wins += cnt;
        const winRate = tradeCount > 0 ? wins / tradeCount : 0;
        const avgPnlPerTrade = tradeCount > 0 ? totalPnl / tradeCount : 0;

        const [sh, sm] = chunk.split('-')[0].split(':').map(Number);
        const ampm = sh >= 12 ? 'PM' : 'AM';
        const sh12 = sh > 12 ? sh - 12 : sh === 0 ? 12 : sh;
        const chunkLabel = `${sh12}:${String(sm).padStart(2,'0')} ${ampm}`;

        results.push({ chunk, chunkLabel, avgPnlPerDay, winRate, totalPnl, tradeCount, dayCount, avgPnlPerTrade });
      }

      const configChunkResults: ConfigChunkResult[] = [];
      for (const [cfgId, chunkMap] of configDayChunkPnls) {
        for (const [chunk, dateMap] of chunkMap) {
          const tradeDateMap = configDayChunkTrades.get(cfgId)?.get(chunk) ?? new Map();
          const winDateMap = configDayChunkWins.get(cfgId)?.get(chunk) ?? new Map();

          const pnls = [...dateMap.values()];
          const totalPnl = pnls.reduce((a, b) => a + b, 0);
          const dayCount = pnls.length;
          const avgPnlPerDay = dayCount > 0 ? totalPnl / dayCount : 0;

          let tradeCount = 0, wins = 0;
          for (const [, cnt] of tradeDateMap) tradeCount += cnt;
          for (const [, cnt] of winDateMap) wins += cnt;
          const winRate = tradeCount > 0 ? wins / tradeCount : 0;
          const avgPnlPerTrade = tradeCount > 0 ? totalPnl / tradeCount : 0;

          const avgWinPct = winRate;
          const avgLossPct = tradeCount > 0 && wins < tradeCount ? -(1 - winRate) * 1.5 : -0.5;
          const edge = avgWinPct - (avgLossPct !== 0 ? Math.abs(avgLossPct) / (avgWinPct + Math.abs(avgLossPct)) : 0.5);

          const [sh, sm] = chunk.split('-')[0].split(':').map(Number);
          const ampm = sh >= 12 ? 'PM' : 'AM';
          const sh12 = sh > 12 ? sh - 12 : sh === 0 ? 12 : sh;
          const chunkLabel = `${sh12}:${String(sm).padStart(2,'0')} ${ampm}`;

          configChunkResults.push({
            configId: cfgId,
            name: configNames.get(cfgId) || cfgId,
            chunk,
            chunkLabel,
            avgPnlPerDay,
            winRate,
            totalPnl,
            tradeCount,
            dayCount,
            avgPnlPerTrade,
            edge,
          });
        }
      }

      configChunkResults.sort((a, b) => b.edge - a.edge);

      res.json({
        chunks: results,
        configChunks: configChunkResults,
        marketHours: '09:30–16:00 ET',
        chunkSizeMinutes: 30,
      });
    } finally { db.close(); }
  });

  // ── GET /replay/api/hma-pairs — unique HMA pair combinations ──────────────
  router.get('/api/hma-pairs', (_req, res) => {
    const db = getDb();
    try {
      const rows = db.prepare('SELECT config_json FROM replay_configs').all() as { config_json: string }[];
      const pairMap = new Map<string, { hmaFast: number; hmaSlow: number; count: number }>();
      for (const row of rows) {
        try {
          const cfg = JSON.parse(row.config_json);
          const hf = cfg.signals?.hmaCrossFast ?? 5;
          const hs = cfg.signals?.hmaCrossSlow ?? 19;
          const key = `${hf}-${hs}`;
          const existing = pairMap.get(key);
          if (existing) { existing.count++; } else { pairMap.set(key, { hmaFast: hf, hmaSlow: hs, count: 1 }); }
        } catch { continue; }
      }
      const pairs = [...pairMap.values()]
        .map((p) => ({ hmaFast: p.hmaFast, hmaSlow: p.hmaSlow, configCount: p.count, name: `HMA ${p.hmaFast}×${p.hmaSlow}` }))
        .sort((a, b) => b.configCount - a.configCount);
      res.json({ pairs });
    } finally { db.close(); }
  });

  // ── GET /replay/api/trade-query — filtered trade data by HMA, time, sizing ─
  router.get('/api/trade-query', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const hmaFast = parseInt(q.hmaFast || '0') || undefined;
    const hmaSlow = parseInt(q.hmaSlow || '0') || undefined;
    const windowSize = parseInt(q.windowSize || '30') || 30;
    const maxContracts = parseInt(q.maxContracts || '0') || undefined;
    const maxDollars = parseInt(q.maxDollarsPerTrade || '0') || undefined;
    const strikeMin = parseFloat(q.strikeMin || '0') || undefined;
    const strikeMax = parseFloat(q.strikeMax || '0') || undefined;
    const activeStart = q.activeStart;
    const activeEnd = q.activeEnd;
    const sizingMode = q.sizingMode === 'skip' || q.sizingMode === 'scale' ? q.sizingMode : 'both';

    const db = getDb();
    try {
      // Step 1: Find configs matching HMA pair
      const configRows = db.prepare('SELECT id, name, config_json FROM replay_configs').all() as { id: string; name: string; config_json: string }[];
      const matchedConfigs: { id: string; name: string }[] = [];
      for (const cr of configRows) {
        try {
          const cfg = JSON.parse(cr.config_json);
          const hf = cfg.signals?.hmaCrossFast ?? 5;
          const hs = cfg.signals?.hmaCrossSlow ?? 19;
          if (hmaFast !== undefined && hf !== hmaFast) continue;
          if (hmaSlow !== undefined && hs !== hmaSlow) continue;
          matchedConfigs.push({ id: cr.id, name: cr.name || cr.id });
        } catch { continue; }
      }

      if (matchedConfigs.length === 0) {
        res.json({
          filters: { hmaFast, hmaSlow, windowSize, maxContracts, maxDollarsPerTrade: maxDollars, sizingMode },
          summary: { totalTrades: 0, wins: 0, winRate: 0, totalPnl: 0, avgPnlPerTrade: 0, avgPnlPerDay: 0, dayCount: 0 },
          chunks: [],
          bestConfigs: [],
          killZones: [],
          meta: { configsMatched: 0, datesCovered: 0, incompleteDataWarning: false },
        });
        return;
      }

      // Step 2: Load results for matched configs
      const configIds = matchedConfigs.map((c) => c.id);
      const placeholders = configIds.map(() => '?').join(',');
      const resultRows = db.prepare(
        `SELECT configId, date, trades_json FROM replay_results WHERE configId IN (${placeholders})`
      ).all(...configIds) as { configId: string; date: string; trades_json: string }[];

      const configNameMap = new Map(matchedConfigs.map((c) => [c.id, c.name]));

      // Step 3: Parse trades and aggregate
      const datesCovered = new Set<string>();
      let incompleteData = false;

      // Per-config per-chunk aggregation for bestConfigs + killZones
      const configChunkData: ConfigChunkData[] = [];

      const globalChunkPnl = new Map<string, Map<string, number>>();
      const globalChunkTrades = new Map<string, number>();
      const globalChunkWins = new Map<string, number>();

      const skipChunkPnl = new Map<string, number>();
      const skipChunkTrades = new Map<string, number>();
      const scaleChunkPnl = new Map<string, number>();
      const scaleChunkTrades = new Map<string, number>();

      for (const row of resultRows) {
        let trades: TradeLike[];
        try { trades = JSON.parse(row.trades_json || '[]'); } catch { continue; }
        if (!Array.isArray(trades) || trades.length === 0) continue;

        datesCovered.add(row.date);

        let filtered = filterTradesByWindow(trades, activeStart, activeEnd);
        filtered = filterTradesByStrike(filtered, strikeMin, strikeMax);

        if (filtered.length === 0) continue;

        const buckets = bucketTradesIntoChunks(filtered, windowSize);

        for (const [chunkKey, chunkTrades] of buckets) {
          const metrics = aggregateChunkMetrics(chunkTrades);
          configChunkData.push({
            configId: row.configId,
            name: configNameMap.get(row.configId) || row.configId,
            chunk: chunkKey,
            avgPnlPerDay: metrics.totalPnl,
            winRate: metrics.winRate,
            tradeCount: metrics.totalTrades,
          });

          if (!globalChunkPnl.has(chunkKey)) globalChunkPnl.set(chunkKey, new Map());
          const dm = globalChunkPnl.get(chunkKey)!;
          dm.set(row.date, (dm.get(row.date) ?? 0) + metrics.totalPnl);
          globalChunkTrades.set(chunkKey, (globalChunkTrades.get(chunkKey) ?? 0) + metrics.totalTrades);
          globalChunkWins.set(chunkKey, (globalChunkWins.get(chunkKey) ?? 0) + metrics.wins);

          if (maxContracts || maxDollars) {
            const skipResult = applySizingFilter(chunkTrades, 'skip', maxContracts, maxDollars);
            skipChunkPnl.set(chunkKey, (skipChunkPnl.get(chunkKey) ?? 0) + skipResult.totalPnl);
            skipChunkTrades.set(chunkKey, (skipChunkTrades.get(chunkKey) ?? 0) + skipResult.trades.length);

            const scaleResult = applySizingFilter(chunkTrades, 'scale', maxContracts, maxDollars);
            scaleChunkPnl.set(chunkKey, (scaleChunkPnl.get(chunkKey) ?? 0) + scaleResult.totalPnl);
            scaleChunkTrades.set(chunkKey, (scaleChunkTrades.get(chunkKey) ?? 0) + scaleResult.trades.length);
          }

          for (const t of chunkTrades) {
            if (!t.entryET && !t.exitET) incompleteData = true;
          }
        }
      }

      const chunks = [...globalChunkPnl.keys()].sort().map((chunkKey) => {
        const dateMap = globalChunkPnl.get(chunkKey)!;
        const pnls = [...dateMap.values()];
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const dayCount = pnls.length;
        const avgPnlPerDay = dayCount > 0 ? totalPnl / dayCount : 0;
        const tradeCount = globalChunkTrades.get(chunkKey) ?? 0;
        const wins = globalChunkWins.get(chunkKey) ?? 0;
        const winRate = tradeCount > 0 ? wins / tradeCount : 0;

        return {
          chunk: chunkKey,
          chunkLabel: chunkLabel(chunkKey),
          totalTrades: tradeCount,
          wins,
          winRate,
          totalPnl,
          avgPnlPerTrade: tradeCount > 0 ? totalPnl / tradeCount : 0,
          avgPnlPerDay,
          dayCount,
          skipView: {
            totalTrades: skipChunkTrades.get(chunkKey) ?? tradeCount,
            totalPnl: skipChunkPnl.get(chunkKey) ?? totalPnl,
          },
          scaleView: {
            totalTrades: scaleChunkTrades.get(chunkKey) ?? tradeCount,
            totalPnl: scaleChunkPnl.get(chunkKey) ?? totalPnl,
          },
        };
      });

      const allPnl = chunks.reduce((a, c) => a + c.totalPnl, 0);
      const allTrades = chunks.reduce((a, c) => a + c.totalTrades, 0);
      const allWins = chunks.reduce((a, c) => a + c.wins, 0);
      const allDays = datesCovered.size;

      res.json({
        filters: { hmaFast, hmaSlow, windowSize, maxContracts, maxDollarsPerTrade: maxDollars, sizingMode },
        summary: {
          totalTrades: allTrades,
          wins: allWins,
          winRate: allTrades > 0 ? allWins / allTrades : 0,
          totalPnl: allPnl,
          avgPnlPerTrade: allTrades > 0 ? allPnl / allTrades : 0,
          avgPnlPerDay: allDays > 0 ? allPnl / allDays : 0,
          dayCount: allDays,
        },
        chunks,
        bestConfigs: findBestConfigsPerChunk(configChunkData),
        killZones: detectKillZones(configChunkData),
        meta: { configsMatched: matchedConfigs.length, datesCovered: allDays, incompleteDataWarning: incompleteData },
      });
    } finally { db.close(); }
  });

  // ── Live View API proxy ─────────────────────────────────────────────────
  // ── GET /replay/api/live/agent/config — serve live config directly from DB
  // Reads AGENT_CONFIG_ID from ecosystem.config.js (not process.env) so
  // set-live-config changes are reflected immediately without restarting.
  router.get('/api/live/agent/config', (_req, res) => {
    try {
      // Parse the live config ID from ecosystem.config.js
      const ecoPath = path.resolve(process.cwd(), 'ecosystem.config.js');
      const ecoContent = fs.readFileSync(ecoPath, 'utf-8');
      const match = ecoContent.match(/AGENT_CONFIG_ID:\s*'([^']+)'/);
      if (!match) return res.json({ error: 'AGENT_CONFIG_ID not found in ecosystem.config.js' });

      const configId = match[1];
      const db = getDb();
      try {
        const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
          .get(configId) as { config_json: string } | undefined;
        if (!row) return res.json({ error: `Config '${configId}' not found in DB` });
        const cfg = JSON.parse(row.config_json);
        res.json({
          id: cfg.id,
          name: cfg.name,
          signals: cfg.signals,
          position: cfg.position,
          strikeSelector: cfg.strikeSelector,
          risk: cfg.risk,
          exit: cfg.exit,
          sizing: cfg.sizing,
          timeWindows: cfg.timeWindows,
        });
      } finally {
        db.close();
      }
    } catch (err: any) {
      res.json({ error: err.message });
    }
  });

  // ── GET /replay/api/live/trades — today's trades from Tradier orders API ──
  // Fetches OTOCO bracket orders + standalone sells directly from broker.
  // Complete round-trip data: entry fills, exit fills, P&L, exit reason.
  router.get('/api/live/trades', async (_req, res) => {
    try {
      const token = process.env.TRADIER_TOKEN;
      const accountId = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
      if (!token) return res.json({ error: 'TRADIER_TOKEN not configured' });

      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

      // Fetch orders from Tradier
      const resp = await fetch(`https://api.tradier.com/v1/accounts/${accountId}/orders`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!resp.ok) return res.status(502).json({ error: `Tradier ${resp.status}` });
      const data = await resp.json() as any;
      const raw = data?.orders?.order;
      const allOrders: any[] = raw ? (Array.isArray(raw) ? raw : [raw]) : [];

      // Filter to today only
      const orders = allOrders.filter((o: any) => o.create_date?.startsWith(today));

      interface RoundTrip {
        orderId: number;
        symbol: string;
        side: string;
        strike: number;
        qty: number;
        entryTime: string;
        entryTs: number;
        entryFill: number | null;
        exitFill: number | null;
        exitReason: string;
        exitTime: string | null;
        exitTs: number;
        tpTarget: number | null;
        slTarget: number | null;
        status: string;
      }

      const roundTrips: RoundTrip[] = [];

      // Normalize: Tradier uses 'class' field, not 'type'
      const orderType = (o: any) => o.type || o.class || '';

      // Collect standalone sells (scannerReverse exits) for matching
      const standaloneSells = orders.filter((o: any) => {
        const t = orderType(o);
        return (t === 'option' || t === 'market' || t === 'equity') &&
          o.side === 'sell_to_close' &&
          o.status === 'filled' &&
          (o.avg_fill_price ?? 0) > 0;
      });
      const usedSellIds = new Set<number>();

      for (const order of orders) {
        // Only process OTOCO/OTO orders (bracket trades)
        const ot = orderType(order);
        if (ot !== 'otoco' && ot !== 'oto') continue;
        const legs: any[] = order.leg ? (Array.isArray(order.leg) ? order.leg : [order.leg]) : [];
        if (legs.length === 0) continue;

        // Find entry leg (buy_to_open), TP leg (limit), SL leg (stop)
        const entryLeg = legs.find((l: any) => l.side === 'buy_to_open');
        const tpLeg = legs.find((l: any) => l.side === 'sell_to_close' && l.price != null && l.stop_price == null);
        const slLeg = legs.find((l: any) => l.side === 'sell_to_close' && l.stop_price != null);

        if (!entryLeg) continue;

        const symbol = entryLeg.option_symbol || '';
        if (!symbol) continue;
        const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        const side = match ? (match[3] === 'C' ? 'call' : 'put') : 'unknown';
        const strike = match ? parseInt(match[4]) / 1000 : 0;

        const entryFill = entryLeg.avg_fill_price ?? null;
        const tpTarget = tpLeg?.price ?? null;
        const slTarget = slLeg?.stop_price ?? null;

        // Determine exit
        let exitFill: number | null = null;
        let exitReason = 'OPEN';
        let exitTime: string | null = null;

        if (tpLeg?.status === 'filled' && (tpLeg.avg_fill_price ?? 0) > 0) {
          exitFill = tpLeg.avg_fill_price;
          exitReason = 'TP';
          exitTime = tpLeg.create_date || tpLeg.transaction_date;
        } else if (slLeg?.status === 'filled' && (slLeg.avg_fill_price ?? 0) > 0) {
          exitFill = slLeg.avg_fill_price;
          exitReason = 'SL';
          exitTime = slLeg.create_date || slLeg.transaction_date;
        }

        // If OCO legs were canceled, look for a standalone sell_to_close (scannerReverse)
        if (exitReason === 'OPEN' && entryLeg.status === 'filled') {
          const entryTs = entryLeg.create_date ? new Date(entryLeg.create_date).getTime() : 0;
          const entryOptionSym = entryLeg.option_symbol || '';
          const matchingSell = standaloneSells.find((s: any) => {
            if (usedSellIds.has(s.id)) return false;
            const sellSym = s.option_symbol || '';
            if (sellSym !== entryOptionSym) return false;
            const sellTs = s.create_date ? new Date(s.create_date).getTime() : 0;
            return sellTs >= entryTs;
          });
          if (matchingSell) {
            usedSellIds.add(matchingSell.id);
            exitFill = matchingSell.avg_fill_price;
            exitReason = 'REV';
            exitTime = matchingSell.create_date;
          }
        }

        const qty = entryLeg.quantity || 1;

        const status = exitReason === 'OPEN'
          ? (entryLeg.status === 'filled' ? 'OPEN' : entryLeg.status?.toUpperCase() || 'PENDING')
          : 'CLOSED';

        const entryTimeStr = entryLeg.create_date || order.create_date || '';

        roundTrips.push({
          orderId: order.id,
          symbol,
          side,
          strike,
          qty,
          entryTime: entryTimeStr,
          entryTs: entryTimeStr ? new Date(entryTimeStr).getTime() : 0,
          entryFill,
          exitFill,
          exitReason,
          exitTime,
          exitTs: exitTime ? new Date(exitTime).getTime() : 0,
          tpTarget,
          slTarget,
          status,
        });
      }

      // Sort by entry time
      roundTrips.sort((a, b) => a.entryTs - b.entryTs);

      // Summary stats — NO internal P&L. Broker is sole source of truth.
      // Use balance.close_pl for today's P&L, /gainloss for historical.
      const closed = roundTrips.filter(t => t.status === 'CLOSED');

      res.json({
        trades: roundTrips,
        summary: {
          total: roundTrips.length,
          closed: closed.length,
          open: roundTrips.length - closed.length,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Forwards requests to the data service (port 3600) so the live view
  // can access live market data through the /replay/ prefix.
  // Read-only — does not affect the data service or trading agent.
  const DATA_SERVICE_PORT = parseInt(process.env.PORT || '3600');

  router.get('/api/live/{*path}', (req, res) => {
    // Strip /api/live prefix → forward as bare path to data service
    // e.g. /replay/api/live/spx/bars?tf=1m → http://localhost:3600/spx/bars?tf=1m
    const queryStr = req.url.includes('?') ? '?' + req.url.split('?')[1] : '';
    const pathSegments = (req.params as any).path;
    const pathStr = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments;
    const targetPath = '/' + pathStr + queryStr;

    const opts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: DATA_SERVICE_PORT,
      path: targetPath,
      method: 'GET',
      timeout: 10000,
    };

    const proxyReq = http.request(opts, (proxyRes) => {
      res.status(proxyRes.statusCode || 200);
      // Forward content-type
      if (proxyRes.headers['content-type']) {
        res.setHeader('Content-Type', proxyRes.headers['content-type']);
      }
      // If upstream aborts mid-stream, headers are already sent — can't JSON.
      // Just destroy the response so the client sees a broken connection.
      proxyRes.on('error', () => {
        try { res.destroy(); } catch { /* ignore */ }
      });
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (res.headersSent) {
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      res.status(502).json({ error: 'Data service unavailable', detail: err.message });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      if (res.headersSent) {
        try { res.destroy(); } catch { /* ignore */ }
        return;
      }
      res.status(504).json({ error: 'Data service timeout' });
    });

    proxyReq.end();
  });

  // ── DELETE /replay/api/config/:id — delete config + all its results ──────
  router.delete('/api/config/:id', (req, res) => {
    const configId = req.params.id;
    const db = getWriteDb();
    try {
      // Check it exists
      const row = db.prepare('SELECT id, name FROM replay_configs WHERE id = ?').get(configId) as any;
      if (!row) return res.status(404).json({ error: `Config '${configId}' not found` });

      // Count associated data
      const resultCount = (db.prepare('SELECT COUNT(*) as c FROM replay_results WHERE configId = ?').get(configId) as any).c;
      const runCount = (db.prepare('SELECT COUNT(*) as c FROM replay_runs WHERE configId = ?').get(configId) as any).c;

      // Delete results, runs, and config
      db.prepare('DELETE FROM replay_results WHERE configId = ?').run(configId);
      db.prepare('DELETE FROM replay_runs WHERE configId = ?').run(configId);
      db.prepare('DELETE FROM replay_configs WHERE id = ?').run(configId);

      console.log(`[replay] Deleted config '${configId}' (${row.name}): ${resultCount} results, ${runCount} runs`);
      res.json({ deleted: configId, name: row.name, resultsDeleted: resultCount, runsDeleted: runCount });
    } finally {
      db.close();
    }
  });

  // ── DELETE /replay/api/configs/batch — batch delete configs + all their results ──────
  router.delete('/api/configs/batch', (req, res) => {
    const { ids } = req.body as { ids?: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }

    const db = getWriteDb();
    try {
      let deleted = 0;
      let resultsDeleted = 0;
      let runsDeleted = 0;
      const errors: { id: string; error: string }[] = [];
      const deletedNames: string[] = [];

      for (const configId of ids) {
        const row = db.prepare('SELECT id, name FROM replay_configs WHERE id = ?').get(configId) as any;
        if (!row) {
          errors.push({ id: configId, error: 'Not found' });
          continue;
        }

        const resultCount = (db.prepare('SELECT COUNT(*) as c FROM replay_results WHERE configId = ?').get(configId) as any).c;
        const runCount = (db.prepare('SELECT COUNT(*) as c FROM replay_runs WHERE configId = ?').get(configId) as any).c;

        db.prepare('DELETE FROM replay_results WHERE configId = ?').run(configId);
        db.prepare('DELETE FROM replay_runs WHERE configId = ?').run(configId);
        db.prepare('DELETE FROM replay_configs WHERE id = ?').run(configId);

        deleted++;
        resultsDeleted += resultCount;
        runsDeleted += runCount;
        deletedNames.push(row.name || configId);
      }

      console.log(`[replay] Batch deleted ${deleted} configs: ${resultsDeleted} results, ${runsDeleted} runs`);
      res.json({ deleted, resultsDeleted, runsDeleted, deletedNames, errors });
    } finally {
      db.close();
    }
  });

  // ── POST /replay/api/backfill — backfill a date from Polygon ─────────────
  // Spawns a detached worker to fetch underlying + options data into replay_bars.
  // body: { date, profileId?: 'spx-0dte'|'ndx-0dte' }
  router.post('/api/backfill', (req, res) => {
    const { date, profileId } = req.body as { date?: string; profileId?: string };

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });
    }

    // Check if POLYGON_API_KEY is configured
    if (!process.env.POLYGON_API_KEY) {
      return res.status(500).json({ error: 'POLYGON_API_KEY not configured on server' });
    }

    const resolvedProfileId = profileId || 'spx-0dte';

    const jobId = randomUUID();
    const jobDir = path.resolve(process.cwd(), 'data', 'jobs');
    if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });

    const jobFile = path.join(jobDir, `backfill-${jobId}.json`);
    const statusFile = path.join(jobDir, `backfill-${jobId}-status.json`);

    // Write initial status
    fs.writeFileSync(statusFile, JSON.stringify({
      jobId, date, profileId: resolvedProfileId, status: 'pending', phase: 'starting',
      spxBars: 0, optionContracts: 0, optionBars: 0, errors: [],
      startedAt: Date.now(),
    }));

    // Write job spec — includes profileId so worker routes correct underlying+option source
    fs.writeFileSync(jobFile, JSON.stringify({
      jobId, date, dbPath: DB_PATH, statusFile, profileId: resolvedProfileId,
    }));

    // Spawn detached worker
    const workerScript = path.resolve(process.cwd(), 'scripts', 'backfill', 'backfill-worker.ts');
    const logFile = fs.openSync(path.join(jobDir, `backfill-${jobId}.log`), 'a');

    const child = spawn('npx', ['tsx', workerScript, jobFile], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFile, logFile],
      env: { ...process.env },
    });

    child.unref();
    console.log(`[backfill] Spawned worker PID ${child.pid} for ${date} (job ${jobId})`);

    res.json({ jobId, date, statusFile: path.basename(statusFile) });
  });

  // ── GET /replay/api/backfill/:jobId — poll backfill status ────────────────
  router.get('/api/backfill/:jobId', (req, res) => {
    const statusFile = path.resolve(process.cwd(), 'data', 'jobs', `backfill-${req.params.jobId}-status.json`);
    if (!fs.existsSync(statusFile)) {
      return res.status(404).json({ error: 'Backfill job not found' });
    }
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      res.json(status);
    } catch {
      res.status(500).json({ error: 'Failed to read status file' });
    }
  });

  // ── Serve the time analytics viewer HTML ──────────────────────────────
  router.get('/time-analytics', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const htmlPath = path.resolve(__dirname, 'time-analytics-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/time-analytics-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── Serve the analytics viewer HTML ──────────────────────────────────────
  router.get('/analytics', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const htmlPath = path.resolve(__dirname, 'analytics-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/analytics-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── Serve the sweep leaderboard HTML ─────────────────────────────────────
  router.get('/sweep', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const htmlPath = path.resolve(__dirname, 'sweep-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/sweep-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── Serve the analytics HTML ──────────────────────────────────────────
  router.get('/analytics', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const htmlPath = path.resolve(__dirname, 'analytics-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/analytics-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── Serve the edge framework paper HTML ─────────────────────────────────
  router.get('/paper', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    const htmlPath = path.resolve(process.cwd(), 'docs/edge-framework-paper.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      res.status(404).send('Paper not found');
    }
  });

  // ── Serve the backfill management HTML ──────────────────────────────────
  router.get('/backfill', (req, res) => {
    const htmlPath = path.resolve(__dirname, 'backfill-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/backfill-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ██  UNIVERSAL BACKFILL — Symbols & Orchestration endpoints (Phase 3)   ██
  // ════════════════════════════════════════════════════════════════════════════

  // ── GET /api/symbols — list all instrument profiles ────────────────────────
  router.get('/api/symbols', (_req, res) => {
    const db = getDb();
    try {
      const profiles = listProfiles(db);
      res.json({ profiles });
    } finally {
      db.close();
    }
  });

  // ── GET /api/symbols/:id — single profile detail ───────────────────────────
  router.get('/api/symbols/:id', (req, res) => {
    const db = getDb();
    try {
      const profile = loadProfile(db, req.params.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });
      res.json({ profile });
    } finally {
      db.close();
    }
  });

  // ── POST /api/symbols/discover — preview auto-discovered profile ───────────
  router.post('/api/symbols/discover', async (req, res) => {
    const { ticker } = req.body as { ticker?: string };
    if (!ticker || typeof ticker !== 'string') {
      return res.status(400).json({ error: 'ticker (string) required' });
    }
    try {
      const discovered = await discoverProfile(ticker);
      res.json({ profile: discovered });
    } catch (e) {
      if (e instanceof DiscoveryError) {
        const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'NO_API_KEY' ? 500 : 502;
        return res.status(status).json({ error: e.message, code: e.code });
      }
      console.error('[symbols/discover] unexpected error:', e);
      res.status(500).json({ error: 'Discovery failed' });
    }
  });

  // ── POST /api/symbols — save confirmed profile ─────────────────────────────
  router.post('/api/symbols', (req, res) => {
    const body = req.body as Partial<StoredInstrumentProfile>;
    if (!body.id || !body.underlyingSymbol || !body.optionPrefix) {
      return res.status(400).json({ error: 'id, underlyingSymbol, optionPrefix required' });
    }
    const db = getWriteDb();
    try {
      const now = Math.floor(Date.now() / 1000);
      const profile: StoredInstrumentProfile = {
        id: body.id,
        displayName: body.displayName || body.underlyingSymbol,
        underlyingSymbol: body.underlyingSymbol,
        assetClass: body.assetClass || 'equity',
        optionPrefix: body.optionPrefix,
        strikeDivisor: body.strikeDivisor ?? 1,
        strikeInterval: body.strikeInterval ?? 1,
        bandHalfWidthDollars: body.bandHalfWidthDollars ?? 10,
        avgDailyRange: body.avgDailyRange ?? null,
        expiryCadences: body.expiryCadences ?? ['weekly'],
        session: body.session ?? { preMarket: '08:00', rthStart: '09:30', rthEnd: '16:00', postMarket: '17:00' },
        vendorRouting: body.vendorRouting ?? { underlying: { vendor: 'polygon', ticker: body.underlyingSymbol }, options: { vendor: 'polygon' } },
        tier: body.tier ?? 1,
        canGoLive: false,
        executionAccountId: null,
        source: 'ui-discovered',
        createdAt: now,
        updatedAt: now,
      };
      saveProfile(db, profile);
      res.json({ profile });
    } finally {
      db.close();
    }
  });

  // ── DELETE /api/symbols/:id — remove profile (reject if canGoLive) ─────────
  router.delete('/api/symbols/:id', (req, res) => {
    const db = getWriteDb();
    try {
      const existing = loadProfile(db, req.params.id);
      if (!existing) return res.status(404).json({ error: 'Profile not found' });
      if (existing.canGoLive) {
        return res.status(409).json({ error: 'Cannot delete a live-enabled profile — disable canGoLive first' });
      }
      deleteProfile(db, req.params.id);
      res.json({ ok: true });
    } finally {
      db.close();
    }
  });

  // ── GET /api/symbols/:id/coverage — coverage gaps for heatmap UI ───────────
  router.get('/api/symbols/:id/coverage', (req, res) => {
    const db = getDb();
    try {
      const profile = loadProfile(db, req.params.id);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      const start = req.query.start as string | undefined;
      const end = req.query.end as string | undefined;
      const gaps = findMissingDates(db, profile.underlyingSymbol, { start, end });
      const pending = gaps.filter(hasWorkPending);
      res.json({
        symbol: profile.underlyingSymbol,
        totalDates: gaps.length,
        pendingDates: pending.length,
        gaps,
      });
    } finally {
      db.close();
    }
  });

  // ── POST /api/backfill/orchestrate — spawn orchestrator worker ─────────────
  router.post('/api/backfill/orchestrate', (req, res) => {
    const { profileId, start, end, onlyMtf } = req.body as {
      profileId?: string; start?: string; end?: string; onlyMtf?: boolean;
    };

    if (!profileId) {
      return res.status(400).json({ error: 'profileId required' });
    }

    const db = getWriteDb();
    try {
      const profile = loadProfile(db, profileId);
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      // Count total trading dates in the range (best effort)
      const gaps = findMissingDates(db, profile.underlyingSymbol, { start, end });
      const pendingGaps = gaps.filter(hasWorkPending);
      const totalDates = pendingGaps.length || gaps.length || 1;

      // Create the job row
      const jobId = createBackfillJob(db, {
        profileId,
        totalDates,
        initialProgress: {
          phase: 'spawning',
          rawMissingCount: pendingGaps.filter(g => g.missingRaw).length,
          mtfMissingCount: pendingGaps.filter(g => g.missingMtfs.length > 0).length,
        },
      });

      // Prepare spec for the orchestrator worker
      const jobDir = path.resolve(process.cwd(), 'data', 'jobs');
      if (!fs.existsSync(jobDir)) fs.mkdirSync(jobDir, { recursive: true });
      const specFile = path.join(jobDir, `orchestrate-${jobId}.json`);
      fs.writeFileSync(specFile, JSON.stringify({
        jobId,
        profileId,
        start: start || null,
        end: end || null,
        onlyMtf: !!onlyMtf,
        dbPath: DB_PATH,
      }));

      // Spawn detached orchestrator worker
      const workerScript = path.resolve(process.cwd(), 'scripts', 'backfill', 'backfill-orchestrator-worker.ts');
      const logFile = fs.openSync(path.join(jobDir, `orchestrate-${jobId}.log`), 'a');

      const child = spawn('npx', ['tsx', workerScript, specFile], {
        cwd: process.cwd(),
        detached: true,
        stdio: ['ignore', logFile, logFile],
        env: { ...process.env },
      });
      child.unref();

      if (child.pid) {
        attachPid(db, jobId, child.pid);
      }

      console.log(`[backfill/orchestrate] Spawned worker PID ${child.pid} for profile '${profileId}' (job ${jobId})`);
      res.json({ jobId, profileId, totalDates, pid: child.pid });
    } finally {
      db.close();
    }
  });

  // ── GET /api/jobs/:jobId — fetch job (works for both replay & backfill) ────
  // This overrides the inline status-file approach for backfill jobs that use
  // the DB-based progress tracking.
  router.get('/api/jobs/:jobId', (req, res) => {
    const db = getDb();
    try {
      const job = getJob(db, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      res.json({ job });
    } finally {
      db.close();
    }
  });

  // ── POST /api/jobs/:jobId/cancel — cancel a running job ────────────────────
  router.post('/api/jobs/:jobId/cancel', (req, res) => {
    const db = getWriteDb();
    try {
      const job = getJob(db, req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (job.status !== 'running' && job.status !== 'pending') {
        return res.status(409).json({ error: `Job already ${job.status}` });
      }

      markCancelled(db, req.params.jobId, 'cancelled by user');

      // Best-effort SIGTERM to worker process
      if (job.pid) {
        try { process.kill(job.pid, 'SIGTERM'); } catch { /* already dead */ }
      }

      res.json({ ok: true, jobId: req.params.jobId });
    } finally {
      db.close();
    }
  });

  // ── GET /api/jobs — list jobs with optional filters ────────────────────────
  router.get('/api/jobs', (req, res) => {
    const db = getDb();
    try {
      const filters: ListJobsFilters = {};
      if (req.query.kind) filters.kind = req.query.kind as 'replay' | 'backfill';
      if (req.query.profile_id) filters.profileId = req.query.profile_id as string;
      if (req.query.status) filters.status = req.query.status as ListJobsFilters['status'];
      if (req.query.limit) filters.limit = Math.min(200, Number(req.query.limit) || 50);

      const jobs = listJobs(db, filters);
      res.json({ jobs });
    } finally {
      db.close();
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  // ██  PINNED REPORTS — Research notes pinned to the leaderboard            ██
  // ════════════════════════════════════════════════════════════════════════════

  function ensureReportsTable(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS leaderboard_reports (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
  }

  // GET /api/reports — list all reports (pinned first)
  router.get('/api/reports', (_req, res) => {
    const db = getDb();
    try {
      ensureReportsTable(db);
      const rows = db.prepare('SELECT * FROM leaderboard_reports ORDER BY pinned DESC, updatedAt DESC').all();
      res.json({ reports: rows });
    } finally {
      db.close();
    }
  });

  // GET /api/reports/pinned — only pinned reports
  router.get('/api/reports/pinned', (_req, res) => {
    const db = getDb();
    try {
      ensureReportsTable(db);
      const rows = db.prepare('SELECT * FROM leaderboard_reports WHERE pinned = 1 ORDER BY updatedAt DESC').all();
      res.json({ reports: rows });
    } finally {
      db.close();
    }
  });

  // POST /api/reports — create a report
  router.post('/api/reports', (req, res) => {
    const { id, title, content, pinned } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    const db = getWriteDb();
    try {
      ensureReportsTable(db);
      const now = Date.now();
      const reportId = id || `report-${now}`;
      db.prepare('INSERT OR REPLACE INTO leaderboard_reports (id, title, content, pinned, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)').run(
        reportId, title, content, pinned ? 1 : 0, now, now
      );
      res.json({ id: reportId, status: 'created' });
    } finally {
      db.close();
    }
  });

  // PATCH /api/reports/:id — toggle pin / update content
  router.patch('/api/reports/:id', (req, res) => {
    const { pinned, title, content } = req.body;
    const db = getWriteDb();
    try {
      ensureReportsTable(db);
      const existing = db.prepare('SELECT * FROM leaderboard_reports WHERE id = ?').get(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Report not found' });
      const now = Date.now();
      if (pinned !== undefined) db.prepare('UPDATE leaderboard_reports SET pinned = ?, updatedAt = ? WHERE id = ?').run(pinned ? 1 : 0, now, req.params.id);
      if (title) db.prepare('UPDATE leaderboard_reports SET title = ?, updatedAt = ? WHERE id = ?').run(title, now, req.params.id);
      if (content) db.prepare('UPDATE leaderboard_reports SET content = ?, updatedAt = ? WHERE id = ?').run(content, now, req.params.id);
      res.json({ id: req.params.id, status: 'updated' });
    } finally {
      db.close();
    }
  });

  // DELETE /api/reports/:id — delete a report
  router.delete('/api/reports/:id', (req, res) => {
    const db = getWriteDb();
    try {
      ensureReportsTable(db);
      db.prepare('DELETE FROM leaderboard_reports WHERE id = ?').run(req.params.id);
      res.json({ status: 'deleted' });
    } finally {
      db.close();
    }
  });

  // ── Journal API ───────────────────────────────────────────────────────────

  const JOURNAL_DIR = path.resolve(process.cwd(), 'logs', 'journals');

  // GET /api/journal/dates — list available journal dates
  router.get('/api/journal/dates', (_req, res) => {
    try {
      if (!fs.existsSync(JOURNAL_DIR)) return res.json([]);
      const dates = fs.readdirSync(JOURNAL_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort()
        .reverse();
      res.json(dates);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/journal/:date — get journal for a specific date (JSON)
  router.get('/api/journal/:date', (req, res) => {
    const date = req.params.date;
    const jsonPath = path.join(JOURNAL_DIR, `${date}.json`);
    if (fs.existsSync(jsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        return res.json(data);
      } catch { /* fall through to markdown */ }
    }
    // Try markdown
    const mdPath = path.join(JOURNAL_DIR, `${date}.md`);
    if (fs.existsSync(mdPath)) {
      return res.json({ date, markdown: fs.readFileSync(mdPath, 'utf-8') });
    }
    res.status(404).json({ error: `No journal for ${date}` });
  });

  // GET /api/journal/:date/md — get journal markdown
  router.get('/api/journal/:date/md', (req, res) => {
    const mdPath = path.join(JOURNAL_DIR, `${req.params.date}.md`);
    if (!fs.existsSync(mdPath)) return res.status(404).send('Not found');
    res.type('text/markdown').send(fs.readFileSync(mdPath, 'utf-8'));
  });

  // POST /api/journal/:date/generate — trigger journal generation for a date
  router.post('/api/journal/:date/generate', async (_req, res) => {
    const date = _req.params.date;
    try {
      const { spawn } = require('child_process');
      const proc = spawn('npx', ['tsx', 'scripts/daily-journal.ts', date], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { out += d.toString(); });
      proc.on('close', (code: number) => {
        if (code === 0) {
          // Read the generated journal
          const jsonPath = path.join(JOURNAL_DIR, `${date}.json`);
          if (fs.existsSync(jsonPath)) {
            return res.json(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')));
          }
          const mdPath = path.join(JOURNAL_DIR, `${date}.md`);
          if (fs.existsSync(mdPath)) {
            return res.json({ date, markdown: fs.readFileSync(mdPath, 'utf-8') });
          }
          return res.json({ status: 'generated', output: out });
        }
        res.status(500).json({ error: `Process exited ${code}`, output: out });
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /journal — serve journal viewer HTML
  router.get('/journal', (_req, res) => {
    const htmlPath = path.join(__dirname, 'journal-viewer.html');
    if (fs.existsSync(htmlPath)) {
      return res.sendFile(htmlPath);
    }
    res.status(404).send('Journal viewer not found');
  });

  // ── Account API (proxies to Tradier) ────────────────────────────────────────

  const TRADIER_TOKEN = process.env.TRADIER_TOKEN;
  const TRADIER_ACCOUNT = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
  const TRADIER_API = 'https://api.tradier.com/v1';

  function tradierHeaders() {
    return { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' };
  }

  // GET /api/account/balance
  router.get('/api/account/balance', async (_req, res) => {
    if (!TRADIER_TOKEN) return res.status(500).json({ error: 'No TRADIER_TOKEN' });
    try {
      const resp = await fetch(`${TRADIER_API}/accounts/${TRADIER_ACCOUNT}/balances`, { headers: tradierHeaders() });
      const data: any = await resp.json();
      res.json(data?.balances || data);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/account/positions
  router.get('/api/account/positions', async (_req, res) => {
    if (!TRADIER_TOKEN) return res.status(500).json({ error: 'No TRADIER_TOKEN' });
    try {
      const resp = await fetch(`${TRADIER_API}/accounts/${TRADIER_ACCOUNT}/positions`, { headers: tradierHeaders() });
      const data: any = await resp.json();
      const raw = data?.positions?.position;
      if (!raw || raw === 'null') return res.json([]);
      res.json(Array.isArray(raw) ? raw : [raw]);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/account/orders
  router.get('/api/account/orders', async (_req, res) => {
    if (!TRADIER_TOKEN) return res.status(500).json({ error: 'No TRADIER_TOKEN' });
    try {
      const resp = await fetch(`${TRADIER_API}/accounts/${TRADIER_ACCOUNT}/orders`, { headers: tradierHeaders() });
      const data: any = await resp.json();
      const raw = data?.orders?.order;
      if (!raw || raw === 'null') return res.json([]);
      res.json(Array.isArray(raw) ? raw : [raw]);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/account/history?start=YYYY-MM-DD&end=YYYY-MM-DD
  router.get('/api/account/history', async (req, res) => {
    if (!TRADIER_TOKEN) return res.status(500).json({ error: 'No TRADIER_TOKEN' });
    try {
      const params = new URLSearchParams({ type: 'trade', limit: '200' });
      if (req.query.start) params.set('start', req.query.start as string);
      if (req.query.end) params.set('end', req.query.end as string);
      const resp = await fetch(`${TRADIER_API}/accounts/${TRADIER_ACCOUNT}/history?${params}`, { headers: tradierHeaders() });
      const data: any = await resp.json();
      const raw = data?.history?.event;
      if (!raw || raw === 'null') return res.json([]);
      res.json(Array.isArray(raw) ? raw : [raw]);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/account/gainloss?start=YYYY-MM-DD&end=YYYY-MM-DD&page=N
  // Returns closed positions with broker-computed P&L (source of truth).
  // Tradier paginates at 100 per page. We fetch all pages and return the full list.
  router.get('/api/account/gainloss', async (req, res) => {
    if (!TRADIER_TOKEN) return res.status(500).json({ error: 'No TRADIER_TOKEN' });
    try {
      const allPositions: any[] = [];
      let page = 1;
      const maxPages = 20; // safety cap
      while (page <= maxPages) {
        const params = new URLSearchParams({ page: String(page), limit: '100', sortBy: 'closeDate', sort: 'desc' });
        if (req.query.start) params.set('start', req.query.start as string);
        if (req.query.end) params.set('end', req.query.end as string);
        const resp = await fetch(`${TRADIER_API}/accounts/${TRADIER_ACCOUNT}/gainloss?${params}`, { headers: tradierHeaders() });
        const data: any = await resp.json();
        const raw = data?.gainloss?.closed_position;
        if (!raw || raw === 'null') break;
        const items = Array.isArray(raw) ? raw : [raw];
        allPositions.push(...items);
        if (items.length < 100) break; // last page
        page++;
      }
      res.json(allPositions);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // GET /api/account/agent-status — read agent status file
  router.get('/api/account/agent-status', (_req, res) => {
    const statusPath = path.resolve(process.cwd(), 'logs', 'agent-status.json');
    if (!fs.existsSync(statusPath)) return res.json(null);
    try {
      res.json(JSON.parse(fs.readFileSync(statusPath, 'utf-8')));
    } catch { res.json(null); }
  });

  // GET /account — serve account dashboard HTML
  router.get('/account', (_req, res) => {
    const htmlPath = path.join(__dirname, 'account-viewer.html');
    if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
    res.status(404).send('Account viewer not found');
  });

  return router;
}
