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
import { DEFAULT_CONFIG, mergeConfig } from '../config/defaults';
import type { Config } from '../config/types';

const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';
const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || 'data/spxer.db');

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

/** Mark any jobs whose worker process has died as failed */
function reapDeadJobs(db: Database.Database) {
  const running = db.prepare("SELECT id, pid FROM replay_jobs WHERE status = 'running'").all() as { id: string; pid: number }[];
  for (const job of running) {
    if (!job.pid) continue;
    try {
      // Signal 0 checks if process exists without killing it
      process.kill(job.pid, 0);
    } catch {
      // Process is dead — mark job as failed
      db.prepare("UPDATE replay_jobs SET status = 'failed', error = 'Worker process died (PID ' || pid || ')', completedAt = ? WHERE id = ?")
        .run(Date.now(), job.id);
    }
  }
}

function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

function getWriteDb(): Database.Database {
  return new Database(DB_PATH);
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

  // ── GET /replay/api/dates — available replay dates ───────────────────────
  router.get('/api/dates', (_req, res) => {
    const db = getDb();
    try {
      // replay_bars stores real UTC timestamps. SPX RTH (9:30-16:00 ET) maps to
      // 13:30-20:00 UTC (EDT) or 14:30-21:00 UTC (EST) — all within the same
      // calendar day, so date(ts, 'unixepoch') groups correctly.
      const rows = db.prepare(`
        SELECT DISTINCT date(ts, 'unixepoch') as d
        FROM ${REPLAY_DATA_SOURCE} WHERE symbol='SPX' AND timeframe='1m'
        ORDER BY d
      `).all() as { d: string }[];
      res.json(rows.map(r => r.d));
    } finally {
      db.close();
    }
  });

  // ── GET /replay/api/configs — saved configs ──────────────────────────────
  router.get('/api/configs', (_req, res) => {
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT id, name, description FROM replay_configs ORDER BY createdAt DESC
      `).all();
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

    const db = getDb();
    try {
      const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
      const dayEnd = dayStart + 86400 + 3600;

      let rows: any[];

      if (warmupBars > 0 && symbol === 'SPX') {
        // Include last N bars from the prior trading day for HMA warmup
        rows = db.prepare(`
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
        rows = db.prepare(`
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
      db.close();
    }
  });

  // ── GET /replay/api/contracts?date= — all contracts for a date ──────────
  router.get('/api/contracts', (req, res) => {
    const { date } = req.query as { date?: string };
    if (!date) {
      return res.status(400).json({ error: 'date required' });
    }

    const db = getDb();
    try {
      const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
      const dayEnd = dayStart + 86400 + 3600;

      const rows = db.prepare(`
        SELECT DISTINCT symbol,
               CASE WHEN symbol GLOB '*C[0-9]*' THEN 'call' ELSE 'put' END as type,
               CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike,
               COUNT(*) as barCount,
               MIN(close) as minPrice,
               MAX(close) as maxPrice,
               AVG(volume) as avgVolume
        FROM ${REPLAY_DATA_SOURCE}
        WHERE timeframe='1m' AND ts >= ? AND ts <= ? AND symbol LIKE 'SPXW%'
        GROUP BY symbol
        ORDER BY strike ASC, type ASC
      `).all(dayStart, dayEnd) as any[];

      res.json(rows);
    } finally {
      db.close();
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

  // ── GET /replay/api/defaults — return DEFAULT_CONFIG ──────────────────────
  router.get('/api/defaults', (_req, res) => {
    res.json(DEFAULT_CONFIG);
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
      const id = configId || `custom-${Date.now()}`;
      const name = configName || fullConfig.name || 'Custom Config';
      fullConfig.id = id;
      fullConfig.name = name;

      // Save the config to the DB
      const wdb = getWriteDb();
      try {
        wdb.prepare(`
          INSERT INTO replay_configs (id, name, description, config_json, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, config_json=excluded.config_json, updatedAt=excluded.updatedAt
        `).run(id, name, fullConfig.description || '', JSON.stringify(fullConfig), Date.now(), Date.now());
      } finally {
        wdb.close();
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

      const id = configId || `custom-${Date.now()}`;
      const name = configName || fullConfig.name || 'Custom Config';
      fullConfig.id = id;
      fullConfig.name = name;

      // Save config to DB
      db.prepare(`
        INSERT INTO replay_configs (id, name, description, config_json, createdAt, updatedAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name=excluded.name, config_json=excluded.config_json, updatedAt=excluded.updatedAt
      `).run(id, name, fullConfig.description || '', JSON.stringify(fullConfig), Date.now(), Date.now());

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
        dbPath: DB_PATH, noJudge: true,
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
    const allowedSorts = ['compositeScore', 'totalPnl', 'sharpe', 'winRate', 'worstDay', 'profitDays', 'trades', 'avgDailyPnl', 'bestDay', 'days', 'avgEntryPrice'];
    const sortCol = allowedSorts.includes(sort || '') ? sort : 'compositeScore';
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
            GROUP_CONCAT(r.totalPnl) as pnlList
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

          let sharpe = 0;
          if (dailyPnls.length > 1) {
            const mean = dailyPnls.reduce((s: number, v: number) => s + v, 0) / dailyPnls.length;
            const variance = dailyPnls.reduce((s: number, v: number) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
            sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
          }

          const compositeScore =
            (winRate * 40) +
            (Math.max(0, Math.min(sharpe, 1)) * 30) +
            (avgDailyPnl > 0 ? 20 : 0) +
            (worstDay > -500 ? 10 : 0);

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
            };
          } catch {}

          enriched.push({
            configId: row.configId, name: row.name, params,
            days, trades: totalTrades, wins: totalWins, winRate,
            totalPnl, avgDailyPnl, worstDay, bestDay,
            sharpe, profitDays, compositeScore, avgEntryPrice: 0,
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
              dayPnl += pnl;
              totalTrades++;
              if (pnl > 0) totalWins++;
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

          let sharpe = 0;
          if (dailyPnls.length > 1) {
            const mean = dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length;
            const variance = dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1);
            sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
          }

          const compositeScore =
            (winRate * 40) +
            (Math.max(0, Math.min(sharpe, 1)) * 30) +
            (avgDailyPnl > 0 ? 20 : 0) +
            (worstDay > -500 ? 10 : 0);

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
            };
        } catch {}

          enriched.push({
            configId, name: data.name, params,
            days, trades: totalTrades, wins: totalWins, winRate,
            totalPnl, avgDailyPnl, worstDay, bestDay,
            sharpe, profitDays, compositeScore, avgEntryPrice,
          });
        }
      } // end needsTradeFilter else

      // Sort
      const validSort = allowedSorts.includes(sortCol!) ? sortCol! : 'compositeScore';
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
            maxContracts: cfg.sizing?.maxContracts ?? 10,
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

  // ── GET /replay/api/sweep/:configId/daily — per-day breakdown ────────────
  router.get('/api/sweep/:configId/daily', (req, res) => {
    const { configId } = req.params;
    const db = getDb();
    try {
      const rows = db.prepare(`
        SELECT date, trades, wins, winRate, totalPnl, avgPnlPerTrade, maxWin, maxLoss, sharpeRatio
        FROM replay_results
        WHERE configId = ?
        ORDER BY date ASC
      `).all(configId);
      res.json(rows);
    } finally {
      db.close();
    }
  });

  // ── Live View API proxy ─────────────────────────────────────────────────
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
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      res.status(502).json({ error: 'Data service unavailable', detail: err.message });
    });

    proxyReq.on('timeout', () => {
      proxyReq.destroy();
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

  // ── GET /replay/api/surface?date= — 3D option surface data ────────────
  // Returns SPX + all option contract prices at every minute for a date,
  // organized for 3D visualization (time × strike × price).
  router.get('/api/surface', (req, res) => {
    const { date } = req.query as { date?: string };
    if (!date) return res.status(400).json({ error: 'date required' });

    const db = getDb();
    try {
      const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
      const dayEnd = dayStart + 86400 + 3600;

      // SPX bars
      const spxBars = db.prepare(`
        SELECT ts, close FROM ${REPLAY_DATA_SOURCE}
        WHERE symbol='SPX' AND timeframe='1m' AND ts >= ? AND ts <= ?
        ORDER BY ts
      `).all(dayStart, dayEnd) as { ts: number; close: number }[];

      if (spxBars.length === 0) return res.json({ error: 'No SPX data for this date' });

      const midSpx = spxBars[Math.floor(spxBars.length / 2)].close;

      // All option bars for this date
      const optBars = db.prepare(`
        SELECT symbol, ts, close FROM ${REPLAY_DATA_SOURCE}
        WHERE timeframe='1m' AND ts >= ? AND ts <= ? AND symbol LIKE 'SPXW%'
        ORDER BY symbol, ts
      `).all(dayStart, dayEnd) as { symbol: string; ts: number; close: number }[];

      // Parse into structured data
      // Group by symbol, extract strike and side
      const contracts: Record<string, {
        symbol: string; strike: number; side: 'call' | 'put';
        distance: number; bars: { ts: number; close: number }[];
      }> = {};

      for (const bar of optBars) {
        if (!contracts[bar.symbol]) {
          const side = bar.symbol.includes('C') ? 'call' as const : 'put' as const;
          const strike = parseInt(bar.symbol.slice(-8)) / 1000;
          contracts[bar.symbol] = {
            symbol: bar.symbol, strike, side,
            distance: Math.round(strike - midSpx),
            bars: [],
          };
        }
        contracts[bar.symbol].bars.push({ ts: bar.ts, close: bar.close });
      }

      // Filter to contracts within ±30 of ATM with enough bars
      const filtered = Object.values(contracts)
        .filter(c => Math.abs(c.distance) <= 30 && c.bars.length >= 20);

      res.json({
        date,
        midSpx: Math.round(midSpx),
        spx: spxBars.map(b => ({ ts: b.ts, c: b.close })),
        contracts: filtered.map(c => ({
          symbol: c.symbol,
          strike: c.strike,
          side: c.side,
          distance: c.distance,
          bars: c.bars.map(b => ({ ts: b.ts, c: b.close })),
        })),
      });
    } finally {
      db.close();
    }
  });

  // ── Serve the option surface 3D viewer ──────────────────────────────────
  router.get('/surface', (req, res) => {
    const htmlPath = path.resolve(__dirname, 'surface-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/surface-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  // ── Serve the sweep leaderboard HTML ─────────────────────────────────────
  router.get('/sweep', (req, res) => {
    const htmlPath = path.resolve(__dirname, 'sweep-viewer.html');
    if (fs.existsSync(htmlPath)) {
      serveWithBasePath(htmlPath, req, res);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/sweep-viewer.html');
      serveWithBasePath(altPath, req, res);
    }
  });

  return router;
}
