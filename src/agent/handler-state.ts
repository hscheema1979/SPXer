/**
 * Handler State — file-based IPC between event_handler_mvp.ts and admin API.
 *
 * The event handler runs as a separate process from the data service.
 * State is written to JSON/JSONL files in logs/ for the admin API to read.
 *
 * Files (in logs/):
 *   handler-state.json      — full state snapshot (configs, positions, PnL)
 *   handler-routing.jsonl   — rolling log of signal routing decisions
 *   handler-commands.jsonl  — commands from UI to handler (toggle mode, etc.)
 */

import * as fs from 'fs';
import * as path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const STATE_FILE = path.join(LOGS_DIR, 'handler-state.json');
const ROUTING_LOG = path.join(LOGS_DIR, 'handler-routing.jsonl');
const COMMANDS_FILE = path.join(LOGS_DIR, 'handler-commands.jsonl');
const MAX_ROUTING_LINES = 200;
const MAX_COMMAND_LINES = 100;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HandlerConfigState {
  id: string;
  name: string;
  hmaPair: string;
  enabled: boolean;
  paper: boolean;
  state: {
    dailyPnl: number;
    positionsOpen: number;
    tradesCompleted: number;
    sessionSignalCount: number;
    lastEntryTs: number | null;
    cooldownRemainingSec: number;
  };
  positions: Array<{
    id: string;
    symbol: string;
    side: string;
    strike: number;
    entryPrice: number;
    quantity: number;
    stopLoss: number;
    takeProfit: number | null;
    openedAt: number;
    basketMember?: string;
  }>;
}

export interface HandlerState {
  ts: number;
  running: boolean;
  accountId: string;
  agentTag: string;
  spxPrice: number;
  connected: boolean;
  subscriptions: string[];
  configs: Record<string, HandlerConfigState>;
  filterStats: {
    totalSignalsReceived: number;
    totalEntries: number;
    filterReasons: Record<string, number>;
  };
  channelStats: Record<string, number>;
  upSince: string;
}

export interface RoutingDecision {
  ts: number;
  timeET: string;
  signal: {
    symbol: string;
    strike: number;
    side: string;
    direction: string;
    hmaFastPeriod: number;
    hmaSlowPeriod: number;
    channel: string;
    price: number;
  };
  decisions: Array<{
    configId: string;
    action: 'entered' | 'skipped';
    reason?: string;
    details?: string;
  }>;
}

export type HandlerCommand =
  | { action: 'toggle_paper'; configId: string; paper: boolean }
  | { action: 'toggle_enabled'; configId: string; enabled: boolean }
  | { action: 'force_close'; configId: string }
  | { action: 'reload_config'; configId: string }
  | { action: 'shutdown' };

// ── State Writer ──────────────────────────────────────────────────────────────

let state: HandlerState | null = null;
let startTime = new Date().toISOString();

export function initHandlerState(opts: {
  paper: boolean;
  accountId: string;
  agentTag: string;
  configIds: string[];
}): void {
  startTime = new Date().toISOString();
  state = {
    ts: Date.now(),
    running: true,
    accountId: opts.accountId,
    agentTag: opts.agentTag,
    spxPrice: 0,
    connected: false,
    subscriptions: [],
    configs: {},
    filterStats: {
      totalSignalsReceived: 0,
      totalEntries: 0,
      filterReasons: {},
    },
    channelStats: {},
    upSince: startTime,
  };

  for (const id of opts.configIds) {
    state.configs[id] = {
      id,
      name: id,
      hmaPair: '',
      enabled: true,
      paper: opts.paper,
      state: {
        dailyPnl: 0,
        positionsOpen: 0,
        tradesCompleted: 0,
        sessionSignalCount: 0,
        lastEntryTs: null,
        cooldownRemainingSec: 0,
      },
      positions: [],
    };
  }

  flushState();
}

