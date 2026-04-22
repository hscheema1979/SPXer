/**
 * SPXer Dashboard — Live trading management UI.
 *
 * Real-time view of all agents, positions, trades, and system health.
 * Provides manual pause/resume/kill controls.
 *
 * Serves static HTML/JS and a REST + WebSocket API.
 * All data comes from real sources: status files, audit logs, data service, Tradier API.
 * No mocks, no stubs.
 */
import express, { type Express } from 'express';
import { createServer, type Server } from 'http';
import { WebSocketServer, type WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { config as appConfig } from '../config';

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';
const TRADIER_BASE = 'https://api.tradier.com/v1';
const LOGS_DIR = path.resolve('./logs');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3602');

// ── Types ──────────────────────────────────────────────────────────────────

interface DashboardState {
  ts: number;
  timeET: string;
  dataService: {
    healthy: boolean;
    status: string | null;
    lastSpxPrice: number | null;
    uptimeSec: number | null;
    trackedContracts: number | null;
    activeContracts: number | null;
    mode: string | null;
    wsClients: number | null;
    optionStream: {
      connected: boolean;
      symbolCount: number;
      lastActivity: number | null;
      theta: { connected: boolean; lastFrameTs: number | null; lastDataTs: number | null } | null;
    } | null;
    providers: Record<string, any> | null;
  };
  agents: {
    spx: AgentState | null;
  };
  watchdog: {
    healthy: boolean;
    ts: number | null;
  } | null;
  tradingPaused: boolean;
  positions: PositionInfo[];
  recentTrades: TradeInfo[];
  orders: OrderInfo[];
  signal: any | null;
}

interface AgentState {
  healthy: boolean;
  status: any;          // Raw agent-status.json
  heartbeatAgeSec: number | null;
}

interface PositionInfo {
  account: string;
  symbol: string;
  side: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  pnl: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
}

interface TradeInfo {
  ts: number;
  timeET: string;
  symbol: string;
  side: string;
  qty: number;
  fillPrice: number;
  pnl: number | null;
  type: string;  // 'trade' | 'close'
}

interface OrderInfo {
  id: number;
  type: string;
  symbol: string;
  side: string;
  quantity: number;
  status: string;
  price: number | null;
  stopPrice: number | null;
  fillPrice: number | null;
  createdAt: string;
  tag: string | null;
  legs: OrderInfo[];
}

// ── Data Collection ────────────────────────────────────────────────────────

function tradierHeaders() {
  return {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };
}

function etTime(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

function etDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Read agent status file from disk.
 */
function readAgentStatus(): any | null {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'agent-status.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read watchdog status file from disk.
 */
function readWatchdogStatus(): any | null {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'watchdog-status.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Read today's trades from audit log — richer structure for config comparison.
 */
function readTodayTrades(): TradeInfo[] {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'agent-audit.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const today = etDate();
    const trades: TradeInfo[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        // Filter to today only
        const entryDate = new Date(entry.ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        if (entryDate !== today) continue;

        if (entry.signal && entry.execution) {
          trades.push({
            ts: entry.ts,
            timeET: new Date(entry.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }),
            symbol: entry.signal.symbol,
            side: entry.signal.side,
            qty: entry.decision?.positionSize ?? entry.execution?.quantity ?? 0,
            fillPrice: entry.execution.fillPrice ?? entry.signal.currentPrice,
            pnl: null,
            type: 'entry',
          });
        } else if (entry.type === 'position_close') {
          trades.push({
            ts: entry.ts,
            timeET: new Date(entry.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }),
            symbol: entry.symbol,
            side: entry.side,
            qty: entry.quantity,
            fillPrice: entry.closePrice,
            pnl: entry.pnl,
            type: 'close',
          });
        }
      } catch {}
    }
    return trades;
  } catch {
    return [];
  }
}

/** Legacy compat wrapper */
function readRecentTrades(n: number = 20): TradeInfo[] {
  return readTodayTrades().slice(-n);
}

/**
 * Fetch positions from Tradier for an account.
 */
async function fetchPositions(accountId: string): Promise<PositionInfo[]> {
  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: tradierHeaders(), timeout: 10_000 },
    );
    const raw = data?.positions?.position;
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
    
    return list.map((p: any) => {
      const match = (p.symbol as string).match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
      const side = match ? (match[3] === 'C' ? 'call' : 'put') : 'unknown';
      const strike = match ? parseInt(match[4]) / 1000 : 0;
      const entryPrice = Math.abs(p.cost_basis) / (Math.abs(p.quantity) * 100);
      
      return {
        account: accountId,
        symbol: p.symbol,
        side,
        quantity: Math.abs(p.quantity),
        entryPrice,
        currentPrice: p.market_value ? Math.abs(p.market_value) / (Math.abs(p.quantity) * 100) : null,
        pnl: (p.market_value !== undefined && p.cost_basis !== undefined) 
          ? p.market_value - p.cost_basis 
          : null,
        stopLoss: null,
        takeProfit: null,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Fetch today's orders from Tradier for an account.
 */
async function fetchOrders(accountId: string): Promise<OrderInfo[]> {
  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/orders`,
      { headers: tradierHeaders(), timeout: 10_000 },
    );
    const raw = data?.orders?.order;
    const list = raw ? (Array.isArray(raw) ? raw : [raw]) : [];

    // Filter to today's orders only (ET date)
    const today = etDate();

    function mapOrder(o: any): OrderInfo {
      return {
        id: o.id,
        type: o.type || o.class,
        symbol: o.option_symbol || o.symbol || '',
        side: o.side || '',
        quantity: o.quantity ?? 0,
        status: o.status,
        price: o.price ?? null,
        stopPrice: o.stop_price ?? null,
        fillPrice: o.avg_fill_price ?? null,
        createdAt: o.create_date,
        tag: o.tag ?? null,
        legs: (o.leg ? (Array.isArray(o.leg) ? o.leg : [o.leg]) : []).map(mapOrder),
      };
    }

    return list
      .filter((o: any) => o.create_date?.startsWith(today))
      .map(mapOrder);
  } catch {
    return [];
  }
}

/**
 * Check if trading is paused.
 */
function isTradingPaused(): boolean {
  try {
    return fs.existsSync(path.join(LOGS_DIR, 'pause-trading.flag'));
  } catch {
    return false;
  }
}

/**
 * Collect full dashboard state.
 */
async function collectState(): Promise<DashboardState> {
  // Data service health
  let dsStatus: DashboardState['dataService'] = {
    healthy: false, status: null, lastSpxPrice: null, uptimeSec: null,
    trackedContracts: null, activeContracts: null, mode: null, wsClients: null,
    optionStream: null, providers: null,
  };
  try {
    const { data } = await axios.get(`${SPXER_BASE}/health`, { timeout: 5_000 });
    dsStatus = {
      healthy: data.status !== 'critical',
      status: data.status,
      lastSpxPrice: data.lastSpxPrice,
      uptimeSec: data.uptimeSec ?? data.uptime,
      trackedContracts: data.trackedContracts ?? data.activeContracts,
      activeContracts: data.activeContracts ?? null,
      mode: data.mode ?? null,
      wsClients: data.wsClients ?? null,
      optionStream: data.optionStream ?? null,
      providers: data.providers ?? null,
    };
  } catch {}

  // Agent status
  const agentStatus = readAgentStatus();
  const spxAgent: AgentState | null = agentStatus ? {
    healthy: agentStatus.ts && (Date.now() - agentStatus.ts) < 90_000,
    status: agentStatus,
    heartbeatAgeSec: agentStatus.ts ? Math.round((Date.now() - agentStatus.ts) / 1000) : null,
  } : null;

  // Watchdog
  const watchdogStatus = readWatchdogStatus();
  const watchdog = watchdogStatus ? {
    healthy: watchdogStatus.healthy,
    ts: watchdogStatus.ts,
  } : null;

  // Positions, orders, and signal (fetch in parallel)
  const accountId = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
  let signal: any = null;
  const [positions, orders] = await Promise.all([
    fetchPositions(accountId),
    fetchOrders(accountId),
  ]);

  // Signal from data service (non-blocking — don't delay dashboard if it fails)
  try {
    const { data } = await axios.get(`${SPXER_BASE}/signal/latest`, { timeout: 3_000 });
    signal = data?.signal !== undefined ? data : (data ?? null);
  } catch {}

  // Recent trades
  const recentTrades = readRecentTrades(20);

  return {
    ts: Date.now(),
    timeET: etTime(),
    dataService: dsStatus,
    agents: { spx: spxAgent },
    watchdog,
    tradingPaused: isTradingPaused(),
    positions,
    recentTrades,
    orders,
    signal,
  };
}

// ── Server ─────────────────────────────────────────────────────────────────

export function startDashboardServer(port: number = DASHBOARD_PORT): { app: Express; server: Server; wss: WebSocketServer } {
  const app = express();
  app.use(express.json());

  // Serve index.html with optional base-path injection (must come before express.static)
  const publicDir = path.join(__dirname, 'public');
  const envBasePath = process.env.BASE_PATH || '';
  app.get('/', (req, res) => {
    const basePath = req.headers['x-forwarded-prefix'] as string || envBasePath;
    try {
      let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf-8');
      if (basePath) {
        html = html.replace('<head>', `<head>\n  <meta name="base-path" content="${basePath}">`);
      }
      res.type('html').send(html);
    } catch (e: any) {
      res.status(500).send(e.message);
    }
  });

  // Static files — no-cache so JS updates take effect without hard-refresh
  app.use(express.static(publicDir, {
    setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); },
  }));

  // ── REST API ───────────────────────────────────────────────────────

  app.get('/api/status', async (_req, res) => {
    try {
      const state = await collectState();
      res.json(state);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/health', async (_req, res) => {
    try {
      const { data } = await axios.get(`${SPXER_BASE}/health`, { timeout: 5_000 });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Proxy SPX bars from data service for chart — filtered to today (ET) only
  app.get('/api/bars', async (req, res) => {
    try {
      const tf = req.query.tf || '1m';
      const n = Math.min(parseInt(req.query.n as string) || 200, 2000);
      const { data } = await axios.get(`${SPXER_BASE}/spx/bars`, {
        params: { tf, n },
        timeout: 10_000,
      });

      // Filter to today's bars only so the chart doesn't bleed prior session days.
      // Compute midnight ET in UTC epoch seconds using Intl (DST-safe).
      if (Array.isArray(data) && data.length > 0) {
        const today = etDate(); // 'YYYY-MM-DD' in ET
        // Midnight ET = midnight UTC minus the UTC-to-ET offset.
        // EDT (summer) = UTC-4, EST (winter) = UTC-5.
        // Use Intl to get the current ET offset correctly.
        const utcNow = new Date();
        const etParts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour: 'numeric', hour12: false, timeZoneName: 'shortOffset',
        }).formatToParts(utcNow);
        const tzPart = etParts.find(p => p.type === 'timeZoneName');
        // tzPart.value is like "GMT-4" or "GMT-5"
        const offsetHours = tzPart ? parseInt(tzPart.value.replace('GMT', '')) : -5;
        // Midnight ET in UTC = midnight UTC minus offset (offset is negative, so subtract)
        const midnightEtUtc = new Date(today + 'T00:00:00Z').getTime() / 1000 - offsetHours * 3600;

        const filtered = data.filter((b: any) => b.ts >= midnightEtUtc);
        return res.json(filtered.length > 0 ? filtered : data);
      }
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  app.get('/api/positions', async (_req, res) => {
    try {
      const spx = await fetchPositions(process.env.TRADIER_ACCOUNT_ID || '6YA51425');
      res.json(spx);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/trades', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 20, 100);
    res.json(readRecentTrades(n));
  });

  app.get('/api/orders', async (_req, res) => {
    try {
      const orders = await fetchOrders(process.env.TRADIER_ACCOUNT_ID || '6YA51425');
      res.json(orders);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Live agent config (proxy via replay-server which reads from DB)
  app.get('/api/config', async (_req, res) => {
    try {
      const { data } = await axios.get(`http://localhost:3601/replay/api/live/agent/config`, { timeout: 5_000 });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Active tracked contracts (option chain band)
  app.get('/api/contracts', async (_req, res) => {
    try {
      const { data } = await axios.get(`${SPXER_BASE}/contracts/active`, { timeout: 10_000 });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Contract bars for a specific symbol
  app.get('/api/contracts/:symbol/bars', async (req, res) => {
    try {
      const tf = req.query.tf || '1m';
      const n = Math.min(parseInt(req.query.n as string) || 100, 2000);
      const { data } = await axios.get(`${SPXER_BASE}/contracts/${req.params.symbol}/bars`, {
        params: { tf, n },
        timeout: 10_000,
      });
      res.json(data);
    } catch (e: any) {
      res.status(502).json({ error: e.message });
    }
  });

  // Round-trip trades: group OTOCO orders into trade lifecycles with config comparison
  app.get('/api/round-trips', async (req, res) => {
    try {
      const accountId = process.env.TRADIER_ACCOUNT_ID || '6YA51425';
      const orders = await fetchOrders(accountId);

      // Fetch agent config for comparison
      let agentConfig: any = null;
      try {
        const { data } = await axios.get(`http://localhost:3601/replay/api/live/agent/config`, { timeout: 5_000 });
        agentConfig = data?.config || data;
      } catch {}

      const tpMult = agentConfig?.position?.takeProfitMultiplier ?? 1.25;
      const slPct = agentConfig?.position?.stopLossPercent ?? 25;

      interface RoundTrip {
        orderId: number;
        symbol: string;
        side: string;
        strike: number | null;
        qty: number;
        entryTime: string;
        entryFill: number | null;
        tpTarget: number | null;    // actual broker TP level
        slTarget: number | null;    // actual broker SL level
        configTp: number | null;    // config-implied TP level
        configSl: number | null;    // config-implied SL level
        exitFill: number | null;
        exitReason: string;         // TP | SL | SIGNAL | OPEN
        exitTime: string | null;
        pnl: number | null;
        status: string;
      }

      const roundTrips: RoundTrip[] = [];

      for (const order of orders) {
        // Only process OTOCO orders (bracket trades)
        if (order.type !== 'otoco' && order.type !== 'oto') continue;
        if (!order.legs || order.legs.length === 0) continue;

        // Find entry leg (buy_to_open), TP leg (limit sell_to_close), SL leg (stop sell_to_close)
        const entryLeg = order.legs.find((l: OrderInfo) => l.side === 'buy_to_open');
        const tpLeg = order.legs.find((l: OrderInfo) => l.side === 'sell_to_close' && l.price != null && l.stopPrice == null);
        const slLeg = order.legs.find((l: OrderInfo) => l.side === 'sell_to_close' && l.stopPrice != null);

        if (!entryLeg) continue;

        const symbol = entryLeg.symbol;
        const match = symbol.match(/^([A-Z]+)(\d{6})([CP])(\d{8})$/);
        const side = match ? (match[3] === 'C' ? 'call' : 'put') : 'unknown';
        const strike = match ? parseInt(match[4]) / 1000 : null;

        const entryFill = entryLeg.fillPrice;
        const tpTarget = tpLeg?.price ?? null;
        const slTarget = slLeg?.stopPrice ?? null;

        // Config-implied levels
        const configTp = entryFill != null ? Math.round(entryFill * tpMult * 100) / 100 : null;
        const configSl = entryFill != null ? Math.round(entryFill * (1 - slPct / 100) * 100) / 100 : null;

        // Determine exit — fillPrice of 0 means not filled (Tradier returns 0, not null)
        let exitFill: number | null = null;
        let exitReason = 'OPEN';
        let exitTime: string | null = null;

        if (tpLeg?.status === 'filled' && tpLeg.fillPrice && tpLeg.fillPrice > 0) {
          exitFill = tpLeg.fillPrice;
          exitReason = 'TP';
          exitTime = tpLeg.createdAt;
        } else if (slLeg?.status === 'filled' && slLeg.fillPrice && slLeg.fillPrice > 0) {
          exitFill = slLeg.fillPrice;
          exitReason = 'SL';
          exitTime = slLeg.createdAt;
        }

        // Check for standalone sell_to_close right before this OTOCO (signal exit / scannerReverse)
        // Pattern: standalone sell appears just before the next OTOCO in the order list
        if (exitReason === 'OPEN') {
          const orderIdx = orders.indexOf(order);
          // Look for a standalone sell_to_close that was created after this OTOCO's entry
          const entryTs = entryLeg.createdAt ? new Date(entryLeg.createdAt).getTime() : 0;
          const signalExit = orders.find((o: OrderInfo, i: number) =>
            i > orderIdx &&
            o.type !== 'otoco' && o.type !== 'oto' &&
            o.side === 'sell_to_close' &&
            o.status === 'filled' &&
            o.fillPrice != null && o.fillPrice > 0 &&
            (o.createdAt ? new Date(o.createdAt).getTime() : 0) >= entryTs
          );
          if (signalExit) {
            exitFill = signalExit.fillPrice;
            exitReason = 'SIGNAL';
            exitTime = signalExit.createdAt;
          }
        }

        // P&L calc (per contract × 100 multiplier)
        const qty = entryLeg.quantity || 1;
        const pnl = (entryFill != null && exitFill != null)
          ? Math.round((exitFill - entryFill) * qty * 100)
          : null;

        const status = exitReason === 'OPEN'
          ? (entryLeg.status === 'filled' ? 'OPEN' : entryLeg.status.toUpperCase())
          : 'CLOSED';

        roundTrips.push({
          orderId: order.id,
          symbol,
          side,
          strike,
          qty,
          entryTime: entryLeg.createdAt,
          entryFill,
          tpTarget,
          slTarget,
          configTp,
          configSl,
          exitFill,
          exitReason,
          exitTime,
          pnl,
          status,
        });
      }

      res.json({ roundTrips, config: { tpMult, slPct } });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/pause', (_req, res) => {
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading.flag'), new Date().toISOString());
      res.json({ paused: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/resume', (_req, res) => {
    try {
      const flagFile = path.join(LOGS_DIR, 'pause-trading.flag');
      if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
      res.json({ paused: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/kill', async (_req, res) => {
    try {
      const { execSync } = require('child_process');
      // Stop agent
      execSync('npx pm2 stop spxer-agent --silent', { timeout: 15_000, stdio: 'pipe' });

      // Cancel all orders for SPX account
      const accounts = [
        process.env.TRADIER_ACCOUNT_ID || '6YA51425',
      ];
      let cancelled = 0;
      for (const accountId of accounts) {
        try {
          const { data } = await axios.get(
            `${TRADIER_BASE}/accounts/${accountId}/orders`,
            { headers: tradierHeaders(), timeout: 10_000 },
          );
          const orders = data?.orders?.order;
          const list = orders ? (Array.isArray(orders) ? orders : [orders]) : [];
          for (const order of list) {
            if (order.status === 'open' || order.status === 'pending') {
              try {
                await axios.delete(
                  `${TRADIER_BASE}/accounts/${accountId}/orders/${order.id}`,
                  { headers: tradierHeaders(), timeout: 5_000 },
                );
                cancelled++;
              } catch {}
            }
          }
        } catch {}
      }

      // Set pause flag
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading.flag'), new Date().toISOString());

      res.json({ killed: true, cancelledOrders: cancelled });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── HTTP Server + WebSocket ────────────────────────────────────────

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Broadcast state to all connected clients every 5s
  const broadcastInterval = setInterval(async () => {
    try {
      const state = await collectState();
      const msg = JSON.stringify(state);
      wss.clients.forEach(client => {
        if (client.readyState === 1) { // WebSocket.OPEN
          client.send(msg);
        }
      });
    } catch {}
  }, 5_000);

  wss.on('close', () => clearInterval(broadcastInterval));

  server.listen(port, () => {
    console.log(`[dashboard] Live dashboard on http://localhost:${port}`);
  });

  return { app, server, wss };
}

// ── Main ───────────────────────────────────────────────────────────────────

if (require.main === module || process.argv[1]?.includes('dashboard')) {
  startDashboardServer(DASHBOARD_PORT);
}

export { collectState, readRecentTrades, readAgentStatus, readWatchdogStatus, isTradingPaused };
