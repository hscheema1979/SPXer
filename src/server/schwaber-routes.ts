/**
 * Schwaber viewer API routes — serves live agent status and activity
 * for the Schwaber dashboard. Mounted at /schwaber/ on the main server.
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';

const LOGS_DIR = path.resolve(process.cwd(), 'logs');

function readStatusFile(): Record<string, any> | null {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'schwaber-status.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readActivityLog(n: number): any[] {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'schwaber-activity.jsonl'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines
      .slice(-n)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse(); // newest first
  } catch {
    return [];
  }
}

function readPlainLog(n: number): string[] {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'schwaber.log'), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-n).reverse();
  } catch {
    return [];
  }
}

export function createSchwaberRoutes(): Router {
  const router = Router();

  // ── Serve viewer HTML ──────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    const htmlPath = path.resolve(__dirname, 'schwaber-viewer.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      const altPath = path.resolve(process.cwd(), 'src/server/schwaber-viewer.html');
      res.sendFile(altPath);
    }
  });

  // ── GET /schwaber/api/status ───────────────────────────────────────────
  router.get('/api/status', (_req, res) => {
    const status = readStatusFile();
    if (!status) return res.json({ online: false });
    res.json({ online: true, ...status });
  });

  // ── GET /schwaber/api/activity?n=100 ──────────────────────────────────
  router.get('/api/activity', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 100, 500);
    res.json(readActivityLog(n));
  });

  // ── GET /schwaber/api/log?n=200 ── raw log lines ──────────────────────
  router.get('/api/log', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 200, 1000);
    res.json(readPlainLog(n));
  });

  // ── GET /schwaber/api/quotes?symbols=SPY,QQQ ── proxy to Schwab ───────
  router.get('/api/quotes', async (req, res) => {
    const symbols = ((req.query.symbols as string) || 'SPY,QQQ').split(',').map(s => s.trim()).filter(Boolean);
    try {
      const { getQuotes, getSchwabAuthStatus } = await import('../providers/schwab');
      const auth = getSchwabAuthStatus();
      if (!auth.authenticated) {
        return res.json({ error: 'Not authenticated with Schwab', needsAuth: true });
      }
      const quotes = await getQuotes(symbols);
      res.json(quotes);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /schwaber/api/auth ── Schwab auth status ───────────────────────
  router.get('/api/auth', (_req, res) => {
    try {
      const { getSchwabAuthStatus } = require('../providers/schwab');
      res.json(getSchwabAuthStatus());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
