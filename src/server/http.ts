import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { statSync } from 'fs';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb, getOptionBarHealth } from '../storage/queries';
import { getMarketMode } from '../pipeline/spx/scheduler';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';
import { readStatus, readRecentActivity } from '../agent/reporter';
import { healthTracker } from '../utils/health';
import { circuitBreakers } from '../utils/resilience';
import { getWsClientCount } from './ws';
import { config } from '../config';
import { createReplayRoutes } from './replay-routes';
import { createAdminRoutes } from './admin-routes';
import { refreshPipelineHealth } from '../ops/pipeline-health';
import { getLatestMetrics, getMetricSeries, getMetricsSummary } from '../ops/metrics-api';
import { getAlertHistory, getRules as getAlertRules } from '../ops/alert-rules';
import { getDb, getCurrentDbPath } from '../storage/db';
import Database from 'better-sqlite3';
import * as path from 'path';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getSchwabAuthStatus,
  startTokenRefresher,
} from '../providers/schwab';
import { createSchwaberRoutes } from './schwaber-routes';
import { createDevopsRoutes } from './devops-routes';
import { signalPoller } from '../index';

let lastSpxPrice: number | null = null;
export function setLastSpxPrice(p: number) { lastSpxPrice = p; }

let trackerCountFn: () => number = () => 0;
export function setTrackerCountFn(fn: () => number) { trackerCountFn = fn; }

