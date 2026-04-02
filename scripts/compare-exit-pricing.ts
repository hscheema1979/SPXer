/**
 * Compare close vs intrabar exit pricing across a date range.
 * Uses the live agent config (hma3x15-undhma-itm5-tp14x-sl70-10k).
 */
import * as dotenv from 'dotenv';
dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../src/replay/machine';
import { getAvailableDays } from '../src/replay/framework';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');
const CONFIG_ID = 'hma3x15-undhma-itm5-tp14x-sl70-10k';

// Date range: last 3 months
const START_DATE = '2026-01-02';
const END_DATE = '2026-04-02';

interface DayResult {
  date: string;
  trades: number;
  wins: number;
  pnl: number;
}

async function main() {
  // Load config and register comparison variants
  const db = new Database(DB_PATH);
  const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get(CONFIG_ID) as any;
  if (!row) { console.error(`Config ${CONFIG_ID} not found`); process.exit(1); }
  const baseConfig = JSON.parse(row.config_json);

  // Register comparison configs (upsert)
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO replay_configs (id, name, config_json, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json, updatedAt=excluded.updatedAt`);

  const closeConfig = JSON.parse(JSON.stringify(baseConfig));
  closeConfig.id = 'cmp-close'; closeConfig.name = 'cmp-close';
  closeConfig.exit.exitPricing = 'close';
  upsert.run('cmp-close', 'Compare: Close Pricing', JSON.stringify(closeConfig), now, now);

  const intraConfig = JSON.parse(JSON.stringify(baseConfig));
  intraConfig.id = 'cmp-intrabar'; intraConfig.name = 'cmp-intrabar';
  intraConfig.exit.exitPricing = 'intrabar';
  upsert.run('cmp-intrabar', 'Compare: Intrabar Pricing', JSON.stringify(intraConfig), now, now);

  // Delete old comparison results so we can re-run
  db.prepare(`DELETE FROM replay_results WHERE configId IN ('cmp-close', 'cmp-intrabar')`).run();
  db.prepare(`DELETE FROM replay_runs WHERE configId IN ('cmp-close', 'cmp-intrabar')`).run();

  // Get dates in range
  const allDates = getAvailableDays(db);
  db.close();
  const dates = allDates.filter(d => d >= START_DATE && d <= END_DATE);
  console.log(`\n  Comparing exit pricing: ${dates.length} trading days (${START_DATE} → ${END_DATE})`);
  console.log(`  Config: ${CONFIG_ID}`);
  console.log(`  HMA: ${baseConfig.signals?.hmaCrossFast}x${baseConfig.signals?.hmaCrossSlow} | SL: ${baseConfig.position?.stopLossPercent}% | TP: ${baseConfig.position?.takeProfitMultiplier}x`);
  console.log(`  Exit strategy: ${baseConfig.exit?.strategy} | Sizing: $${baseConfig.sizing?.baseDollarsPerTrade}\n`);

  const closeResults: DayResult[] = [];
  const intrabarResults: DayResult[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    try {
      const closeResult = await runReplay(closeConfig, date, {
        dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
      });
      closeResults.push({ date, trades: closeResult.trades, wins: closeResult.wins, pnl: closeResult.totalPnl });

      const intraResult = await runReplay(intraConfig, date, {
        dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: false, noJudge: true,
      });
      intrabarResults.push({ date, trades: intraResult.trades, wins: intraResult.wins, pnl: intraResult.totalPnl });

      if ((i + 1) % 10 === 0 || i === dates.length - 1) {
        process.stdout.write(`  ${i + 1}/${dates.length} days done\r`);
      }
    } catch (e: any) {
      console.error(`  ERROR on ${date}: ${e.message}`);
    }
  }

  // Summarize
  console.log(`\n\n${'='.repeat(78)}`);
  console.log(`  EXIT PRICING COMPARISON — ${dates.length} days`);
  console.log(`${'='.repeat(78)}\n`);

  const cTrades = closeResults.reduce((s, r) => s + r.trades, 0);
  const cWins = closeResults.reduce((s, r) => s + r.wins, 0);
  const cPnl = closeResults.reduce((s, r) => s + r.pnl, 0);
  const cWinDays = closeResults.filter(r => r.pnl > 0).length;
  const cMaxWin = Math.max(...closeResults.map(r => r.pnl));
  const cMaxLoss = Math.min(...closeResults.map(r => r.pnl));

  const iTrades = intrabarResults.reduce((s, r) => s + r.trades, 0);
  const iWins = intrabarResults.reduce((s, r) => s + r.wins, 0);
  const iPnl = intrabarResults.reduce((s, r) => s + r.pnl, 0);
  const iWinDays = intrabarResults.filter(r => r.pnl > 0).length;
  const iMaxWin = Math.max(...intrabarResults.map(r => r.pnl));
  const iMaxLoss = Math.min(...intrabarResults.map(r => r.pnl));

  const fmt = (n: number) => n >= 0 ? `+$${n.toFixed(0)}` : `-$${Math.abs(n).toFixed(0)}`;
  const pct = (n: number, d: number) => d > 0 ? `${(n / d * 100).toFixed(1)}%` : '0%';

  console.log(`  ${'Metric'.padEnd(25)} ${'CLOSE'.padStart(14)} ${'INTRABAR'.padStart(14)} ${'DELTA'.padStart(14)}`);
  console.log(`  ${'-'.repeat(25)} ${'-'.repeat(14)} ${'-'.repeat(14)} ${'-'.repeat(14)}`);
  console.log(`  ${'Total trades'.padEnd(25)} ${String(cTrades).padStart(14)} ${String(iTrades).padStart(14)} ${String(iTrades - cTrades).padStart(14)}`);
  console.log(`  ${'Win rate'.padEnd(25)} ${pct(cWins, cTrades).padStart(14)} ${pct(iWins, iTrades).padStart(14)}`);
  console.log(`  ${'Total P&L'.padEnd(25)} ${fmt(cPnl).padStart(14)} ${fmt(iPnl).padStart(14)} ${fmt(iPnl - cPnl).padStart(14)}`);
  console.log(`  ${'Avg daily P&L'.padEnd(25)} ${fmt(cPnl / closeResults.length).padStart(14)} ${fmt(iPnl / intrabarResults.length).padStart(14)}`);
  console.log(`  ${'Win days'.padEnd(25)} ${`${cWinDays}/${closeResults.length}`.padStart(14)} ${`${iWinDays}/${intrabarResults.length}`.padStart(14)}`);
  console.log(`  ${'Best day'.padEnd(25)} ${fmt(cMaxWin).padStart(14)} ${fmt(iMaxWin).padStart(14)}`);
  console.log(`  ${'Worst day'.padEnd(25)} ${fmt(cMaxLoss).padStart(14)} ${fmt(iMaxLoss).padStart(14)}`);

  // Per-day breakdown for big divergences
  console.log(`\n  Top 10 divergences (close - intrabar):\n`);
  const diffs = closeResults.map((c, i) => ({
    date: c.date,
    closePnl: c.pnl,
    intraPnl: intrabarResults[i]?.pnl ?? 0,
    diff: c.pnl - (intrabarResults[i]?.pnl ?? 0),
  })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 10);

  console.log(`  ${'Date'.padEnd(12)} ${'Close P&L'.padStart(12)} ${'Intrabar P&L'.padStart(14)} ${'Difference'.padStart(12)}`);
  console.log(`  ${'-'.repeat(12)} ${'-'.repeat(12)} ${'-'.repeat(14)} ${'-'.repeat(12)}`);
  for (const d of diffs) {
    console.log(`  ${d.date.padEnd(12)} ${fmt(d.closePnl).padStart(12)} ${fmt(d.intraPnl).padStart(14)} ${fmt(d.diff).padStart(12)}`);
  }
  console.log();
}

main().catch(console.error);
