/**
 * backfill-ndx-daily.ts
 *
 * Fetch NDX daily aggregates (Polygon I:NDX) into a small JSON cache used to
 * WARM UP higher-timeframe (daily/weekly) HMA/DEMA signals for the multi-DTE
 * sweep. The per-day option parquet only holds the entry session's intraday
 * bars — not nearly enough history to seed a daily/weekly indicator.
 *
 * Output: data/ndx-daily-history.json — [{ date, o, h, l, c }, ...] ascending.
 *
 * Run: npx tsx scripts/diag/backfill-ndx-daily.ts 2023-01-01 2026-05-20
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import * as fs from 'fs';
import * as path from 'path';

export interface DailyBar { date: string; o: number; h: number; l: number; c: number; }

const OUT = path.resolve(__dirname, '../../data/ndx-daily-history.json');

export async function fetchNdxDaily(start: string, end: string): Promise<DailyBar[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY not set');
  const url = `https://api.polygon.io/v2/aggs/ticker/I:NDX/range/1/day/${start}/${end}?adjusted=true&sort=asc&limit=50000&apiKey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  const rows: DailyBar[] = (json.results || []).map((r: any) => ({
    // Polygon daily bar ts is the session date at 00:00 ET-ish; format as YYYY-MM-DD in UTC.
    date: new Date(r.t).toISOString().slice(0, 10),
    o: r.o, h: r.h, l: r.l, c: r.c,
  }));
  return rows;
}

async function main() {
  const [start = '2023-01-01', end = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  console.error(`Fetching NDX daily ${start} → ${end} ...`);
  const rows = await fetchNdxDaily(start, end);
  fs.writeFileSync(OUT, JSON.stringify(rows));
  console.error(`Wrote ${rows.length} daily bars → ${OUT}`);
  if (rows.length) console.error(`Range: ${rows[0].date} → ${rows[rows.length - 1].date}`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
