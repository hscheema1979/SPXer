/**
 * hma3m-hourly-bucket.ts — bucket trade-level output from hma3m-tpsl-study
 * (run with --emit-trades) into per-hour P&L. Emits the same shape that
 * `/api/etf-long-hourly` consumes: { hours: string[], series: { label: number[] } }.
 *
 *   npx tsx scripts/diag/hma3m-hourly-bucket.ts <input.json> [--out path.json]
 *
 * Buckets are ENTRY hour-of-ET (the "where in the day did this trade fire"
 * question). Output is per-config dollar-P&L per hour bucket across all dates.
 */
import * as fs from 'fs';
import * as path from 'path';

const inPath = process.argv[2];
if (!inPath) { console.error('usage: hma3m-hourly-bucket.ts <input.json> [--out path.json]'); process.exit(2); }
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 && outIdx + 1 < process.argv.length ? process.argv[outIdx + 1]
  : inPath.replace(/\.json$/, '.hourly.json');

const HOURS = ['09', '10', '11', '12', '13', '14', '15'] as const;

function etHour(ts: number): string {
  // ts is Unix seconds (UTC). Convert to ET via Intl.
  const d = new Date(ts * 1000);
  const hh = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
  // hh comes back '09' .. '15' (or with leading zero stripped depending on locale)
  return hh.padStart(2, '0');
}

const j = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const out: any = {
  generatedAt: new Date().toISOString(),
  source: path.basename(inPath),
  hours: HOURS,
  symbols: {},
};

for (const [symbol, sd] of Object.entries<any>(j.symbols || {})) {
  const series: { [label: string]: number[] } = {};
  const tradeCounts: { [label: string]: number[] } = {};
  for (const [label, sig] of Object.entries<any>(sd.signals || {})) {
    const pnlByHour = Array(HOURS.length).fill(0);
    const tradesByHour = Array(HOURS.length).fill(0);
    for (const t of (sig.trades || [])) {
      const h = etHour(t.entryTs);
      const idx = HOURS.indexOf(h as any);
      if (idx < 0) continue;
      pnlByHour[idx] += t.pnl;
      tradesByHour[idx] += 1;
    }
    series[label] = pnlByHour.map(v => +v.toFixed(2));
    tradeCounts[label] = tradesByHour;
  }
  out.symbols[symbol] = { hours: HOURS, series, tradeCounts };
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

// Pretty stdout dump
for (const [symbol, sd] of Object.entries<any>(out.symbols)) {
  console.log(`\n[${symbol}] hourly entry-time P&L`);
  console.log(`${''.padEnd(38)} ${HOURS.map(h => h.padStart(8)).join('')}`);
  for (const [label, arr] of Object.entries<number[]>((sd as any).series)) {
    const counts = (sd as any).tradeCounts[label];
    console.log(`${label.padEnd(38)} ${arr.map((v, i) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}/${counts[i]}`.padStart(8)).join('')}`);
  }
}
console.log(`\n✓ wrote ${outPath}`);
