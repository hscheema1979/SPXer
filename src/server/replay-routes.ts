/**
 * Replay viewer API routes — serves replay data for the chart viewer.
 * Mounted on the existing Express app at /replay/api/*
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { runReplay } from '../replay/machine';
import { DEFAULT_CONFIG, mergeConfig } from '../config/defaults';
import type { Config } from '../config/types';

const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';
const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || 'data/spxer.db');

function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
}

function getWriteDb(): Database.Database {
  return new Database(DB_PATH);
}

export function createReplayRoutes(): Router {
  const router = Router();

  // ── Serve the HTML viewer ────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    const htmlPath = path.resolve(__dirname, 'replay-viewer.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      // Fallback for ts-node/tsx where __dirname is src/server
      const altPath = path.resolve(process.cwd(), 'src/server/replay-viewer.html');
      res.sendFile(altPath);
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

  // ── GET /replay/api/sweep — leaderboard aggregated from replay_results ───
  // Supports ?maxEntryPrice=N to recompute metrics using only trades with entry ≤ $N
  router.get('/api/sweep', (req, res) => {
    const { sort, limit, dir, minDays, maxEntryPrice, maxConcurrent, maxTradesPerDay } = req.query as Record<string, string | undefined>;
    const allowedSorts = ['compositeScore', 'totalPnl', 'sharpe', 'winRate', 'worstDay', 'profitDays', 'trades', 'avgDailyPnl', 'bestDay', 'days', 'avgEntryPrice'];
    const sortCol = allowedSorts.includes(sort || '') ? sort : 'compositeScore';
    const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';
    const maxRows = Math.min(parseInt(limit || '500'), 2000);
    const entryPriceCap = maxEntryPrice ? parseFloat(maxEntryPrice) : 0;  // 0 = no filter
    const concurrentCap = maxConcurrent ? parseInt(maxConcurrent) : 0;    // 0 = no filter
    const dailyTradeCap = maxTradesPerDay ? parseInt(maxTradesPerDay) : 0; // 0 = no filter

    const db = getDb();
    try {
      // Load all configs + their daily results (with trades JSON for price filtering)
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

      // Group by configId
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

      // Compute metrics per config (with optional entry price filter)
      const minDaysVal = Math.max(1, parseInt(minDays || '2'));
      const enriched: any[] = [];

      for (const [configId, data] of configMap) {
        if (data.dailyResults.length < minDaysVal) continue;

        // Recompute metrics from trades, optionally filtering by entry price
        const dailyPnls: number[] = [];
        let totalTrades = 0, totalWins = 0, totalPnl = 0;
        let entryPriceSum = 0, entryPriceCount = 0;

        for (const day of data.dailyResults) {
          // Step 1: filter by entry price
          let filtered = entryPriceCap > 0
            ? day.trades.filter((t: any) => t.entryPrice <= entryPriceCap)
            : [...day.trades];

          // Step 2: sort by entry time for chronological processing
          filtered.sort((a: any, b: any) => (a.entryTs || 0) - (b.entryTs || 0));

          // Step 3: enforce max concurrent positions — skip trades that would exceed the cap
          if (concurrentCap > 0) {
            const accepted: any[] = [];
            for (const t of filtered) {
              // Count how many accepted trades are still open when this trade enters
              const openAtEntry = accepted.filter((a: any) => a.exitTs > t.entryTs).length;
              if (openAtEntry < concurrentCap) {
                accepted.push(t);
              }
            }
            filtered = accepted;
          }

          // Step 4: enforce max trades per day — take only the first N
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

        // Extract config params
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

  // ── Serve the sweep leaderboard HTML ─────────────────────────────────────
  router.get('/sweep', (_req, res) => {
    const htmlPath = path.resolve(__dirname, 'sweep-viewer.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/sweep-viewer.html');
      res.sendFile(altPath);
    }
  });

  return router;
}
