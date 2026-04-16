/**
 * Unified Account Monitor — Engine
 *
 * Pure infrastructure: scheduling, alert deduplication, session management,
 * and data collection. No LLM SDK dependency.
 */

import { nowET, todayET } from '../utils/et-time';
import type { Severity } from './types';
import { isMaintenanceActive } from './types';
import { loadMonitorState, buildStateContext } from './state';

// ── Market Hours Scheduler ──────────────────────────────────────────────────

/** Monitor operating mode based on time of day */
export type MonitorMode = 'pre-market' | 'rth' | 'post-close' | 'overnight' | 'closed';

export interface ScheduleResult {
  intervalMs: number;
  mode: MonitorMode;
}

/**
 * Market holidays — US equity markets closed.
 */
const HOLIDAYS = new Set([
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01',
  '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-06-19', '2026-07-03', '2026-08-31',
  '2026-11-26', '2026-12-25',
]);

/** Early close days — market closes at 1:00 PM ET */
const EARLY_CLOSE_DAYS = new Set([
  '2025-07-03', '2025-11-28',
  '2026-07-02', '2026-11-27',
]);

/** Intervals per mode */
const INTERVALS: Record<MonitorMode, number> = {
  'pre-market': 5 * 60 * 1000,    // 5 min
  'rth':        30 * 1000,         // 30 sec
  'post-close': 2 * 60 * 1000,    // 2 min
  'overnight':  30 * 60 * 1000,   // 30 min
  'closed':     0,                 // don't run
};

/**
 * Determine the current monitor interval and mode based on ET time.
 * Injectable `now` for testing.
 */
export function getMonitorInterval(now = new Date()): ScheduleResult {
  const today = todayET(now);
  const { h, m } = nowET(now);
  const minuteOfDay = h * 60 + m;

  // Weekend check: Saturday (6) or Sunday (0)
  const dayOfWeek = getDayOfWeekET(now);
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return { intervalMs: INTERVALS.closed, mode: 'closed' };
  }

  // Holiday check
  if (HOLIDAYS.has(today)) {
    return { intervalMs: INTERVALS.closed, mode: 'closed' };
  }

  // Early close days: market closes at 13:00 ET
  const isEarlyClose = EARLY_CLOSE_DAYS.has(today);
  const closeMinute = isEarlyClose ? 13 * 60 : 16 * 60;       // 1:00 PM or 4:00 PM
  const postCloseEnd = closeMinute + 30;                        // +30 min wind-down

  // Time windows (in minutes from midnight ET)
  const preMarketStart = 8 * 60;   // 8:00 AM
  const rthStart = 9 * 60 + 30;    // 9:30 AM

  if (minuteOfDay < preMarketStart) {
    return { intervalMs: INTERVALS.overnight, mode: 'overnight' };
  }
  if (minuteOfDay < rthStart) {
    return { intervalMs: INTERVALS['pre-market'], mode: 'pre-market' };
  }
  if (minuteOfDay < closeMinute) {
    return { intervalMs: INTERVALS.rth, mode: 'rth' };
  }
  if (minuteOfDay < postCloseEnd) {
    return { intervalMs: INTERVALS['post-close'], mode: 'post-close' };
  }
  // After post-close window
  return { intervalMs: INTERVALS.overnight, mode: 'overnight' };
}

/**
 * Get day of week in ET. 0=Sunday, 6=Saturday.
 */
function getDayOfWeekET(now: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? '';
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  return map[weekday] ?? 0;
}

/** Check if today is an early close day */
export function isEarlyCloseDay(now = new Date()): boolean {
  return EARLY_CLOSE_DAYS.has(todayET(now));
}

// ── Alert Deduplicator ──────────────────────────────────────────────────────

interface AlertEntry {
  count: number;
  firstSeen: number;   // ms timestamp
  lastSeen: number;
  severity: Severity;
  message: string;      // original message for summary
}

/** Dedup window in ms — suppress identical alerts within this window */
const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Alert deduplication. Suppresses repeated identical alerts within a 5-minute
 * window and produces summary lines when the condition persists.
 */
export class AlertDedup {
  private entries = new Map<string, AlertEntry>();
  private dedupWindowMs: number;

  constructor(dedupWindowMs = DEDUP_WINDOW_MS) {
    this.dedupWindowMs = dedupWindowMs;
  }

