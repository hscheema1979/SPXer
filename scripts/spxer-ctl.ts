#!/usr/bin/env npx tsx
/**
 * spxer-ctl — Unified CLI for SPXer trading system operations.
 *
 * Usage:  npx tsx scripts/spxer-ctl.ts <command> [args]
 *         ./scripts/spxer-ctl <command> [args]
 *
 * Run with no args or `help` for available commands.
 */

import { execSync, exec as execCb } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as dotenv from 'dotenv';

dotenv.config({ path: '/home/ubuntu/SPXer/.env' });

// ─── Paths ───────────────────────────────────────────────────────────────────

const ROOT = '/home/ubuntu/SPXer';
const DATA_DIR = path.join(ROOT, 'data');
const LOGS_DIR = path.join(ROOT, 'logs');
const PM2_LOGS = '/home/ubuntu/.pm2/logs';
const DB_PATH = path.join(DATA_DIR, 'spxer.db');
const WAL_PATH = DB_PATH + '-wal';
const MAINTENANCE_FILE = path.join(LOGS_DIR, 'agent-maintenance.json');
const STATUS_SPX = path.join(LOGS_DIR, 'agent-status-spx.json');
const ACTIVITY_LOG = path.join(LOGS_DIR, 'agent-activity.jsonl');
const AUDIT_LOG = path.join(LOGS_DIR, 'agent-audit.jsonl');
// account-monitor removed — was interfering with successful trades
const MONITOR_LOG = ''; // placeholder — account-monitor log no longer exists

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const ESC = '\x1b[';
const c = {
  reset:   `${ESC}0m`,
  bold:    `${ESC}1m`,
  dim:     `${ESC}2m`,
  red:     `${ESC}31m`,
  green:   `${ESC}32m`,
  yellow:  `${ESC}33m`,
  blue:    `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan:    `${ESC}36m`,
  white:   `${ESC}37m`,
  bgRed:   `${ESC}41m`,
  bgGreen: `${ESC}42m`,
  bgYellow:`${ESC}43m`,
};

function green(s: string)  { return `${c.green}${s}${c.reset}`; }
function red(s: string)    { return `${c.red}${s}${c.reset}`; }
function yellow(s: string) { return `${c.yellow}${s}${c.reset}`; }
function cyan(s: string)   { return `${c.cyan}${s}${c.reset}`; }
function dim(s: string)    { return `${c.dim}${s}${c.reset}`; }
function bold(s: string)   { return `${c.bold}${s}${c.reset}`; }
function magenta(s: string){ return `${c.magenta}${s}${c.reset}`; }

function statusColor(s: string): string {
  switch (s) {
    case 'online': return green(s);
    case 'stopped': case 'errored': return red(s);
    case 'launching': case 'stopping': return yellow(s);
    default: return dim(s);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function nowET(): { h: number; m: number; s: number; dateStr: string; timeStr: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map(p => [p.type, p.value])
  );
  const h = parseInt(parts.hour, 10);
  const m = parseInt(parts.minute, 10);
  const s = parseInt(parts.second, 10);
  return {
    h, m, s,
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    timeStr: `${parts.hour}:${parts.minute}:${parts.second} ET`,
  };
}

function marketMode(): string {
  const { h, m } = nowET();
  const day = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  if (day === 'Sat' || day === 'Sun') return 'closed';
  const mins = h * 60 + m;
  if (mins < 540) return 'overnight';       // before 9:00
  if (mins < 570) return 'pre-market';      // 9:00-9:30
  if (mins < 976) return 'RTH';             // 9:30-16:15 (975 = 16*60+15)
  if (mins < 1020) return 'post-close';     // 16:15-17:00
  return 'overnight';                        // after 17:00
}

function marketModeColor(mode: string): string {
  switch (mode) {
    case 'RTH': return green(mode);
    case 'pre-market': return yellow(mode);
    case 'post-close': return yellow(mode);
    case 'overnight': return dim(mode);
    case 'closed': return red(mode);
    default: return mode;
  }
}

function formatUptime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const days = Math.floor(hr / 24);
  return `${days}d ${hr % 24}h`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatMoney(n: number): string {
  const sign = n >= 0 ? '+' : '';
  const s = `${sign}$${Math.abs(n).toFixed(0)}`;
  return n >= 0 ? green(s) : red(s);
}

function padR(s: string, len: number): string {
  // Strip ANSI for length calculation
  const raw = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, len - raw.length));
}

function padL(s: string, len: number): string {
  const raw = s.replace(/\x1b\[[0-9;]*m/g, '');
  return ' '.repeat(Math.max(0, len - raw.length)) + s;
}

function readJSON(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function readJSONL(filePath: string, maxLines?: number): any[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const slice = maxLines ? lines.slice(-maxLines) : lines;
    return slice.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function tailFile(filePath: string, lines: number): string {
  try {
    return execSync(`tail -n ${lines} "${filePath}"`, { encoding: 'utf-8' });
  } catch { return ''; }
}

function fileSize(filePath: string): number {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function fileAge(filePath: string): number {
  try { return Date.now() - fs.statSync(filePath).mtimeMs; } catch { return Infinity; }
}

function httpGet(url: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${url}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function shell(cmd: string): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim(); }
  catch { return ''; }
}

function shellAsync(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    execCb(cmd, { encoding: 'utf-8', timeout: 15000 }, (err, stdout) => {
      resolve(err ? '' : (stdout || '').trim());
    });
  });
}

function sqlite(query: string): string {
  return shell(`sqlite3 "${DB_PATH}" "${query}"`);
}

// ─── Tradier API ──────────────────────────────────────────────────────────────

const TRADIER_TOKEN = process.env.TRADIER_TOKEN || '';
const TRADIER_BASE = 'https://api.tradier.com/v1';

const ACCOUNTS: Record<string, { id: string; label: string; type: string }> = {
  spx: { id: '6YA51425', label: 'SPX (Margin)', type: 'margin' },
};

function tradierGet(endpoint: string, timeoutMs = 8000): Promise<any> {
  if (!TRADIER_TOKEN) return Promise.reject(new Error('TRADIER_TOKEN not set'));
  const url = new URL(`${TRADIER_BASE}${endpoint}`);
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { Authorization: `Bearer ${TRADIER_TOKEN}`, Accept: 'application/json' },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${endpoint}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${endpoint}`)); });
  });
}

function resolveAccountId(hint?: string): { id: string; label: string } {
  if (!hint || hint === 'all') return { id: 'all', label: 'All Accounts' };
  const lower = hint.toLowerCase();
  if (ACCOUNTS[lower]) return { id: ACCOUNTS[lower].id, label: ACCOUNTS[lower].label };
  // Try direct account ID
  for (const [, acc] of Object.entries(ACCOUNTS)) {
    if (acc.id === hint) return { id: acc.id, label: acc.label };
  }
  // Default to SPX
  return { id: ACCOUNTS.spx.id, label: ACCOUNTS.spx.label };
}

