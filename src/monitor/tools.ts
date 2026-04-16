/**
 * Unified Account Monitor — Tool Definitions
 *
 * Monitor tools for the account monitor agent. Each tool queries Tradier,
 * the data service, agent status files, or system resources.
 *
 * All tools return { content: [{type:'text', text}], details: {} }.
 * Typebox schemas double as JSON Schema for Anthropic tool definitions.
 */

import { Type } from '@sinclair/typebox';
import axios from 'axios';
import * as fs from 'fs';
import { todayET, nowET } from '../utils/et-time';
import {
  ACCOUNTS,
  TRADIER_BASE,
  tradierHeaders,
  textResult,
  MONITOR_LOG_FILE,
  STALE_THRESHOLD_MS,
  isMaintenanceActive,
  type AccountKey,
  type ToolResult,
} from './types';
import {
  loadMonitorState,
  saveMonitorState,
  recordAction,
  checkCooldown,
} from './state';

/** Cooldown periods for remediation actions */
const ACTION_COOLDOWNS: Record<string, number> = {
  stop_agent: 30 * 60 * 1000,          // 30 min — don't stop the same agent repeatedly
  close_position: 30 * 60 * 1000,      // 30 min — don't panic-sell repeatedly  
  cancel_order: 5 * 60 * 1000,         // 5 min — order cancels are less dangerous
  cancel_all_orders: 15 * 60 * 1000,   // 15 min — bulk cancel needs breathing room
};

/**
 * Guard for remediation tools — blocks action during maintenance OR cooldown.
 * Returns a ToolResult if blocked, or null if action is allowed.
 */
function maintenanceGuard(toolName: string): ToolResult | null {
  // Check maintenance mode first
  const maint = isMaintenanceActive();
  if (maint.active) {
    const msg = `🚫 BLOCKED: ${toolName} not allowed during agent maintenance. Reason: ${maint.reason}.`;
    console.log(`[monitor] ${msg}`);
    return textResult(msg);
  }
  
  // Check cooldown
  const cooldownMs = ACTION_COOLDOWNS[toolName];
  if (cooldownMs) {
    const state = loadMonitorState();
    const check = checkCooldown(state, toolName, cooldownMs);
    if (!check.allowed) {
      const msg = `🚫 COOLDOWN: ${check.reason}. Wait before retrying.`;
      console.log(`[monitor] ${msg}`);
      return textResult(msg);
    }
  }
  
  return null;
}

/**
 * Record that a remediation action was taken (for cooldown tracking).
 */
function recordRemediationAction(action: string, target: string, reason: string): void {
  const state = loadMonitorState();
  recordAction(state, action, target, reason);
  saveMonitorState(state);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve which account keys to query */
function resolveAccounts(account?: string): AccountKey[] {
  if (account === 'spx') return ['spx'];
  if (account === 'xsp') return ['xsp'];
  return ['spx', 'xsp']; // default: both
}

/** Safe Tradier GET with timeout */
async function tradierGet(path: string, params?: Record<string, string>, timeoutMs = 10000) {
  return axios.get(`${TRADIER_BASE}${path}`, {
    headers: tradierHeaders(),
    params,
    timeout: timeoutMs,
  });
}

/** Normalize Tradier's inconsistent array/single/null responses */
function normalizeArray(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw) return [raw];
  return [];
}

// ── Tool 1: get_positions ───────────────────────────────────────────────────

