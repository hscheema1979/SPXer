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

      if (configId && !config) {
        // Load existing config (no overrides — just re-run it)
        const db = getDb();
        try {
          const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
            .get(configId) as { config_json: string } | undefined;
          if (!row) return res.status(404).json({ error: `Config '${configId}' not found` });
          fullConfig = JSON.parse(row.config_json) as Config;
        } finally {
          db.close();
        }
      } else if (configId && config) {
        // Try loading existing config as base, fall back to defaults
        const db = getDb();
        try {
          const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?')
            .get(configId) as { config_json: string } | undefined;
          const base = row ? JSON.parse(row.config_json) as Config : DEFAULT_CONFIG;
          fullConfig = mergeConfig(base, config);
        } finally {
          db.close();
        }
      } else if (config) {
        fullConfig = mergeConfig(DEFAULT_CONFIG, config);
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

  return router;
}
