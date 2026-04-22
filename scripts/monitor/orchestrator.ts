/**
 * SPXer Orchestrator — monitors the trading agent, writes reports,
 * alerts on critical events. Calls GLM-5 for periodic summaries.
 *
 * Runs in its own tmux session alongside the agent.
 *
 * Usage: tmux new-session -d -s orchestrator 'cd /home/ubuntu/SPXer && npx tsx orchestrator.ts'
 */
import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';

const LOGS_DIR = path.join(process.cwd(), 'logs');
const STATUS_FILE = path.join(LOGS_DIR, 'agent-status.json');
const ACTIVITY_LOG = path.join(LOGS_DIR, 'agent-activity.jsonl');
const REPORT_FILE = path.join(LOGS_DIR, 'orchestrator-report.md');

const CHECK_INTERVAL_MS = 60_000;   // check every 60s
const REPORT_INTERVAL_MS = 300_000; // write report every 5 min
const STALE_THRESHOLD_MS = 120_000; // agent stale if no update in 2 min

// GLM-5 for summarization
const glm = new Anthropic({
  apiKey: process.env.GLM_API_KEY!,
  baseURL: process.env.GLM_BASE_URL || 'https://api.z.ai/api/anthropic',
});

interface AgentStatus {
  ts: number;
  timeET: string;
  cycle: number;
  mode: string;
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
}

function readStatus(): AgentStatus | null {
  try {
    return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8'));
  } catch { return null; }
}

function readRecentActivity(n: number = 20): string[] {
  try {
    const lines = fs.readFileSync(ACTIVITY_LOG, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-n);
  } catch { return []; }
}

function isAgentAlive(): boolean {
  try {
    execSync('tmux has-session -t agent 2>/dev/null');
    return true;
  } catch { return false; }
}

function restartAgent(): void {
  console.log('[orch] ⚠️  Restarting agent...');
  try {
    execSync('tmux kill-session -t agent 2>/dev/null');
  } catch { /* may already be dead */ }
  execSync("tmux new-session -d -s agent 'cd /home/ubuntu/SPXer && npx tsx spx_agent.ts 2>&1 | tee logs/agent.log'");
  console.log('[orch] Agent restarted');
}

let lastReportTime = 0;
let alertsSent: string[] = [];

function checkAlerts(status: AgentStatus | null): string[] {
  const alerts: string[] = [];

  if (!isAgentAlive()) {
    alerts.push('CRITICAL: Agent tmux session is DEAD');
    restartAgent();
  }

  if (!status) {
    alerts.push('WARNING: No agent status file found');
    return alerts;
  }

  const staleness = Date.now() - status.ts;
  if (staleness > STALE_THRESHOLD_MS) {
    alerts.push(`WARNING: Agent status stale (${Math.round(staleness / 1000)}s old)`);
  }

  if (status.dailyPnL < 0 && Math.abs(status.dailyPnL) > 1500) {
    alerts.push(`RISK: Daily P&L at $${status.dailyPnL.toFixed(2)} — approaching $2000 limit`);
  }

  if (status.lastAction === 'buy' || status.lastAction === 'sell_to_close') {
    const key = `${status.cycle}-${status.lastAction}`;
    if (!alertsSent.includes(key)) {
      alerts.push(`TRADE: ${status.lastAction.toUpperCase()} executed at cycle #${status.cycle}`);
      alertsSent.push(key);
      if (alertsSent.length > 100) alertsSent = alertsSent.slice(-50);
    }
  }

  if (status.judgeCallsToday > 0) {
    alerts.push(`INFO: Opus judge called ${status.judgeCallsToday} time(s) today`);
  }

  return alerts;
}

async function writeReport(status: AgentStatus | null, alerts: string[]): Promise<void> {
  const alive = isAgentAlive();
  const activity = readRecentActivity(10);
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

  let scannerBlock = 'No scanner data';
  if (status?.scannerReads) {
    scannerBlock = status.scannerReads
      .map(sr => `- **${sr.id}**: ${sr.read.slice(0, 120)} (${sr.setups} setups)`)
      .join('\n');
  }

  const activityBlock = activity.length === 0
    ? 'No recent events'
    : activity.map(l => {
        try {
          const e = JSON.parse(l);
          return `- ${e.timeET}: [${e.event}] ${e.summary}`;
        } catch { return `- ${l.slice(0, 80)}`; }
      }).join('\n');

  const alertBlock = alerts.length === 0
    ? 'None'
    : alerts.map(a => `- ${a}`).join('\n');

  const report = `# SPXer Agent Report — ${now}

**Status**: ${alive ? (status ? 'Running' : 'Running (no status yet)') : 'DEAD'}
**Cycle**: #${status?.cycle ?? '?'} | **SPX**: $${status?.spxPrice?.toFixed(2) ?? '?'} | **Mode**: ${status?.mode ?? '?'}
**Contracts**: ${status?.contractsTracked ?? 0} tracked (${status?.contractsWithBars ?? 0} with bars)
**Positions**: ${status?.openPositions ?? 0}/2 | **Daily P&L**: $${status?.dailyPnL?.toFixed(2) ?? '0'}
**Judge calls**: ${status?.judgeCallsToday ?? 0} today
**Next check**: ${status?.nextCheckSecs ?? '?'}s

## Last Assessment
${status?.lastReasoning ?? 'None'}

## Scanner Reads
${scannerBlock}

## Recent Events
${activityBlock}

## Alerts
${alertBlock}
`;

  fs.writeFileSync(REPORT_FILE, report);
  console.log(`[orch] Report written @ ${now}`);
}

async function main(): Promise<void> {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   SPXer Orchestrator (GLM-5 powered)  ║');
  console.log('║   Check: 60s | Report: 5min           ║');
  console.log('╚═══════════════════════════════════════╝\n');

  while (true) {
    const status = readStatus();
    const alerts = checkAlerts(status);

    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const spx = status?.spxPrice?.toFixed(2) ?? '?';
    const cycle = status?.cycle ?? '?';
    const action = status?.lastAction ?? '?';
    console.log(`[orch] ${ts} | SPX $${spx} | cycle #${cycle} | action: ${action} | alerts: ${alerts.length}`);

    if (alerts.length > 0) {
      alerts.forEach(a => console.log(`[orch] ⚠️  ${a}`));
    }

    // Write report every 5 minutes
    if (Date.now() - lastReportTime > REPORT_INTERVAL_MS) {
      await writeReport(status, alerts);
      lastReportTime = Date.now();
    }

    await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

process.on('SIGTERM', () => { console.log('\n[orch] Shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('\n[orch] Shutting down'); process.exit(0); });

main().catch(e => { console.error('[orch] Fatal:', e); process.exit(1); });
