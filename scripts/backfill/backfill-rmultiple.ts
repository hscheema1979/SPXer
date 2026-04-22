#!/usr/bin/env npx tsx
/**
 * Backfill sumWinPct, cntWins, sumLossPct, cntLosses columns in replay_results.
 * Parses trades_json for each row and computes the R-multiple aggregation columns.
 *
 * Usage: npx tsx scripts/backfill/backfill-rmultiple.ts
 */

import Database from 'better-sqlite3';
import path from 'path';

const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'data/spxer.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Ensure columns exist
const cols = new Set((db.prepare("PRAGMA table_info(replay_results)").all() as { name: string }[]).map(c => c.name));
if (!cols.has('sumWinPct')) {
  console.log('Adding R-multiple columns...');
  db.exec(`
    ALTER TABLE replay_results ADD COLUMN sumWinPct REAL DEFAULT 0;
    ALTER TABLE replay_results ADD COLUMN cntWins INTEGER DEFAULT 0;
    ALTER TABLE replay_results ADD COLUMN sumLossPct REAL DEFAULT 0;
    ALTER TABLE replay_results ADD COLUMN cntLosses INTEGER DEFAULT 0;
  `);
}

// Count rows needing backfill (sumWinPct = 0 AND cntWins = 0 but trades > 0)
const totalRows = (db.prepare('SELECT COUNT(*) as n FROM replay_results WHERE trades > 0').get() as any).n;
const alreadyDone = (db.prepare('SELECT COUNT(*) as n FROM replay_results WHERE cntWins > 0 OR cntLosses > 0').get() as any).n;
console.log(`Total rows with trades: ${totalRows}, already backfilled: ${alreadyDone}`);

if (alreadyDone >= totalRows) {
  console.log('All rows already backfilled. Done.');
  db.close();
  process.exit(0);
}

const update = db.prepare(`
  UPDATE replay_results
  SET sumWinPct = ?, cntWins = ?, sumLossPct = ?, cntLosses = ?
  WHERE runId = ?
`);

const rows = db.prepare('SELECT runId, trades_json FROM replay_results WHERE (cntWins = 0 AND cntLosses = 0 AND trades > 0)').all() as { runId: string; trades_json: string }[];

console.log(`Backfilling ${rows.length} rows...`);

const batchSize = 1000;
let processed = 0;

const runBatch = db.transaction((batch: typeof rows) => {
  for (const row of batch) {
    let sumWinPct = 0, cntWins = 0, sumLossPct = 0, cntLosses = 0;
    try {
      const trades = JSON.parse(row.trades_json) as { pnlPct: number }[];
      for (const t of trades) {
        if (t.pnlPct > 0) { sumWinPct += t.pnlPct; cntWins++; }
        else if (t.pnlPct < 0) { sumLossPct += t.pnlPct; cntLosses++; }
      }
    } catch {
      // skip malformed JSON
    }
    update.run(sumWinPct, cntWins, sumLossPct, cntLosses, row.runId);
  }
});

for (let i = 0; i < rows.length; i += batchSize) {
  const batch = rows.slice(i, i + batchSize);
  runBatch(batch);
  processed += batch.length;
  if (processed % 10000 === 0 || processed === rows.length) {
    console.log(`  ${processed}/${rows.length} (${(processed * 100 / rows.length).toFixed(1)}%)`);
  }
}

console.log(`Done. Backfilled ${processed} rows.`);

// Verify
const sample = db.prepare("SELECT configId, SUM(sumWinPct) as swp, SUM(cntWins) as cw, SUM(sumLossPct) as slp, SUM(cntLosses) as cl FROM replay_results GROUP BY configId LIMIT 5").all();
console.log('\nSample verification:');
for (const r of sample as any[]) {
  const avgWin = r.cw > 0 ? (r.swp / r.cw).toFixed(2) : 'N/A';
  const avgLoss = r.cl > 0 ? (r.slp / r.cl).toFixed(2) : 'N/A';
  console.log(`  ${r.configId}: avgWin=${avgWin}% avgLoss=${avgLoss}% (${r.cw} wins, ${r.cl} losses)`);
}

db.close();
