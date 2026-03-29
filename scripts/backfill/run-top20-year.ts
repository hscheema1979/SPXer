/**
 * Run top 20 configs across all available replay dates.
 * Skips dates that already have results. Sequential per config, no parallelism (SQLite).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../../src/replay/machine';
import { getAvailableDays } from '../../src/replay/framework';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

const TOP_20 = [
  // Already done (249 days): skip automatically
  // 'hma3x15-itm5-tp14x-sl70',
  // 'hma3x15-undhma-otm0-tp14x-sl70',
  // 'hma3x17-undhma-otm0-tp1325x-sl70',
  // 'hma3x15-undhma-itm5-tp14x-sl70-10k',
  // 'hma3x19-undhma-otm5-tp14x-sl40',
  // 'hma3x15-rsi-pxhma-undhma-tp5x-sl80',
  // 'hma3x15-undhma-tp5x-nosl',
  // 'hma3x15-undhma-otm10-tp5x-sl80',  // 244 days

  // Partially done — need to finish
  'hma3x15-undhma-otm0-tp14x-sl70-10k',   // 121/249 days
  'hma3x15-undhma-itm5-tp14x-sl70',        // 65/249 days (dup name, different config?)
  'hma3x17-undhma-tp15x-sl70',             // 23/249 days

  // Top sw3 sweep winners (23 days each, need 226 more)
  'sw3-f5s19-5md3me-sl40-tp8',
  'sw3-f5s19-3md5me-sl80-tp3',
  'sw3-f5s19-3md3me-sl0-tp5',
  'sw3-f5s19-3md3me-sl80-tp5',
  'sw3-f5s19-3md5me-sl0-tp3',
  'sw3-f5s19-3md3me-sl0-tp8',
  'sw3-f5s19-3md3me-sl80-tp8',
  'sw3-f5s19-5md3me-sl0-tp8',
  'sw3-f5s19-5md3me-sl80-tp8',
  'sw3-f5s19-3md3me-sl0-tp3',
  'sw3-f5s19-3md3me-sl80-tp3',
  'sw3-f5s19-3md3me-sl40-tp8',
  'sw3-f5s19-3md3me-sl40-tp5',
  'sw3-f5s19-5md5me-sl80-tp3',
  'sw3-f5s19-5md5me-sl0-tp3',
  'sw3-f5s19-5md3me-sl40-tp5',
  'sw3-f5s19-5md3me-sl0-tp5',
];

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const allDates = getAvailableDays(db);
  db.close();

  console.log(`\n  Top 20 Configs × ${allDates.length} dates\n`);

  for (let ci = 0; ci < TOP_20.length; ci++) {
    const configId = TOP_20[ci];

    // Load config
    const cdb = new Database(DB_PATH, { readonly: true });
    const row = cdb.prepare('SELECT config_json, name FROM replay_configs WHERE id = ?').get(configId) as any;
    cdb.close();
    if (!row) { console.log(`  [${ci+1}/20] ${configId}: NOT FOUND, skipping`); continue; }
    const config = JSON.parse(row.config_json);

    // Get existing results
    const rdb = new Database(DB_PATH, { readonly: true });
    const existing = new Set(
      (rdb.prepare('SELECT date FROM replay_results WHERE configId = ?').all(configId) as any[]).map(r => r.date)
    );
    rdb.close();

    const remaining = allDates.filter(d => !existing.has(d));
    if (remaining.length === 0) {
      console.log(`  [${ci+1}/20] ${row.name}: ✓ already complete (${existing.size} days)`);
      continue;
    }

    console.log(`  [${ci+1}/20] ${row.name}: ${existing.size} done, ${remaining.length} remaining`);
    const startTime = Date.now();

    for (let di = 0; di < remaining.length; di++) {
      const date = remaining[di];
      try {
        const result = await runReplay(config, date, {
          dataDbPath: DB_PATH,
          storeDbPath: DB_PATH,
          verbose: false,
          noJudge: true,
        });
        if ((di + 1) % 25 === 0 || di === remaining.length - 1) {
          const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          const rate = ((di + 1) / ((Date.now() - startTime) / 1000)).toFixed(1);
          const eta = ((remaining.length - di - 1) / parseFloat(rate) / 60).toFixed(1);
          console.log(`    ${di+1}/${remaining.length} days (${elapsed}m elapsed, ${eta}m remaining)`);
        }
      } catch (e: any) {
        // Skip failures silently (holidays etc)
      }
    }

    const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`    ✓ Done in ${totalElapsed}m`);
  }

  // Final summary
  const sdb = new Database(DB_PATH, { readonly: true });
  for (const configId of TOP_20) {
    const row = sdb.prepare(`
      SELECT COUNT(*) as days, SUM(trades) as trades, ROUND(SUM(totalPnl)) as pnl
      FROM replay_results WHERE configId = ?
    `).get(configId) as any;
    const name = (sdb.prepare('SELECT name FROM replay_configs WHERE id = ?').get(configId) as any)?.name || configId;
    console.log(`  ${name.padEnd(50)} ${row.days} days | ${row.trades} trades | $${row.pnl}`);
  }
  sdb.close();
}

main().catch(e => { console.error(e); process.exit(1); });