function parseOptionSymbol(sym: string): { expiry: string; type: string; strike: number; prefix: string } | null {
  const m = sym.match(/^(SPXW?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, prefix, expiryCode, type, strikeCode] = m;
  return {
    prefix,
    expiry: `20${expiryCode.slice(0, 2)}-${expiryCode.slice(2, 4)}-${expiryCode.slice(4, 6)}`,
    type: type === 'C' ? 'Call' : 'Put',
    strike: parseInt(strikeCode) / 1000,
  };
}

function formatOptionSymbol(sym: string): string {
  const parsed = parseOptionSymbol(sym);
  if (!parsed) return sym;
  return `${parsed.prefix} ${parsed.expiry} ${parsed.strike} ${parsed.type}`;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = 'true';
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

interface PM2Proc {
  name: string;
  pm_id: number;
  status: string;
  uptime: number;
  memory: number;
  cpu: number;
  restarts: number;
}

function getPM2Procs(): PM2Proc[] {
  try {
    const raw = execSync('pm2 jlist', { encoding: 'utf-8', timeout: 10000 });
    const procs: any[] = JSON.parse(raw);
    return procs.map(p => ({
      name: p.name,
      pm_id: p.pm_id,
      status: p.pm2_env?.status || 'unknown',
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      restarts: p.pm2_env?.restart_time || 0,
    }));
  } catch { return []; }
}

function getSPXerProcs(): PM2Proc[] {
  const known = ['spxer', 'spxer-agent', 'spxer-dashboard', 'replay-viewer', 'schwaber'];
  return getPM2Procs().filter(p => known.includes(p.name));
}

// ─── Box drawing ─────────────────────────────────────────────────────────────

function hline(width: number, left = '├', right = '┤', fill = '─'): string {
  return left + fill.repeat(width - 2) + right;
}

function boxTop(width: number): string { return '┌' + '─'.repeat(width - 2) + '┐'; }
function boxBot(width: number): string { return '└' + '─'.repeat(width - 2) + '┘'; }
function boxRow(content: string, width: number): string {
  const raw = content.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, width - 4 - raw.length);
  return `│ ${content}${' '.repeat(pad)} │`;
}

function tableRow(cols: string[], widths: number[]): string {
  return '│ ' + cols.map((col, i) => padR(col, widths[i])).join(' │ ') + ' │';
}

function tableSep(widths: number[], left = '├', mid = '┼', right = '┤'): string {
  return left + widths.map(w => '─'.repeat(w + 2)).join(mid) + right;
}

function tableTop(widths: number[]): string {
  return '┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐';
}

function tableBot(widths: number[]): string {
  return '└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘';
}

// ─── Time formatting from audit/activity ─────────────────────────────────────

function tsToET(ts: number): string {
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
  return fmt.format(d).replace(',', '');
}

function tsToETFull(ts: number): string {
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return fmt.format(d).replace(',', '') + ' ET';
}

function staleness(sec: number): string {
  if (sec < 60) return green(`${sec}s`);
  if (sec < 300) return yellow(`${Math.floor(sec / 60)}m ${sec % 60}s`);
  return red(`${Math.floor(sec / 60)}m`);
}

// ─── PM2 target resolution ──────────────────────────────────────────────────

const TARGET_MAP: Record<string, string[]> = {
  'pipeline':   ['spxer'],
  'agent-spx':  ['spxer-agent'],
  'agent':      ['spxer-agent'],
  'agents':     ['spxer-agent'],
  'dashboard':  ['spxer-dashboard'],
  'viewer':     ['replay-viewer'],
  'schwaber':   ['schwaber'],
  'all':        ['spxer', 'spxer-agent', 'spxer-dashboard', 'replay-viewer', 'schwaber'],
};

function resolveTarget(target: string): string[] {
  return TARGET_MAP[target] || [target];
}

const LOG_MAP: Record<string, string> = {
  'spxer':     'spxer-out.log',
  'pipeline':  'spxer-out.log',
  'agent':     'spxer-agent-out.log',
  'agent-spx': 'spxer-agent-out.log',
  'spx':       'spxer-agent-out.log',
  'dashboard': 'dashboard-out.log',
  'viewer':    'replay-viewer-out.log',
  'schwaber':  'schwaber-out.log',
};

const ERROR_LOG_MAP: Record<string, string> = {
  'spxer':     'spxer-error.log',
  'pipeline':  'spxer-error.log',
  'agent':     'spxer-agent-error.log',
  'agent-spx': 'spxer-agent-error.log',
  'spx':       'spxer-agent-error.log',
  'dashboard': 'dashboard-error.log',
  'viewer':    'replay-viewer-error.log',
  'schwaber':  'schwaber-error.log',
};

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const et = nowET();
  const mode = marketMode();

  // Parallel fetches
  const [health, pipelineHealth, procs] = await Promise.all([
    httpGet('http://localhost:3600/health').catch(() => null),
    httpGet('http://localhost:3600/pipeline/health').catch(() => null),
    Promise.resolve(getSPXerProcs()),
  ]);

  const spxStatus = readJSON(STATUS_SPX);
  const maintenance = readJSON(MAINTENANCE_FILE);

  const W = 78;

  // ── Header ──
  console.log(boxTop(W));
  console.log(boxRow(`${bold('SPXer Control')}  ${dim(et.dateStr)}  ${cyan(et.timeStr)}  ${marketModeColor(mode)}`, W));
  if (maintenance?.active) {
    console.log(boxRow(`${red('MAINTENANCE')} ${maintenance.reason || ''} ${dim(`by ${maintenance.by || 'unknown'}`)}`, W));
  }
  console.log(hline(W, '├', '┤'));

  // ── PM2 Processes ──
  console.log(boxRow(bold('Processes'), W));
  const procWidths = [18, 8, 10, 8, 4, 3];
  console.log('│ ' + tableTop(procWidths).slice(1));
  console.log('│ ' + tableRow(
    [dim('Name'), dim('Status'), dim('Uptime'), dim('Memory'), dim('CPU'), dim('Rs')],
    procWidths
  ).slice(1));
  console.log('│ ' + tableSep(procWidths).slice(1));

  for (const p of procs) {
    console.log('│ ' + tableRow([
      p.name,
      statusColor(p.status),
      p.status === 'online' ? formatUptime(p.uptime) : dim('--'),
      p.status === 'online' ? formatBytes(p.memory) : dim('--'),
      p.status === 'online' ? `${p.cpu}%` : dim('--'),
      p.restarts > 0 ? yellow(String(p.restarts)) : dim('0'),
    ], procWidths).slice(1));
  }
  console.log('│ ' + tableBot(procWidths).slice(1));

  // ── Pipeline ──
  console.log(hline(W, '├', '┤'));
  if (health) {
    const spxPrice = health.lastSpxPrice || health.data?.SPX?.lastBarTs ? '' : '';
    const esData = health.data?.ES;
    const spxData = health.data?.SPX;
    const activePrice = health.lastSpxPrice || 0;
    const pMode = health.mode || 'unknown';

    // Count healthy providers
    const providers = health.providers || {};
    const provNames = Object.keys(providers);
    const healthyCount = provNames.filter(n => providers[n].healthy).length;

    console.log(boxRow(
      `${bold('Pipeline')}  mode: ${cyan(pMode)}  SPX: ${bold('$' + activePrice)}  ` +
      `providers: ${healthyCount === provNames.length ? green(`${healthyCount}/${provNames.length}`) : yellow(`${healthyCount}/${provNames.length}`)}  ` +
      `contracts: ${cyan(String(health.activeContracts || 0))}  WS: ${health.wsClients || 0}`,
      W
    ));

    if (pipelineHealth) {
      const bb = pipelineHealth.barBuilder || {};
      const ind = pipelineHealth.indicators || {};
      const db = pipelineHealth.db || {};
      const sig = pipelineHealth.signals || {};
      console.log(boxRow(
        `  bars: ${bb.barsBuilt || 0} built, ${bb.syntheticBars || 0} synthetic  ` +
        `indicators: ${ind.computed || 0} computed  ` +
        `db writes: ${db.writesSucceeded || 0}/${db.writesAttempted || 0}` +
        (db.writesFailed > 0 ? red(` (${db.writesFailed} failed)`) : ''),
        W
      ));
      if (sig.lastSignal) {
        console.log(boxRow(`  last signal: ${JSON.stringify(sig.lastSignal).slice(0, 65)}`, W));
      }
    }
  } else {
    console.log(boxRow(`${bold('Pipeline')}  ${red('UNREACHABLE')} — data service not responding on :3600`, W));
  }

  // ── Agents ──
  console.log(hline(W, '├', '┤'));
  console.log(boxRow(bold('Agents'), W));

  for (const [label, status] of [['SPX', spxStatus]] as const) {
    if (!status) {
      const age = fileAge(STATUS_SPX);
      if (age < 86400000) {
        console.log(boxRow(`  ${bold(label)}: ${dim('status file stale')} (${formatUptime(age)} ago)`, W));
      } else {
        console.log(boxRow(`  ${bold(label)}: ${dim('no status')}`, W));
      }
      continue;
    }
    const pnl = formatMoney(status.dailyPnL || 0);
    const paperTag = status.paper ? yellow(' [PAPER]') : '';
    const age = fileAge(STATUS_SPX);
    const fresh = age < 120000 ? '' : dim(` (${formatUptime(age)} ago)`);
    console.log(boxRow(
      `  ${bold(label)}${paperTag}: cycle ${status.cycle}  pos: ${status.openPositions}  ` +
      `P&L: ${pnl}  ${dim(status.lastAction || '')}${fresh}`,
      W
    ));
    if (status.lastReasoning) {
      const reason = status.lastReasoning.length > 65
        ? status.lastReasoning.slice(0, 62) + '...'
        : status.lastReasoning;
      console.log(boxRow(`    ${dim(reason)}`, W));
    }
  }

  // ── DB ──
  console.log(hline(W, '├', '┤'));
  const dbSize = fileSize(DB_PATH);
  const walSize = fileSize(WAL_PATH);
  const walWarn = walSize > 200 * 1024 * 1024 ? red(' [HIGH]') : '';
  console.log(boxRow(
    `${bold('Database')}  size: ${formatBytes(dbSize)}  WAL: ${formatBytes(walSize)}${walWarn}`,
    W
  ));

  // ── Recent Alerts ──
  const monitorLines = tailFile(MONITOR_LOG, 20);
  const alertLines = monitorLines.split('\n')
    .filter(l => l.includes('[ALERT]') || l.includes('[WARN]'))
    .slice(-3);
  if (alertLines.length > 0) {
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Recent Alerts'), W));
    for (const line of alertLines) {
      const truncated = line.length > 72 ? line.slice(0, 69) + '...' : line;
      const colored = truncated.includes('[ALERT]') ? red(truncated) : yellow(truncated);
      console.log(boxRow(`  ${colored}`, W));
    }
  }

  console.log(boxBot(W));
}

