#!/usr/bin/env tsx
/**
 * Smoke test: run a basket replay for one day and verify storage.
 *
 * Builds a basket config from the user's current live single-strike config
 * (hma3x12-itm5-tp125x-sl25-3m) with 5 members: ITM10, ITM5, ATM, OTM5, OTM10.
 * Runs replay on a recent cached date, then asserts:
 *   - per-member configs saved (id = "<basket>:<member>")
 *   - per-member results exist (configId = "<basket>:<member>")
 *   - aggregate result exists (configId = "<basket>")
 *   - aggregate trades == Σ member trades
 *
 * Usage: npx tsx scripts/smoke-basket-replay.ts [YYYY-MM-DD]
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createStore } from '../src/replay/store';
import { runBasketReplay } from '../src/replay/basket-runner';
import type { Config, BasketMember } from '../src/config/types';

const DATE = process.argv[2] ?? '2026-04-17';
const BASE_ID = 'spx-hma3x12-itm5-tp125x-sl25-3m';
const BASKET_ID = 'spx-smoke-basket-5strike';

async function main() {
  const store = createStore();
  const base = store.getConfig(BASE_ID);
  if (!base) {
    console.error(`Base config not found: ${BASE_ID}`);
    process.exit(1);
  }

  const members: BasketMember[] = [
    { id: 'itm10', strikeOffset: -10 },
    { id: 'itm5',  strikeOffset: -5 },
    { id: 'atm',   strikeOffset: 0 },
    { id: 'otm5',  strikeOffset: 5 },
    { id: 'otm10', strikeOffset: 10 },
  ];

  // Basket config: inherit everything from base, just enable basket + members.
  // Divide per-member sizing by member count so total account exposure stays fixed.
  const perMemberSizingValue = Math.max(1, Math.floor((base.sizing.sizingValue ?? 15) / members.length));
  const basketConfig: Config = {
    ...base,
    id: BASKET_ID,
    name: `Smoke Basket 5-strike (from ${BASE_ID})`,
    description: `Smoke test — basket fan-out across ITM10..OTM10, per-member sizing=${perMemberSizingValue}%`,
    sizing: { ...base.sizing, sizingValue: perMemberSizingValue },
    basket: { enabled: true, members },
  };

  store.saveConfig(basketConfig);
  store.close();

  console.log(`\n[smoke] Running basket replay: ${BASKET_ID} on ${DATE}`);
  console.log(`[smoke] Members: ${members.map(m => m.id).join(', ')}`);
  console.log(`[smoke] Per-member sizing: ${perMemberSizingValue}%\n`);

  const result = await runBasketReplay(basketConfig, DATE, {
    verbose: true,
    noJudge: true,
  });

  // ── Verify storage ──
  const verify = createStore();
  const aggRows = verify.getResultsByConfig(BASKET_ID).filter(r => r.date === DATE);
  if (aggRows.length === 0) {
    console.error(`\n[smoke] FAIL: aggregate result missing for ${BASKET_ID} ${DATE}`);
    process.exit(1);
  }
  const agg = aggRows[aggRows.length - 1]; // most recent if multiple

  let memberTradeSum = 0;
  let memberPnlSum = 0;
  let memberRowsFound = 0;
  for (const m of members) {
    const memberId = `${BASKET_ID}:${m.id}`;
    const cfg = verify.getConfig(memberId);
    const rows = verify.getResultsByConfig(memberId).filter(r => r.date === DATE);
    if (!cfg) {
      console.error(`[smoke] FAIL: member config missing for ${memberId}`);
      process.exit(1);
    }
    if (rows.length === 0) {
      console.error(`[smoke] FAIL: member result missing for ${memberId} ${DATE}`);
      process.exit(1);
    }
    const res = rows[rows.length - 1];
    memberRowsFound++;
    memberTradeSum += res.trades;
    memberPnlSum += res.totalPnl;
  }
  verify.close();

  console.log(`\n[smoke] ── VERIFICATION ─────────`);
  console.log(`[smoke] Member config rows: ${memberRowsFound}/${members.length}`);
  console.log(`[smoke] Aggregate trades:   ${agg.trades} (sum of members: ${memberTradeSum})`);
  console.log(`[smoke] Aggregate P&L:      $${agg.totalPnl.toFixed(2)} (sum of members: $${memberPnlSum.toFixed(2)})`);

  const tradesMatch = agg.trades === memberTradeSum;
  const pnlMatch = Math.abs(agg.totalPnl - memberPnlSum) < 0.01;

  if (!tradesMatch) {
    console.error(`[smoke] FAIL: aggregate trades ${agg.trades} ≠ member sum ${memberTradeSum}`);
    process.exit(1);
  }
  if (!pnlMatch) {
    console.error(`[smoke] FAIL: aggregate P&L $${agg.totalPnl.toFixed(2)} ≠ member sum $${memberPnlSum.toFixed(2)}`);
    process.exit(1);
  }

  console.log(`\n[smoke] PASS — basket storage and aggregation verified.`);
  console.log(`[smoke] Drill-down queries:`);
  console.log(`[smoke]   SELECT * FROM replay_results WHERE configId = '${BASKET_ID}';               -- aggregate`);
  console.log(`[smoke]   SELECT * FROM replay_results WHERE configId LIKE '${BASKET_ID}:%';          -- per-member\n`);
}

main().catch(err => {
  console.error(`[smoke] FATAL: ${err.message || err}`);
  process.exit(1);
});
