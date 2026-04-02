import * as dotenv from 'dotenv'; dotenv.config();
import Database from 'better-sqlite3';
import * as path from 'path';
import { runReplay } from '../src/replay/machine';

const DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');
const db = new Database(DB_PATH, { readonly: true });
const row = db.prepare('SELECT config_json FROM replay_configs WHERE id = ?').get('hma3x15-undhma-itm5-tp14x-sl70-10k') as any;
db.close();
const config = JSON.parse(row.config_json);
console.log('Config keys:', Object.keys(config));
console.log('exit:', JSON.stringify(config.exit));
console.log('scanners:', config.scanners?.enabled, 'judges:', config.judges?.enabled);
console.log('HMA fast/slow:', config.signals?.hmaCrossFast, config.signals?.hmaCrossSlow);

async function main() {
  const result = await runReplay(config, '2026-04-02', { dataDbPath: DB_PATH, storeDbPath: DB_PATH, verbose: true, noJudge: true });
  console.log('Trades:', result.trades, 'P&L:', result.totalPnl);
}
main().catch(console.error);