async function cmdPipeline() {
  const [health, pipelineHealth] = await Promise.all([
    httpGet('http://localhost:3600/health').catch(() => null),
    httpGet('http://localhost:3600/pipeline/health').catch(() => null),
  ]);

  if (!health && !pipelineHealth) {
    console.log(red('Data service not responding on :3600'));
    return;
  }

  const W = 78;
  console.log(boxTop(W));
  console.log(boxRow(bold('Pipeline Deep Dive'), W));
  console.log(hline(W, '├', '┤'));

  // Provider health
  if (health?.providers) {
    console.log(boxRow(bold('Providers'), W));
    const pw = [18, 7, 10, 8, 12];
    console.log('│ ' + tableTop(pw).slice(1));
    console.log('│ ' + tableRow(
      [dim('Provider'), dim('Status'), dim('Stale'), dim('Fails'), dim('Circuit')],
      pw
    ).slice(1));
    console.log('│ ' + tableSep(pw).slice(1));

    for (const [name, info] of Object.entries(health.providers) as [string, any][]) {
      const circuit = pipelineHealth?.circuitBreakers?.[name] ||
                      pipelineHealth?.providers?.[name]?.circuitState || 'unknown';
      console.log('│ ' + tableRow([
        name,
        info.healthy ? green('OK') : red('DOWN'),
        staleness(info.staleSec || 0),
        String(info.consecutiveFailures || 0),
        circuit === 'closed' ? green('closed') : red(circuit),
      ], pw).slice(1));
    }
    console.log('│ ' + tableBot(pw).slice(1));
  }

  // Bar builder
  if (pipelineHealth?.barBuilder) {
    const bb = pipelineHealth.barBuilder;
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Bar Builder'), W));
    console.log(boxRow(`  Bars built:      ${cyan(String(bb.barsBuilt || 0))}`, W));
    console.log(boxRow(`  Synthetic:       ${bb.syntheticBars || 0}`, W));
    console.log(boxRow(`  Interpolated:    ${bb.gapsInterpolated || 0}`, W));
    console.log(boxRow(`  Stale fills:     ${bb.gapsStale || 0}`, W));
    console.log(boxRow(`  Rejected:        ${bb.barsRejected > 0 ? red(String(bb.barsRejected)) : '0'}`, W));
  }

  // Indicators
  if (pipelineHealth?.indicators) {
    const ind = pipelineHealth.indicators;
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Indicators'), W));
    console.log(boxRow(`  Computed:        ${cyan(String(ind.computed || 0))}`, W));
    console.log(boxRow(`  NaN rejected:    ${ind.nanRejected > 0 ? red(String(ind.nanRejected)) : '0'}`, W));
    console.log(boxRow(`  Seeds completed: ${green(String(ind.seedsCompleted || 0))}`, W));
    console.log(boxRow(`  Seeds failed:    ${ind.seedsFailed > 0 ? red(String(ind.seedsFailed)) : '0'}`, W));
  }

  // DB writes
  if (pipelineHealth?.db) {
    const db = pipelineHealth.db;
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Database Writes'), W));
    console.log(boxRow(`  Attempted:       ${db.writesAttempted || 0}`, W));
    console.log(boxRow(`  Succeeded:       ${green(String(db.writesSucceeded || 0))}`, W));
    console.log(boxRow(`  Failed:          ${db.writesFailed > 0 ? red(String(db.writesFailed)) : '0'}`, W));
  }

  // Signals
  if (pipelineHealth?.signals) {
    const sig = pipelineHealth.signals;
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Signals'), W));
    console.log(boxRow(`  Detected:        ${sig.detected || 0}`, W));
    console.log(boxRow(`  Synthetic filt.: ${sig.syntheticFiltered || 0}`, W));
    if (sig.lastSignal) {
      console.log(boxRow(`  Last signal:     ${JSON.stringify(sig.lastSignal).slice(0, 55)}`, W));
    }
  }

  // Circuit breakers
  if (pipelineHealth?.circuitBreakers) {
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(bold('Circuit Breakers'), W));
    for (const [name, state] of Object.entries(pipelineHealth.circuitBreakers) as [string, string][]) {
      const colored = state === 'closed' ? green(state) : red(state);
      console.log(boxRow(`  ${padR(name, 18)} ${colored}`, W));
    }
  }

  // Mode / uptime
  console.log(hline(W, '├', '┤'));
  console.log(boxRow(
    `Mode: ${cyan(pipelineHealth?.currentMode || health?.mode || '?')}  ` +
    `Uptime: ${formatUptime((pipelineHealth?.uptimeSec || health?.uptimeSec || 0) * 1000)}  ` +
    `Contracts: ${health?.activeContracts || 0} active / ${health?.trackedContracts || 0} tracked`,
    W
  ));

  console.log(boxBot(W));
}

async function cmdAgents() {
  const W = 78;
  console.log(boxTop(W));
  console.log(boxRow(bold('Agent Deep Dive'), W));

  for (const [label, statusFile] of [['SPX', STATUS_SPX]] as const) {
    console.log(hline(W, '├', '┤'));
    const status = readJSON(statusFile);
    if (!status) {
      console.log(boxRow(`${bold(label)} Agent: ${dim('no status file')}`, W));
      continue;
    }

    const paperTag = status.paper ? yellow(' [PAPER]') : green(' [LIVE]');
    const age = fileAge(statusFile);
    const fresh = age < 120000 ? green('fresh') : red(`stale ${formatUptime(age)}`);

    console.log(boxRow(`${bold(label)} Agent${paperTag}  status: ${fresh}`, W));
    console.log(boxRow(`  Cycle:        ${status.cycle}`, W));
    console.log(boxRow(`  SPX Price:    $${status.spxPrice || '?'}`, W));
    console.log(boxRow(`  Mode:         ${status.mode || '?'}`, W));
    console.log(boxRow(`  Positions:    ${status.openPositions}`, W));
    console.log(boxRow(`  Daily P&L:    ${formatMoney(status.dailyPnL || 0)}`, W));
    console.log(boxRow(`  Mins to close: ${status.minutesToClose ?? '?'}`, W));
    console.log(boxRow(`  Contracts:    ${status.contractsTracked || 0} tracked, ${status.contractsWithBars || 0} with bars`, W));
    console.log(boxRow(`  Last action:  ${status.lastAction || '?'}`, W));
    if (status.lastReasoning) {
      const r = status.lastReasoning.length > 65 ? status.lastReasoning.slice(0, 62) + '...' : status.lastReasoning;
      console.log(boxRow(`  Reasoning:    ${dim(r)}`, W));
    }
    if (status.upSince) {
      console.log(boxRow(`  Up since:     ${tsToETFull(new Date(status.upSince).getTime())}`, W));
    }
  }

  // Recent activity
  console.log(hline(W, '├', '┤'));
  console.log(boxRow(bold('Recent Activity (last 10)'), W));
  const activity = readJSONL(ACTIVITY_LOG, 10);
  if (activity.length === 0) {
    console.log(boxRow(dim('  No activity entries'), W));
  } else {
    for (const entry of activity) {
      const time = entry.timeET || tsToET(entry.ts);
      const event = entry.event === 'close' ? magenta(entry.event) :
                    entry.event === 'entry' ? green(entry.event) :
                    entry.event === 'exit' ? yellow(entry.event) :
                    dim(entry.event || '?');
      const summary = (entry.summary || '').slice(0, 52);
      console.log(boxRow(`  ${dim(time)} ${padR(event, 8)} ${summary}`, W));
    }
  }

  // Maintenance status
  const maint = readJSON(MAINTENANCE_FILE);
  if (maint?.active) {
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(`${red('MAINTENANCE ACTIVE')}: ${maint.reason || 'no reason'}  by: ${maint.by || '?'}`, W));
  }

  console.log(boxBot(W));
}

async function cmdTrades(flags: Record<string, string>) {
  const entries = readJSONL(AUDIT_LOG);
  if (entries.length === 0) {
    console.log(dim('No audit log entries found.'));
    return;
  }

  // Filter
  const agentFilter = flags.agent;
  let filtered = entries;

  if (flags.today === 'true') {
    const today = nowET().dateStr;
    filtered = filtered.filter(e => {
      const d = new Date(e.ts);
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
      return `${parts.year}-${parts.month}-${parts.day}` === today;
    });
  }

  // Each audit entry has execution info
  if (filtered.length === 0) {
    console.log(dim('No trades found for the specified filter.'));
    return;
  }

  const W = 90;
  console.log(boxTop(W));
  console.log(boxRow(bold(`Trade History (${filtered.length} entries)`), W));
  console.log(hline(W, '├', '┤'));

  const tw = [11, 4, 25, 6, 6, 8, 10];
  console.log('│ ' + tableTop(tw).slice(1));
  console.log('│ ' + tableRow(
    [dim('Time'), dim('Side'), dim('Symbol'), dim('Entry'), dim('Exit'), dim('P&L'), dim('Reason')],
    tw
  ).slice(1));
  console.log('│ ' + tableSep(tw).slice(1));

  for (const entry of filtered.slice(-30)) {
    const time = entry.signal?.ts ? tsToET(entry.signal.ts) : tsToET(entry.ts);
    const side = entry.signal?.side || '?';
    const symbol = (entry.execution?.executedSymbol || entry.signal?.symbol || '?').slice(-16);
    const fillPrice = entry.execution?.fillPrice ? `$${entry.execution.fillPrice.toFixed(2)}` : '--';
    const sideColor = side === 'call' ? green(side) : side === 'put' ? red(side) : side;

    console.log('│ ' + tableRow([
      dim(time),
      sideColor,
      symbol,
      fillPrice,
      dim('--'),
      dim('--'),
      (entry.decision?.reasoning || '').slice(0, 10),
    ], tw).slice(1));
  }

  console.log('│ ' + tableBot(tw).slice(1));
  console.log(boxBot(W));
}

function cmdLogs(positional: string[], flags: Record<string, string>) {
  const process = positional[0] || 'pipeline';
  const lines = parseInt(flags.lines || '50', 10);

  if (process === 'all') {
    for (const [name, file] of Object.entries(LOG_MAP)) {
      if (['pipeline', 'agent-spx'].includes(name)) continue; // skip aliases
      const logPath = path.join(PM2_LOGS, file);
      if (!fs.existsSync(logPath)) continue;
      console.log(bold(`\n--- ${name} ---`));
      console.log(tailFile(logPath, Math.min(lines, 20)));
    }
    return;
  }

  const logFile = LOG_MAP[process];
  if (!logFile) {
    console.log(red(`Unknown process: ${process}`));
    console.log(dim(`Available: ${Object.keys(LOG_MAP).join(', ')}`));
    return;
  }

  const logPath = path.join(PM2_LOGS, logFile);
  if (!fs.existsSync(logPath)) {
    console.log(dim(`Log file not found: ${logPath}`));
    return;
  }

  console.log(bold(`${process} logs (last ${lines} lines)`));
  console.log(dim(logPath));
  console.log('');
  console.log(tailFile(logPath, lines));
}

