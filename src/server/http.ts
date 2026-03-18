import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { getBars, getLatestBar, getAllActiveContracts, getDbSizeMb } from '../storage/queries';
import { getMarketMode } from '../pipeline/scheduler';
import { fetchOptionsChain, fetchExpirations } from '../providers/tradier';

let lastSpxPrice: number | null = null;
export function setLastSpxPrice(p: number) { lastSpxPrice = p; }

let trackerCountFn: () => number = () => 0;
export function setTrackerCountFn(fn: () => number) { trackerCountFn = fn; }

const startTime = Date.now();

export function startHttpServer(port: number): { app: Express; httpServer: Server } {
  const app = express();
  app.use(express.json());

  app.get('/health', (_, res) => res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    mode: getMarketMode(),
    lastSpxPrice,
    dbSizeMb: getDbSizeMb(),
    trackedContracts: trackerCountFn(),
  }));

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

  const httpServer = createServer(app);
  httpServer.listen(port, () => console.log(`[http] Listening on :${port}`));
  return { app, httpServer };
}
