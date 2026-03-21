import Database from 'better-sqlite3';
const DB_PATH = './data/spxer.db';
const db = new Database(DB_PATH, { readonly: true });
const start = Math.floor(new Date('2026-03-19T09:30:00-04:00').getTime() / 1000);
const end = start + 390 * 60;

const contracts = db.prepare(`
  SELECT DISTINCT c.symbol FROM contracts c
  JOIN bars b ON b.symbol = c.symbol
  WHERE b.timeframe = '1m' AND b.ts >= ? AND b.ts <= ?
  LIMIT 3
`).all(start, end) as any[];
console.log('contract symbols:', contracts.map(r => r.symbol));

if (contracts.length > 0) {
  const sym = contracts[0].symbol;
  console.log('symbol:', sym);
  
  const latest = db.prepare(`
    SELECT close, ts FROM bars WHERE symbol = ? AND timeframe = '1m'
    ORDER BY ts DESC LIMIT 1
  `).get(sym) as any;
  console.log('latest price:', latest);
  
  const atStart = db.prepare(`
    SELECT close, ts FROM bars WHERE symbol = ? AND timeframe = '1m' AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).get(sym, start) as any;
  console.log('price at session start:', atStart);
}

db.close();