function cmdErrors(flags: Record<string, string>) {
  const maxLines = parseInt(flags.lines || '20', 10);
  const sinceStr = flags.since || '1h';

  // Parse --since
  let sinceMs = 3600000; // 1h default
  const sinceMatch = sinceStr.match(/^(\d+)(m|h|d)$/);
  if (sinceMatch) {
    const val = parseInt(sinceMatch[1], 10);
    const unit = sinceMatch[2];
    sinceMs = val * (unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000);
  }
  const cutoff = Date.now() - sinceMs;

  const allErrors: { process: string; line: string; ts: number }[] = [];

  const errorFiles: Record<string, string> = {
    'spxer':     'spxer-error.log',
    'agent-spx': 'spxer-agent-error.log',
    'monitor':   'account-monitor-error.log',
    'dashboard': 'dashboard-error.log',
    'viewer':    'replay-viewer-error.log',
    'schwaber':  'schwaber-error.log',
  };

  for (const [proc, file] of Object.entries(errorFiles)) {
    const logPath = path.join(PM2_LOGS, file);
    const content = tailFile(logPath, 200);
    if (!content) continue;

    for (const line of content.split('\n').filter(Boolean)) {
      // Try to extract timestamp from PM2 log format: YYYY-MM-DD HH:mm:ss
      const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      let ts = Date.now(); // fallback
      if (tsMatch) {
        const parsed = new Date(tsMatch[1] + 'Z').getTime();
        if (!isNaN(parsed)) ts = parsed;
      }

      if (ts >= cutoff) {
        allErrors.push({ process: proc, line: line.trim(), ts });
      }
    }
  }

  // Sort by time, take most recent
  allErrors.sort((a, b) => a.ts - b.ts);
  const recent = allErrors.slice(-maxLines);

  if (recent.length === 0) {
    console.log(green(`No errors in the last ${sinceStr}`));
    return;
  }

  console.log(bold(`Errors in the last ${sinceStr} (${recent.length} of ${allErrors.length})`));
  console.log('');

  for (const err of recent) {
    const procColor = err.process === 'spxer' ? cyan : err.process.includes('agent') ? yellow : magenta;
    const truncated = err.line.length > 100 ? err.line.slice(0, 97) + '...' : err.line;
    console.log(`${procColor(`[${padR(err.process, 10)}]`)} ${truncated}`);
  }
}

function setMaintenance(active: boolean, reason?: string) {
  const data = {
    active,
    reason: reason || '',
    startedAt: active ? Date.now() : 0,
    startedAtUTC: active ? new Date().toISOString() : '',
    by: 'spxer-ctl',
  };
  fs.writeFileSync(MAINTENANCE_FILE, JSON.stringify(data, null, 2));
}

async function cmdRestart(positional: string[]) {
  const target = positional[0];
  if (!target) {
    console.log(red('Usage: spxer-ctl restart <target>'));
    console.log(dim('Targets: ' + Object.keys(TARGET_MAP).join(', ')));
    return;
  }

  const pm2Names = resolveTarget(target);
  const isAgent = pm2Names.some(n => n.includes('agent'));

  if (isAgent) {
    console.log(yellow('Setting maintenance mode...'));
    setMaintenance(true, `restarting ${target}`);
    await new Promise(r => setTimeout(r, 1000));
  }

  for (const name of pm2Names) {
    process.stdout.write(`Restarting ${cyan(name)}... `);
    try {
      execSync(`pm2 restart ${name}`, { timeout: 15000, stdio: 'pipe' });
      console.log(green('OK'));
    } catch (e: any) {
      // If not running, try start
      try {
        execSync(`pm2 start ecosystem.config.js --only ${name}`, {
          cwd: ROOT, timeout: 15000, stdio: 'pipe',
        });
        console.log(green('started'));
      } catch {
        console.log(red('FAILED'));
      }
    }
  }

  // Verify
  await new Promise(r => setTimeout(r, 3000));
  const procs = getSPXerProcs();
  for (const name of pm2Names) {
    const proc = procs.find(p => p.name === name);
    if (proc?.status === 'online') {
      console.log(`  ${name}: ${green('online')}`);
    } else {
      console.log(`  ${name}: ${red(proc?.status || 'not found')}`);
    }
  }

  if (isAgent) {
    console.log(yellow('Clearing maintenance mode...'));
    setMaintenance(false);
  }
}

async function cmdStop(positional: string[]) {
  const target = positional[0];
  if (!target) {
    console.log(red('Usage: spxer-ctl stop <target>'));
    console.log(dim('Targets: ' + Object.keys(TARGET_MAP).join(', ')));
    return;
  }

  const pm2Names = resolveTarget(target);
  const isAgent = pm2Names.some(n => n.includes('agent'));

  if (isAgent) {
    setMaintenance(true, `stopping ${target}`);
  }

  for (const name of pm2Names) {
    process.stdout.write(`Stopping ${cyan(name)}... `);
    try {
      execSync(`pm2 stop ${name}`, { timeout: 15000, stdio: 'pipe' });
      console.log(green('stopped'));
    } catch {
      console.log(yellow('already stopped or not found'));
    }
  }
}

async function cmdStart(positional: string[]) {
  const target = positional[0];
  if (!target) {
    console.log(red('Usage: spxer-ctl start <target>'));
    console.log(dim('Targets: ' + Object.keys(TARGET_MAP).join(', ')));
    return;
  }

  const pm2Names = resolveTarget(target);

  for (const name of pm2Names) {
    process.stdout.write(`Starting ${cyan(name)}... `);
    try {
      execSync(`pm2 start ${name}`, { timeout: 15000, stdio: 'pipe' });
      console.log(green('OK'));
    } catch {
      try {
        execSync(`pm2 start ecosystem.config.js --only ${name}`, {
          cwd: ROOT, timeout: 15000, stdio: 'pipe',
        });
        console.log(green('started'));
      } catch {
        console.log(red('FAILED'));
      }
    }
  }

  // Clear maintenance if agent
  const isAgent = pm2Names.some(n => n.includes('agent'));
  if (isAgent) {
    setMaintenance(false);
  }
}

function cmdMaintenance(positional: string[]) {
  const action = positional[0];

  if (!action || action === 'status') {
    const maint = readJSON(MAINTENANCE_FILE);
    if (!maint) {
      console.log(dim('No maintenance file found.'));
      return;
    }
    if (maint.active) {
      console.log(red('MAINTENANCE ACTIVE'));
      console.log(`  Reason:  ${maint.reason || 'none'}`);
      console.log(`  Started: ${maint.startedAtUTC || '?'}`);
      console.log(`  By:      ${maint.by || '?'}`);
      if (maint.startedAt) {
        console.log(`  Duration: ${formatUptime(Date.now() - maint.startedAt)}`);
      }
    } else {
      console.log(green('No active maintenance'));
    }
    return;
  }

  if (action === 'on') {
    const reason = positional.slice(1).join(' ') || 'manual';
    setMaintenance(true, reason);
    console.log(yellow(`Maintenance ON: ${reason}`));
    return;
  }

  if (action === 'off') {
    setMaintenance(false);
    console.log(green('Maintenance OFF'));
    return;
  }

  console.log(red('Usage: spxer-ctl maintenance on [reason] | off | status'));
}

function cmdConfigList() {
  const result = sqlite(
    "SELECT id, name, datetime(createdAt/1000, 'unixepoch') FROM replay_configs ORDER BY createdAt DESC LIMIT 20"
  );
  if (!result) {
    console.log(dim('No configs found or database unavailable.'));
    return;
  }

  console.log(bold('Replay Configs (last 20)'));
  console.log('');

  const lines = result.split('\n').filter(Boolean);
  for (const line of lines) {
    const [id, name, created] = line.split('|');
    console.log(`  ${cyan(padR(id || '', 45))} ${padR(name || '', 20)} ${dim(created || '')}`);
  }
}

function cmdConfigShow(positional: string[]) {
  const id = positional[0];
  if (!id) {
    console.log(red('Usage: spxer-ctl config show <id>'));
    return;
  }

  const result = sqlite(
    `SELECT config_json FROM replay_configs WHERE id = '${id.replace(/'/g, "''")}'`
  );
  if (!result) {
    console.log(red(`Config '${id}' not found.`));
    return;
  }

  try {
    const config = JSON.parse(result);
    console.log(bold(`Config: ${id}`));
    console.log('');
    console.log(JSON.stringify(config, null, 2));
  } catch {
    console.log(result);
  }
}

