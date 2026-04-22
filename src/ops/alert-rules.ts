/**
 * Centralized alert rules engine for SPXer.
 *
 * Periodically builds an AlertContext from the data service, agent status files,
 * PM2, and disk stats, then evaluates a configurable set of rules. Triggered
 * alerts are sent via sendAlert() (ntfy push + console), logged to
 * logs/alerts.jsonl, and kept in an in-memory ring buffer for API consumption.
 *
 * Maintenance mode (logs/agent-maintenance.json { active: true }) suppresses
 * push notifications — alerts are still evaluated and logged with a [MAINT] prefix.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { nowET } from '../utils/et-time';
import { sendAlert, type AlertSeverity } from './alerter';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AlertContext {
  health: any;                    // GET /health response
  pipeline: any;                  // GET /pipeline/health response
  agentSpx: any | null;           // logs/agent-status-spx.json
  maintenance: { active: boolean };
  processes: any[];               // pm2 jlist output
  diskFreeGb: number;
  timestamp: number;
}

export interface AlertRule {
  name: string;
  description: string;
  severity: AlertSeverity;
  cooldownSec: number;
  enabled: boolean;
  evaluate: (ctx: AlertContext) => { triggered: boolean; message: string } | null;
}

interface AlertHistoryEntry {
  ts: number;
  rule: string;
  severity: string;
  message: string;
}

// ─── Internal state ──────────────────────────────────────────────────────────

const LOGS_DIR = path.resolve(process.cwd(), 'logs');
const ALERTS_LOG = path.join(LOGS_DIR, 'alerts.jsonl');
const MAX_HISTORY = 100;

let _rules: AlertRule[] = [];
let _history: AlertHistoryEntry[] = [];
let _lastFired: Map<string, number> = new Map();   // rule name → last fire ts
let _interval: ReturnType<typeof setInterval> | null = null;

// State tracked across ticks
let _pipelineDownConsecutive = 0;
let _positionStuckSince: Map<string, number> = new Map(); // agentId → first seen ts

// ─── RTH detection ───────────────────────────────────────────────────────────

function isRTH(now = new Date()): boolean {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(now);
  if (day === 'Sat' || day === 'Sun') return false;

  const et = nowET(now);
  const hourDecimal = et.h + et.m / 60;
  return hourDecimal >= 9.5 && hourDecimal < 16.25;
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function httpGet(urlPath: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:3600${urlPath}`, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${urlPath}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout for ${urlPath}`)); });
  });
}

// ─── File readers ────────────────────────────────────────────────────────────

function readJsonFile(filePath: string): any | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getDiskFreeGb(): number {
  try {
    const out = execSync('df -BG / --output=avail | tail -1', { timeout: 5000, encoding: 'utf-8' });
    const match = out.trim().match(/(\d+)/);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function getPm2Processes(): any[] {
  try {
    const out = execSync('pm2 jlist', { timeout: 10000, encoding: 'utf-8' });
    return JSON.parse(out);
  } catch {
    return [];
  }
}

// ─── Context builder ─────────────────────────────────────────────────────────

async function buildContext(): Promise<AlertContext> {
  // Fetch API endpoints in parallel; failures yield null
  const [health, pipeline] = await Promise.all([
    httpGet('/health').catch(() => null),
    httpGet('/pipeline/health').catch(() => null),
  ]);

  const agentSpx = readJsonFile(path.join(LOGS_DIR, 'agent-status-spx.json'));
  const maintenance = readJsonFile(path.join(LOGS_DIR, 'agent-maintenance.json')) ?? { active: false };
  const processes = getPm2Processes();
  const diskFreeGb = getDiskFreeGb();

  return {
    health,
    pipeline,
    agentSpx,
    maintenance,
    processes,
    diskFreeGb,
    timestamp: Date.now(),
  };
}

// ─── Default rules ───────────────────────────────────────────────────────────

export function getDefaultRules(): AlertRule[] {
  return [
    // 1. pipeline-down
    {
      name: 'pipeline-down',
      description: 'Data pipeline /health is unreachable for 2+ consecutive checks',
      severity: 'critical',
      cooldownSec: 600,
      enabled: true,
      evaluate: (ctx) => {
        if (ctx.health === null) {
          _pipelineDownConsecutive++;
        } else {
          _pipelineDownConsecutive = 0;
          return null;
        }
        if (_pipelineDownConsecutive >= 2) {
          return {
            triggered: true,
            message: `Data service unreachable for ${_pipelineDownConsecutive} consecutive checks`,
          };
        }
        return null;
      },
    },

    // 2. spx-data-stale
    {
      name: 'spx-data-stale',
      description: 'SPX price data stale > 120s during RTH',
      severity: 'warning',
      cooldownSec: 300,
      enabled: true,
      evaluate: (ctx) => {
        if (!isRTH() || !ctx.health) return null;
        const providers = ctx.health.providers;
        if (!providers) return null;
        // Check tradier provider staleness from health endpoint
        // health.providers may have lastUpdate or similar — check lastSpxPrice age
        // Use pipeline health for more precise staleness
        if (ctx.pipeline?.providers?.tradier) {
          const lastSuccess = ctx.pipeline.providers.tradier.lastSuccessTs;
          if (lastSuccess > 0) {
            const staleSec = (ctx.timestamp - lastSuccess) / 1000;
            if (staleSec > 120) {
              return {
                triggered: true,
                message: `SPX data is ${Math.round(staleSec)}s stale (last success: ${new Date(lastSuccess).toISOString()})`,
              };
            }
          }
        }
        return null;
      },
    },

    // 3. agent-crashed
    {
      name: 'agent-crashed',
      description: 'Trading agent PM2 process not online during RTH',
      severity: 'critical',
      cooldownSec: 600,
      enabled: true,
      evaluate: (ctx) => {
        if (!isRTH()) return null;
        const agentNames = ['spxer-agent'];
        const crashed: string[] = [];
        for (const name of agentNames) {
          const proc = ctx.processes.find((p: any) => p.name === name);
          if (proc && proc.pm2_env?.status !== 'online') {
            crashed.push(`${name} (${proc.pm2_env?.status ?? 'unknown'})`);
          }
          // If process not found in pm2 at all, also flag it
          if (!proc) {
            crashed.push(`${name} (not in PM2)`);
          }
        }
        if (crashed.length > 0) {
          return {
            triggered: true,
            message: `Agent processes not online: ${crashed.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 4. agent-no-cycle
    {
      name: 'agent-no-cycle',
      description: 'Agent status file older than 5 minutes during RTH',
      severity: 'warning',
      cooldownSec: 900,
      enabled: true,
      evaluate: (ctx) => {
        if (!isRTH()) return null;
        const stale: string[] = [];
        const maxAgeMs = 5 * 60 * 1000;

        for (const [label, status] of [['SPX', ctx.agentSpx]] as const) {
          if (!status?.ts) continue;
          const ageMs = ctx.timestamp - status.ts;
          if (ageMs > maxAgeMs) {
            stale.push(`${label} (${Math.round(ageMs / 1000)}s old)`);
          }
        }
        if (stale.length > 0) {
          return {
            triggered: true,
            message: `Agent status stale: ${stale.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 5. daily-loss-limit
    {
      name: 'daily-loss-limit',
      description: 'Agent daily P&L below -$500 (informational only — does NOT stop trading)',
      severity: 'warning',
      cooldownSec: 1800,
      enabled: false,
      evaluate: (ctx) => {
        const breached: string[] = [];
        for (const [label, status] of [['SPX', ctx.agentSpx]] as const) {
          if (status && typeof status.dailyPnL === 'number' && status.dailyPnL < -500) {
            breached.push(`${label}: $${status.dailyPnL.toFixed(0)}`);
          }
        }
        if (breached.length > 0) {
          return {
            triggered: true,
            message: `Daily loss limit breached: ${breached.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 6. position-stuck
    {
      name: 'position-stuck',
      description: 'Position open for > 2 hours with no status change',
      severity: 'warning',
      cooldownSec: 1800,
      enabled: true,
      evaluate: (ctx) => {
        const twoHoursMs = 2 * 60 * 60 * 1000;
        const stuck: string[] = [];

        for (const [label, status] of [['SPX', ctx.agentSpx]] as const) {
          if (!status) continue;
          const key = `position-${label}`;

          if (status.openPositions > 0) {
            if (!_positionStuckSince.has(key)) {
              _positionStuckSince.set(key, ctx.timestamp);
            }
            const since = _positionStuckSince.get(key)!;
            if (ctx.timestamp - since > twoHoursMs) {
              const hrs = ((ctx.timestamp - since) / 3600000).toFixed(1);
              stuck.push(`${label} (open ${hrs}h)`);
            }
          } else {
            _positionStuckSince.delete(key);
          }
        }

        if (stuck.length > 0) {
          return {
            triggered: true,
            message: `Position possibly stuck: ${stuck.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 7. wal-oversized
    {
      name: 'wal-oversized',
      description: 'SQLite WAL file exceeds 200MB',
      severity: 'warning',
      cooldownSec: 3600,
      enabled: true,
      evaluate: (ctx) => {
        const walMb = ctx.health?.db?.walSizeMb;
        if (typeof walMb === 'number' && walMb > 200) {
          return {
            triggered: true,
            message: `WAL file is ${walMb.toFixed(0)}MB (threshold: 200MB)`,
          };
        }
        return null;
      },
    },

    // 8. db-oversized
    {
      name: 'db-oversized',
      description: 'Database exceeds 50GB',
      severity: 'warning',
      cooldownSec: 86400,
      enabled: true,
      evaluate: (ctx) => {
        const sizeMb = ctx.health?.db?.sizeMb;
        if (typeof sizeMb === 'number') {
          const sizeGb = sizeMb / 1024;
          if (sizeGb > 50) {
            return {
              triggered: true,
              message: `Database is ${sizeGb.toFixed(1)}GB (threshold: 50GB)`,
            };
          }
        }
        return null;
      },
    },

    // 9. disk-low
    {
      name: 'disk-low',
      description: 'Disk free space below 5GB',
      severity: 'critical',
      cooldownSec: 3600,
      enabled: true,
      evaluate: (ctx) => {
        if (ctx.diskFreeGb >= 0 && ctx.diskFreeGb < 5) {
          return {
            triggered: true,
            message: `Disk free space is ${ctx.diskFreeGb}GB (threshold: 5GB)`,
          };
        }
        return null;
      },
    },

    // 10. memory-high
    {
      name: 'memory-high',
      description: 'PM2 process memory exceeds 800MB',
      severity: 'warning',
      cooldownSec: 1800,
      enabled: true,
      evaluate: (ctx) => {
        const threshold = 800 * 1024 * 1024; // 800MB in bytes
        const high: string[] = [];

        for (const proc of ctx.processes) {
          const mem = proc.monit?.memory;
          if (typeof mem === 'number' && mem > threshold) {
            const memMb = Math.round(mem / (1024 * 1024));
            high.push(`${proc.name} (${memMb}MB)`);
          }
        }

        if (high.length > 0) {
          return {
            triggered: true,
            message: `High memory usage: ${high.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 11. circuit-breaker-open — transient during restarts, auto-heals in <90s
    {
      name: 'circuit-breaker-open',
      description: 'Pipeline circuit breaker in open state (transient during restarts)',
      severity: 'warning',
      cooldownSec: 900,
      enabled: false,
      evaluate: (ctx) => {
        if (!ctx.pipeline?.providers) return null;
        const open: string[] = [];

        for (const [name, provider] of Object.entries(ctx.pipeline.providers) as [string, any][]) {
          if (provider?.circuitState === 'open') {
            open.push(name);
          }
        }

        // Also check top-level circuitBreakers if present
        if (ctx.pipeline.circuitBreakers) {
          for (const [name, state] of Object.entries(ctx.pipeline.circuitBreakers)) {
            if (state === 'open') {
              open.push(name);
            }
          }
        }

        if (open.length > 0) {
          return {
            triggered: true,
            message: `Circuit breakers open: ${open.join(', ')}`,
          };
        }
        return null;
      },
    },

    // 12. db-write-failures — DISABLED: was firing on transient SQLite locking
    // during heavy option bar flushes. Metrics collector now uses separate DB.
    {
      name: 'db-write-failures',
      description: 'Pipeline reports DB write failures',
      severity: 'warning',
      cooldownSec: 900,
      enabled: false,
      evaluate: (ctx) => {
        const failed = ctx.pipeline?.db?.writesFailed;
        if (typeof failed === 'number' && failed > 0) {
          return {
            triggered: true,
            message: `${failed} DB write failures detected in pipeline`,
          };
        }
        return null;
      },
    },

    // 14. excessive-restarts — DISABLED: PM2 restart counts are cumulative
    // and never reset. Normal deploys trigger this constantly. Not actionable.
    {
      name: 'excessive-restarts',
      description: 'PM2 process restarted more than 5 times (cumulative, not useful)',
      severity: 'warning',
      cooldownSec: 3600,
      enabled: false,
      evaluate: (ctx) => {
        const restartThreshold = 5;
        const restarted: string[] = [];

        for (const proc of ctx.processes) {
          const restarts = proc.pm2_env?.restart_time ?? 0;
          if (restarts > restartThreshold) {
            restarted.push(`${proc.name} (${restarts}x)`);
          }
        }

        if (restarted.length > 0) {
          return {
            triggered: true,
            message: `Excessive PM2 restarts: ${restarted.join(', ')}`,
          };
        }
        return null;
      },
    },
  ];
}

// ─── Persistent log ──────────────────────────────────────────────────────────

function appendAlertLog(entry: AlertHistoryEntry): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(ALERTS_LOG, JSON.stringify(entry) + '\n');
  } catch (err: any) {
    console.warn(`[alert-rules] Failed to write alert log: ${err.message}`);
  }
}

// ─── Engine tick ─────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  let ctx: AlertContext;
  try {
    ctx = await buildContext();
  } catch (err: any) {
    console.warn(`[alert-rules] Failed to build context: ${err.message}`);
    return;
  }

  const isMaintenance = ctx.maintenance?.active === true;

  for (const rule of _rules) {
    if (!rule.enabled) continue;

    let result: { triggered: boolean; message: string } | null = null;
    try {
      result = rule.evaluate(ctx);
    } catch (err: any) {
      console.warn(`[alert-rules] Rule "${rule.name}" threw: ${err.message}`);
      continue;
    }

    if (!result || !result.triggered) continue;

    // Check cooldown
    const lastFired = _lastFired.get(rule.name) ?? 0;
    const cooldownMs = rule.cooldownSec * 1000;
    if (ctx.timestamp - lastFired < cooldownMs) continue;

    _lastFired.set(rule.name, ctx.timestamp);

    const prefix = isMaintenance ? '[MAINT] ' : '';
    const title = `${prefix}${rule.name}`;
    const message = `${prefix}${result.message}`;

    // Record in history
    const entry: AlertHistoryEntry = {
      ts: ctx.timestamp,
      rule: rule.name,
      severity: rule.severity,
      message: result.message,
    };
    _history.push(entry);
    if (_history.length > MAX_HISTORY) {
      _history = _history.slice(-MAX_HISTORY);
    }

    // Persist to JSONL
    appendAlertLog(entry);

    // Send push notification (unless maintenance)
    if (isMaintenance) {
      console.log(`[alert-rules] ${title}: ${result.message} (push suppressed — maintenance mode)`);
    } else {
      await sendAlert(
        `rules:${rule.name}`,
        title,
        message,
        rule.severity,
      );
    }
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start the alert engine. Loads default rules if none are set.
 * @param intervalMs  Check interval in milliseconds (default: 60000)
 */
