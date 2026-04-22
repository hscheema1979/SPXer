import Database from 'better-sqlite3';
const db = new Database('./data/spxer.db');

// Get per-bar volumes for SPXW contracts in the $3-$15 range
// Use multiple recent dates for a better sample
const dates = [
  { label: '2026-04-16', start: 1776182400, end: 1776211200 },
  { label: '2026-04-15', start: 1776096000, end: 1776124800 },
  { label: '2026-04-14', start: 1776009600, end: 1776038400 },
];

const allBars: any[] = [];

for (const d of dates) {
  const rows = db.prepare(`
    SELECT symbol, ts, close, volume
    FROM replay_bars
    WHERE symbol LIKE 'SPXW%'
      AND timeframe='1m'
      AND ts >= ? AND ts <= ?
      AND synthetic = 0
      AND close >= 3 AND close <= 15
  `).all(d.start, d.end) as any[];
  allBars.push(...rows);
}

console.log('Total 1m bars in $3-$15 range across 3 days:', allBars.length);
console.log();

// Per-bar volume distribution
const vols = allBars.map(b => b.volume).sort((a, b) => a - b);
const p10 = vols[Math.floor(vols.length * 0.10)];
const p25 = vols[Math.floor(vols.length * 0.25)];
const p50 = vols[Math.floor(vols.length * 0.50)];
const p75 = vols[Math.floor(vols.length * 0.75)];
const p90 = vols[Math.floor(vols.length * 0.90)];
const p95 = vols[Math.floor(vols.length * 0.95)];
const avg = vols.reduce((a, b) => a + b, 0) / vols.length;

console.log('=== PER 1-MINUTE BAR volume (contracts in $3-$15 range) ===');
console.log('Avg:', Math.round(avg));
console.log('P10:', p10);
console.log('P25:', p25);
console.log('Median:', p50);
console.log('P75:', p75);
console.log('P90:', p90);
console.log('P95:', p95);
console.log('Max:', vols[vols.length - 1]);
console.log();

// What % of bars could absorb 25 contracts instantly?
const canFill25 = vols.filter(v => v >= 25).length;
const canFill50 = vols.filter(v => v >= 50).length;
console.log('Bars with vol >= 25:', canFill25, '/', vols.length, '(' + (canFill25/vols.length*100).toFixed(1) + '%)');
console.log('Bars with vol >= 50:', canFill50, '/', vols.length, '(' + (canFill50/vols.length*100).toFixed(1) + '%)');
console.log('Bars with vol >= 100:', vols.filter(v => v >= 100).length, '/', vols.length, '(' + (vols.filter(v => v >= 100).length/vols.length*100).toFixed(1) + '%)');
console.log();

// Now simulate 3-minute bars by grouping
// Group by symbol + 3min bucket
const threeMinBars = new Map<string, number>();
for (const b of allBars) {
  const bucket = Math.floor(b.ts / 180) * 180; // 3-min bucket
  const key = `${b.symbol}|${bucket}`;
  threeMinBars.set(key, (threeMinBars.get(key) || 0) + b.volume);
}

const vols3m = [...threeMinBars.values()].sort((a, b) => a - b);
const p10_3 = vols3m[Math.floor(vols3m.length * 0.10)];
const p25_3 = vols3m[Math.floor(vols3m.length * 0.25)];
const p50_3 = vols3m[Math.floor(vols3m.length * 0.50)];
const p75_3 = vols3m[Math.floor(vols3m.length * 0.75)];
const p90_3 = vols3m[Math.floor(vols3m.length * 0.90)];
const p95_3 = vols3m[Math.floor(vols3m.length * 0.95)];
const avg3 = vols3m.reduce((a, b) => a + b, 0) / vols3m.length;

console.log('=== PER 3-MINUTE BAR volume (contracts in $3-$15 range) ===');
console.log('Avg:', Math.round(avg3));
console.log('P10:', p10_3);
console.log('P25:', p25_3);
console.log('Median:', p50_3);
console.log('P75:', p75_3);
console.log('P90:', p90_3);
console.log('P95:', p95_3);
console.log('Max:', vols3m[vols3m.length - 1]);
console.log();

const canFill25_3 = vols3m.filter(v => v >= 25).length;
const canFill50_3 = vols3m.filter(v => v >= 50).length;
console.log('3m bars with vol >= 25:', canFill25_3, '/', vols3m.length, '(' + (canFill25_3/vols3m.length*100).toFixed(1) + '%)');
console.log('3m bars with vol >= 50:', canFill50_3, '/', vols3m.length, '(' + (canFill50_3/vols3m.length*100).toFixed(1) + '%)');
console.log('3m bars with vol >= 100:', vols3m.filter(v => v >= 100).length, '/', vols3m.length, '(' + (vols3m.filter(v => v >= 100).length/vols3m.length*100).toFixed(1) + '%)');
console.log();

// Worst case: bars with volume < 25 — what do they look like?
console.log('=== THIN BARS (vol < 25 per 3m) — sample ===');
const thinBars = [...threeMinBars.entries()]
  .filter(([_, v]) => v < 25 && v > 0)
  .sort((a, b) => a[1] - b[1])
  .slice(0, 10);
for (const [key, vol] of thinBars) {
  const [sym, tsStr] = key.split('|');
  const t = new Date(parseInt(tsStr) * 1000).toISOString().slice(11, 16);
  console.log('  ', sym.padEnd(25), t, 'vol:', vol);
}