function cmdConfigDiff(positional: string[]) {
  const [id1, id2] = positional;
  if (!id1 || !id2) {
    console.log(red('Usage: spxer-ctl config diff <id1> <id2>'));
    return;
  }

  const r1 = sqlite(`SELECT config_json FROM replay_configs WHERE id = '${id1.replace(/'/g, "''")}'`);
  const r2 = sqlite(`SELECT config_json FROM replay_configs WHERE id = '${id2.replace(/'/g, "''")}'`);

  if (!r1) { console.log(red(`Config '${id1}' not found.`)); return; }
  if (!r2) { console.log(red(`Config '${id2}' not found.`)); return; }

  let c1: any, c2: any;
  try { c1 = JSON.parse(r1); c2 = JSON.parse(r2); }
  catch { console.log(red('Failed to parse config JSON.')); return; }

  console.log(bold(`Config Diff: ${cyan(id1)} vs ${cyan(id2)}`));
  console.log('');

  function diffObj(a: any, b: any, prefix = ''): void {
    const allKeys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const key of [...allKeys].sort()) {
      const path = prefix ? `${prefix}.${key}` : key;
      const va = a?.[key];
      const vb = b?.[key];

      if (typeof va === 'object' && va !== null && typeof vb === 'object' && vb !== null && !Array.isArray(va)) {
        diffObj(va, vb, path);
        continue;
      }

      const sa = JSON.stringify(va);
      const sb = JSON.stringify(vb);
      if (sa !== sb) {
        console.log(`  ${padR(path, 35)} ${red(sa ?? 'undefined')} -> ${green(sb ?? 'undefined')}`);
      }
    }
  }

  diffObj(c1, c2);
}

function cmdDb() {
  const dbSize = fileSize(DB_PATH);
  const walSize = fileSize(WAL_PATH);

  const W = 60;
  console.log(boxTop(W));
  console.log(boxRow(bold('Database Stats'), W));
  console.log(hline(W, '├', '┤'));

  console.log(boxRow(`  DB file:  ${formatBytes(dbSize)} ${dim(DB_PATH)}`, W));
  const walWarn = walSize > 200 * 1024 * 1024 ? red(' [HIGH — run db checkpoint]') : '';
  console.log(boxRow(`  WAL file: ${formatBytes(walSize)}${walWarn}`, W));

  // Row counts
  console.log(hline(W, '├', '┤'));
  console.log(boxRow(bold('Row Counts'), W));

  const tables = [
    ['bars', 'SELECT COUNT(*) FROM bars'],
    ['contracts', 'SELECT COUNT(*) FROM contracts'],
    ['replay_runs', 'SELECT COUNT(*) FROM replay_runs'],
    ['replay_results', 'SELECT COUNT(*) FROM replay_results'],
    ['replay_configs', 'SELECT COUNT(*) FROM replay_configs'],
  ];

  for (const [name, query] of tables) {
    const count = sqlite(query);
    console.log(boxRow(`  ${padR(name, 18)} ${count || '?'}`, W));
  }

  // Last bar
  const lastBar = sqlite("SELECT datetime(ts, 'unixepoch') FROM bars ORDER BY ts DESC LIMIT 1");
  if (lastBar) {
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(`  Last bar: ${lastBar} UTC`, W));
  }

  // Backups
  console.log(hline(W, '├', '┤'));
  console.log(boxRow(bold('Backups'), W));
  const backupDir = path.join(DATA_DIR, 'backups');
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.endsWith('.db'))
      .sort()
      .slice(-5);
    if (files.length === 0) {
      console.log(boxRow(dim('  No backups found'), W));
    } else {
      for (const f of files) {
        const size = fileSize(path.join(backupDir, f));
        console.log(boxRow(`  ${f}  ${dim(formatBytes(size))}`, W));
      }
    }
  } catch {
    console.log(boxRow(dim('  Backup directory not found'), W));
  }

  // Disk space
  const diskInfo = shell("df -h /home/ubuntu --output=avail,size,pcent | tail -1");
  if (diskInfo) {
    console.log(hline(W, '├', '┤'));
    console.log(boxRow(`  Disk: ${diskInfo.trim()}`, W));
  }

  console.log(boxBot(W));
}

function cmdDbCheckpoint() {
  console.log('Running WAL checkpoint (TRUNCATE)...');
  const walBefore = fileSize(WAL_PATH);
  const result = sqlite('PRAGMA wal_checkpoint(TRUNCATE);');
  const walAfter = fileSize(WAL_PATH);
  console.log(`  Result:  ${result || 'OK'}`);
  console.log(`  WAL:     ${formatBytes(walBefore)} -> ${formatBytes(walAfter)}`);
}

function cmdDbBackup() {
  const backupDir = path.join(DATA_DIR, 'backups');
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}

  const ts = new Date().toISOString().replace(/[:-]/g, '').replace('T', '-').slice(0, 15);
  const backupPath = path.join(backupDir, `spxer-${ts}.db`);

  console.log(`Backing up to ${backupPath}...`);
  const start = Date.now();
  try {
    execSync(`sqlite3 "${DB_PATH}" ".backup '${backupPath}'"`, { timeout: 300000 });
    const size = fileSize(backupPath);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(green(`Backup complete: ${formatBytes(size)} in ${elapsed}s`));
  } catch (e: any) {
    console.log(red(`Backup failed: ${e.message || e}`));
  }
}

function cmdDbPurge(flags: Record<string, string>) {
  const dryRun = flags['dry-run'] === 'true';
  const args = dryRun ? '--dry-run' : '';
  console.log(`Running bar purge ${dryRun ? dim('[DRY RUN]') : yellow('[LIVE]')}...`);
  try {
    const output = execSync(`npx tsx scripts/purge-bars.ts ${args}`, {
      cwd: ROOT, encoding: 'utf-8', timeout: 120000,
    });
    console.log(output);
  } catch (e: any) {
    console.log(red(`Purge failed: ${e.message || e}`));
  }
}

function cmdAlerts(flags: Record<string, string>) {
  const maxLines = parseInt(flags.lines || '20', 10);

  // Monitor log alerts
  const content = tailFile(MONITOR_LOG, 200);
  const lines = content.split('\n')
    .filter(l => l.includes('[ALERT]') || l.includes('[WARN]') || l.includes('[ERROR]'))
    .slice(-maxLines);

  if (lines.length === 0) {
    console.log(green('No recent alerts.'));
    return;
  }

  console.log(bold(`Recent Alerts (${lines.length})`));
  console.log('');

  for (const line of lines) {
    if (line.includes('[ALERT]')) {
      console.log(red(line.length > 120 ? line.slice(0, 117) + '...' : line));
    } else if (line.includes('[WARN]')) {
      console.log(yellow(line.length > 120 ? line.slice(0, 117) + '...' : line));
    } else {
      console.log(line.length > 120 ? line.slice(0, 117) + '...' : line);
    }
  }
}

// ─── Broker Commands (Tradier API) ──────────────────────────────────────────

