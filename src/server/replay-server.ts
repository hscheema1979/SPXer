/**
 * Standalone replay viewer server — serves the replay viewer without
 * needing the full data pipeline to be running.
 *
 * Usage: npx tsx src/server/replay-server.ts
 * Opens at: http://localhost:3601/replay/
 */

import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createReplayRoutes } from './replay-routes';
import { createAdminRoutes } from './admin-routes';

const PORT = parseInt(process.env.REPLAY_PORT || '3601');

const app = express();
app.use(express.json());

// Mount replay routes
app.use('/replay', createReplayRoutes());

// Mount admin routes
app.use('/admin', createAdminRoutes());

// Redirect root to replay viewer
app.get('/', (_req, res) => res.redirect('/replay/'));

app.listen(PORT, () => {
  console.log(`[replay-viewer] Listening on http://localhost:${PORT}/replay/`);
});