const getPositionsTool = {
  name: 'get_positions',
  label: 'Get Broker Positions',
  description:
    'Fetch open positions from Tradier for one or both trading accounts. ' +
    'Returns symbol, quantity, cost basis, date acquired, and computed entry price. ' +
    'Use account="spx" for the SPX margin account, "xsp" for the XSP cash account, or "both" (default).',
  parameters: Type.Object({
    account: Type.Optional(
      Type.String({ description: 'Which account: "spx", "xsp", or "both" (default)' }),
    ),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    try {
      const keys = resolveAccounts(params?.account);
      const lines: string[] = [];

      for (const key of keys) {
        const acct = ACCOUNTS[key];
        const { data } = await tradierGet(`/accounts/${acct.accountId}/positions`);
        const positions = normalizeArray(data?.positions?.position);

        lines.push(`── ${acct.label} (${acct.accountId}) ──`);
        if (positions.length === 0) {
          lines.push('  No open positions.');
        } else {
          for (const p of positions) {
            const entry = Math.abs(p.cost_basis) / (Math.abs(p.quantity) * 100);
            lines.push(
              `  ${p.symbol} x${p.quantity} | entry=$${entry.toFixed(2)} | cost=$${p.cost_basis} | acquired=${p.date_acquired}`,
            );
          }
        }
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error fetching positions: ${e.message}`);
    }
  },
};

// ── Tool 2: get_orders ──────────────────────────────────────────────────────

const getOrdersTool = {
  name: 'get_orders',
  label: 'Get Recent Orders',
  description:
    "Fetch today's orders from Tradier. Shows order ID, status, class, side, symbol, fill price, and legs. " +
    'Filter by account ("spx", "xsp", "both") and status ("all", "open", "filled", "rejected", "pending", "canceled").',
  parameters: Type.Object({
    account: Type.Optional(
      Type.String({ description: 'Which account: "spx", "xsp", or "both" (default)' }),
    ),
    status_filter: Type.Optional(
      Type.String({
        description: 'Filter by status: all, open, filled, rejected, pending, canceled. Default: all',
      }),
    ),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    try {
      const keys = resolveAccounts(params?.account);
      const statusFilter = params?.status_filter;
      const today = todayET();
      const lines: string[] = [];

      for (const key of keys) {
        const acct = ACCOUNTS[key];
        const { data } = await tradierGet(`/accounts/${acct.accountId}/orders`);
        let orders = normalizeArray(data?.orders?.order);

        // Filter to today's orders
        orders = orders.filter((o: any) => o.create_date?.startsWith(today));

        // Apply status filter
        if (statusFilter && statusFilter !== 'all') {
          orders = orders.filter((o: any) => o.status === statusFilter);
        }

        lines.push(`── ${acct.label} (${acct.accountId}) — ${orders.length} orders ──`);

        if (orders.length === 0) {
          lines.push('  No matching orders today.');
        } else {
          for (const o of orders) {
            const legs = normalizeArray(o.leg);
            const sym = o.option_symbol || legs[0]?.option_symbol || o.symbol || '';
            const side = o.side || legs[0]?.side || '';
            let line = `  #${o.id} ${o.status} ${o.class} ${side} ${sym} qty=${o.quantity || legs[0]?.quantity || ''} fill=$${o.avg_fill_price ?? '-'}`;
            if (o.reason_description) line += ` REASON: ${o.reason_description}`;
            for (const l of legs) {
              line += `\n    leg #${l.id} ${l.status} ${l.type} ${l.side} ${l.option_symbol} price=${l.price ?? l.stop ?? '-'} fill=$${l.avg_fill_price ?? '-'}`;
            }
            lines.push(line);
          }
        }
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error fetching orders: ${e.message}`);
    }
  },
};

// ── Tool 3: get_balance ─────────────────────────────────────────────────────

const getBalanceTool = {
  name: 'get_balance',
  label: 'Get Account Balance',
  description:
    'Fetch account balances from Tradier for one or both accounts. ' +
    'Returns equity, buying power, market value, open P&L, and close P&L.',
  parameters: Type.Object({
    account: Type.Optional(
      Type.String({ description: 'Which account: "spx", "xsp", or "both" (default)' }),
    ),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    try {
      const keys = resolveAccounts(params?.account);
      const lines: string[] = [];

      for (const key of keys) {
        const acct = ACCOUNTS[key];
        const { data } = await tradierGet(`/accounts/${acct.accountId}/balances`, undefined, 5000);
        const b = data?.balances;

        lines.push(`── ${acct.label} (${acct.accountId}) ──`);

        // Tradier returns equity=0 when no positions are open (it's position equity).
        // total_equity is the actual account value. total_cash is cash on hand.
        // Use total_equity as the primary indicator of account health.
        const totalEquity = b?.total_equity ?? b?.equity ?? '?';
        const totalCash = b?.total_cash ?? '?';

        // Cash accounts have cash.cash_available, margin accounts have margin.buying_power
        const buyingPower =
          b?.cash?.cash_available ?? b?.margin?.buying_power ?? b?.buying_power ?? '?';
        lines.push(`  Total Equity: $${totalEquity}`);
        lines.push(`  Total Cash: $${totalCash}`);
        lines.push(`  Buying Power: $${buyingPower}`);
        lines.push(`  Position Equity: $${b?.equity ?? 0} (open position value only — $0 when flat)`);
        lines.push(`  Market Value: $${b?.market_value ?? '?'}`);
        lines.push(`  Open P&L: $${b?.open_pl ?? '?'}`);
        lines.push(`  Close P&L: $${b?.close_pl ?? '?'}`);
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error fetching balances: ${e.message}`);
    }
  },
};

