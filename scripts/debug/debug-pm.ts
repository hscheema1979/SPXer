import Database from 'better-sqlite3';
const DB_PATH = './data/spxer.db';

function getDb() { return new Database(DB_PATH, { readonly: true }); }

const date = '2026-03-19';
const start = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
const end = start + 390 * 60;

const db = getDb();
const bars = db.prepare(`
  SELECT ts, open, high, low, close, volume, indicators
  FROM bars WHERE symbol='SPX' AND timeframe='1m' AND ts >= ? AND ts <= ?
  ORDER BY ts
`).all(start, end) as any[];
console.log('SPX bars:', bars.length, 'first:', bars[0]?.ts, 'last:', bars[bars.length-1]?.ts);

const contracts = db.prepare(`
  SELECT DISTINCT c.symbol, c.type, c.strike, c.expiry
  FROM contracts c JOIN bars b ON b.symbol = c.symbol
  WHERE b.timeframe='1m' AND b.ts >= ? AND b.ts <= ?
`).all(start, end) as any[];
console.log('contracts:', contracts.length, 'first:', contracts[0]?.symbol);

const pm = new Map<string, number>();
const syms = contracts.map(c => c.symbol);
const priceRows = db.prepare(`
  SELECT symbol, ts, close FROM bars
  WHERE symbol IN (${syms.map(() => '?').join(',')})
  AND timeframe='1m' AND ts >= ? AND ts <= ?
  ORDER BY ts
`).all(...syms, start, end) as any[];
console.log('price rows:', priceRows.length);
for (const r of priceRows) pm.set(`${r.symbol}@${r.ts}`, r.close);
console.log('pm size:', pm.size);
if (priceRows.length > 0) {
  console.log('first key:', `${priceRows[0].symbol}@${priceRows[0].ts}`, '=', pm.get(`${priceRows[0].symbol}@${priceRows[0].ts}`));
}

db.close();