  /**
   * Check if an alert should be logged.
   *
   * Returns:
   *   { log: true }                     — first occurrence, log it
   *   { log: false }                    — duplicate within window, suppress
   *   { log: true, summary: "..." }     — window elapsed, log summary instead
   */
  shouldLog(
    message: string,
    severity: Severity,
    now = Date.now(),
  ): { log: boolean; summary?: string } {
    const hash = this.computeHash(message, severity);
    const existing = this.entries.get(hash);

    if (!existing) {
      // First occurrence — log it, start tracking
      this.entries.set(hash, {
        count: 1,
        firstSeen: now,
        lastSeen: now,
        severity,
        message,
      });
      this.pruneOld(now);
      return { log: true };
    }

    const elapsed = now - existing.firstSeen;
    existing.count++;
    existing.lastSeen = now;

    if (elapsed < this.dedupWindowMs) {
      // Within window — suppress
      return { log: false };
    }

    // Window elapsed and condition persists — emit summary, reset tracking
    const durationMin = Math.round(elapsed / 60_000);
    const summary = `${this.truncate(existing.message, 80)} (×${existing.count} over ${durationMin} min) — still unresolved`;

    // Reset for next window
    this.entries.set(hash, {
      count: 1,
      firstSeen: now,
      lastSeen: now,
      severity,
      message,
    });

    return { log: true, summary };
  }

  /** Get count of currently tracked unique alerts */
  get activeCount(): number {
    return this.entries.size;
  }

  /** Clear all tracked alerts */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Simple hash: normalize whitespace, lowercase, then take first 120 chars.
   * We hash on the core content, not exact wording — so slight LLM rephrasing
   * of the same issue still deduplicates.
   */
  private computeHash(message: string, severity: string): string {
    // Extract key financial figures and keywords for dedup
    const normalized = message
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/\$[\d,.-]+/g, '$X')           // normalize dollar amounts
      .replace(/\d{1,2}:\d{2}(:\d{2})?/g, 'T') // normalize timestamps
      .replace(/#\d+/g, '#N')                   // normalize order IDs
      .replace(/cycle\s*#?\d+/gi, 'cycle')      // normalize cycle numbers
      .trim();
    // Use severity + first 120 chars of normalized content as hash key
    return `${severity}:${normalized.slice(0, 120)}`;
  }

  private truncate(s: string, maxLen: number): string {
    return s.length <= maxLen ? s : s.slice(0, maxLen - 3) + '...';
  }

  /** Remove entries older than 2x the dedup window */
  private pruneOld(now: number): void {
    const cutoff = now - this.dedupWindowMs * 2;
    for (const [hash, entry] of this.entries) {
      if (entry.lastSeen < cutoff) {
        this.entries.delete(hash);
      }
    }
  }
}

// ── Session Cycle Manager ───────────────────────────────────────────────────

const DEFAULT_RESET_INTERVAL = 120; // 120 cycles × 30s = 1 hour

/**
 * Tracks cycle count and manages LLM session resets to prevent
 * context window bloat. Resets every N cycles, carrying forward
 * a condensed summary.
 */
export class SessionCycleManager {
  private cycle = 0;
  private resetInterval: number;
  private lastAssessment = '';

  constructor(resetInterval = DEFAULT_RESET_INTERVAL) {
    this.resetInterval = resetInterval;
  }

  /** Increment and return current cycle number */
  tick(): number {
    return ++this.cycle;
  }

  /** Get current cycle count */
  getCycleCount(): number {
    return this.cycle;
  }

  /** Should the LLM session be reset this cycle? */
  shouldReset(): boolean {
    return this.cycle > 1 && this.cycle % this.resetInterval === 1;
  }

  /** Store the last LLM assessment for carryover */
  setLastAssessment(assessment: string): void {
    this.lastAssessment = assessment;
  }

  /** Get the last stored assessment */
  getLastAssessment(): string {
    return this.lastAssessment;
  }

  /**
   * Build a compaction prompt — asks the LLM to summarize the session
   * before we reset it. The summary is stored in persistent state.
   */
  buildCompactionPrompt(): string {
    return [
      'SESSION COMPACTION: Your conversation history is about to be reset for memory management.',
      'Please produce a structured summary of everything important from this monitoring session.',
      '',
      'Include in your summary:',
      '- Current positions and their P&L status',
      '- Any actions you took and their outcomes',
      '- Any ongoing issues or concerns',
      '- Trade entries/exits you observed',
      '- Current market direction and agent alignment',
      '- Rejection counts and whether they are resolved',
      '',
      'Format as a JSON object:',
      '```json',
      '{',
      '  "severity": "info",',
      '  "assessment": "COMPACTION SUMMARY: [your full summary here]",',
      '  "positions_summary": "description of current positions",',
      '  "issues_active": ["list of unresolved issues"],',
      '  "issues_resolved": ["list of issues that were resolved this session"],',
      '  "actions_taken": ["list of actions taken this session"]',
      '}',
      '```',
    ].join('\n');
  }

