import * as dotenv from 'dotenv';
dotenv.config();

import { createStore } from '../src/replay/store';
import { getAvailableDays } from '../src/replay/framework';
import { REPLAY_DB_DEFAULT } from '../src/storage/replay-db';
import { runReplay } from '../src/replay/machine';
import { runBasketReplay } from '../src/replay/basket-runner';

const db = new Database(REPLAY_DB_DEFAULT, { readonly: true });
const allDays = getAvailableDays(db, 'SPX');
db.close();

const store = createStore();
const configs = store.listConfigs();
store.close();

const db2 = new Database(REPLAY_DB_DEFAULT, { readonly: true });

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

console.log(`Processing ${configsWithMissing.length} configs with missing days...`);
console.log(`Total missing: ${configsWithMissing.reduce((s,c) => s + c.missing.length, 0)} results\n`);

let completed = 0;
let totalAdded = 0;

for (const cfg of configsWithMissing) {
  const store2 = createStore();
  const loaded = store2.getConfig(cfg.id);
  store2.close();
  if (!loaded) continue;

  let added = 0;
  for (const date of cfg.missing) {
    try {
      if (cfg.isBasket) {
        await runBasketReplay(loaded, date, { verbose: false, noJudge: true });
      } else {
        await runReplay(loaded, date, { verbose: false, noJudge: true });
      }
      added++;
    } catch (e) {}
  }

  completed++;
  totalAdded += added;
  console.log(`[${completed}/${configsWithMissing.length}] ${cfg.id}: +${added} (${cfg.missing.length - added} failed)`);

  if (completed % 10 === 0) {
    const db3 = new Database(REPLAY_DB_DEFAULT, { readonly: true });
    const t = db3.prepare('SELECT COUNT(*) as c FROM replay_results').get();
    db3.close();
    console.log(`  Total results so far: ${t.c}`);
  }
}

console.log(`\nDONE: ${totalAdded} new results across ${completed} configs`);