/**
 * XSP Position & Order Monitor Agent — Pi SDK
 *
 * LLM-powered oversight agent using the pi agent SDK.
 * Has tools to query Tradier API and SPXer data service directly.
 * Can read logs, check positions, analyze orders, and flag issues.
 *
 * Runs alongside spxer-xsp — does NOT trade, only monitors and reports.
 *
 * Usage:
 *   npx tsx agent-xsp-monitor.ts
 */
import * as dotenv from 'dotenv';
dotenv.config();

import { Type } from '@sinclair/typebox';
// Dynamic import to bypass ESM exports resolution in CJS tsx environment
let AuthStorage: any, createAgentSession: any, createExtensionRuntime: any;
let createReadTool: any, createBashTool: any;
let ModelRegistry: any, SessionManager: any, SettingsManager: any;
type ResourceLoader = any;
type ToolDefinition = any;

async function loadPiAgent() {
  const piAgent = await import('/home/ubuntu/SPXer/node_modules/@mariozechner/pi-coding-agent/dist/index.js');
  AuthStorage = piAgent.AuthStorage;
  createAgentSession = piAgent.createAgentSession;
  createExtensionRuntime = piAgent.createExtensionRuntime;
  createReadTool = piAgent.createReadTool;
  createBashTool = piAgent.createBashTool;
  ModelRegistry = piAgent.ModelRegistry;
  SessionManager = piAgent.SessionManager;
  SettingsManager = piAgent.SettingsManager;
}
import axios from 'axios';
import * as fs from 'fs';

// Inline config to avoid CJS/ESM cycle with src/config
const TRADIER_BASE = 'https://api.tradier.com/v1';
const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';

// ── Config ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = '6YA58635';
const MONITOR_INTERVAL_SEC = 30;
const LOG_FILE = 'logs/xsp-monitor.log';
const CWD = process.cwd();

const TRADIER_HEADERS = {
  Authorization: `Bearer ${TRADIER_TOKEN}`,
  Accept: 'application/json',
};

// ── Custom Tools ────────────────────────────────────────────────────────────