  /**
   * Build carryover context from persistent state + last compaction summary.
   */
  buildCarryoverSummary(lastAssessment?: string): string {
    const text = lastAssessment ?? this.lastAssessment;
    if (!text) {
      return 'This is a fresh monitoring session. No prior context.';
    }

    return [
      'CONTEXT FROM PREVIOUS SESSION (compacted to save memory):',
      '',
      text,
      '',
      'Continue monitoring from this state. You have FULL HISTORY above.',
      'Do not repeat actions already taken — check the persistent state for cooldowns.',
    ].join('\n');
  }
}

// ── Data Collector ──────────────────────────────────────────────────────────

/**
 * Tool function signatures — matches what tools.ts will export.
 * Using a dependency-injected interface so engine.ts has no import on tools.ts,
 * making it testable with mocks.
 */
export interface MonitorTools {
  getPositions(account: 'spx' | 'xsp' | 'both'): Promise<string>;
  getOrders(account: 'spx' | 'xsp' | 'both', statusFilter: string): Promise<string>;
  getBalance(account: 'spx' | 'xsp' | 'both'): Promise<string>;
  getMarketSnapshot(): Promise<string>;
  getAgentStatus(agent: 'spx' | 'xsp' | 'both'): Promise<string>;
  checkSystemHealth(): Promise<string>;
}

/**
 * Pre-collect all relevant data based on the current monitor mode.
 * Returns a structured text snapshot the LLM can analyze directly,
 * eliminating the need for the LLM to call tools itself.
 *
 * This is cheaper (no tool-use round-trips) and faster.
 */
export async function collectPreLLMData(
  mode: MonitorMode,
  cycle: number,
  tools: MonitorTools,
): Promise<string> {
  const { h, m } = nowET();
  const timeStr = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;
  const header = `═══ MONITOR CYCLE #${cycle} | ${timeStr} | Mode: ${mode.toUpperCase()} ═══`;

  const sections: string[] = [header, ''];

  // Inject persistent state — actions taken, cooldowns, day summary
  const persistentState = loadMonitorState();
  persistentState.cycle = cycle;
  sections.push(buildStateContext(persistentState), '');

  // Check maintenance mode
  const maint = isMaintenanceActive();
  if (maint.active) {
    sections.push(
      '## ⚠️ MAINTENANCE MODE ACTIVE',
      `Reason: ${maint.reason}`,
      'All remediation tools (close_position, cancel_order, cancel_all_orders, stop_agent) are BLOCKED.',
      'Do NOT attempt to close positions or cancel orders. The agent is being restarted.',
      'Positions with OTOCO bracket orders are protected server-side at Tradier.',
      '',
    );
  }

  try {
    if (mode === 'overnight') {
      // Minimal checks — only system health
      const health = await tools.checkSystemHealth();
      sections.push('## System Health', health, '');
    } else if (mode === 'pre-market') {
      // Light checks — balance, system, agent readiness
      const [balance, health, status] = await Promise.all([
        tools.getBalance('both'),
        tools.checkSystemHealth(),
        tools.getAgentStatus('both'),
      ]);
      sections.push('## Account Balances', balance, '');
      sections.push('## System Health', health, '');
      sections.push('## Agent Status', status, '');
    } else if (mode === 'post-close') {
      // Wind-down — positions should be closed, check final state
      const [positions, balance, orders, status, health] = await Promise.all([
        tools.getPositions('both'),
        tools.getBalance('both'),
        tools.getOrders('both', 'all'),
        tools.getAgentStatus('both'),
        tools.checkSystemHealth(),
      ]);
      sections.push('## Open Positions (should be none post-close)', positions, '');
      sections.push('## Account Balances', balance, '');
      sections.push('## Today\'s Orders', orders, '');
      sections.push('## Agent Status', status, '');
      sections.push('## System Health', health, '');
    } else if (mode === 'rth') {
      // Full RTH check — everything
      const [positions, orders, rejectedOrders, balance, snapshot, status, health] = await Promise.all([
        tools.getPositions('both'),
        tools.getOrders('both', 'open'),
        tools.getOrders('both', 'rejected'),
        tools.getBalance('both'),
        tools.getMarketSnapshot(),
        tools.getAgentStatus('both'),
        tools.checkSystemHealth(),
      ]);
      sections.push('## Open Positions', positions, '');
      sections.push('## Open Orders', orders, '');
      sections.push('## Rejected Orders', rejectedOrders, '');
      sections.push('## Account Balances', balance, '');
      sections.push('## SPX Market Snapshot', snapshot, '');
      sections.push('## Agent Status', status, '');
      sections.push('## System Health', health, '');
    }
  } catch (e: any) {
    sections.push(`## Data Collection Error`, `Failed to collect some data: ${e.message}`, '');
  }

  return sections.join('\n');
}

// ── Logger ──────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import { MONITOR_LOG_FILE } from './types';

/**
 * Append a timestamped, severity-tagged entry to the monitor log.
 * Also writes to stdout for PM2 capture.
 */
export function logEntry(
  message: string,
  severity: Severity = 'info',
  logFile = MONITOR_LOG_FILE,
): void {
  const ts = new Date().toISOString();
  const tag = severity.toUpperCase();
  const line = `[${ts}] [${tag}] ${message}`;
  fs.mkdirSync('logs', { recursive: true });
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
}
