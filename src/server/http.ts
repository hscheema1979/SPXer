import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { statSync } from 'fs';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb } from '../storage/queries';
import { getMarketMode } from '../pipeline/scheduler';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';
import { readStatus, readRecentActivity } from '../agent/reporter';
import { healthTracker } from '../utils/health';
import { circuitBreakers } from '../utils/resilience';
import { getWsClientCount } from './ws';
import { config } from '../config';
import { createReplayRoutes } from './replay-routes';
import { refreshPipelineHealth } from '../ops/pipeline-health';
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  getSchwabAuthStatus,
  startTokenRefresher,
} from '../providers/schwab';
import { createSchwaberRoutes } from './schwaber-routes';

let lastSpxPrice: number | null = null;
export function setLastSpxPrice(p: number) { lastSpxPrice = p; }

let trackerCountFn: () => number = () => 0;
export function setTrackerCountFn(fn: () => number) { trackerCountFn = fn; }

let optionStreamStatusFn: () => { connected: boolean; symbolCount: number; lastActivity: number } = () => ({
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
      const walPath = (config.dbPath || './data/spxer.db') + '-wal';
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
      },
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
    // Serve the live agent config from the DB (same source the agents use)
    try {
      const { createStore } = require('../replay/store');
      const store = createStore();
      const configId = process.env.AGENT_CONFIG_ID || 'hma3x17-scannerReverse-live';
      const cfg = store.getConfig(configId);
      store.close();
      if (!cfg) return res.json({ error: `Config '${configId}' not found in DB` });
      res.json({
        id: cfg.id,
        name: cfg.name,
        signals: {
          hmaCrossFast: cfg.signals?.hmaCrossFast,
          hmaCrossSlow: cfg.signals?.hmaCrossSlow,
          targetOtmDistance: cfg.signals?.targetOtmDistance,
          enableHmaCrosses: cfg.signals?.enableHmaCrosses,
          enableEmaCrosses: cfg.signals?.enableEmaCrosses,
          requireUnderlyingHmaCross: cfg.signals?.requireUnderlyingHmaCross,
          signalTimeframe: cfg.signals?.signalTimeframe,
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

  // ── Schwab OAuth ──

  // Step 1: redirect browser to Schwab login
  // Visit https://bitloom.cloud/schwab/auth to kick off the flow
  app.get('/schwab/auth', (_req, res) => {
    try {
      const url = buildAuthUrl();
      res.redirect(url);
    } catch (e: any) {
      res.status(500).send(`Schwab auth error: ${e.message}`);
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
      console.error('[schwab] Callback error:', e.message);
      res.status(500).send(`Schwab token exchange failed: ${e.message}`);
    }
  });

  // Status check — shows auth health without exposing tokens
  app.get('/schwab/status', (_req, res) => {
    res.json(getSchwabAuthStatus());
  });

  // ── Schwaber viewer ──
  app.use('/schwaber', createSchwaberRoutes());

  // ── Replay viewer ──
  app.use('/replay', createReplayRoutes());

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
