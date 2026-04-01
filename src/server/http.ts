import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { statSync } from 'fs';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb } from '../storage/queries';
import { getMarketMode } from '../pipeline/scheduler';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';
import { readStatus, readRecentActivity } from '../agent/reporter';
import { healthTracker } from '../utils/health';
import { getWsClientCount } from './ws';
import { config } from '../config';
import { createReplayRoutes } from './replay-routes';

let lastSpxPrice: number | null = null;
export function setLastSpxPrice(p: number) { lastSpxPrice = p; }

let trackerCountFn: () => number = () => 0;
export function setTrackerCountFn(fn: () => number) { trackerCountFn = fn; }

const startTime = Date.now();

export function startHttpServer(port: number): { app: Express; httpServer: Server } {
  const app = express();
  app.use(express.json());

  app.get('/health', (_, res) => {
    const report = healthTracker.getStatus();
    const dbSizeMb = getDbSizeMb();

    // WAL file size (best-effort — file may not exist)
    let walSizeMb = 0;
    try {
      const walPath = (config.dbPath || './data/spxer.db') + '-wal';
      walSizeMb = Math.round(statSync(walPath).size / 1024 / 1024 * 10) / 10;
    } catch {}

    const tracked = trackerCountFn();
    const active = getAllActiveContracts();
    const activeCount = active.filter(c => c.state === 'ACTIVE').length;

    res.json({
      // Health report — 'n/a' when no providers tracked, 'healthy'/'degraded'/'critical' otherwise
      status: report.status,
      uptimeSec: report.uptimeSec,
      providers: report.providers,
      data: report.data,
      db: { sizeMb: dbSizeMb, walSizeMb },
      trackedContracts: tracked,
      activeContracts: activeCount,
      wsClients: getWsClientCount(),
      // Backward-compatible fields
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mode: getMarketMode(),
      lastSpxPrice,
      dbSizeMb,
    });
  });

  app.get('/spx/snapshot', (_, res) => {
    const bar = getLatestBar('SPX', '1m') ?? getLatestBar('ES', '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/spx/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    const symbol = getMarketMode() === 'rth' ? 'SPX' : 'ES';
    res.json(getBars(symbol, tf, n));
  });

  app.get('/contracts/active', (_, res) => res.json(getAllActiveContracts()));

  app.get('/contracts/:symbol/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars(req.params.symbol, tf, n));
  });

  app.get('/contracts/:symbol/latest', (req, res) => {
    const bar = getLatestBar(req.params.symbol, '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/chain', async (req, res) => {
    try {
      const expiry = req.query.expiry as string;
      if (!expiry) return res.status(400).json({ error: 'expiry required' });
      const chain = await fetchOptionsChain('SPX', expiry);
      res.json(chain);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /chain/expirations — list all tracked expiry dates
  app.get('/chain/expirations', async (_req, res) => {
    try {
      const dates = await fetchExpirations('SPX');
      res.json(dates);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /underlying/context — market context snapshot (ES, NQ, VX, sectors)
  app.get('/underlying/context', async (_req, res) => {
    try {
      const { fetchScreenerSnapshot } = await import('../providers/tv-screener');
      const snap = await fetchScreenerSnapshot();
      res.json(snap);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Agent endpoints (consumed by SPX-0DTE dashboard) ──

  app.get('/agent/status', (_req, res) => {
    const status = readStatus();
    if (!status) return res.json({ status: 'offline' });
    res.json(status);
  });

  app.get('/agent/activity', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 50, 200);
    res.json(readRecentActivity(n));
  });

  app.get('/signal/latest', (_req, res) => {
    const { getLastHmaSignal } = require('../index');
    const signal = getLastHmaSignal();
    if (!signal) return res.json({ signal: null });
    res.json(signal);
  });

  app.get('/agent/config', (_req, res) => {
    // Serve the live agent config so the viewer can display it
    try {
      const { AGENT_CONFIG } = require('../../agent-config');
      const cfg = AGENT_CONFIG;
      res.json({
        id: cfg.id,
        name: cfg.name,
        signals: {
          hmaCrossFast: cfg.signals.hmaCrossFast,
          hmaCrossSlow: cfg.signals.hmaCrossSlow,
          targetOtmDistance: cfg.signals.targetOtmDistance,
          enableHmaCrosses: cfg.signals.enableHmaCrosses,
          enableEmaCrosses: cfg.signals.enableEmaCrosses,
          requireUnderlyingHmaCross: cfg.signals.requireUnderlyingHmaCross,
          signalTimeframe: cfg.signals.signalTimeframe,
        },
        position: cfg.position,
        strikeSelector: cfg.strikeSelector,
        risk: cfg.risk,
        exit: cfg.exit,
        sizing: cfg.sizing,
        timeWindows: cfg.timeWindows,
      });
    } catch {
      res.json({ error: 'Config not available' });
    }
  });

  // ── Replay viewer ──
  app.use('/replay', createReplayRoutes());

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
