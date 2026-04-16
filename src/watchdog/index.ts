/**
 * Watchdog — Independent safety monitor for SPXer trading agents.
 *
 * Design principles:
 *   1. NEVER cancel OCO/bracket orders. They are server-side protection at the
 *      broker — the whole point is they survive agent crashes. Cancelling them
 *      leaves positions naked.
 *   2. Restart before kill. If an agent is unresponsive, try restarting it first
 *      so it can reconcile positions and re-submit OCO protection.
 *   3. Thresholds must be compatible with the data pipeline. The data service
 *      polls SPX every ~60s, so heartbeat staleness of 60-90s is NORMAL.
 *      Only act on genuinely stale heartbeats (5+ minutes).
 *   4. Each agent gets its own status file. SPX writes agent-status-spx.json,
 *      XSP writes agent-status-xsp.json. No more clobbering.
 *   5. Escalating response: log → restart → kill (no order cancellation).
 *      Only kill after restart fails to recover the agent.
 */
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { config as appConfig } from '../config';

// ── Configuration ──────────────────────────────────────────────────────────

const SPXER_BASE = process.env.SPXER_URL || 'http://localhost:3600';
const LOGS_DIR = path.resolve('./logs');
const STATUS_FILE = path.join(LOGS_DIR, 'watchdog-status.json');
const CHECK_INTERVAL_MS = 30_000;        // 30s check cycle

// Heartbeat thresholds — escalating response
const HEARTBEAT_WARN_MS = 180_000;       // 3 min — log warning only
const HEARTBEAT_RESTART_MS = 300_000;    // 5 min — attempt restart
const HEARTBEAT_KILL_MS = 600_000;       // 10 min — kill (restart failed)

// Cooldown: don't restart the same agent more than once per 5 minutes
const RESTART_COOLDOWN_MS = 300_000;

const TRADIER_BASE = 'https://api.tradier.com/v1';

interface AgentWatch {
  name: string;            // Display name
  statusFile: string;      // Path to agent-specific status file
  pm2Name: string;         // PM2 process name
  accountId: string;       // Tradier account ID
  enabled: boolean;        // Whether to watch this agent
}

const AGENTS: AgentWatch[] = [
  {
    name: 'SPX Agent',
    statusFile: path.join(LOGS_DIR, 'agent-status-spx.json'),
    pm2Name: 'spxer-agent',
    accountId: process.env.TRADIER_ACCOUNT_ID || '6YA51425',
    enabled: true,
  },
  {
    name: 'XSP Agent',
    statusFile: path.join(LOGS_DIR, 'agent-status-xsp.json'),
    pm2Name: 'spxer-xsp',
    accountId: process.env.XSP_ACCOUNT_ID || '6YA58635',
    enabled: true,
  },
];

// Track last restart time per agent to enforce cooldown
const lastRestartTime: Record<string, number> = {};

// ── Types ──────────────────────────────────────────────────────────────────

export interface WatchdogStatus {
  ts: number;
  timeET: string;
  healthy: boolean;
  checks: {
    dataService: { healthy: boolean; status: string | null; responseTimeMs: number | null };
    agents: Record<string, {
      healthy: boolean;
      lastHeartbeatAge: number | null;
      action: string | null;
    }>;
  };
  actions: string[];
  uptimeSec: number;
}

// ── Core Functions ─────────────────────────────────────────────────────────

function tradierHeaders() {
  return {
    Authorization: `Bearer ${appConfig.tradierToken}`,
    Accept: 'application/json',
  };
}

/**
 * Read agent status file and extract timestamp.
 * Falls back to the legacy shared status file if agent-specific file doesn't exist.
 */
export function readAgentHeartbeat(statusFile: string): { ts: number; cycle: number } | null {
  try {
    const raw = fs.readFileSync(statusFile, 'utf-8');
    const data = JSON.parse(raw);
    return { ts: data.ts ?? 0, cycle: data.cycle ?? 0 };
  } catch {
    // Fallback: try legacy shared status file
    try {
      const legacyFile = path.join(LOGS_DIR, 'agent-status.json');
      const raw = fs.readFileSync(legacyFile, 'utf-8');
      const data = JSON.parse(raw);
      return { ts: data.ts ?? 0, cycle: data.cycle ?? 0 };
    } catch {
      return null;
    }
  }
}

/**
 * Check data service health endpoint.
 */
export async function checkDataService(url: string): Promise<{
  healthy: boolean;
  status: string | null;
  responseTimeMs: number | null;
  error?: string;
}> {
  const start = Date.now();
  try {
    const { data } = await axios.get(`${url}/health`, { timeout: 10_000 });
    const elapsed = Date.now() - start;
    const status = data?.status ?? 'unknown';
    const healthy = status !== 'critical' && status !== 'unreachable';
    return { healthy, status, responseTimeMs: elapsed };
  } catch (e: any) {
    const elapsed = Date.now() - start;
    return { healthy: false, status: 'unreachable', responseTimeMs: elapsed, error: e.message };
  }
}

