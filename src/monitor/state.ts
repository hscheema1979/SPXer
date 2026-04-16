/**
 * Persistent Monitor State — survives session resets and process restarts.
 *
 * Tracks actions taken, positions seen, rejection baselines, and cooldowns.
 * Written to disk every cycle. The LLM session can reset all it wants —
 * this file is the ground truth for "what did we already do?"
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_FILE = path.join(process.cwd(), 'logs', 'monitor-state.json');

export interface ActionRecord {
  action: string;       // 'stop_agent' | 'close_position' | 'cancel_order' | 'cancel_all_orders'
  target: string;       // 'spx' | 'xsp' | order ID
  reason: string;
  timestamp: number;    // unix ms
}

export interface PositionSnapshot {
  symbol: string;
  qty: number;
  entryPrice: number;
  lastSeen: number;     // unix ms
}

export interface MonitorState {
  date: string;                       // YYYY-MM-DD — resets daily
  cycle: number;
  sessionStartedAt: number;           // unix ms
  
  // Action history — full audit trail for the day
  actions: ActionRecord[];
  
  // Cooldowns — when was each action type last used?
  lastActionTime: Record<string, number>;   // action type → unix ms
  
  // Position tracking — what we saw last cycle
  lastPositions: Record<string, PositionSnapshot[]>;  // account → positions
  
  // Rejection baseline — so we report NEW rejections, not historical total
  rejectionBaseline: Record<string, number>;  // account → count at baseline
  
  // Running summary — compacted history for LLM context
  daySummary: string;
  
  // Trade log — entries/exits we've observed
  tradesObserved: number;
  dailyPnlObserved: number;
}

const EMPTY_STATE: MonitorState = {
  date: '',
  cycle: 0,
  sessionStartedAt: Date.now(),
  actions: [],
  lastActionTime: {},
  lastPositions: {},
  rejectionBaseline: {},
  daySummary: 'No activity yet.',
  tradesObserved: 0,
  dailyPnlObserved: 0,
};

/** Load persistent state from disk, or create fresh if new day / missing */
export function loadMonitorState(): MonitorState {
  const today = new Date().toISOString().slice(0, 10);
  
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw) as MonitorState;
    
    // Reset on new day
    if (state.date !== today) {
      console.log(`[monitor-state] New day (${today}) — resetting state`);
      return { ...EMPTY_STATE, date: today, sessionStartedAt: Date.now() };
    }
    
    return state;
  } catch {
    return { ...EMPTY_STATE, date: today, sessionStartedAt: Date.now() };
  }
}

/** Save state to disk */
export function saveMonitorState(state: MonitorState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e: any) {
    console.error(`[monitor-state] Failed to save: ${e.message}`);
  }
}

/** Record an action and update cooldown */
export function recordAction(
  state: MonitorState,
  action: string,
  target: string,
  reason: string,
): void {
  const now = Date.now();
  state.actions.push({ action, target, reason, timestamp: now });
  state.lastActionTime[action] = now;
}

/** 
 * Check if an action is allowed (not in cooldown).
 * Returns { allowed: true } or { allowed: false, reason, remainingMs }
 */
export function checkCooldown(
  state: MonitorState,
  action: string,
  cooldownMs: number,
): { allowed: boolean; reason?: string; remainingMs?: number } {
  const lastTime = state.lastActionTime[action];
  if (!lastTime) return { allowed: true };
  
  const elapsed = Date.now() - lastTime;
  if (elapsed >= cooldownMs) return { allowed: true };
  
  const remaining = cooldownMs - elapsed;
  return {
    allowed: false,
    reason: `${action} on cooldown — last used ${Math.round(elapsed / 60000)} min ago, ${Math.round(remaining / 60000)} min remaining`,
    remainingMs: remaining,
  };
}

/**
 * Set the rejection baseline for an account.
 * Call this when the monitor first starts or after handling rejections.
 */
export function setRejectionBaseline(state: MonitorState, account: string, count: number): void {
  state.rejectionBaseline[account] = count;
}

/**
 * Get NEW rejections since baseline.
 */
export function getNewRejections(state: MonitorState, account: string, currentCount: number): number {
  const baseline = state.rejectionBaseline[account] ?? 0;
  return Math.max(0, currentCount - baseline);
}

/**
 * Build a context summary from persistent state for LLM injection.
 * This replaces the old 2-sentence carryover with structured history.
 */
export function buildStateContext(state: MonitorState): string {
  const parts: string[] = [];
  
  parts.push(`## Persistent Monitor State (survives session resets)`);
  parts.push(`Date: ${state.date} | Cycle: ${state.cycle} | Session age: ${Math.round((Date.now() - state.sessionStartedAt) / 60000)} min`);
  parts.push(`Trades observed today: ${state.tradesObserved} | Estimated P&L: $${state.dailyPnlObserved.toFixed(0)}`);
  parts.push('');
  
  // Recent actions
  if (state.actions.length > 0) {
    parts.push('### Actions Taken Today');
    const recent = state.actions.slice(-10); // last 10
    for (const a of recent) {
      const ago = Math.round((Date.now() - a.timestamp) / 60000);
      parts.push(`- ${ago} min ago: ${a.action} on ${a.target} — ${a.reason}`);
    }
    parts.push('');
  }
  
  // Cooldown status
  const cooldowns = Object.entries(state.lastActionTime);
  if (cooldowns.length > 0) {
    parts.push('### Action Cooldowns');
    for (const [action, lastTime] of cooldowns) {
      const ago = Math.round((Date.now() - lastTime) / 60000);
      parts.push(`- ${action}: last used ${ago} min ago`);
    }
    parts.push('');
  }
  
  // Day summary
  if (state.daySummary && state.daySummary !== 'No activity yet.') {
    parts.push('### Day Summary (compacted history)');
    parts.push(state.daySummary);
    parts.push('');
  }
  
  return parts.join('\n');
}
