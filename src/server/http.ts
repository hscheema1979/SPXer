import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { statSync, readFileSync } from 'fs';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb } from '../storage/queries';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';
import { healthTracker } from '../utils/health';
import { config } from '../config';
import { createReplayRoutes } from './replay-routes';
import { createSweepManagerRoutes } from './sweep-manager-routes';
import { createAdminRoutes } from './admin-routes';
import { tickerRoutes } from './ticker-routes';
import { serveHtml } from './serve-html';
import { createStore } from '../replay/store';
import * as path from 'path';

const startTime = Date.now();

export function startHttpServer(port: number): { app: Express; httpServer: Server } {
  const app = express();
  app.use(express.json());

  // Shared shell assets (CSS + nav injector). Served before any route handlers
  // so every page (replay/sweep/admin/etc.) can link `/static/spxer-shell.css`.
  // Cache is short (60s) so fixes propagate quickly; the HTML rewriter appends
  // `?v=<mtime>` to bust caches immediately when an asset changes.
  app.use('/static', express.static(path.resolve(__dirname, 'static'), {
    maxAge: '60s',
    etag: true,
    fallthrough: true,
  }));

  // SPXer Studio — Next.js static export of the new shadcn-based dashboard.
  // Built from /home/ubuntu/spxer-studio (Next.js: npm run build → out/).
  // Mounted at /studio so the public URL is /spxer/studio/ (nginx routes
  // /spxer/* → this service). Old per-product pages (OptionX, Backtest,
  // Spreads, Monthly) keep running at their existing URLs until parity is
  // proven in Studio, at which point the old pages get retired.
  app.get(['/studio', '/studio/', '/spxer/studio', '/spxer/studio/'],
    (_req, res) => res.redirect('/spxer/studio/dashboard/'));
  // Serve under BOTH /studio (when nginx has stripped /spxer/ prefix) AND
  // /spxer/studio (when accessing the service directly, e.g. for local testing).
  // The Next.js basePath in HTML is /spxer/studio so assets reference that.
  const studioStatic = express.static('/home/ubuntu/spxer-studio/out', {
    maxAge: '5m', etag: true, fallthrough: true, extensions: ['html'],
  });
  app.use('/studio',       studioStatic);
  app.use('/spxer/studio', studioStatic);

  // ── Health endpoint ─────────────────────────────────────────────────────

  app.get('/health', (_, res) => {
    const report = healthTracker.getStatus();
    const dbSizeMb = getDbSizeMb();

    // WAL file size (best-effort — file may not exist)
    let walSizeMb = 0;
    try {
      const walPath = (config.dbPath || './data/spxer.db') + '-wal';
      walSizeMb = Math.round(statSync(walPath).size / 1024 / 1024 * 10) / 10;
    } catch {}

    res.json({
      status: 'healthy',
      uptimeSec: report.uptimeSec,
      db: { sizeMb: dbSizeMb, walSizeMb },
      replayEndpoints: true,
      // Backward-compatible fields
      uptime: Math.floor((Date.now() - startTime) / 1000),
      dbSizeMb,
    });
  });

  // ── Historical data endpoints (for replay) ───────────────────────────────

  app.get('/spx/snapshot', (_, res) => {
    const bar = getLatestBar('SPX', '1m');
    res.json(bar ?? { error: 'no data' });
  });

  app.get('/spx/bars', (req, res) => {
    const tf = (req.query.tf as string) || '1m';
    const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
    res.json(getBars('SPX', tf, n));
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

  app.get('/chain/expirations', async (_req, res) => {
    try {
      const dates = await fetchExpirations('SPX');
      res.json(dates);
    } catch (e: any) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Config endpoint (for replay config management) ───────────────────────

  app.get('/agent/config', (req, res) => {
    // Serve configs from the DB (used by replay system)
    try {
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

  // ── Sweep/ticker lifecycle API (Studio "Tickers" page) ───────────────────
  // Mounted BEFORE the broad /replay router so its specific path can't be
  // shadowed by any catch-all in createReplayRoutes().
  app.use('/replay/api/sweep-mgr', createSweepManagerRoutes());

  // ── Replay viewer ────────────────────────────────────────────────────────

  app.use('/replay', createReplayRoutes());

  // ── Admin viewer (consolidated from old replay-viewer process) ───────────
  app.use('/admin', createAdminRoutes());

  // ── Ticker management ─────────────────────────────────────────────────────

  app.use('/api/tickers', tickerRoutes);

  // ── Ticker Manager UI ──────────────────────────────────────────────────────

  app.get('/tickers', (req, res) => {
    serveHtml(path.resolve(__dirname, 'ticker-manager.html'), req, res);
  });

  // ── Root endpoint ─────────────────────────────────────────────────────────

  // ── Root endpoint ─────────────────────────────────────────────────────────
  //
  // Browsers land on the unified UI (Tickers is the default — it surfaces
  // data inventory + backfill status, the most common entry point).
  //
  // API clients still get the service descriptor — opt in via Accept: application/json
  // or query param `?format=json`. Honoring the X-Forwarded-Prefix header so
  // /spxer/ on the public URL redirects to /spxer/tickers.

  app.get('/', (req, res) => {
    const wantsJson =
      req.query.format === 'json' ||
      (req.headers.accept || '').includes('application/json') &&
        !(req.headers.accept || '').includes('text/html');

    if (wantsJson) {
      res.json({
        service: 'SPXer Replay-Only Data Service',
        version: '2.0',
        endpoints: {
          health: '/health',
          ui: '/tickers',
          replay: '/replay',
          tickers: '/api/tickers',
          spx: { snapshot: '/spx/snapshot', bars: '/spx/bars?tf=1m&n=100' },
          contracts: { active: '/contracts/active', bars: '/contracts/:symbol/bars' },
          chain: '/chain?expiry=YYYY-MM-DD',
          config: '/agent/config?id=config-id',
        },
        notice: 'Replay-only data service. For UI, browse /tickers.',
      });
      return;
    }

    // Browser → redirect to Replay (the primary tool), honoring nginx prefix.
    const prefix = (req.headers['x-forwarded-prefix'] as string) || '';
    res.redirect(302, `${prefix}/replay/`);
  });

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