// ── Tool 4: get_quotes ──────────────────────────────────────────────────────

const getQuotesTool = {
  name: 'get_quotes',
  label: 'Get Option Quotes',
  description:
    'Fetch real-time quotes from Tradier for specific option symbols. ' +
    'Returns last price, bid, ask, volume, and open interest.',
  parameters: Type.Object({
    symbols: Type.String({
      description:
        'Comma-separated option symbols, e.g. "XSP260330P00632000,SPXW260330C06650000"',
    }),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    try {
      const { data } = await tradierGet(
        '/markets/quotes',
        { symbols: params.symbols, greeks: 'false' },
        5000,
      );
      const quotes = normalizeArray(data?.quotes?.quote);

      if (quotes.length === 0) return textResult('No quotes returned.');

      const lines = quotes.map(
        (q: any) =>
          `${q.symbol}: last=$${q.last ?? '-'} bid=$${q.bid ?? '-'} ask=$${q.ask ?? '-'} vol=${q.volume ?? 0} OI=${q.open_interest ?? 0}`,
      );
      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error fetching quotes: ${e.message}`);
    }
  },
};

// ── Tool 5: get_market_snapshot ─────────────────────────────────────────────

const getMarketSnapshotTool = {
  name: 'get_market_snapshot',
  label: 'Get SPX Market Snapshot',
  description:
    'Fetch the latest SPX snapshot from the data pipeline (localhost:3600). ' +
    'Returns price, HMA cross direction (bullish/bearish), RSI, EMA, MACD, Bollinger Bands, ATR, and VWAP.',
  parameters: Type.Object({}),
  execute: async (): Promise<ToolResult> => {
    try {
      const { data } = await axios.get('http://localhost:3600/spx/snapshot', { timeout: 5000 });
      const ind = data.indicators || {};

      const hmaCross =
        (ind.hma3 ?? 0) > (ind.hma17 ?? 0) ? 'BULLISH' : 'BEARISH';

      const fmt = (v: number | undefined, d = 2) =>
        v != null ? v.toFixed(d) : '?';

      const lines = [
        `SPX: ${data.close} (O:${data.open} H:${data.high} L:${data.low})`,
        `HMA(3): ${fmt(ind.hma3)} | HMA(17): ${fmt(ind.hma17)} | Cross: ${hmaCross}`,
        `RSI(14): ${fmt(ind.rsi14, 1)}`,
        `EMA(9): ${fmt(ind.ema9)} | EMA(21): ${fmt(ind.ema21)} | EMA(50): ${fmt(ind.ema50)} | EMA(200): ${fmt(ind.ema200)}`,
        `MACD: ${fmt(ind.macd, 3)} | Signal: ${fmt(ind.macdSignal, 3)} | Hist: ${fmt(ind.macdHistogram, 3)}`,
        `BB: Upper=${fmt(ind.bbUpper)} Mid=${fmt(ind.bbMiddle)} Lower=${fmt(ind.bbLower)} Width=${fmt(ind.bbWidth, 4)}`,
        `ADX: ${fmt(ind.adx14, 1)} | StochK: ${fmt(ind.stochK, 1)} | CCI: ${fmt(ind.cci20, 1)}`,
        `ATR: ${fmt(ind.atr14)} (${fmt(ind.atrPct, 3)}%) | VWAP: ${fmt(ind.vwap)}`,
        `Momentum(10): ${fmt(ind.momentum10)}`,
      ];
      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error fetching SPX snapshot: ${e.message}`);
    }
  },
};