interface OptionStreamStatus {
  connected: boolean;
  symbolCount: number;
  lastActivity: number;
  theta?: { connected: boolean; symbolCount: number; lastActivity: number; primary: boolean };
}
let optionStreamStatusFn: () => OptionStreamStatus = () => ({
  connected: false, symbolCount: 0, lastActivity: 0,
});
export function setOptionStreamStatusFn(fn: typeof optionStreamStatusFn) { optionStreamStatusFn = fn; }

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
      const walPath = (getCurrentDbPath() || config.dbPath || './data/spxer.db') + '-wal';
      walSizeMb = Math.round(statSync(walPath).size / 1024 / 1024 * 10) / 10;
    } catch {}

    const tracked = trackerCountFn();
    const active = getAllActiveContracts();
    const activeCount = active.filter(c => c.state === 'ACTIVE').length;

    const optionStream = optionStreamStatusFn();

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
      optionStream: {
        connected: optionStream.connected,
        symbolCount: optionStream.symbolCount,
        lastActivity: optionStream.lastActivity,
        theta: optionStream.theta,
      },
      optionBarHealth: (() => {
        try {
          const sinceTs = Math.floor(Date.now() / 1000) - 1800; // last 30 min
          const h = getOptionBarHealth(sinceTs);
          return {
            totalBars30m: h.total,
            syntheticBars30m: h.synthetic,
            staleBars30m: h.stale,
            contracts30m: h.contracts,
            syntheticRatio: h.total > 0 ? Math.round((h.synthetic / h.total) * 100) / 100 : 0,
          };
        } catch { return null; }
      })(),
      // Backward-compatible fields
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mode: getMarketMode(),
      lastSpxPrice,
      dbSizeMb,
    });
  });

  app.get('/spx/snapshot', (_, res) => {
    const bar = getLatestBar('SPX', '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/spx/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars('SPX', tf, n));
  });

  // Pipeline telemetry — per-stage counters updated by the pipeline as it runs
  app.get('/pipeline/health', (_, res) => {
    const snap = refreshPipelineHealth();
    // Enrich with live circuit breaker states
    const cbStates: Record<string, string> = {};
    circuitBreakers.forEach((cb, name) => { cbStates[name] = cb.getState(); });
    res.json({ ...snap, circuitBreakers: cbStates });
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
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /chain/expirations — list all tracked expiry dates
  app.get('/chain/expirations', async (_req, res) => {
    try {
      const dates = await fetchExpirations('SPX');
      res.json(dates);
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET /underlying/context — market context snapshot (ES, NQ, VX, sectors)
  app.get('/underlying/context', async (_req, res) => {
    try {
      const { fetchScreenerSnapshot } = await import('../providers/tv-screener');
      const snap = await fetchScreenerSnapshot();
      res.json(snap);
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Agent endpoints (consumed by SPX-0DTE dashboard) ──

  app.get('/agent/status', (_req, res) => {
    const status = readStatus();
    if (!status) return res.json({ status: 'offline' });
    res.json(status);
  });

  app.get('/agent/activity', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 50, 500);
    res.json(readRecentActivity(n));
  });

  app.get('/signal/latest', (_req, res) => {
    const { getLastHmaSignal } = require('../index');
    const signal = getLastHmaSignal();
    if (!signal) return res.json({ signal: null });
    res.json(signal);
  });

  app.get('/signals', (req, res) => {
    const { getLatestSignals } = require('../storage/queries');
    const signals = getLatestSignals({
      offsetLabel: req.query.offset as string,
      timeframe: req.query.timeframe as string,
      hmaPair: req.query.hmaPair as string,
      limit: Math.min(parseInt(req.query.limit as string) || 50, 500),
    });
    res.json(signals);
  });


  app.get('/agent/config', (req, res) => {
    // Serve the live agent config from the DB (same source the agents use)
    try {
      const { createStore } = require('../replay/store');
      const store = createStore();
      const configId = process.env.AGENT_CONFIG_ID || (req.query.id as string);
      if (!configId) return res.json({ error: 'No AGENT_CONFIG_ID configured' });
      const cfg = store.getConfig(configId);
      if (!cfg) return res.json({ error: `Config ${configId} not found` });
      res.json(cfg.config);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Agent Simulation Mode endpoints ─────────────────────────────────────

  app.get('/agent/simulation', (_req, res) => {
    try {
      const { getExecutionMode, getSimulationStats, getFakeBroker } = require('../agent/execution-router');
      const mode = getExecutionMode();
      const stats = getSimulationStats();
      const fakeBroker = getFakeBroker();

      let positions = [];
      if (fakeBroker) {
        positions = fakeBroker.getSimulatedPositions();
      }

      res.json({
        active: mode === 'SIMULATION',
        mode,
        stats: {
          ordersSubmitted: stats.ordersSubmitted,
          ordersFilled: stats.ordersFilled,
          pendingOrders: stats.pendingOrders,
        },
        positions,
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/agent/simulation/toggle', (req, res) => {
    // Toggle simulation mode (requires restart to take effect)
    const enabled = req.body.enabled;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be boolean' });
    }

    // For now, this just returns what WOULD happen
    // Actual toggle requires changing AGENT_EXECUTION_MODE env var and restarting
    res.json({
      message: enabled
        ? 'To enable simulation mode: set AGENT_EXECUTION_MODE=SIMULATION and restart handler'
        : 'To disable simulation mode: unset AGENT_EXECUTION_MODE or set to LIVE and restart handler',
      currentMode: process.env.AGENT_EXECUTION_MODE || 'LIVE',
      requiresRestart: true,
    });
  });

  app.get('/agent/mode', (_req, res) => {
    // Get current execution mode
    try {
      const { getExecutionMode } = require('../agent/execution-router');
      res.json({
        mode: getExecutionMode(),
        simulation: getExecutionMode() === 'SIMULATION',
        paper: process.env.AGENT_PAPER === 'true',
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Signal Poller Status ───────────────────────────────────────────────────────

  app.get('/signal-poller/status', (_req, res) => {
    try {
      const result = signalPoller.getLastPollResult();
      if (!result) {
        return res.json({ status: 'no_poll_yet' });
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Schwab OAuth ──

  // Step 1: redirect browser to Schwab login
  // Visit https://bitloom.cloud/schwab/auth to kick off the flow
  app.get('/schwab/auth', (_req, res) => {
    try {
      const url = buildAuthUrl();
      res.redirect(url);
    } catch (e: any) {
      res.status(500).send(`Schwab auth error: ${(e as Error).message}`);
    }
  });

  // Step 2: Schwab redirects back here with ?code=...
  // Must match the Callback URL registered in the Schwab Developer Portal exactly:
  //   https://bitloom.cloud/schwab/callback
  app.get('/schwab/callback', async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) {
      return res.status(400).send('Missing authorization code from Schwab');
    }
    try {
      const tokens = await exchangeCodeForTokens(code);
      // Start background refresher now that we have valid tokens
      startTokenRefresher();
      res.send(`
        <html><body style="font-family:monospace;padding:2rem">
          <h2>✅ Schwab authenticated</h2>
          <p>Access token expires: <strong>${new Date(tokens.expires_at * 1000).toISOString()}</strong></p>
          <p>Refresh token expires (7-day limit): <strong>${new Date(tokens.refresh_expires_at * 1000).toISOString()}</strong></p>
          <p>Account hash: <strong>${tokens.account_hash ?? 'fetching...'}</strong></p>
          <p>Tokens saved to DB. Auto-refresher running every 29 min.</p>
          <p>⚠️ Bookmark this reminder: re-authenticate before the 7-day refresh token expires.</p>
        </body></html>
      `);
    } catch (e: any) {
      console.error('[schwab] Callback error:', (e as Error).message);
      res.status(500).send(`Schwab token exchange failed: ${(e as Error).message}`);
    }
  });

  // Status check — shows auth health without exposing tokens
  app.get('/schwab/status', (_req, res) => {
    res.json(getSchwabAuthStatus());
  });

  // ── Metrics API (reads from separate metrics.db) ────────────
  const metricsDbPath = process.env.METRICS_DB_PATH || path.join(process.cwd(), 'data', 'metrics.db');
  let metricsDb: InstanceType<typeof Database> | null = null;
  function getMetricsDb() {
    if (!metricsDb) {
      try {
        metricsDb = new Database(metricsDbPath, { readonly: true });
      } catch {
        return null;
      }
    }
    return metricsDb;
  }

  app.get('/metrics/latest', (_req, res) => {
    try {
      const mdb = getMetricsDb();
      if (!mdb) return res.status(503).json({ error: 'metrics DB not available' });
      res.json(getLatestMetrics(mdb));
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/metrics/summary', (req, res) => {
    try {
      const mdb = getMetricsDb();
      if (!mdb) return res.status(503).json({ error: 'metrics DB not available' });
      const hours = parseInt(req.query.hours as string) || 24;
      res.json(getMetricsSummary(mdb, hours));
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.get('/metrics/:name', (req, res) => {
    try {
      const mdb = getMetricsDb();
      if (!mdb) return res.status(503).json({ error: 'metrics DB not available' });
      const from = parseInt(req.query.from as string) || (Math.floor(Date.now() / 1000) - 3600);
      const to = parseInt(req.query.to as string) || Math.floor(Date.now() / 1000);
      const step = req.query.step ? parseInt(req.query.step as string) : undefined;
      const tags = req.query.tags as string | undefined;
      res.json(getMetricSeries(mdb, req.params.name, from, to, step, tags));
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Alerts API ──────────────────────────────────────────────
  app.get('/alerts/history', (_req, res) => {
    res.json(getAlertHistory());
  });

  app.get('/alerts/rules', (_req, res) => {
    res.json(getAlertRules());
  });

  // ── Schwaber viewer ──
  app.use('/schwaber', createSchwaberRoutes());

  // ── DevOps monitoring ──
  app.use('/devops', createDevopsRoutes());

  // ── Replay viewer ──
  app.use('/replay', createReplayRoutes());

  // ── Admin management ──
  app.use('/admin', createAdminRoutes());

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
