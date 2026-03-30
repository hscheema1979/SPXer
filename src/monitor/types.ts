/**
 * Unified Account Monitor — Shared Types & Config
 */

/** Account identifier used across all monitor tools */
export type AccountKey = 'spx' | 'xsp';

/** Agent process identifier */
export type AgentKey = 'spx' | 'xsp';

/** Alert severity levels */
export type Severity = 'info' | 'warn' | 'alert';

/** Account configuration entry */
export interface AccountConfig {
  accountId: string;
  label: string;
  agentProcess: string;
  statusFile: string;
  activityFile: string;
}

/** Full accounts map */
export const ACCOUNTS: Record<AccountKey, AccountConfig> = {
  spx: {
    accountId: '6YA51425',
    label: 'SPX Margin',
    agentProcess: 'spxer-agent',
    statusFile: 'logs/agent-status.json',
    activityFile: 'logs/agent-activity.jsonl',
  },
  xsp: {
    accountId: '6YA58635',
    label: 'XSP Cash',
    agentProcess: 'spxer-xsp',
    statusFile: 'logs/agent-status.json',
    activityFile: 'logs/agent-activity.jsonl',
  },
};

/** Tradier API config */
export const TRADIER_BASE = 'https://api.tradier.com/v1';

export function tradierHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.TRADIER_TOKEN || ''}`,
    Accept: 'application/json',
  };
}

/** Standard tool result shape for Pi SDK */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

/** Helper to build a text tool result */
export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], details: {} };
}

/** Monitor log file path */
export const MONITOR_LOG_FILE = 'logs/account-monitor.log';

/** Staleness threshold in ms — status file older than this triggers a warning */
export const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
