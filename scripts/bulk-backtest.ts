#!/usr/bin/env tsx
/**
 * Bulk backtest runner — runs ALL saved configs across ALL available dates.
 * Parallel execution: N configs at a time across all dates.
 *
 * Usage:
 *   npx tsx scripts/bulk-backtest.ts --parallel=4
 *   npx tsx scripts/bulk-backtest.ts --parallel=8 --skip-baskets
 */

import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import { createStore } from '../src/replay/store';
import { getAvailableDays } from '../src/replay/framework';
import { REPLAY_DB_DEFAULT } from '../src/storage/replay-db';
import { runReplay } from '../src/replay/machine';
import { runBasketReplay } from '../src/replay/basket-runner';

const PARALLEL = parseInt(process.env.PARALLEL || '4', 10);
const SKIP_BASKETS = process.argv.includes('--skip-baskets');
const QUIET = process.argv.includes('--quiet');
const SESSION_END = process.env.SESSION_END || '16:00';

// ── Gather configs ──────────────────────────────────────────────────────────

const store = createStore();
let configs = store.listConfigs();
store.close();

if (SKIP_BASKETS) {
  configs = configs.filter(c => !c.id.includes(':'));
}

console.log(`\nBulk backtest: ${configs.length} configs | parallel=${PARALLEL} | skip_baskets=${SKIP_BASKETS}`);

// ── Get available dates ──────────────────────────────────────────────────────

const db = new Database(REPLAY_DB_DEFAULT, { readonly: true });
const allDays = getAvailableDays(db, 'SPX');
db.close();

console.log(`Dates: ${allDays.length} (${allDays[0]} → ${allDays[allDays.length - 1]})\n`);

// ── Replay options ───────────────────────────────────────────────────────────

const replayOpts = { verbose: !QUIET, noJudge: true };

// ── Progress tracking ────────────────────────────────────────────────────────

let completed = 0;
let failed = 0;
let totalTrades = 0;
let totalPnl = 0;

const lock = (fn: () => void) => fn();

function log(...args: any[]) {
  if (!QUIET) console.log(...args);
}

// ── Per-config runner (one config, all dates) ───────────────────────────────

async function runConfig(configId: string): Promise<{ trades: number; pnl: number; days: number; errors: number }> {
  let cfg: any;
  const store2 = createStore();
  const loaded = store2.getConfig(configId);
  store2.close();
  if (!loaded) return { trades: 0, pnl: 0, days: 0, errors: 1 };

  const isBasket = !!(loaded.basket?.enabled && loaded.basket.members?.length);
  cfg = loaded;

  let trades = 0;
  let pnl = 0;
  let errors = 0;

  for (const date of allDays) {
    try {
      if (isBasket) {
        const r = await runBasketReplay(cfg, date, { verbose: false, noJudge: true });
        trades += r.aggregate.trades;
        pnl += r.aggregate.totalPnl;
      } else {
        const r = await runReplay(cfg, date, replayOpts);
        trades += r.trades;
        pnl += r.totalPnl;
      }
    } catch (e: any) {
      errors++;
    }
  }

  return { trades, pnl, days: allDays.length, errors };
}

// ── Main parallel loop ───────────────────────────────────────────────────────

async function main() {
  const start = Date.now();
  const results: { configId: string; trades: number; pnl: number; errors: number }[] = [];

  // Process in chunks of PARALLEL configs
  for (let i = 0; i < configs.length; i += PARALLEL) {
    const chunk = configs.slice(i, i + PARALLEL);
    const chunkResults = await Promise.allSettled(
      chunk.map(c => runConfig(c.id))
    );

    for (let j = 0; j < chunkResults.length; j++) {
      const r = chunkResults[j];
      const configId = chunk[j].id;
      if (r.status === 'fulfilled') {
        completed++;
        totalTrades += r.value.trades;
        totalPnl += r.value.pnl;
        results.push({ configId, ...r.value });
        log(`[${completed}/${configs.length}] ${configId} | ${r.value.trades} trades | $${r.value.pnl.toFixed(0)} | ${r.value.errors} errors`);
      } else {
        failed++;
        log(`[FAIL] ${configId}: ${r.reason?.message}`);
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  COMPLETED: ${completed} | FAILED: ${failed} | TIME: ${elapsed}s`);
  console.log(`  TOTAL TRADES: ${totalTrades} | TOTAL P&L: $${totalPnl.toFixed(0)}`);
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(console.error);