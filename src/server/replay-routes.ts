/**
 * Replay viewer API routes — serves replay data for the chart viewer.
 * Mounted on the existing Express app at /replay/api/*
 */

import { Router } from 'express';
import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';
const DB_PATH = path.resolve(process.cwd(), process.env.DB_PATH || 'data/spxer.db');

function getDb(): Database.Database {
  return new Database(DB_PATH, { readonly: true });
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
      const rows = db.prepare(`
        SELECT DISTINCT date(ts, 'unixepoch', '-5 hours') as d
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

  // ── GET /replay/api/bars?date=&symbol=&tf= — OHLCV bars for a symbol ───
  router.get('/api/bars', (req, res) => {
    const { date, symbol, tf } = req.query as { date?: string; symbol?: string; tf?: string };
    if (!date || !symbol) {
      return res.status(400).json({ error: 'date and symbol required' });
    }
    const timeframe = tf || '1m';

    const db = getDb();
    try {
      // Compute session window for the date (9:30 AM - 4:15 PM ET)
      // Use a broad UTC window to capture the full session regardless of DST
      const dayStart = Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000);
      const dayEnd = dayStart + 86400 + 3600; // +25h to cover timezone edge

      const rows = db.prepare(`
        SELECT ts, open, high, low, close, volume, indicators
        FROM ${REPLAY_DATA_SOURCE}
        WHERE symbol = ? AND timeframe = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
      `).all(symbol, timeframe, dayStart, dayEnd) as any[];

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

  return router;
}