// ── Tool 6: get_agent_status ────────────────────────────────────────────────

const getAgentStatusTool = {
  name: 'get_agent_status',
  label: 'Get Agent Status',
  description:
    'Read the current status of one or both trading agents. Shows cycle count, positions, P&L, last action, reasoning, ' +
    'and file freshness. Warns if the status file is stale (not updated in >2 minutes). ' +
    'Also shows PM2 process state (online/stopped/errored) and restart count.',
  parameters: Type.Object({
    agent: Type.Optional(
      Type.String({ description: 'Which agent: "spx", "xsp", or "both" (default)' }),
    ),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    try {
      const keys = resolveAccounts(params?.agent);
      const lines: string[] = [];
      const now = Date.now();

      // Get PM2 process info via pm2 jlist
      let pm2Processes: any[] = [];
      try {
        const { execSync } = await import('child_process');
        const pm2Raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
        pm2Processes = JSON.parse(pm2Raw);
      } catch {
        // pm2 not available or failed
      }

      for (const key of keys) {
        const acct = ACCOUNTS[key];
        lines.push(`── ${acct.label} Agent (${acct.agentProcess}) ──`);

        // PM2 process status
        const pm2Proc = pm2Processes.find((p: any) => p.name === acct.agentProcess);
        if (pm2Proc) {
          const uptime = pm2Proc.pm2_env?.pm_uptime
            ? Math.round((now - pm2Proc.pm2_env.pm_uptime) / 1000)
            : '?';
          lines.push(
            `  PM2: ${pm2Proc.pm2_env?.status ?? 'unknown'} | PID: ${pm2Proc.pid} | Restarts: ${pm2Proc.pm2_env?.restart_time ?? '?'} | Uptime: ${uptime}s | Memory: ${Math.round((pm2Proc.monit?.memory ?? 0) / 1024 / 1024)}MB`,
          );
        } else {
          lines.push(`  PM2: ⚠ Process "${acct.agentProcess}" not found in PM2`);
        }

        // Status file
        try {
          const stat = fs.statSync(acct.statusFile);
          const ageMs = now - stat.mtimeMs;
          const ageSec = Math.round(ageMs / 1000);
          const staleWarning = ageMs > STALE_THRESHOLD_MS ? ` ⚠ STALE (${ageSec}s old)` : '';

          const raw = fs.readFileSync(acct.statusFile, 'utf-8');
          const status = JSON.parse(raw);

          lines.push(`  Status file: updated ${ageSec}s ago${staleWarning}`);
          lines.push(`  Cycle: ${status.cycle ?? '?'} | Positions: ${status.openPositions ?? '?'} | Daily P&L: $${status.dailyPnL ?? '?'}`);
          lines.push(`  Last action: ${status.lastAction ?? '?'}`);

          const reasoning = status.lastReasoning || status.reasoning;
          if (reasoning) {
            lines.push(`  Reasoning: ${String(reasoning).slice(0, 200)}`);
          }
        } catch (e: any) {
          lines.push(`  Status file: ⚠ ${e.code === 'ENOENT' ? 'Not found' : e.message}`);
        }

        // Activity file freshness
        try {
          const stat = fs.statSync(acct.activityFile);
          const ageMs = now - stat.mtimeMs;
          const ageSec = Math.round(ageMs / 1000);
          const staleWarning = ageMs > STALE_THRESHOLD_MS ? ` ⚠ STALE` : '';
          lines.push(`  Activity log: updated ${ageSec}s ago${staleWarning}`);
        } catch {
          lines.push(`  Activity log: not found`);
        }
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error reading agent status: ${e.message}`);
    }
  },
};

// ── Tool 7: check_system_health ─────────────────────────────────────────────

const checkSystemHealthTool = {
  name: 'check_system_health',
  label: 'Check System Health',
  description:
    'Check system-level health: disk usage, PM2 process list (all SPXer processes), ' +
    'database file size and WAL size, and data service health endpoint.',
  parameters: Type.Object({}),
  execute: async (): Promise<ToolResult> => {
    try {
      const { execSync } = await import('child_process');
      const lines: string[] = [];

      // Disk usage
      try {
        const df = execSync('df -h / | tail -1', { encoding: 'utf-8', timeout: 3000 }).trim();
        const parts = df.split(/\s+/);
        // parts: [filesystem, size, used, avail, use%, mountpoint]
        lines.push(`── Disk ──`);
        lines.push(`  Size: ${parts[1]} | Used: ${parts[2]} | Avail: ${parts[3]} | Use%: ${parts[4]}`);
        const usePct = parseInt(parts[4]);
        if (usePct >= 90) lines.push(`  ⚠ CRITICAL: Disk ${usePct}% full!`);
        else if (usePct >= 80) lines.push(`  ⚠ WARNING: Disk ${usePct}% full`);
      } catch (e: any) {
        lines.push(`── Disk ── Error: ${e.message}`);
      }

      // Database files
      lines.push(`── Database ──`);
      const dbPath = 'data/spxer.db';
      try {
        const dbStat = fs.statSync(dbPath);
        lines.push(`  spxer.db: ${(dbStat.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
      } catch {
        lines.push(`  spxer.db: not found`);
      }
      try {
        const walStat = fs.statSync(`${dbPath}-wal`);
        lines.push(`  WAL: ${(walStat.size / 1024 / 1024).toFixed(1)} MB`);
      } catch {
        lines.push(`  WAL: not present`);
      }
      // Check for leftover backup files
      for (const backup of ['data/spxer.db.backup', 'data/spxer.db.pre-utc-fix']) {
        try {
          const stat = fs.statSync(backup);
          lines.push(`  ⚠ Backup exists: ${backup} (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB) — consider deleting`);
        } catch {
          // expected — no backup
        }
      }

      // PM2 processes
      lines.push(`── PM2 Processes ──`);
      try {
        const pm2Raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
        const procs = JSON.parse(pm2Raw);
        const spxerProcs = procs.filter(
          (p: any) =>
            p.name?.startsWith('spxer') ||
            p.name?.includes('monitor') ||
            p.name === 'litellm' ||
            p.name === 'replay-viewer',
        );
        if (spxerProcs.length === 0) {
          lines.push(`  No SPXer-related PM2 processes found`);
        } else {
          for (const p of spxerProcs) {
            const status = p.pm2_env?.status ?? 'unknown';
            const mem = Math.round((p.monit?.memory ?? 0) / 1024 / 1024);
            const cpu = p.monit?.cpu ?? 0;
            const restarts = p.pm2_env?.restart_time ?? 0;
            const icon = status === 'online' ? '✓' : '✗';
            lines.push(`  ${icon} ${p.name}: ${status} | ${mem}MB | CPU ${cpu}% | restarts: ${restarts}`);
          }
        }
      } catch {
        lines.push(`  PM2 not available`);
      }

      // Data service health
      lines.push(`── Data Service ──`);
      try {
        const { data } = await axios.get('http://localhost:3600/health', { timeout: 3000 });
        lines.push(`  Status: ${data.status ?? 'unknown'} | Uptime: ${data.uptime ?? '?'} | Mode: ${data.mode ?? '?'}`);
        if (data.spxPrice) lines.push(`  SPX: $${data.spxPrice}`);
        if (data.dbSize) lines.push(`  DB reported size: ${data.dbSize}`);
      } catch {
        lines.push(`  ✗ Data service not responding on port 3600`);
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error checking system health: ${e.message}`);
    }
  },
};

// ── Tool 8: log_observation ─────────────────────────────────────────────────

const logObservationTool = {
  name: 'log_observation',
  label: 'Log Monitor Observation',
  description:
    'Write a timestamped observation to the unified monitor log file (logs/account-monitor.log). ' +
    'Use severity "info" for routine updates, "warn" for concerning conditions, "alert" for urgent issues needing human attention.',
  parameters: Type.Object({
    message: Type.String({ description: 'The observation or alert to log' }),
    severity: Type.Optional(
      Type.String({ description: 'Severity: info, warn, alert. Default: info' }),
    ),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    const severity = ((params?.severity as string) || 'info').toUpperCase();
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${severity}] ${params.message}\n`;

    try {
      fs.mkdirSync('logs', { recursive: true });
      fs.appendFileSync(MONITOR_LOG_FILE, entry);
      console.log(`[monitor] [${severity}] ${params.message}`);
      return textResult(`Logged: [${severity}] ${params.message}`);
    } catch (e: any) {
      // If disk is full, still try to output to console
      console.error(`[monitor] FAILED TO WRITE LOG: ${e.message}`);
      console.log(`[monitor] [${severity}] ${params.message}`);
      return textResult(`⚠ Log write failed (${e.message}), printed to console: [${severity}] ${params.message}`);
    }
  },
};

// ── Tool 9: cancel_order ─────────────────────────────────────────────────────

const cancelOrderTool = {
  name: 'cancel_order',
  label: 'Cancel Order',
  description:
    'Cancel a specific open/pending order by ID. Use to clean up stuck orders, ' +
    'orphaned bracket legs, or stale orders that should not be active. ' +
    'Provide the account and order ID.',
  parameters: Type.Object({
    account: Type.String({ description: 'Which account: "spx" or "xsp"' }),
    order_id: Type.String({ description: 'The Tradier order ID to cancel' }),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    const blocked = maintenanceGuard('cancel_order');
    if (blocked) return blocked;

    try {
      const key = params.account as AccountKey;
      const acct = ACCOUNTS[key];
      if (!acct) return textResult(`Unknown account: ${params.account}`);

      await axios.delete(
        `${TRADIER_BASE}/accounts/${acct.accountId}/orders/${params.order_id}`,
        { headers: tradierHeaders(), timeout: 10000 },
      );
      const msg = `Cancelled order #${params.order_id} on ${acct.label}`;
      console.log(`[monitor] 🗑️ ${msg}`);
      return textResult(msg);
    } catch (e: any) {
      const err = e?.response?.data?.errors?.error || e.message;
      return textResult(`Failed to cancel order #${params.order_id}: ${err}`);
    }
  },
};

// ── Tool 10: cancel_all_orders ──────────────────────────────────────────────

const cancelAllOrdersTool = {
  name: 'cancel_all_orders',
  label: 'Cancel All Open Orders',
  description:
    'Cancel ALL open/pending orders on an account. Use for emergency cleanup — ' +
    'e.g., agent in a rejection loop, orphaned bracket legs piling up, ' +
    'or pre-open cleanup of stale orders.',
  parameters: Type.Object({
    account: Type.String({ description: 'Which account: "spx", "xsp", or "both"' }),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    const blocked = maintenanceGuard('cancel_all_orders');
    if (blocked) return blocked;

    try {
      const keys = params.account === 'both' ? ['spx', 'xsp'] as AccountKey[]
        : [params.account as AccountKey];
      const lines: string[] = [];

      for (const key of keys) {
        const acct = ACCOUNTS[key];
        if (!acct) { lines.push(`Unknown account: ${key}`); continue; }

        const { data } = await axios.get(
          `${TRADIER_BASE}/accounts/${acct.accountId}/orders`,
          { headers: tradierHeaders(), timeout: 10000 },
        );
        const raw = data?.orders?.order;
        const orders = normalizeArray(raw);
        let cancelled = 0;

        for (const order of orders) {
          if (order.status !== 'open' && order.status !== 'pending' && order.status !== 'partially_filled') continue;
          try {
            await axios.delete(
              `${TRADIER_BASE}/accounts/${acct.accountId}/orders/${order.id}`,
              { headers: tradierHeaders(), timeout: 10000 },
            );
            cancelled++;
          } catch {
            // some may already be cancelled/filled
          }
        }
        lines.push(`${acct.label}: cancelled ${cancelled} order(s)`);
        console.log(`[monitor] 🗑️ Cancelled ${cancelled} orders on ${acct.label}`);
      }

      return textResult(lines.join('\n'));
    } catch (e: any) {
      return textResult(`Error cancelling orders: ${e.message}`);
    }
  },
};

// ── Tool 11: close_position ─────────────────────────────────────────────────

const closePositionTool = {
  name: 'close_position',
  label: 'Close Position (Emergency)',
  description:
    'Emergency close a position by submitting a market sell_to_close order. ' +
    'Use when an agent is frozen/crashed but has open positions at the broker that need to be closed ' +
    'to prevent expiration losses or margin violations. ' +
    'Provide the account, option symbol, and quantity.',
  parameters: Type.Object({
    account: Type.String({ description: 'Which account: "spx" or "xsp"' }),
    option_symbol: Type.String({ description: 'The option symbol to close, e.g. "SPXW260331C06420000"' }),
    quantity: Type.Number({ description: 'Number of contracts to sell' }),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    const blocked = maintenanceGuard('close_position');
    if (blocked) return blocked;

    try {
      const key = params.account as AccountKey;
      const acct = ACCOUNTS[key];
      if (!acct) return textResult(`Unknown account: ${params.account}`);

      const rootSymbol = key === 'xsp' ? 'XSP' : 'SPX';
      const body = new URLSearchParams({
        class: 'option',
        symbol: rootSymbol,
        option_symbol: params.option_symbol,
        side: 'sell_to_close',
        quantity: String(params.quantity),
        type: 'market',
        duration: 'day',
      }).toString();

      const { data } = await axios.post(
        `${TRADIER_BASE}/accounts/${acct.accountId}/orders`,
        body,
        { headers: { ...tradierHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
      );
      const orderId = data?.order?.id;
      const msg = `EMERGENCY CLOSE: sold ${params.quantity}x ${params.option_symbol} on ${acct.label} — order #${orderId}`;
      console.log(`[monitor] 🚨 ${msg}`);
      recordRemediationAction('close_position', `${params.account}:${params.option_symbol}`, msg);
      return textResult(msg);
    } catch (e: any) {
      const err = e?.response?.data?.errors?.error || e.message;
      return textResult(`Failed to close position: ${err}`);
    }
  },
};

// ── Tool 12: stop_agent ─────────────────────────────────────────────────────

const stopAgentTool = {
  name: 'stop_agent',
  label: 'Stop Trading Agent',
  description:
    'Stop a trading agent via PM2. Use when an agent is in a rejection loop, ' +
    'trading on expired contracts, account is insolvent, or agent is causing damage. ' +
    'The agent will NOT auto-restart after being stopped this way.',
  parameters: Type.Object({
    agent: Type.String({ description: 'Which agent: "spx" or "xsp"' }),
    reason: Type.String({ description: 'Why the agent is being stopped — logged for audit' }),
  }),
  execute: async (_id: string, params: any): Promise<ToolResult> => {
    const blocked = maintenanceGuard('stop_agent');
    if (blocked) return blocked;

    try {
      const key = params.agent as AccountKey;
      const acct = ACCOUNTS[key];
      if (!acct) return textResult(`Unknown agent: ${params.agent}`);

      const { execSync } = await import('child_process');

      // Stop the agent process
      execSync(`pm2 stop ${acct.agentProcess} 2>/dev/null`, { encoding: 'utf-8', timeout: 10000 });

      const msg = `STOPPED ${acct.agentProcess}: ${params.reason}`;
      console.log(`[monitor] 🛑 ${msg}`);
      recordRemediationAction('stop_agent', params.agent, params.reason);

      // Log to monitor file
      fs.mkdirSync('logs', { recursive: true });
      fs.appendFileSync(MONITOR_LOG_FILE, `[${new Date().toISOString()}] [ACTION] ${msg}\n`);

      return textResult(msg);
    } catch (e: any) {
      return textResult(`Failed to stop agent: ${e.message}`);
    }
  },
};

// ── Export all tools ────────────────────────────────────────────────────────

/** All 12 monitor tools */
export const MONITOR_TOOLS = [
  // Read-only observation (tools 1-8)
  getPositionsTool,
  getOrdersTool,
  getBalanceTool,
  getQuotesTool,
  getMarketSnapshotTool,
  getAgentStatusTool,
  checkSystemHealthTool,
  logObservationTool,
  // Remediation actions (tools 9-12)
  cancelOrderTool,
  cancelAllOrdersTool,
  closePositionTool,
  stopAgentTool,
];