/**
 * Check if a PM2 process is online.
 */
function isPm2Online(name: string): boolean {
  try {
    const pm2List = execSync('npx pm2 jlist --silent', { timeout: 10_000, stdio: 'pipe' }).toString();
    const procs = JSON.parse(pm2List);
    const proc = procs.find((p: any) => p.name === name);
    return proc?.pm2_env?.status === 'online';
  } catch {
    return false;
  }
}

/**
 * Get PM2 process uptime in ms (0 if not found/not online).
 */
function getPm2Uptime(name: string): number {
  try {
    const pm2List = execSync('npx pm2 jlist --silent', { timeout: 10_000, stdio: 'pipe' }).toString();
    const procs = JSON.parse(pm2List);
    const proc = procs.find((p: any) => p.name === name);
    if (proc?.pm2_env?.status === 'online') {
      return Date.now() - (proc.pm2_env?.pm_uptime ?? Date.now());
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Restart a PM2 process. Returns true if successful.
 */
export function restartPm2Process(name: string): boolean {
  try {
    execSync(`npx pm2 restart ${name} --silent`, { timeout: 15_000, stdio: 'pipe' });
    console.log(`[watchdog] 🔄 Restarted PM2 process: ${name}`);
    return true;
  } catch (e: any) {
    console.error(`[watchdog] Failed to restart ${name}: ${e.message}`);
    return false;
  }
}

/**
 * Kill a PM2 process by name. Last resort only.
 */
export function killPm2Process(name: string): boolean {
  try {
    execSync(`npx pm2 stop ${name} --silent`, { timeout: 15_000, stdio: 'pipe' });
    console.log(`[watchdog] 🛑 Stopped PM2 process: ${name}`);
    return true;
  } catch (e: any) {
    console.error(`[watchdog] Failed to stop ${name}: ${e.message}`);
    return false;
  }
}

/**
 * Check if an account has open positions (for logging/awareness only).
 */
export async function checkOpenPositions(accountId: string): Promise<number> {
  try {
    const { data } = await axios.get(
      `${TRADIER_BASE}/accounts/${accountId}/positions`,
      { headers: tradierHeaders(), timeout: 10_000 },
    );
    const positions = data?.positions?.position;
    if (!positions) return 0;
    const list = Array.isArray(positions) ? positions : [positions];
    return list.length;
  } catch {
    return -1; // Unknown
  }
}

/**
 * Write watchdog status file for dashboard consumption.
 */
export function writeWatchdogStatus(status: WatchdogStatus): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch (e: any) {
    console.error(`[watchdog] Failed to write status: ${e.message}`);
  }
}

/**
 * Read watchdog status file.
 */
export function readWatchdogStatus(): WatchdogStatus | null {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Main Check Cycle ───────────────────────────────────────────────────────

function etTime(): string {
  return new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false });
}

const startTime = Date.now();
const actions: string[] = [];

export async function runCheck(): Promise<WatchdogStatus> {
  const actionsThisCycle: string[] = [];

  // 1. Check data service
  const dsResult = await checkDataService(SPXER_BASE);

  // 2. Check each agent heartbeat
  const agentResults: WatchdogStatus['checks']['agents'] = {};
  for (const agent of AGENTS) {
    if (!agent.enabled) continue;

    const heartbeat = readAgentHeartbeat(agent.statusFile);
    let healthy = true;
    let action: string | null = null;
    let ageMs: number | null = null;

    const isOnline = isPm2Online(agent.pm2Name);

    if (heartbeat) {
      ageMs = Date.now() - heartbeat.ts;

      if (ageMs > HEARTBEAT_KILL_MS && isOnline) {
        // ── Level 3: Kill (10+ min stale, restart didn't help) ──
        healthy = false;
        const ageSec = Math.round(ageMs / 1000);
        const uptimeMs = getPm2Uptime(agent.pm2Name);

        // Only kill if process has been up long enough (not a fresh restart)
        if (uptimeMs > RESTART_COOLDOWN_MS) {
          const openPos = await checkOpenPositions(agent.accountId);
          console.warn(`[watchdog] 🛑 ${agent.name} heartbeat stale ${ageSec}s — killing (${openPos} open positions, OCO orders PRESERVED)`);
          killPm2Process(agent.pm2Name);
          action = `Killed ${agent.pm2Name} (heartbeat stale ${ageSec}s, ${openPos} positions — OCO preserved)`;
          actionsThisCycle.push(action);
        } else {
          action = `Heartbeat stale ${ageSec}s, but process restarted ${Math.round(uptimeMs / 1000)}s ago — waiting`;
        }

      } else if (ageMs > HEARTBEAT_RESTART_MS && isOnline) {
        // ── Level 2: Restart (5+ min stale) ──
        healthy = false;
        const ageSec = Math.round(ageMs / 1000);
        const now = Date.now();
        const lastRestart = lastRestartTime[agent.pm2Name] ?? 0;

        if (now - lastRestart > RESTART_COOLDOWN_MS) {
          const openPos = await checkOpenPositions(agent.accountId);
          console.warn(`[watchdog] 🔄 ${agent.name} heartbeat stale ${ageSec}s — restarting (${openPos} open positions, OCO orders PRESERVED)`);
          restartPm2Process(agent.pm2Name);
          lastRestartTime[agent.pm2Name] = now;
          action = `Restarted ${agent.pm2Name} (heartbeat stale ${ageSec}s, ${openPos} positions — OCO preserved)`;
          actionsThisCycle.push(action);
        } else {
          const cooldownLeft = Math.round((RESTART_COOLDOWN_MS - (now - lastRestart)) / 1000);
          action = `Heartbeat stale ${ageSec}s, restart on cooldown (${cooldownLeft}s remaining)`;
        }

      } else if (ageMs > HEARTBEAT_WARN_MS && isOnline) {
        // ── Level 1: Warn (3+ min stale) ──
        const ageSec = Math.round(ageMs / 1000);
        action = `Heartbeat stale ${ageSec}s — monitoring (warn threshold)`;
        // Don't mark unhealthy yet, just log
        console.log(`[watchdog] ⚠️ ${agent.name} heartbeat stale: ${ageSec}s (warn only)`);

      } else if (!isOnline && ageMs > HEARTBEAT_WARN_MS) {
        // Agent not running, stale heartbeat — just note it
        action = `Process not running, heartbeat stale ${Math.round(ageMs / 1000)}s — no action`;
      }

    } else {
      // No status file at all
      if (isOnline) {
        const uptimeMs = getPm2Uptime(agent.pm2Name);
        if (uptimeMs > RESTART_COOLDOWN_MS) {
          // Process online for 5+ min but never wrote status — something wrong
          healthy = false;
          console.warn(`[watchdog] ⚠️ ${agent.name} has no status file after ${Math.round(uptimeMs / 1000)}s — restarting`);
          restartPm2Process(agent.pm2Name);
          lastRestartTime[agent.pm2Name] = Date.now();
          action = `No status file after ${Math.round(uptimeMs / 1000)}s — restarted (OCO preserved)`;
          actionsThisCycle.push(action);
        } else {
          // Just started, give it time
          action = `No status file yet, process started ${Math.round(uptimeMs / 1000)}s ago — grace period`;
        }
      } else {
        // Not running, no file — normal stopped state
        healthy = true;
        action = null;
      }
    }

    agentResults[agent.name] = {
      healthy,
      lastHeartbeatAge: ageMs !== null ? Math.round(ageMs / 1000) : null,
      action,
    };
  }

  // Track actions
  actions.push(...actionsThisCycle);

  // Keep only last 50 actions
  if (actions.length > 50) actions.splice(0, actions.length - 50);

  const overallHealthy = dsResult.healthy && Object.values(agentResults).every(a => a.healthy);

  const status: WatchdogStatus = {
    ts: Date.now(),
    timeET: etTime(),
    healthy: overallHealthy,
    checks: {
      dataService: {
        healthy: dsResult.healthy,
        status: dsResult.status,
        responseTimeMs: dsResult.responseTimeMs,
      },
      agents: agentResults,
    },
    actions: actionsThisCycle,
    uptimeSec: Math.round((Date.now() - startTime) / 1000),
  };

  writeWatchdogStatus(status);

  if (!overallHealthy) {
    console.warn(`[watchdog] ⚠️ UNHEALTHY — data: ${dsResult.status}, agents: ${JSON.stringify(agentResults)}`);
  }

  return status;
}

// ── Main Loop ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[watchdog] Starting — checking every ${CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[watchdog] Monitoring: ${AGENTS.filter(a => a.enabled).map(a => a.name).join(', ')}`);
  console.log(`[watchdog] Thresholds: warn=${HEARTBEAT_WARN_MS / 1000}s, restart=${HEARTBEAT_RESTART_MS / 1000}s, kill=${HEARTBEAT_KILL_MS / 1000}s`);
  console.log(`[watchdog] POLICY: OCO/bracket orders are NEVER cancelled`);
  console.log(`[watchdog] Data service: ${SPXER_BASE}`);

  // Write initial status
  writeWatchdogStatus({
    ts: Date.now(),
    timeET: etTime(),
    healthy: true,
    checks: {
      dataService: { healthy: true, status: 'starting', responseTimeMs: null },
      agents: {},
    },
    actions: [],
    uptimeSec: 0,
  });

  // Run forever
  while (true) {
    try {
      await runCheck();
    } catch (e: any) {
      console.error(`[watchdog] Check failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

// Allow import without auto-running
if (require.main === module || process.argv[1]?.includes('watchdog')) {
  main().catch(e => {
    console.error('[watchdog] Fatal:', e);
    process.exit(1);
  });
}

export { AGENTS, main };