const getPositionsTool: ToolDefinition = {
  name: 'get_positions',
  label: 'Get Broker Positions',
  description: 'Fetch all open positions from Tradier broker for the XSP cash account. Returns symbol, quantity, cost basis, and date acquired.',
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${ACCOUNT_ID}/positions`,
        { headers: TRADIER_HEADERS, timeout: 10000 },
      );
      const raw = data?.positions?.position;
      const positions = Array.isArray(raw) ? raw : raw ? [raw] : [];
      if (positions.length === 0) return { content: [{ type: 'text', text: 'No open positions.' }], details: {} };

      const lines = positions.map((p: any) => {
        const entry = Math.abs(p.cost_basis) / (Math.abs(p.quantity) * 100);
        return `${p.symbol} x${p.quantity} | entry=$${entry.toFixed(2)} | cost_basis=$${p.cost_basis} | acquired=${p.date_acquired}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const getOrdersTool: ToolDefinition = {
  name: 'get_orders',
  label: 'Get Recent Orders',
  description: "Fetch today's orders from Tradier broker. Shows order ID, status (filled/rejected/open/pending/canceled), class (option/otoco/oco), side, symbol, fill price, and any legs. Use this to check for rejected orders, stuck brackets, or execution issues.",
  parameters: Type.Object({
    status_filter: Type.Optional(Type.String({ description: 'Filter by status: all, open, filled, rejected, pending, canceled. Default: all' })),
  }),
  execute: async (_id, params) => {
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${ACCOUNT_ID}/orders`,
        { headers: TRADIER_HEADERS, timeout: 10000 },
      );
      const raw = data?.orders?.order;
      const orders = Array.isArray(raw) ? raw : raw ? [raw] : [];

      const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      let filtered = orders.filter((o: any) => o.create_date?.startsWith(todayET));

      const statusFilter = (params as any)?.status_filter;
      if (statusFilter && statusFilter !== 'all') {
        filtered = filtered.filter((o: any) => o.status === statusFilter);
      }

      if (filtered.length === 0) return { content: [{ type: 'text', text: 'No matching orders today.' }], details: {} };

      const lines = filtered.map((o: any) => {
        const legs = Array.isArray(o.leg) ? o.leg : o.leg ? [o.leg] : [];
        const sym = o.option_symbol || legs[0]?.option_symbol || '';
        const side = o.side || legs[0]?.side || '';
        let line = `#${o.id} ${o.status} ${o.class} ${side} ${sym} qty=${o.quantity || legs[0]?.quantity || ''} fill=$${o.avg_fill_price ?? '-'}`;
        if (o.reason_description) line += ` REASON: ${o.reason_description}`;
        for (const l of legs) {
          line += `\n  leg #${l.id} ${l.status} ${l.type} ${l.side} ${l.option_symbol} price=${l.price ?? l.stop ?? '-'} fill=$${l.avg_fill_price ?? '-'}`;
        }
        return line;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const getQuotesTool: ToolDefinition = {
  name: 'get_quotes',
  label: 'Get Option Quotes',
  description: 'Fetch real-time quotes from Tradier for specific option symbols. Returns last, bid, ask, volume, open interest.',
  parameters: Type.Object({
    symbols: Type.String({ description: 'Comma-separated option symbols, e.g. "XSP260330P00632000,XSP260330C00633000"' }),
  }),
  execute: async (_id, params) => {
    try {
      const { data } = await axios.get(`${TRADIER_BASE}/markets/quotes`, {
        headers: TRADIER_HEADERS,
        params: { symbols: (params as any).symbols, greeks: 'false' },
        timeout: 5000,
      });
      const raw = data?.quotes?.quote;
      const quotes = Array.isArray(raw) ? raw : raw ? [raw] : [];

      if (quotes.length === 0) return { content: [{ type: 'text', text: 'No quotes returned.' }], details: {} };

      const lines = quotes.map((q: any) =>
        `${q.symbol}: last=$${q.last ?? '-'} bid=$${q.bid ?? '-'} ask=$${q.ask ?? '-'} vol=${q.volume ?? 0} OI=${q.open_interest ?? 0}`
      );
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const getBalanceTool: ToolDefinition = {
  name: 'get_balance',
  label: 'Get Account Balance',
  description: 'Fetch account balance from Tradier. Returns equity, buying power, and cash available.',
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const { data } = await axios.get(
        `${TRADIER_BASE}/accounts/${ACCOUNT_ID}/balances`,
        { headers: TRADIER_HEADERS, timeout: 5000 },
      );
      const b = data?.balances;
      const lines = [
        `Equity: $${b?.equity ?? b?.total_equity ?? '?'}`,
        `Buying Power: $${b?.cash?.cash_available ?? b?.buying_power ?? '?'}`,
        `Market Value: $${b?.market_value ?? '?'}`,
        `Open P&L: $${b?.open_pl ?? '?'}`,
        `Close P&L: $${b?.close_pl ?? '?'}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const getSpxSnapshotTool: ToolDefinition = {
  name: 'get_spx_snapshot',
  label: 'Get SPX Market Snapshot',
  description: 'Fetch the latest SPX snapshot from the data pipeline (localhost:3600). Returns price, indicators (HMA, RSI, EMA, MACD, Bollinger Bands, Keltner, ADX, etc.), and bar data.',
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const { data } = await axios.get('http://localhost:3600/spx/snapshot', { timeout: 5000 });
      const ind = data.indicators || {};
      const lines = [
        `SPX: ${data.close} (O:${data.open} H:${data.high} L:${data.low})`,
        `HMA(3): ${ind.hma3?.toFixed(2)} | HMA(17): ${ind.hma17?.toFixed(2)} | Cross: ${(ind.hma3 ?? 0) > (ind.hma17 ?? 0) ? 'BULLISH' : 'BEARISH'}`,
        `RSI(14): ${ind.rsi14?.toFixed(1)}`,
        `EMA(9): ${ind.ema9?.toFixed(2)} | EMA(21): ${ind.ema21?.toFixed(2)} | EMA(50): ${ind.ema50?.toFixed(2)} | EMA(200): ${ind.ema200?.toFixed(2)}`,
        `MACD: ${ind.macd?.toFixed(3)} | Signal: ${ind.macdSignal?.toFixed(3)} | Hist: ${ind.macdHistogram?.toFixed(3)}`,
        `BB: Upper=${ind.bbUpper?.toFixed(2)} Mid=${ind.bbMiddle?.toFixed(2)} Lower=${ind.bbLower?.toFixed(2)} Width=${ind.bbWidth?.toFixed(4)}`,
        `KC: Upper=${ind.kcUpper?.toFixed(2)} Mid=${ind.kcMiddle?.toFixed(2)} Lower=${ind.kcLower?.toFixed(2)} Slope=${ind.kcSlope?.toFixed(3)}`,
        `ADX: ${ind.adx14?.toFixed(1)} | StochK: ${ind.stochK?.toFixed(1)} | CCI: ${ind.cci20?.toFixed(1)}`,
        `ATR: ${ind.atr14?.toFixed(2)} (${ind.atrPct?.toFixed(3)}%) | VWAP: ${ind.vwap?.toFixed(2)}`,
        `Momentum(10): ${ind.momentum10?.toFixed(2)}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const getAgentStatusTool: ToolDefinition = {
  name: 'get_agent_status',
  label: 'Get XSP Agent Status',
  description: 'Read the current status of the spxer-xsp trading agent. Shows cycle count, positions, P&L, last action, and reasoning.',
  parameters: Type.Object({}),
  execute: async () => {
    try {
      const raw = fs.readFileSync('logs/agent-status.json', 'utf-8');
      return { content: [{ type: 'text', text: raw }], details: {} };
    } catch (e: any) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], details: {} };
    }
  },
};

const logObservationTool: ToolDefinition = {
  name: 'log_observation',
  label: 'Log Monitor Observation',
  description: 'Write a timestamped observation to the monitor log file. Use this for important findings, alerts, or periodic summaries.',
  parameters: Type.Object({
    message: Type.String({ description: 'The observation or alert to log' }),
    severity: Type.Optional(Type.String({ description: 'Severity: info, warn, alert. Default: info' })),
  }),
  execute: async (_id, params) => {
    const p = params as any;
    const severity = (p.severity || 'info').toUpperCase();
    const ts = new Date().toISOString();
    const entry = `[${ts}] [${severity}] ${p.message}\n`;
    fs.mkdirSync('logs', { recursive: true });
    fs.appendFileSync(LOG_FILE, entry);
    console.log(`[monitor] [${severity}] ${p.message}`);
    return { content: [{ type: 'text', text: `Logged: [${severity}] ${p.message}` }], details: {} };
  },
};

// ── System Prompt ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an options trading monitor for a small XSP (Mini-SPX) cash account (${ACCOUNT_ID}).

You run every ${MONITOR_INTERVAL_SEC} seconds. Your job is to check the current state using your tools, then log a concise assessment.

## Workflow each cycle:
1. get_positions — see what's open at the broker
2. get_quotes — get real-time prices for open position symbols
3. get_orders (status_filter: "open") — check for pending/stuck bracket orders
4. get_orders (status_filter: "rejected") — check for any rejected orders
5. get_spx_snapshot — check underlying SPX indicators (HMA cross direction, RSI, trend)
6. get_balance — check account health
7. log_observation — write your assessment

## What to watch for:
- **Orphaned positions**: Broker shows positions the agent doesn't know about (e.g. bracket-opened positions that weren't tracked)
- **Rejected orders**: sell_to_close rejections mean bracket TP/SL legs are blocking. Flag immediately.
- **Position/signal mismatch**: If HMA says bearish but we hold calls (or vice versa), flag it
- **P&L drift**: Unrealized losses approaching stop levels
- **Time decay**: 0DTE options lose value fast. Flag positions approaching worthlessness
- **Bracket order status**: OTOCO legs that should have triggered but haven't
- **Buying power**: Cash account can get locked up

## Style:
- Be concise: 3-5 sentences for normal conditions
- Expand when there's a real issue
- Always log_observation with your assessment
- Use severity "alert" for anything requiring immediate human attention
- Use severity "warn" for concerning but not urgent issues
- Use severity "info" for routine status updates

## Context:
- The trading agent (spxer-xsp) uses HMA(3)×HMA(17) crosses on SPX to flip between calls and puts
- It opens 2 contracts per signal: 1 OTOCO bracket (test, with server-side TP/SL) and 1 plain market (agent-managed exits)
- XSP options are 1/10th SPX. Strikes: SPX 6340 = XSP 634
- Market closes at 4:00 PM ET. All 0DTE options expire worthless at close.
- This is a $1,200 cash account — every dollar matters

You have read and bash tools to check log files if needed. Agent logs are at:
- PM2 logs: /home/ubuntu/.pm2/logs/spxer-xsp-out.log
- Monitor log: logs/xsp-monitor.log
- Agent status: logs/agent-status.json
- Agent activity: logs/agent-activity.jsonl`;

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await loadPiAgent();

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     XSP Monitor Agent (Pi SDK)                         ║');
  console.log(`║     Account: ${ACCOUNT_ID} | Interval: ${MONITOR_INTERVAL_SEC}s                  ║`);
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  fs.mkdirSync('logs', { recursive: true });

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // Use Haiku 4.5 via Anthropic OAuth — fast, smart, native tool use
  const model = modelRegistry.find('anthropic', 'claude-haiku-4-5');
  if (!model) {
    console.error('[monitor] Model not found in registry. Available:');
    const available = await modelRegistry.getAvailable();
    available.forEach(m => console.error(`  ${m.provider}/${m.id}`));
    process.exit(1);
  }

  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => SYSTEM_PROMPT,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 2 },
  });

  const { session } = await createAgentSession({
    cwd: CWD,
    model,
    thinkingLevel: 'low',
    authStorage,
    modelRegistry,
    resourceLoader,
    tools: [createReadTool(CWD), createBashTool(CWD)],
    customTools: [
      getPositionsTool,
      getOrdersTool,
      getQuotesTool,
      getBalanceTool,
      getSpxSnapshotTool,
      getAgentStatusTool,
      logObservationTool,
    ],
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  });

  // Stream output to console
  session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === 'tool_execution_start') {
      console.log(`\n[tool] ${event.toolName}`);
    }
  });

  console.log('[monitor] Agent session created. Starting monitor loop...\n');

  let cycle = 0;
  while (true) {
    cycle++;
    const nowET = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`[monitor] Cycle #${cycle} — ${nowET} ET\n`);

    try {
      await session.prompt(
        `Monitor cycle #${cycle}. Current time: ${nowET} ET. Run your checks and log your assessment.`
      );
    } catch (e: any) {
      console.error(`[monitor] Cycle error: ${e.message}`);
    }

    console.log('\n');
    await new Promise(r => setTimeout(r, MONITOR_INTERVAL_SEC * 1000));
  }
}

process.on('SIGTERM', () => { console.log('\n[monitor] Shutting down'); process.exit(0); });
process.on('SIGINT', () => { console.log('\n[monitor] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[monitor] Fatal:', e); process.exit(1); });
