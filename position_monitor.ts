#!/usr/bin/env tsx
/**
 * Position Monitor Service — PURE OBSERVER
 *
 * INDEPENDENT service that monitors open positions and logs state.
 * Does NOT execute trades — event handler handles all actions (entries, flips, exits).
 *
 * Responsibilities:
 * - Poll account.db for open positions
 * - Fetch current prices from Tradier REST API
 * - Fetch SPX HMA state from Tradier REST API
 * - Evaluate and LOG exit conditions (TP/SL, time, reversal)
 * - Update high water marks in DB
 * - Log broker state changes (fills, cancellations)
 *
 * Runs independently of event handler and spxer - true microservice.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { evaluateExit, type CorePositionWithHwm } from './src/core/trade-manager';
import { initAccountDb, closeAccountDb, getAccountDb } from './src/storage/db';
import { createStore } from './src/replay/store';
import type { Config } from './src/config/types';
import { computeCloseCutoff } from './src/utils/et-time';
import { makeHMAState, hmaStep } from './src/pipeline/indicators/tier1';

// ── Configuration ────────────────────────────────────────────────────────────

const TRADIER_BASE = 'https://api.tradier.com';
const TRADIER_TOKEN = process.env.TRADIER_TOKEN;

const POLL_INTERVAL_MS = 10_000;  // 10 seconds
const CONFIG_IDS = process.env.AGENT_CONFIG_IDS
  ? process.env.AGENT_CONFIG_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : [process.env.AGENT_CONFIG_ID || 'default'];

// ── State ─────────────────────────────────────────────────────────────────────

const configs = new Map<string, Config>();
let spxHmaState: { direction: 'bullish' | 'bearish' | null; fresh: boolean } = {
  direction: null,
  fresh: false,
};
let running = true;

// SPX HMA state for reversal detection
const spxHma3State = makeHMAState(3);
const spxHma12State = makeHMAState(12);

// ── Types ─────────────────────────────────────────────────────────────────────

interface DbPosition {
  id: string;
  config_id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  entry_price: number;
  quantity: number;
  stop_loss: number;
  take_profit: number | null;
  high_water: number;
  status: string;
  opened_at: number;
  basket_member: string | null;
}

// ── Helper Functions ───────────────────────────────────────────────────────────

function getTradierToken(): string {
  const token = process.env.TRADIER_TOKEN;
  if (!token) {
    throw new Error('TRADIER_TOKEN not set in environment');
  }
  return token;
}

// ── Load Configs ─────────────────────────────────────────────────────────────

function loadConfigs(): void {
  const store = createStore();

  for (const configId of CONFIG_IDS) {
    const cfg = store.getConfig(configId);
    if (!cfg) {
      console.error(`[position-monitor] Failed to load config: ${configId}`);
      continue;
    }
    configs.set(configId, cfg);
    console.log(`[position-monitor] Loaded config '${configId}'`);
  }

  store.close();
}

// ── Fetch SPX HMA State (from Tradier, not spxer) ───────────────────────────

async function fetchSpxHmaState(): Promise<void> {
  try {
    // Fetch SPX timesales from Tradier
    const resp = await axios.get(`${TRADIER_BASE}/v1/markets/timesales`, {
      params: {
        symbol: 'SPX',
        interval: '1min',
        session_filter: 'all',
      },
      headers: {
        'Authorization': `Bearer ${getTradierToken()}`,
        'Accept': 'application/json'
      },
    });

    const bars = resp.data?.series?.data || [];
    if (bars.length < 12) {
      console.log(`[position-monitor] Not enough SPX bars for HMA (${bars.length} < 12)`);
      return; // Not enough data for HMA
    }

    // Compute HMA(3) and HMA(12) from SPX bars
    const state3 = makeHMAState(3);
    const state12 = makeHMAState(12);
    const hma3Vals: number[] = [];
    const hma12Vals: number[] = [];

    for (const bar of bars) {
      const h3 = hmaStep(state3, bar.close);
      const h12 = hmaStep(state12, bar.close);
      if (h3 !== null) hma3Vals.push(h3);
      if (h12 !== null) hma12Vals.push(h12);
    }

    if (hma3Vals.length < 2 || hma12Vals.length < 2) {
      return;
    }

    const currHma3 = hma3Vals[hma3Vals.length - 1];
    const currHma12 = hma12Vals[hma12Vals.length - 1];
    const currDirection = currHma3 > currHma12 ? 'bullish' : 'bearish';

    // Check for reversal
    if (currDirection !== spxHmaState.direction) {
      spxHmaState = { direction: currDirection, fresh: true };
      console.log(`[position-monitor] 🔄 SPX HMA reversal: ${currDirection.toUpperCase()} (HMA3=${currHma3.toFixed(2)}, HMA12=${currHma12.toFixed(2)})`);
    } else {
      spxHmaState.fresh = false;
    }
  } catch (e) {
    console.error('[position-monitor] Failed to fetch SPX HMA state from Tradier:', e);
  }
}

// ── Fetch Option Price (from Tradier, not spxer) ─────────────────────────────

async function fetchOptionPrice(symbol: string): Promise<number | null> {
  try {
    const resp = await axios.get(`${TRADIER_BASE}/v1/markets/quotes`, {
      params: { symbols: symbol },
      headers: {
        'Authorization': `Bearer ${getTradierToken()}`,
        'Accept': 'application/json'
      },
    });

    const quote = resp.data?.quotes?.quote;
    return quote?.last || quote?.mid || null;
  } catch (e) {
    console.error(`[position-monitor] Failed to fetch price for ${symbol}:`, e);
    return null;
  }
}

// ── Monitor Positions (Observer Only — No Execution) ─────────────────────────

async function monitorPositions(): Promise<void> {
  const db = getAccountDb();
  const now = Date.now() / 1000;

  // Fetch all open positions from DB
  const positions = db.prepare(`
    SELECT id, config_id, symbol, side, strike, entry_price, quantity,
           stop_loss, take_profit, high_water, status, opened_at, basket_member
    FROM positions
    WHERE status IN ('OPEN', 'OPENING')
  `).all() as DbPosition[];

  if (positions.length === 0) {
    return;  // No positions to monitor
  }

  console.log(`[position-monitor] Monitoring ${positions.length} open position(s)`);

  for (const pos of positions) {
    const config = configs.get(pos.config_id);
    if (!config) {
      console.error(`[position-monitor] Config not found: ${pos.config_id}`);
      continue;
    }

    try {
      // Fetch current price from Tradier (independent of spxer)
      const currentPrice = await fetchOptionPrice(pos.symbol);

      if (currentPrice === null) {
        console.warn(`[position-monitor] No price available for ${pos.symbol}`);
        continue;
      }

      // Update high water mark
      const newHighWater = Math.max(pos.high_water, currentPrice);
      if (newHighWater > pos.high_water) {
        db.prepare('UPDATE positions SET high_water = ? WHERE id = ?')
          .run(newHighWater, pos.id);
        console.log(`[position-monitor] [${pos.config_id}] [${pos.basket_member || 'main'}] ${pos.symbol} x${pos.quantity} high water updated: $${newHighWater.toFixed(2)}`);
      }

      // Build core position object
      const corePos: CorePositionWithHwm = {
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        strike: pos.strike,
        qty: pos.quantity,
        entryPrice: pos.entry_price,
        stopLoss: pos.stop_loss,
        takeProfit: pos.take_profit,
        entryTs: pos.opened_at,
        highWaterPrice: newHighWater,
      };

      // Evaluate exit conditions (OBSERVER ONLY — log, don't execute)
      const closeCutoffTs = computeCloseCutoff(config);
      const exitDecision = evaluateExit(
        corePos,
        currentPrice,
        spxHmaState.direction,
        spxHmaState.fresh,
        config,
        now,
        closeCutoffTs,
      );

      if (exitDecision) {
        // Log exit condition detected — event handler will execute
        console.log(`[position-monitor] [${pos.config_id}] [${pos.basket_member || 'main'}] ⚠️ EXIT CONDITION: ${pos.symbol} x${pos.quantity} @ $${currentPrice.toFixed(2)} — ${exitDecision.reason.toUpperCase()}`);
        console.log(`[position-monitor] → Entry: $${pos.entry_price.toFixed(2)} | TP: $${pos.take_profit?.toFixed(2) || 'N/A'} | SL: $${pos.stop_loss.toFixed(2)} | HWM: $${newHighWater.toFixed(2)}`);
      } else {
        // Log current state
        const unrealizedPnl = (currentPrice - pos.entry_price) * pos.quantity * 100;
        console.log(`[position-monitor] [${pos.config_id}] [${pos.basket_member || 'main'}] ${pos.symbol} x${pos.quantity} @ $${currentPrice.toFixed(2)} | P&L: $${unrealizedPnl.toFixed(2)} | HWM: $${newHighWater.toFixed(2)}`);
      }
    } catch (e: any) {
      console.error(`[position-monitor] Error monitoring ${pos.id}:`, e.message);
    }
  }
}

// ── Monitoring Loop ───────────────────────────────────────────────────────────

async function monitoringLoop(): Promise<void> {
  while (running) {
    try {
      await fetchSpxHmaState();
      await monitorPositions();
    } catch (e) {
      console.error('[position-monitor] Error in monitoring loop:', e);
    }

    // Wait before next poll
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('[position-monitor] Position Monitor Service starting (OBSERVER MODE — no execution)...');
  console.log(`[position-monitor] Configs: ${CONFIG_IDS.join(', ')}`);
  console.log(`[position-monitor] Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log('[position-monitor] INDEPENDENT MODE: Fetching from Tradier REST API (no spxer dependency)');
  console.log('[position-monitor] Observer only — event handler handles all execution');

  // Initialize
  initAccountDb();
  loadConfigs();

  if (configs.size === 0) {
    console.error('[position-monitor] No configs loaded, exiting');
    process.exit(1);
  }

  // Handle shutdown
  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);

  // Start monitoring loop
  console.log('[position-monitor] Monitoring loop started');
  await monitoringLoop();
}

function gracefulShutdown(): void {
  console.log('[position-monitor] Shutting down...');
  running = false;
  closeAccountDb();
  process.exit(0);
}

main().catch((err) => {
  console.error('[position-monitor] Fatal error:', err);
  process.exit(1);
});
