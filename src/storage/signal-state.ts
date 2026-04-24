/**
 * Signal State — Transient state tracking in live DB
 *
 * Stores SignalState across PM2 restarts.
 * Auto-cleans when live DB rotates (daily).
 */

import type { Direction } from '../core/types';

export interface DirectionState {
  cross: Direction | null;
  prevFast: number | null;
  prevSlow: number | null;
  lastBarTs: number | null;
}

/**
 * Signal state for one contract/timeframe combination.
 * Matches the SignalState structure from strategy-engine.ts.
 */
export interface SignalState {
  // Direction HMA state (entry gating)
  directionCross: Direction | null;
  prevDirectionHmaFast: number | null;
  prevDirectionHmaSlow: number | null;
  lastDirectionBarTs: number | null;

  // Exit HMA state (signal reversal)
  exitCross: Direction | null;
  prevExitHmaFast: number | null;
  prevExitHmaSlow: number | null;
  lastExitBarTs: number | null;
}

/**
 * Create initial empty signal state.
 */
export function createInitialSignalState(): SignalState {
  return {
    directionCross: null,
    prevDirectionHmaFast: null,
    prevDirectionHmaSlow: null,
    lastDirectionBarTs: null,
    exitCross: null,
    prevExitHmaFast: null,
    prevExitHmaSlow: null,
    lastExitBarTs: null,
  };
}

/**
 * Load signal state from live DB.
 * Returns initial state if not found.
 */
export function loadSignalState(key: string): SignalState {
  try {
    const { dayDbPath, getDb } = require('./db');
    const today = require('../utils/et-time').todayET();
    const db = getDb(dayDbPath(today));

    const row = db.prepare('SELECT state_json FROM signal_state WHERE key = ?').get(key);
    if (row && row.state_json) {
      return JSON.parse(row.state_json);
    }
  } catch (e) {
    // DB not ready, return initial state
  }
  return createInitialSignalState();
}

/**
 * Save signal state to live DB.
 */
export function saveSignalState(key: string, state: SignalState): void {
  try {
    const { dayDbPath, getDb } = require('./db');
    const today = require('../utils/et-time').todayET();
    const db = getDb(dayDbPath(today));

    db.prepare(`
      INSERT INTO signal_state (key, state_json, updated_at)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(key) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(state));
  } catch (e) {
    console.warn(`[signal-state] Failed to save state for ${key}:`, e);
  }
}

/**
 * Ensure signal_state table exists in live DB.
 */
export function initSignalStateTable(): void {
  try {
    const { dayDbPath, getDb } = require('./db');
    const today = require('../utils/et-time').todayET();
    const db = getDb(dayDbPath(today));

    db.exec(`
      CREATE TABLE IF NOT EXISTS signal_state (
        key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  } catch (e) {
    console.warn('[signal-state] Failed to initialize table:', e);
  }
}
