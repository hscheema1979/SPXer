/**
 * Canonical SPXer server — backtest + backfill only.
 *
 * Serves the replay/backtest viewer, the sweep manager API, the admin UI,
 * the ticker/backfill API, and the SPXer Studio (shadcn) dashboard. This is
 * the ONLY HTTP server in the repo since the live data service (src/index.ts,
 * src/server/http.ts) was removed — there is no live pipeline anymore.
 *
 * Usage: npx tsx src/server/replay-server.ts   (PM2: replay-viewer)
 * Opens at: http://localhost:3601/replay/
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import * as path from 'path';
import { createReplayRoutes } from './replay-routes';
import { createAdminRoutes } from './admin-routes';
import { createSweepManagerRoutes } from './sweep-manager-routes';
import { tickerRoutes } from './ticker-routes';
import { createStore } from '../replay/store';

const PORT = parseInt(process.env.REPLAY_PORT || '3601');

const app = express();
app.use(express.json());

// NOTE: This server does NOT serve the SPXer Studio. The studio is a separate
// dedicated process — `spxer-studio` (studio-server.cjs, port 3800) — which
// serves the Next.js export under /spxer/studio. Route /spxer/studio at that
// process, never here.

// Shared shell assets (CSS + nav injector) for the viewer pages. Short cache so
// fixes propagate; the HTML rewriter appends `?v=<mtime>` to bust caches.
app.use('/static', express.static(path.resolve(__dirname, 'static'), {
  maxAge: '60s',
  etag: true,
  fallthrough: true,
}));

// Config endpoint (used by the replay system to load a config by id).
app.get('/agent/config', (req, res) => {
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

// Sweep/ticker lifecycle API (Studio "Tickers" page). Mounted BEFORE the broad
// /replay router so its specific path can't be shadowed by a catch-all there.
app.use('/replay/api/sweep-mgr', createSweepManagerRoutes());

// Replay/backtest viewer + API
app.use('/replay', createReplayRoutes());

// Admin/config management
app.use('/admin', createAdminRoutes());

// Ticker / backfill management API (consumed by Studio)
app.use('/api/tickers', tickerRoutes);

// Root → replay viewer (honoring any nginx prefix)
app.get('/', (req, res) => {
  const prefix = (req.headers['x-forwarded-prefix'] as string) || '';
  res.redirect(302, `${prefix}/replay/`);
});

app.listen(PORT, () => {
  console.log(`[spxer-server] Backtest/backfill server on http://localhost:${PORT}/replay/`);
});
