import Database from 'better-sqlite3';
const DB_PATH = './data/spxer.db';

function getDb() { return new Database(DB_PATH, { readonly: true }); }

const date = '2026-03-19';
const start = Math.floor(new Date(date + 'T09:30:00-04:00').getTime() / 1000);
const end = start + 390 * 60;

const db = getDb();
const spxBars = db.prepare(`
  SELECT ts, open, high, low, close, volume, indicators
  FROM bars WHERE symbol='SPX' AND timeframe='1m' AND ts >= ? AND ts <= ?
  ORDER BY ts
`).all(start, end) as any[];

const contracts = db.prepare(`
  SELECT DISTINCT c.symbol, c.type, c.strike, c.expiry
  FROM contracts c JOIN bars b ON b.symbol = c.symbol
  WHERE b.timeframe='1m' AND b.ts >= ? AND b.ts <= ?
`).all(start, end) as any[];

const syms = contracts.map(c => c.symbol);
const priceRows = db.prepare(`
  SELECT symbol, ts, close FROM bars
  WHERE symbol IN (${syms.map(() => '?').join(',')})
  AND timeframe='1m' AND ts >= ? AND ts <= ?
  ORDER BY ts
`).all(...syms, start, end) as any[];

const pm = new Map<string, number>();
for (const r of priceRows) pm.set(`${r.symbol}@${r.ts}`, r.close);

console.log('SPX first bar ts:', spxBars[0].ts, 'close:', spxBars[0].close);
console.log('SPX last bar ts:', spxBars[spxBars.length-1].ts);

const c0 = contracts[0];
const priceAtSpxTs = pm.get(`${c0.symbol}@${spxBars[0].ts}`);
const priceAtNearestBelow = (() => {
  let best: number | undefined;
  let bestTs = 0;
  for (const [key, val] of pm) {
    if (!key.startsWith(c0.symbol + '@')) continue;
    const kts = parseInt(key.split('@')[1]);
    if (kts <= spxBars[0].ts && kts > bestTs) {
      bestTs = kts;
      best = val;
    }
  }
  return { ts: bestTs, price: best };
})();
console.log(`price for ${c0.symbol} at SPX bar ts ${spxBars[0].ts}: ${priceAtSpxTs}`);
console.log('nearest below:', priceAtNearestBelow);

db.close();
