#!/usr/bin/env tsx
import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import { createStore } from '../src/replay/store';
import { getAvailableDays } from '../src/replay/framework';
import { REPLAY_DB_DEFAULT } from '../src/storage/replay-db';
import { runReplay } from '../src/replay/machine';
import { runBasketReplay } from '../src/replay/basket-runner';

const QUIET = process.argv.includes('--quiet');
const PARALLEL = parseInt(process.env.PARALLEL || '4', 10);

const db = new Database(REPLAY_DB_DEFAULT, { readonly: true });
const allDays = getAvailableDays(db, 'SPX');
db.close();

console.log(`\nBulk backtest continuation:`);
console.log(`  Dates: ${allDays.length} (${allDays[0]} → ${allDays[allDays.length - 1]})`);

const store = createStore();
const configs = store.listConfigs();
store.close();

const db2 = new Database(REPLAY_DB_DEFAULT, { readonly: true });

// For each config, find missing dates
const configsWithMissing: { id: string; missing: string[]; isBasket: boolean }[] = [];

for (const cfg of configs) {
  const done = db2.prepare("SELECT date FROM replay_results WHERE configId = ?").all(cfg.id) as { date: string }[];
  const doneSet = new Set(done.map(d => d.date));
  const missing = allDays.filter(d => !doneSet.has(d));
  if (missing.length > 0) {
    configsWithMissing.push({ id: cfg.id, missing, isBasket: !!(cfg.basket?.enabled && cfg.basket.members?.length) });
  }
}
db2.close();

console.log(`  Configs needing work: ${configsWithMissing.length}`);
console.log(`  Configs fully done: ${configs.length - configsWithMissing.length}\n`);

if (configsWithMissing.length === 0) {
  console.log('All configs fully done!');
  process.exit(0);
}

let completed = 0;
let totalWork = configsWithMissing.reduce((s, c) => s + c.missing.length, 0);
console.log(`  Total missing results to fill: ${totalWork}\n`);

async function runConfigMissing(cfg: { id: string; missing: string[]; isBasket: boolean }): Promise<{ id: string; added: number }> {
  const store2 = createStore();
  const loaded = store2.getConfig(cfg.id);
  store2.close();
  if (!loaded) return { id: cfg.id, added: 0 };

  let added = 0;
  for (const date of cfg.missing) {
    try {
      if (cfg.isBasket) {
        const r = await runBasketReplay(loaded, date, { verbose: false, noJudge: true });
        added += 1;
      } else {
        await runReplay(loaded, date, { verbose: false, noJudge: true });
        added += 1;
      }
    } catch (e) {
      // skip
    }
  }
  return { id: cfg.id, added };
}

async function main() {
  const start = Date.now();
  let totalAdded = 0;

  for (let i = 0; i < configsWithMissing.length; i += PARALLEL) {
    const chunk = configsWithMissing.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(chunk.map(c => runConfigMissing(c)));

    for (let j = 0; j < results.length; j++) {
      completed++;
      const r = results[j];
      if (r.status === 'fulfilled') {
        totalAdded += r.value.added;
        if (!QUIET) process.stdout.write(`[${completed}/${configsWithMissing.length}] ${r.value.id}: +${r.value.added} results\n`);
      } else {
        if (!QUIET) process.stdout.write(`[${completed}/${configsWithMissing.length}] FAIL: ${r.reason}\n`);
      }
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDONE: +${totalAdded} results in ${elapsed}s`);
}

main().catch(console.error);