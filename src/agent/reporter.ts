/**
 * Reporter: writes agent status to a structured file each cycle
 * and maintains a rolling activity log for the orchestrator to read.
 */
import * as fs from 'fs';
import * as path from 'path';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const STATUS_FILE = path.join(LOGS_DIR, 'agent-status.json');
const ACTIVITY_LOG = path.join(LOGS_DIR, 'agent-activity.jsonl');
const MAX_ACTIVITY_LINES = 500;

// Agent suffix for per-agent status files (set via setAgentId)
let agentSuffix = '';

/**
 * Set the agent identifier for per-agent status files.
 * Call once at startup: setAgentId('spx').
 * Status writes to: logs/agent-status-spx.json.
 * Also writes the legacy logs/agent-status.json for backward compatibility.
 */
export function setAgentId(id: string): void {
  agentSuffix = id;
}

export interface AgentStatus {
  ts: number;
  timeET: string;
  cycle: number;
  mode: string;
  paper?: boolean;
  spxPrice: number;
  minutesToClose: number;
  contractsTracked: number;
  contractsWithBars: number;
  openPositions: number;
  dailyPnL: number;
  judgeCallsToday: number;
  lastAction: string;
  lastReasoning: string;
  scannerReads: { id: string; read: string; setups: number }[];
  nextCheckSecs: number;
  upSince: string;
  /** Task 3.3: OTOCO bracket protection counters for TP re-entries.
   *  Optional for backward compat with older status consumers. */
  executionCounters?: {
    tpReentriesAttempted: number;
    tpReentriesProtected: number;
    tpReentriesUnprotected: number;
  };
}

let startTime = new Date().toISOString();

export function writeStatus(status: AgentStatus): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const payload = JSON.stringify({ ...status, upSince: startTime }, null, 2);

    // Write agent-specific status file (e.g. agent-status-spx.json)
    if (agentSuffix) {
      fs.writeFileSync(path.join(LOGS_DIR, `agent-status-${agentSuffix}.json`), payload);
    }

    // Always write legacy shared file for backward compat (dashboard, HTTP API)
    fs.writeFileSync(path.join(LOGS_DIR, 'agent-status.json'), payload);
  } catch (e) {
    console.error('[reporter] Failed to write status:', (e as Error).message);
  }
}

export interface ActivityEntry {
  ts: number;
  timeET: string;
  cycle: number;
  event: 'scan' | 'escalate' | 'trade' | 'close' | 'error' | 'risk_block' | 'judge-panel';
  summary: string;
  details?: Record<string, unknown>;
}

export function logActivity(entry: ActivityEntry): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_LOG, JSON.stringify(entry) + '\n');

    // Trim if too long
    const content = fs.readFileSync(ACTIVITY_LOG, 'utf-8');
    const lines = content.trim().split('\n');
    if (lines.length > MAX_ACTIVITY_LINES) {
      fs.writeFileSync(ACTIVITY_LOG, lines.slice(-MAX_ACTIVITY_LINES).join('\n') + '\n');
    }
  } catch (e) {
    console.error('[reporter] Failed to log activity:', (e as Error).message);
  }
}

export function readStatus(): AgentStatus | null {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readRecentActivity(n: number = 20): ActivityEntry[] {
  try {
    const content = fs.readFileSync(ACTIVITY_LOG, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}
