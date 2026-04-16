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
  };
  agents: {
    spx: AgentState | null;
    xsp: AgentState | null;
  };
  watchdog: {
    healthy: boolean;
    ts: number | null;
  } | null;
  tradingPaused: boolean;
  positions: PositionInfo[];
  recentTrades: TradeInfo[];
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
 * Read recent trades from audit log.
 */
function readRecentTrades(n: number = 20): TradeInfo[] {
  try {
    const raw = fs.readFileSync(path.join(LOGS_DIR, 'agent-audit.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const trades: TradeInfo[] = [];
    
    // Read from end (most recent first)
    for (let i = lines.length - 1; i >= 0 && trades.length < n; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'position_close') {
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
        } else if (entry.signal && entry.execution) {
          trades.push({
            ts: entry.ts,
            timeET: new Date(entry.ts).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }),
            symbol: entry.signal.symbol,
            side: entry.signal.side,
            qty: entry.decision?.positionSize ?? 0,
            fillPrice: entry.execution.fillPrice ?? entry.signal.currentPrice,
            pnl: null,
            type: 'trade',
          });
        }
      } catch {}
    }
    return trades;
  } catch {
    return [];
  }
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
 * Check if trading is paused.
 */
function isTradingPaused(): boolean {
  try {
    return fs.existsSync(path.join(LOGS_DIR, 'pause-trading.flag'))
        || fs.existsSync(path.join(LOGS_DIR, 'pause-trading-xsp.flag'));
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
    healthy: false, status: null, lastSpxPrice: null, uptimeSec: null, trackedContracts: null,
  };
  try {
    const { data } = await axios.get(`${SPXER_BASE}/health`, { timeout: 5_000 });
    dsStatus = {
      healthy: data.status !== 'critical',
      status: data.status,
      lastSpxPrice: data.lastSpxPrice,
      uptimeSec: data.uptimeSec ?? data.uptime,
      trackedContracts: data.trackedContracts ?? data.activeContracts,
    };
  } catch {}

  // Agent status
  const agentStatus = readAgentStatus();
  const spxAgent: AgentState | null = agentStatus ? {
    healthy: agentStatus.ts && (Date.now() - agentStatus.ts) < 90_000,
    status: agentStatus,
    heartbeatAgeSec: agentStatus.ts ? Math.round((Date.now() - agentStatus.ts) / 1000) : null,
  } : null;
  // Both agents write to same file — for now they share status
  const xspAgent: AgentState | null = spxAgent;

  // Watchdog
  const watchdogStatus = readWatchdogStatus();
  const watchdog = watchdogStatus ? {
    healthy: watchdogStatus.healthy,
    ts: watchdogStatus.ts,
  } : null;

  // Positions from both accounts
  const [spxPositions, xspPositions] = await Promise.all([
    fetchPositions(process.env.TRADIER_ACCOUNT_ID || '6YA51425'),
    fetchPositions(process.env.XSP_ACCOUNT_ID || '6YA58635'),
  ]);
  const positions = [...spxPositions, ...xspPositions];

  // Recent trades
  const recentTrades = readRecentTrades(20);

  return {
    ts: Date.now(),
    timeET: etTime(),
    dataService: dsStatus,
    agents: { spx: spxAgent, xsp: xspAgent },
    watchdog,
    tradingPaused: isTradingPaused(),
    positions,
    recentTrades,
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

  // Static files (JS, CSS, etc — index.html handled above)
  app.use(express.static(publicDir));

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

  app.get('/api/positions', async (_req, res) => {
    try {
      const [spx, xsp] = await Promise.all([
        fetchPositions(process.env.TRADIER_ACCOUNT_ID || '6YA51425'),
        fetchPositions(process.env.XSP_ACCOUNT_ID || '6YA58635'),
      ]);
      res.json([...spx, ...xsp]);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/trades', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 20, 100);
    res.json(readRecentTrades(n));
  });

  app.post('/api/pause', (_req, res) => {
    try {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      // Write flags for both agents (SPX uses pause-trading.flag, XSP uses pause-trading-xsp.flag)
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading.flag'), new Date().toISOString());
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading-xsp.flag'), new Date().toISOString());
      res.json({ paused: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/resume', (_req, res) => {
    try {
      // Remove flags for both agents
      for (const flag of ['pause-trading.flag', 'pause-trading-xsp.flag']) {
        const flagFile = path.join(LOGS_DIR, flag);
        if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
      }
      res.json({ paused: false });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/kill', async (_req, res) => {
    try {
      const { execSync } = require('child_process');
      // Stop agents
      execSync('npx pm2 stop spxer-agent spxer-xsp --silent', { timeout: 15_000, stdio: 'pipe' });
      
      // Cancel all orders for both accounts
      const accounts = [
        process.env.TRADIER_ACCOUNT_ID || '6YA51425',
        process.env.XSP_ACCOUNT_ID || '6YA58635',
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

      // Set pause flags for both agents
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading.flag'), new Date().toISOString());
      fs.writeFileSync(path.join(LOGS_DIR, 'pause-trading-xsp.flag'), new Date().toISOString());

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
