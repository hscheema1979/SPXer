/**
 * prune-post-cutoff-trades.ts
 *
 * Removes trades with entryET >= 15:45 from every replay_results row and
 * recomputes the aggregate metrics (trades, wins, winRate, totalPnl,
 * avgPnlPerTrade, maxWin, maxLoss, maxConsecutive*).
 *
 * Why: historical replay results were produced BEFORE the unified entry-gate
 * refactor that made activeEnd='15:45' / cutoffTimeET='15:45' strictly
 * exclusive. Re-running every config × date pair would be expensive, so we
 * patch the stored results in place to match what the current code would
 * produce on re-run.
 *
 * Safety:
 *   • Dry-run by default — pass --apply to actually write.
 *   • Backup already taken to data/backups/replay_results_backup_pre-cutoff-fix.sql.
 *   • Runs inside a single transaction so interrupted runs leave the DB clean.
 *
 * Usage:
 *   npx tsx scripts/prune-post-cutoff-trades.ts           # dry-run
 *   npx tsx scripts/prune-post-cutoff-trades.ts --apply   # write changes
 */
import Database from 'better-sqlite3';
import { computeMetrics } from '../src/replay/metrics';

const DB_PATH = process.env.DB_PATH || './data/spxer.db';
const CUTOFF = '15:45'; // HH:MM — compare via lexicographic string compare (zero-padded)
const APPLY = process.argv.includes('--apply');

interface Trade {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryTs: number;
  entryET: string;
  entryPrice: number;
  exitTs: number;
  exitET: string;
  exitPrice: number;
  reason: string;
  pnlPct: number;
  pnl$: number;
  signalType: string;
}

function isAfterCutoff(entryET: string): boolean {
  // "15:45", "15:46", ..., "15:59" all compare >= "15:45" lexicographically.
  // Equivalent to numeric compare because HH:MM is fixed-width and zero-padded.
  return entryET >= CUTOFF;
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const rows = db.prepare<[], { runId: string; trades_json: string }>(
  `SELECT runId, trades_json FROM replay_results`
).all();

console.log(`[prune] Scanning ${rows.length} replay_results rows (cutoff: entryET >= ${CUTOFF})…`);

let rowsAffected = 0;
let tradesRemoved = 0;
let pnlRemoved = 0;
const updates: Array<{
  runId: string;
  trades_json: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  avgPnlPerTrade: number;
  maxWin: number;
  maxLoss: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
}> = [];

for (const row of rows) {
  let parsed: Trade[];
  try {
    parsed = JSON.parse(row.trades_json);
  } catch {
    console.warn(`[prune] Skipping ${row.runId} — trades_json parse failed`);
    continue;
  }
  if (!Array.isArray(parsed)) continue;

  const kept: Trade[] = [];
  const removed: Trade[] = [];
  for (const t of parsed) {
    if (typeof t?.entryET === 'string' && isAfterCutoff(t.entryET)) {
      removed.push(t);
    } else {
      kept.push(t);
    }
  }
  if (removed.length === 0) continue;

  rowsAffected++;
  tradesRemoved += removed.length;
  pnlRemoved += removed.reduce((s, t) => s + (t.pnl$ || 0), 0);

  const m = computeMetrics(kept as any);
  updates.push({
    runId: row.runId,
    trades_json: JSON.stringify(kept),
    trades: m.trades,
    wins: m.wins,
    winRate: m.winRate,
    totalPnl: m.totalPnl,
    avgPnlPerTrade: m.avgPnlPerTrade,
    maxWin: m.maxWin,
    maxLoss: m.maxLoss,
    maxConsecutiveWins: m.maxConsecutiveWins,
    maxConsecutiveLosses: m.maxConsecutiveLosses,
  });
}

console.log(`[prune] Rows affected: ${rowsAffected}`);
console.log(`[prune] Trades removed: ${tradesRemoved}`);
console.log(`[prune] Net P&L removed: $${pnlRemoved.toFixed(2)}`);

if (!APPLY) {
  console.log(`[prune] Dry-run — pass --apply to write changes.`);
  process.exit(0);
}

const stmt = db.prepare(`
  UPDATE replay_results
     SET trades = @trades,
         wins = @wins,
         winRate = @winRate,
         totalPnl = @totalPnl,
         avgPnlPerTrade = @avgPnlPerTrade,
         maxWin = @maxWin,
         maxLoss = @maxLoss,
         maxConsecutiveWins = @maxConsecutiveWins,
         maxConsecutiveLosses = @maxConsecutiveLosses,
         trades_json = @trades_json
   WHERE runId = @runId
`);

const tx = db.transaction((batch: typeof updates) => {
  for (const u of batch) stmt.run(u);
});

console.log(`[prune] Applying updates…`);
tx(updates);
console.log(`[prune] Done. ${updates.length} rows updated.`);
db.close();
