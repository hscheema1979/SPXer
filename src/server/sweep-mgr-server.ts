/**
 * sweep-mgr-server — standalone host for the sweep-manager REST surface.
 *
 * Background: the routes used to be mounted by src/server/replay-server.ts on
 * :3601. That server was deleted in a32fe0e1a ("remove dead :3601 replay
 * viewer") and took sweep-manager-routes.ts with it — which silently killed
 * the Studio "Tickers" page (it still calls /spxer/replay/api/sweep-mgr/*).
 * This process gives those routes a home again, with nothing else attached.
 *
 * Path shape is preserved on purpose: the studio proxy strips only the
 * `/spxer` hop, so requests arrive here as /replay/api/sweep-mgr/*.
 *
 * PORT: env SWEEP_MGR_PORT (default 3603). Binds 127.0.0.1 — the studio
 * (:3800) is the only front door, so there is no CORS surface.
 *
 * cwd MUST be the SPXer repo root: the routes resolve the registry, parquet
 * root and job dir from process.cwd().
 */
import express, { type Express } from 'express';
import { createSweepManagerRoutes } from './sweep-manager-routes';

export const SWEEP_MGR_MOUNT = '/replay/api/sweep-mgr';

export function createSweepMgrApp(): Express {
  const app = express();
  app.use(express.json());
  app.get('/health', (_req, res) => {
    res.json({ ok: true, mount: SWEEP_MGR_MOUNT, cwd: process.cwd(), uptimeSec: Math.floor(process.uptime()) });
  });
  app.use(SWEEP_MGR_MOUNT, createSweepManagerRoutes());
  return app;
}

export function startSweepMgr(port: number): { close: () => void } {
  return createSweepMgrApp().listen(port, '127.0.0.1');
}

// CLI entry — `tsx src/server/sweep-mgr-server.ts`
const invokedDirectly = process.argv[1] && /sweep-mgr-server\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const PORT = Number.parseInt(process.env.SWEEP_MGR_PORT ?? '3603', 10);
  startSweepMgr(PORT);
  console.log(`[sweep-mgr] listening on 127.0.0.1:${PORT}${SWEEP_MGR_MOUNT}  cwd=${process.cwd()}`);
}