export function startAlertEngine(intervalMs = 60_000): void {
  if (_interval) return; // already running

  if (_rules.length === 0) {
    _rules = getDefaultRules();
  }

  console.log(`[alert-rules] Starting alert engine (${_rules.filter(r => r.enabled).length} rules, ${intervalMs / 1000}s interval)`);

  // Run first tick immediately
  tick().catch((err) => console.warn(`[alert-rules] Initial tick failed: ${err.message}`));

  _interval = setInterval(() => {
    tick().catch((err) => console.warn(`[alert-rules] Tick failed: ${err.message}`));
  }, intervalMs);
}

/** Stop the alert engine. */
export function stopAlertEngine(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    console.log('[alert-rules] Alert engine stopped');
  }
}

/** Get alert history (last 100 entries). */
export function getAlertHistory(): AlertHistoryEntry[] {
  return [..._history];
}

/** Enable a rule by name. */
export function enableRule(name: string): void {
  const rule = _rules.find(r => r.name === name);
  if (rule) {
    rule.enabled = true;
    console.log(`[alert-rules] Enabled rule: ${name}`);
  } else {
    console.warn(`[alert-rules] Rule not found: ${name}`);
  }
}

/** Disable a rule by name. */
export function disableRule(name: string): void {
  const rule = _rules.find(r => r.name === name);
  if (rule) {
    rule.enabled = false;
    _lastFired.delete(name);
    console.log(`[alert-rules] Disabled rule: ${name}`);
  } else {
    console.warn(`[alert-rules] Rule not found: ${name}`);
  }
}

/** Get all rules (read-only snapshot). */
export function getRules(): AlertRule[] {
  return _rules.map(r => ({ ...r }));
}