export function setConnected(connected: boolean): void {
  if (!state) return;
  state.connected = connected;
  state.ts = Date.now();
  setImmediate(() => flushState());
}

export function updateSpxPrice(price: number): void {
  if (!state) return;
  state.spxPrice = price;
}

export function setSubscriptions(channels: string[]): void {
  if (!state) return;
  state.subscriptions = channels;
  setImmediate(() => flushState());
}

export function registerConfig(configId: string, name: string, hmaPair: string): void {
  if (!state || !state.configs[configId]) return;
  state.configs[configId].name = name;
  state.configs[configId].hmaPair = hmaPair;
  setImmediate(() => flushState());
}

export function updateConfigState(
  configId: string,
  update: Partial<HandlerConfigState['state']> & {
    positions?: HandlerConfigState['positions'];
  },
): void {
  if (!state || !state.configs[configId]) return;
  const cfg = state.configs[configId];
  if (update.dailyPnl !== undefined) cfg.state.dailyPnl = update.dailyPnl;
  if (update.positionsOpen !== undefined) cfg.state.positionsOpen = update.positionsOpen;
  if (update.tradesCompleted !== undefined) cfg.state.tradesCompleted = update.tradesCompleted;
  if (update.sessionSignalCount !== undefined) cfg.state.sessionSignalCount = update.sessionSignalCount;
  if (update.lastEntryTs !== undefined) cfg.state.lastEntryTs = update.lastEntryTs;
  if (update.cooldownRemainingSec !== undefined) cfg.state.cooldownRemainingSec = update.cooldownRemainingSec;
  if (update.positions !== undefined) cfg.positions = update.positions;
  setImmediate(() => flushState());
}

export function recordRoutingDecision(decision: RoutingDecision): void {
  if (!state) return;

  state.filterStats.totalSignalsReceived++;
  const channel = decision.signal.channel;
  state.channelStats[channel] = (state.channelStats[channel] || 0) + 1;

  for (const d of decision.decisions) {
    if (d.action === 'entered') {
      state.filterStats.totalEntries++;
    } else if (d.reason) {
      state.filterStats.filterReasons[d.reason] =
        (state.filterStats.filterReasons[d.reason] || 0) + 1;
    }
  }

  state.ts = Date.now();
  appendRoutingLog(decision);
  flushState();
}

export function markStopped(): void {
  if (!state) return;
  state.running = false;
  state.connected = false;
  state.ts = Date.now();
  flushState();
}

// ── Command File (UI → Handler) ───────────────────────────────────────────────

export function writeCommand(cmd: HandlerCommand & { ts: number }): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(COMMANDS_FILE, JSON.stringify(cmd) + '\n');
  } catch (e) {
    console.error('[handler-state] Failed to write command:', (e as Error).message);
  }
}

export function readPendingCommands(): HandlerCommand[] {
  try {
    const content = fs.readFileSync(COMMANDS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return [];
    const cmds = lines.map(l => JSON.parse(l));
    fs.writeFileSync(COMMANDS_FILE, ''); // clear after reading
    return cmds;
  } catch {
    return [];
  }
}

// ── State Reader (used by admin API) ──────────────────────────────────────────

export function readHandlerState(): HandlerState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as HandlerState;
    if (Date.now() - parsed.ts > 60_000) {
      return { ...parsed, running: false, connected: false };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function readRoutingLog(n: number = 50): RoutingDecision[] {
  try {
    const content = fs.readFileSync(ROUTING_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────

function flushState(): void {
  if (!state) return;
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[handler-state] Failed to write state:', (e as Error).message);
  }
}

function appendRoutingLog(decision: RoutingDecision): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(ROUTING_LOG, JSON.stringify(decision) + '\n');

    const content = fs.readFileSync(ROUTING_LOG, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > MAX_ROUTING_LINES) {
      fs.writeFileSync(ROUTING_LOG, lines.slice(-MAX_ROUTING_LINES).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[handler-state] Failed to write routing log:', (e as Error).message);
  }
}