async function cmdPositions(flags: Record<string, string>) {
  const acctHint = flags.account || flags.acct || 'all';
  const accountIds = acctHint === 'all'
    ? Object.values(ACCOUNTS)
    : [resolveAccountId(acctHint)].map(a => ({ ...a, ...Object.values(ACCOUNTS).find(acc => acc.id === a.id) }));

  for (const acc of Object.values(ACCOUNTS)) {
    if (acctHint !== 'all' && acc.id !== resolveAccountId(acctHint).id) continue;

    console.log(bold(`\n  Positions — ${acc.label} (${acc.id})`));
    console.log('');

    try {
      const data = await tradierGet(`/accounts/${acc.id}/positions`);
      const positions = data?.positions?.position;
      if (!positions || positions === 'null') {
        console.log(dim('    No open positions'));
        continue;
      }
      const posList = Array.isArray(positions) ? positions : [positions];

      const widths = [30, 6, 10, 12, 12, 10];
      console.log(tableTop(widths));
      console.log(tableRow([
        bold('Symbol'), bold('Qty'), bold('Cost'), bold('Value'), bold('P&L'), bold('P&L %')
      ], widths));
      console.log(tableSep(widths));

      let totalPnl = 0;
      for (const p of posList) {
        const cost = p.cost_basis ?? 0;
        const value = (p.quantity ?? 0) * (p.cost_basis ? p.cost_basis / (p.quantity || 1) : 0);
        const pnl = (p.market_value ?? value) - cost;
        totalPnl += pnl;
        const pnlPct = cost !== 0 ? (pnl / Math.abs(cost)) * 100 : 0;
        const symDisplay = formatOptionSymbol(p.symbol);

        console.log(tableRow([
          cyan(symDisplay),
          String(p.quantity),
          `$${(cost).toFixed(2)}`,
          `$${(p.market_value ?? 0).toFixed(2)}`,
          formatMoney(pnl),
          `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
        ], widths));
      }
      console.log(tableSep(widths));
      console.log(tableRow([
        bold('Total'), '', '', '', formatMoney(totalPnl), ''
      ], widths));
      console.log(tableBot(widths));
    } catch (e: any) {
      console.log(red(`    Error: ${e.message}`));
    }
  }
}

async function cmdOrders(flags: Record<string, string>) {
  const acctHint = flags.account || flags.acct || 'all';
  const showAll = flags.all === 'true';
  const limit = parseInt(flags.lines || flags.n || '20', 10);

  for (const acc of Object.values(ACCOUNTS)) {
    if (acctHint !== 'all' && acc.id !== resolveAccountId(acctHint).id) continue;

    console.log(bold(`\n  Orders — ${acc.label} (${acc.id})`));
    console.log('');

    try {
      const data = await tradierGet(`/accounts/${acc.id}/orders`);
      let orders = data?.orders?.order;
      if (!orders || orders === 'null') {
        console.log(dim('    No orders'));
        continue;
      }
      orders = Array.isArray(orders) ? orders : [orders];

      // Filter to today by default, or show all
      if (!showAll) {
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        orders = orders.filter((o: any) => {
          const created = o.create_date || o.transaction_date || '';
          return created.startsWith(todayStr);
        });
        if (orders.length === 0) {
          console.log(dim('    No orders today (use --all for all orders)'));
          continue;
        }
      }

      // Most recent first, limit
      orders = orders.slice(-limit).reverse();

      const widths = [8, 10, 8, 24, 6, 8, 10, 12];
      console.log(tableTop(widths));
      console.log(tableRow([
        bold('ID'), bold('Status'), bold('Type'), bold('Symbol'), bold('Side'), bold('Qty'),
        bold('Price'), bold('Fill'),
      ], widths));
      console.log(tableSep(widths));

      for (const o of orders) {
        const status = o.status || '?';
        const statusStr = status === 'filled' ? green(status)
          : status === 'open' || status === 'pending' ? yellow(status)
          : status === 'canceled' || status === 'rejected' ? red(status)
          : dim(status);

        // Handle OTOCO (multi-leg) and single orders
        const legs = o.leg ? (Array.isArray(o.leg) ? o.leg : [o.leg]) : null;
        if (legs && legs.length > 0) {
          // Multi-leg order header
          console.log(tableRow([
            String(o.id), statusStr, cyan(o.class || o.type || '?'),
            dim(`(${legs.length} legs)`), '', '', '', '',
          ], widths));

          for (const leg of legs) {
            const symDisplay = formatOptionSymbol(leg.option_symbol || leg.symbol || '');
            const fillPrice = leg.avg_fill_price ? `$${Number(leg.avg_fill_price).toFixed(2)}` : dim('—');
            const price = leg.price ? `$${Number(leg.price).toFixed(2)}`
              : leg.stop_price ? `stop $${Number(leg.stop_price).toFixed(2)}` : dim('—');

            console.log(tableRow([
              dim(`  └${leg.id || ''}`), statusStr, leg.type || '?',
              symDisplay,
              leg.side || '?', String(leg.quantity || '?'),
              price, fillPrice,
            ], widths));
          }
        } else {
          // Single order
          const symDisplay = formatOptionSymbol(o.option_symbol || o.symbol || '');
          const fillPrice = o.avg_fill_price ? `$${Number(o.avg_fill_price).toFixed(2)}` : dim('—');
          const price = o.price ? `$${Number(o.price).toFixed(2)}`
            : o.stop_price ? `stop $${Number(o.stop_price).toFixed(2)}` : dim('—');

          console.log(tableRow([
            String(o.id), statusStr, o.type || '?',
            symDisplay,
            o.side || '?', String(o.quantity || '?'),
            price, fillPrice,
          ], widths));
        }
      }
      console.log(tableBot(widths));
      console.log(dim(`    Showing ${orders.length} orders` + (showAll ? '' : ' (today only, use --all for all)')));
    } catch (e: any) {
      console.log(red(`    Error: ${e.message}`));
    }
  }
}

async function cmdBalance(flags: Record<string, string>) {
  const acctHint = flags.account || flags.acct || 'all';

  for (const acc of Object.values(ACCOUNTS)) {
    if (acctHint !== 'all' && acc.id !== resolveAccountId(acctHint).id) continue;

    try {
      const data = await tradierGet(`/accounts/${acc.id}/balances`);
      const bal = data?.balances;
      if (!bal) {
        console.log(red(`  ${acc.label}: No balance data`));
        continue;
      }

      const W = 52;
      console.log('');
      console.log(boxTop(W));
      console.log(boxRow(bold(`${acc.label} (${acc.id})`), W));
      console.log(hline(W));

      // Common fields
      const equity = bal.total_equity ?? bal.equity ?? 0;
      const cash = bal.total_cash ?? bal.cash?.cash_available ?? 0;
      const marketValue = bal.market_value ?? 0;
      const optionBP = bal.option_buying_power ?? bal.cash?.cash_available ?? 0;
      const dayTradeBP = bal.day_trading_buying_power ?? null;
      const pendingCash = bal.pending_cash ?? 0;
      const unclearedFunds = bal.uncleared_funds ?? 0;

      console.log(boxRow(`Total Equity:       ${bold(`$${Number(equity).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)}`, W));
      console.log(boxRow(`Cash:               $${Number(cash).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, W));
      console.log(boxRow(`Market Value:       $${Number(marketValue).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, W));
      console.log(boxRow(`Option Buying Power: ${green(`$${Number(optionBP).toLocaleString('en-US', { minimumFractionDigits: 2 })}`)}`, W));
      if (dayTradeBP !== null) {
        console.log(boxRow(`Day Trade BP:       $${Number(dayTradeBP).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, W));
      }
      if (pendingCash) {
        console.log(boxRow(`Pending Cash:       $${Number(pendingCash).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, W));
      }
      if (unclearedFunds) {
        console.log(boxRow(`Uncleared Funds:    $${Number(unclearedFunds).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, W));
      }

      // Margin-specific
      if (bal.margin) {
        const mg = bal.margin;
        console.log(hline(W));
        console.log(boxRow(dim('Margin Details'), W));
        if (mg.fed_call !== undefined) console.log(boxRow(`  Fed Call:         $${Number(mg.fed_call).toFixed(2)}`, W));
        if (mg.maintenance_call !== undefined) console.log(boxRow(`  Maint Call:       $${Number(mg.maintenance_call).toFixed(2)}`, W));
        if (mg.stock_buying_power !== undefined) console.log(boxRow(`  Stock BP:         $${Number(mg.stock_buying_power).toFixed(2)}`, W));
        if (mg.option_short_value !== undefined) console.log(boxRow(`  Short Value:      $${Number(mg.option_short_value).toFixed(2)}`, W));
      }

      // Cash-specific
      if (bal.cash) {
        const ca = bal.cash;
        console.log(hline(W));
        console.log(boxRow(dim('Cash Details'), W));
        if (ca.cash_available !== undefined) console.log(boxRow(`  Cash Available:   $${Number(ca.cash_available).toFixed(2)}`, W));
        if (ca.unsettled_funds !== undefined) console.log(boxRow(`  Unsettled:        $${Number(ca.unsettled_funds).toFixed(2)}`, W));
        if (ca.sweep !== undefined) console.log(boxRow(`  Sweep:            $${Number(ca.sweep).toFixed(2)}`, W));
      }

      console.log(boxBot(W));
    } catch (e: any) {
      console.log(red(`  ${acc.label}: ${e.message}`));
    }
  }
}

async function cmdQuote(args: string[]) {
  if (args.length === 0) {
    // Default: SPX + VIX
    args = ['SPX', 'VIX'];
  }
  const symbols = args.map(s => s.toUpperCase()).join(',');

  try {
    const data = await tradierGet(`/markets/quotes?symbols=${symbols}`);
    const quotes = data?.quotes?.quote;
    if (!quotes) {
      console.log(dim('  No quotes returned'));
      return;
    }
    const quoteList = Array.isArray(quotes) ? quotes : [quotes];

    for (const q of quoteList) {
      const W = 52;
      console.log('');
      console.log(boxTop(W));
      console.log(boxRow(bold(`${q.symbol} — ${q.description || ''}`), W));
      console.log(hline(W));

      const change = q.change ?? 0;
      const changePct = q.change_percentage ?? 0;
      const changeStr = change >= 0
        ? green(`+${change.toFixed(2)} (+${changePct.toFixed(2)}%)`)
        : red(`${change.toFixed(2)} (${changePct.toFixed(2)}%)`);

      console.log(boxRow(`Last:    ${bold(`$${Number(q.last ?? 0).toFixed(2)}`)}  ${changeStr}`, W));
      console.log(boxRow(`Bid:     $${Number(q.bid ?? 0).toFixed(2)}    Ask: $${Number(q.ask ?? 0).toFixed(2)}`, W));
      console.log(boxRow(`Open:    $${Number(q.open ?? 0).toFixed(2)}    Prev Close: $${Number(q.prevclose ?? q.close ?? 0).toFixed(2)}`, W));
      console.log(boxRow(`High:    $${Number(q.high ?? 0).toFixed(2)}    Low:  $${Number(q.low ?? 0).toFixed(2)}`, W));
      console.log(boxRow(`Volume:  ${Number(q.volume ?? 0).toLocaleString()}`, W));
      console.log(boxBot(W));
    }
  } catch (e: any) {
    console.log(red(`  Error: ${e.message}`));
  }
}

async function cmdOptionQuote(args: string[]) {
  if (args.length === 0) {
    console.log(red('  Usage: spxer-ctl option-quote <symbol> [symbol...]'));
    console.log(dim('  Example: spxer-ctl option-quote SPXW260417C07100000'));
    return;
  }

  const symbols = args.map(s => s.toUpperCase()).join(',');
  try {
    const data = await tradierGet(`/markets/quotes?symbols=${symbols}`);
    const quotes = data?.quotes?.quote;
    if (!quotes) {
      console.log(dim('  No quotes returned'));
      return;
    }
    const quoteList = Array.isArray(quotes) ? quotes : [quotes];

    const widths = [28, 8, 8, 8, 10, 8, 10];
    console.log('');
    console.log(tableTop(widths));
    console.log(tableRow([
      bold('Contract'), bold('Last'), bold('Bid'), bold('Ask'), bold('Spread'),
      bold('Volume'), bold('OI'),
    ], widths));
    console.log(tableSep(widths));

    for (const q of quoteList) {
      const bid = q.bid ?? 0;
      const ask = q.ask ?? 0;
      const spread = ask - bid;
      const spreadStr = spread <= 0.75 ? green(`$${spread.toFixed(2)}`) : red(`$${spread.toFixed(2)}`);

      console.log(tableRow([
        cyan(formatOptionSymbol(q.symbol)),
        `$${Number(q.last ?? 0).toFixed(2)}`,
        `$${bid.toFixed(2)}`,
        `$${ask.toFixed(2)}`,
        spreadStr,
        String(q.volume ?? 0),
        String(q.open_interest ?? 0),
      ], widths));
    }
    console.log(tableBot(widths));
  } catch (e: any) {
    console.log(red(`  Error: ${e.message}`));
  }
}

async function cmdChain(args: string[], flags: Record<string, string>) {
  const expiry = args[0] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const symbol = flags.symbol || 'SPX';
  const strikeRange = parseInt(flags.range || '50', 10);

  try {
    // Get current SPX price for centering
    const quoteData = await tradierGet(`/markets/quotes?symbols=${symbol}`);
    const price = quoteData?.quotes?.quote?.last ?? 0;

    const data = await tradierGet(`/markets/options/chains?symbol=${symbol}&expiration=${expiry}&greeks=true`);
    let options = data?.options?.option;
    if (!options) {
      console.log(dim(`  No chain data for ${symbol} ${expiry}`));
      // Show available expirations
      const expData = await tradierGet(`/markets/options/expirations?symbol=${symbol}&includeAllRoots=true`);
      const exps = expData?.expirations?.date;
      if (exps) {
        const expList = Array.isArray(exps) ? exps : [exps];
        console.log(dim(`  Available expirations: ${expList.slice(0, 10).join(', ')}`));
      }
      return;
    }
    options = Array.isArray(options) ? options : [options];

    // Filter to ±range around current price
    if (price > 0) {
      options = options.filter((o: any) =>
        Math.abs(o.strike - price) <= strikeRange
      );
    }

    // Separate calls and puts, sort by strike
    const calls = options.filter((o: any) => o.option_type === 'call').sort((a: any, b: any) => a.strike - b.strike);
    const puts = options.filter((o: any) => o.option_type === 'put').sort((a: any, b: any) => a.strike - b.strike);

    console.log('');
    console.log(bold(`  ${symbol} Option Chain — ${expiry} (±$${strikeRange} from $${price.toFixed(0)})`));
    console.log('');

    // Print calls
    if (calls.length > 0) {
      console.log(bold('  CALLS'));
      const widths = [8, 8, 8, 8, 8, 8, 8];
      console.log('  ' + tableTop(widths));
      console.log('  ' + tableRow([
        bold('Strike'), bold('Bid'), bold('Ask'), bold('Last'), bold('Vol'),
        bold('OI'), bold('Delta'),
      ], widths));
      console.log('  ' + tableSep(widths));

      for (const o of calls) {
        const delta = o.greeks?.delta;
        const strikeStr = price > 0 && o.strike > price ? dim(o.strike.toFixed(0)) : bold(String(o.strike.toFixed(0)));
        console.log('  ' + tableRow([
          strikeStr,
          `$${(o.bid ?? 0).toFixed(2)}`,
          `$${(o.ask ?? 0).toFixed(2)}`,
          `$${(o.last ?? 0).toFixed(2)}`,
          String(o.volume ?? 0),
          String(o.open_interest ?? 0),
          delta != null ? delta.toFixed(3) : dim('—'),
        ], widths));
      }
      console.log('  ' + tableBot(widths));
    }

    // Print puts
    if (puts.length > 0) {
      console.log('');
      console.log(bold('  PUTS'));
      const widths = [8, 8, 8, 8, 8, 8, 8];
      console.log('  ' + tableTop(widths));
      console.log('  ' + tableRow([
        bold('Strike'), bold('Bid'), bold('Ask'), bold('Last'), bold('Vol'),
        bold('OI'), bold('Delta'),
      ], widths));
      console.log('  ' + tableSep(widths));

      for (const o of puts) {
        const delta = o.greeks?.delta;
        const strikeStr = price > 0 && o.strike < price ? dim(o.strike.toFixed(0)) : bold(String(o.strike.toFixed(0)));
        console.log('  ' + tableRow([
          strikeStr,
          `$${(o.bid ?? 0).toFixed(2)}`,
          `$${(o.ask ?? 0).toFixed(2)}`,
          `$${(o.last ?? 0).toFixed(2)}`,
          String(o.volume ?? 0),
          String(o.open_interest ?? 0),
          delta != null ? delta.toFixed(3) : dim('—'),
        ], widths));
      }
      console.log('  ' + tableBot(widths));
    }

    console.log(dim(`  ${calls.length} calls, ${puts.length} puts shown`));
  } catch (e: any) {
    console.log(red(`  Error: ${e.message}`));
  }
}

async function cmdHistory(flags: Record<string, string>) {
  const acctHint = flags.account || flags.acct || 'spx';
  const limit = parseInt(flags.lines || flags.n || '30', 10);
  const acc = resolveAccountId(acctHint);

  const accountEntry = Object.values(ACCOUNTS).find(a => a.id === acc.id);
  console.log(bold(`\n  Trade History — ${accountEntry?.label || acc.id}`));
  console.log('');

  try {
    const data = await tradierGet(`/accounts/${acc.id}/history?limit=${limit}&type=trade`);
    const events = data?.history?.event;
    if (!events || events === 'null') {
      console.log(dim('    No trade history'));
      return;
    }
    const eventList = (Array.isArray(events) ? events : [events]).reverse();

    const widths = [12, 12, 24, 8, 8, 10, 10];
    console.log(tableTop(widths));
    console.log(tableRow([
      bold('Date'), bold('Type'), bold('Symbol'), bold('Side'), bold('Qty'),
      bold('Price'), bold('Amount'),
    ], widths));
    console.log(tableSep(widths));

    for (const ev of eventList) {
      const trade = ev.trade;
      if (!trade) continue;

      const date = (ev.date || '').slice(0, 10);
      const symDisplay = formatOptionSymbol(trade.symbol || '');
      const side = trade.trade_type || '?';
      const sideStr = side.includes('buy') ? green(side) : red(side);
      const amount = trade.amount ?? trade.cost ?? 0;

      console.log(tableRow([
        date,
        ev.type || '?',
        cyan(symDisplay),
        sideStr,
        String(trade.quantity || '?'),
        `$${Number(trade.price ?? 0).toFixed(2)}`,
        formatMoney(amount),
      ], widths));
    }
    console.log(tableBot(widths));
    console.log(dim(`    Showing last ${eventList.length} trades`));
  } catch (e: any) {
    console.log(red(`    Error: ${e.message}`));
  }
}

async function cmdGainloss(flags: Record<string, string>) {
  const acctHint = flags.account || flags.acct || 'spx';
  const limit = parseInt(flags.lines || flags.n || '30', 10);
  const acc = resolveAccountId(acctHint);
  const accountEntry = Object.values(ACCOUNTS).find(a => a.id === acc.id);
  console.log(bold(`\n  Gain/Loss — ${accountEntry?.label || acc.id}`));
  console.log('');

  try {
    const data = await tradierGet(`/accounts/${acc.id}/gainloss?count=${limit}`);
    const positions = data?.gainloss?.closed_position;
    if (!positions || positions === 'null') {
      console.log(dim('    No closed positions'));
      return;
    }
    const posList = (Array.isArray(positions) ? positions : [positions]);

    const widths = [24, 12, 6, 10, 10, 10, 8];
    console.log(tableTop(widths));
    console.log(tableRow([
      bold('Symbol'), bold('Closed'), bold('Qty'), bold('Cost'),
      bold('Proceeds'), bold('P&L'), bold('P&L %'),
    ], widths));
    console.log(tableSep(widths));

    let totalPnl = 0;
    for (const p of posList) {
      const cost = p.cost ?? 0;
      const proceeds = p.proceeds ?? 0;
      const pnl = p.gain_loss ?? (proceeds - cost);
      totalPnl += pnl;
      const pnlPct = cost !== 0 ? (pnl / Math.abs(cost)) * 100 : 0;
      const closeDate = (p.close_date || '').slice(0, 10);
      const symDisplay = formatOptionSymbol(p.symbol || '');

      console.log(tableRow([
        cyan(symDisplay),
        closeDate,
        String(p.quantity || '?'),
        `$${Math.abs(cost).toFixed(2)}`,
        `$${proceeds.toFixed(2)}`,
        formatMoney(pnl),
        `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
      ], widths));
    }
    console.log(tableSep(widths));
    console.log(tableRow([
      bold('Total'), '', '', '', '', formatMoney(totalPnl), ''
    ], widths));
    console.log(tableBot(widths));
  } catch (e: any) {
    console.log(red(`    Error: ${e.message}`));
  }
}

async function cmdBroker(subArgs: string[], flags: Record<string, string>) {
  const sub = subArgs[0];
  if (!sub) {
    // Summary: positions + balance for all accounts
    console.log(bold('\n  Broker Summary'));
    await cmdBalance(flags);
    await cmdPositions(flags);
    return;
  }

  switch (sub) {
    case 'positions': case 'pos':
      await cmdPositions(flags);
      break;
    case 'orders': case 'ord':
      await cmdOrders(flags);
      break;
    case 'balance': case 'bal':
      await cmdBalance(flags);
      break;
    case 'quote': case 'q':
      await cmdQuote(subArgs.slice(1));
      break;
    case 'option-quote': case 'oq':
      await cmdOptionQuote(subArgs.slice(1));
      break;
    case 'chain':
      await cmdChain(subArgs.slice(1), flags);
      break;
    case 'history': case 'hist':
      await cmdHistory(flags);
      break;
    case 'gainloss': case 'gl': case 'pnl':
      await cmdGainloss(flags);
      break;
    default:
      console.log(red(`Unknown broker subcommand: ${sub}`));
      console.log(dim(`Available: positions|pos, orders|ord, balance|bal, quote|q, option-quote|oq, chain, history|hist, gainloss|gl|pnl`));
  }
}

async function cmdCheck() {
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // 1. All core processes running
  const procs = getSPXerProcs();
  const coreProcs = ['spxer', 'spxer-dashboard', 'replay-viewer'];
  for (const name of coreProcs) {
    const proc = procs.find(p => p.name === name);
    const online = proc?.status === 'online';
    checks.push({
      name: `PM2 ${name}`,
      pass: online,
      detail: online ? `online, ${formatUptime(proc!.uptime)}` : (proc?.status || 'not found'),
    });
  }

  // 2. Health endpoint
  let health: any = null;
  try {
    health = await httpGet('http://localhost:3600/health', 5000);
    checks.push({ name: 'Health endpoint', pass: true, detail: `status: ${health.status}` });
  } catch {
    checks.push({ name: 'Health endpoint', pass: false, detail: 'unreachable' });
  }

  // 3. Data staleness (ES for overnight, SPX for RTH)
  if (health?.data) {
    const esStale = health.data.ES?.staleSec || Infinity;
    const spxStale = health.data.SPX?.staleSec || Infinity;
    const mode = marketMode();
    const relevantStale = mode === 'RTH' ? spxStale : esStale;
    const relevantName = mode === 'RTH' ? 'SPX' : 'ES';
    const staleOk = relevantStale < 120 || mode === 'closed';
    checks.push({
      name: `${relevantName} data freshness`,
      pass: staleOk,
      detail: staleOk ? `${relevantStale}s` : `STALE: ${relevantStale}s (>${mode === 'closed' ? 'market closed' : '120s'})`,
    });
  }

  // 4. WAL size
  const walSize = fileSize(WAL_PATH);
  const walOk = walSize < 200 * 1024 * 1024;
  checks.push({
    name: 'WAL size',
    pass: walOk,
    detail: formatBytes(walSize) + (walOk ? '' : ' > 200MB'),
  });

  // 5. Disk space
  try {
    const dfOutput = shell("df /home/ubuntu --output=avail -B1 | tail -1");
    const availBytes = parseInt(dfOutput.trim(), 10);
    const diskOk = availBytes > 5 * 1024 * 1024 * 1024; // 5GB
    checks.push({
      name: 'Disk space',
      pass: diskOk,
      detail: `${formatBytes(availBytes)} available`,
    });
  } catch {
    checks.push({ name: 'Disk space', pass: false, detail: 'check failed' });
  }

  // 6. No maintenance active
  const maint = readJSON(MAINTENANCE_FILE);
  checks.push({
    name: 'No active maintenance',
    pass: !maint?.active,
    detail: maint?.active ? `active: ${maint.reason}` : 'clear',
  });

  // Print results
  const allPass = checks.every(c => c.pass);
  console.log(bold('Health Check'));
  console.log('');

  for (const check of checks) {
    const icon = check.pass ? green('PASS') : red('FAIL');
    console.log(`  ${icon}  ${padR(check.name, 25)} ${dim(check.detail)}`);
  }

  console.log('');
  if (allPass) {
    console.log(green('All checks passed.'));
  } else {
    const failCount = checks.filter(c => !c.pass).length;
    console.log(red(`${failCount} check(s) failed.`));
  }

  process.exit(allPass ? 0 : 1);
}

function cmdHelp() {
  console.log(`
${bold('spxer-ctl')} — SPXer trading system CLI

${bold('USAGE')}
  npx tsx scripts/spxer-ctl.ts <command> [args]
  ./scripts/spxer-ctl <command> [args]

${bold('COMMANDS')}
  ${cyan('status')}                          Full system overview (default)
  ${cyan('pipeline')}                        Pipeline deep dive (providers, bars, indicators)
  ${cyan('agents')}                          Agent deep dive (SPX)
  ${cyan('trades')} [--today] [--agent=spx]  Trade history from audit log
  ${cyan('logs')} <process> [--lines=50]     Tail PM2 logs
  ${cyan('errors')} [--lines=20] [--since=1h] Recent errors across all processes

  ${cyan('restart')} <target>                Safe restart (maintenance mode for agents)
  ${cyan('stop')} <target>                   Stop process
  ${cyan('start')} <target>                  Start process
  ${cyan('maintenance')} on [reason]         Enable maintenance mode
  ${cyan('maintenance')} off                 Disable maintenance mode
  ${cyan('maintenance')} status              Show maintenance state

  ${cyan('config list')}                     List replay configs
  ${cyan('config show')} <id>                Show config details
  ${cyan('config diff')} <id1> <id2>         Diff two configs

  ${cyan('db')}                              Database stats
  ${cyan('db checkpoint')}                   Force WAL checkpoint
  ${cyan('db backup')}                       Manual backup
  ${cyan('db purge')} [--dry-run]            Run bar purge

  ${cyan('alerts')} [--lines=20]             Recent alerts from monitor log
  ${cyan('check')}                           Health check (exit 0 or 1)

${bold('BROKER')} (Tradier API — SPX account only)
  ${cyan('broker')}                          Summary (balance + positions)
  ${cyan('positions')}  ${dim('(pos)')}               Open positions
  ${cyan('orders')}     ${dim('(ord)')}  [--all]       Today's orders (--all for all)
  ${cyan('balance')}    ${dim('(bal)')}               Account balances & buying power
  ${cyan('quote')}      ${dim('(q)')}   [symbols...]  Market quotes (default: SPX VIX)
  ${cyan('chain')}      [expiry] [--range=50]  Option chain (default: today, ±$50)
  ${cyan('gainloss')}   ${dim('(gl, pnl)')}  [--n=30]  Closed position P&L
  ${cyan('history')}    ${dim('(hist)')}  [--n=30]     Trade history

  ${cyan('help')}                            Show this help

${bold('TARGETS')} (for restart/stop/start)
  pipeline, agent-spx, agents, monitor, dashboard, viewer, schwaber, all

${bold('LOG PROCESSES')} (for logs command)
  spxer, agent, monitor, dashboard, viewer, schwaber, all
`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const { positional, flags } = parseArgs(args);
  const command = positional[0] || 'status';
  const subArgs = positional.slice(1);

  try {
    switch (command) {
      case 'status':
        await cmdStatus();
        break;

      case 'pipeline':
        await cmdPipeline();
        break;

      case 'agents':
      case 'agent':
        await cmdAgents();
        break;

      case 'trades':
        await cmdTrades(flags);
        break;

      case 'logs':
      case 'log':
        cmdLogs(subArgs, flags);
        break;

      case 'errors':
      case 'error':
        cmdErrors(flags);
        break;

      case 'restart':
        await cmdRestart(subArgs);
        break;

      case 'stop':
        await cmdStop(subArgs);
        break;

      case 'start':
        await cmdStart(subArgs);
        break;

      case 'maintenance':
      case 'maint':
        cmdMaintenance(subArgs);
        break;

      case 'config':
        if (subArgs[0] === 'list' || !subArgs[0]) cmdConfigList();
        else if (subArgs[0] === 'show') cmdConfigShow(subArgs.slice(1));
        else if (subArgs[0] === 'diff') cmdConfigDiff(subArgs.slice(1));
        else {
          console.log(red(`Unknown config subcommand: ${subArgs[0]}`));
          console.log(dim('Available: list, show <id>, diff <id1> <id2>'));
        }
        break;

      case 'db':
        if (!subArgs[0]) cmdDb();
        else if (subArgs[0] === 'checkpoint') cmdDbCheckpoint();
        else if (subArgs[0] === 'backup') cmdDbBackup();
        else if (subArgs[0] === 'purge') cmdDbPurge(flags);
        else {
          console.log(red(`Unknown db subcommand: ${subArgs[0]}`));
          console.log(dim('Available: (none), checkpoint, backup, purge'));
        }
        break;

      case 'alerts':
      case 'alert':
        cmdAlerts(flags);
        break;

      case 'broker':
      case 'b':
        await cmdBroker(subArgs, flags);
        break;

      case 'positions':
      case 'pos':
        await cmdPositions(flags);
        break;

      case 'orders':
      case 'ord':
        await cmdOrders(flags);
        break;

      case 'balance':
      case 'bal':
        await cmdBalance(flags);
        break;

      case 'quote':
      case 'q':
        await cmdQuote(subArgs);
        break;

      case 'chain':
        await cmdChain(subArgs, flags);
        break;

      case 'gainloss':
      case 'gl':
      case 'pnl':
        await cmdGainloss(flags);
        break;

      case 'history':
      case 'hist':
        await cmdHistory(flags);
        break;

      case 'check':
      case 'healthcheck':
        await cmdCheck();
        break;

      case 'help':
      case '--help':
      case '-h':
        cmdHelp();
        break;

      default:
        console.log(red(`Unknown command: ${command}`));
        console.log(dim('Run `spxer-ctl help` for available commands.'));
        process.exit(1);
    }
  } catch (e: any) {
    console.error(red(`Error: ${e.message || e}`));
    process.exit(1);
  }
}

main();
