/**
 * backfill-etf-shares.ts — 1m share-bar backfill for leveraged ETFs.
 *
 * The leveraged-ETF long-only study trades the UNDERLYING ETF shares (not
 * options), so all we need is the ticker's own 1m OHLCV series. We fetch from
 * Polygon stock aggregates (the tickers are plain equities) and write ONE
 * parquet per ticker-per-date in the SAME schema the sweep loader reads
 * (data/parquet/bars/{profile}/{date}.parquet), using writeDayParquet().
 *
 * Only 1m bars are written — the sweep engine aggregates 1m → 5m/15m/1h/1d on
 * the fly (same as the SPX long engine), so higher TFs are derived downstream.
 *
 * The trading calendar is taken from an existing dense profile (spx-0dte) so we
 * only request real trading days and align date-for-date with the index data.
 *
 * Usage:
 *   npx tsx scripts/backfill/backfill-etf-shares.ts                 # all pilot tickers, ~1yr
 *   npx tsx scripts/backfill/backfill-etf-shares.ts --tickers=TQQQ,SOXL
 *   npx tsx scripts/backfill/backfill-etf-shares.ts --days=120      # most-recent N trading days
 *   npx tsx scripts/backfill/backfill-etf-shares.ts --force         # re-fetch even if parquet exists
 *   npx tsx scripts/backfill/backfill-etf-shares.ts --concurrency=8 # parallel day fetches (unlimited Polygon tier)
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

import * as fs from 'fs';
import * as path from 'path';
import { writeDayParquet, type BarRow } from '../../src/storage/parquet-writer';

const POLYGON_KEY = process.env.POLYGON_API_KEY;
const POLYGON_BASE = 'https://api.polygon.io';
if (!POLYGON_KEY) { console.error('POLYGON_API_KEY not set in .env'); process.exit(1); }

// Highest-volume leveraged ETFs (both directions) for the pilot. The profile id
// is the lowercased ticker — that becomes the parquet subdir and the sweep
// --symbol value.
const PILOT_TICKERS = ['TQQQ', 'SQQQ', 'SOXL', 'TNA', 'FAS'];

const PARQUET_ROOT = path.resolve(process.cwd(), 'data/parquet/bars');
const CALENDAR_PROFILE = 'spx-0dte'; // dense, every trading day → use as calendar

// ── args ─────────────────────────────────────────────────────────────────────
function argVal(name: string): string | undefined {
  const flag = process.argv.find(a => a.startsWith(`--${name}=`));
  return flag ? flag.split('=').slice(1).join('=') : undefined;
}
const TICKERS = (argVal('tickers')?.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)) ?? PILOT_TICKERS;
const FORCE = process.argv.includes('--force');
const DAYS = parseInt(argVal('days') || '', 10);
const CONCURRENCY = Math.max(1, parseInt(argVal('concurrency') || '8', 10));

// ── trading calendar (real trading days from the spx-0dte parquet dir) ────────
function tradingDates(): string[] {
  const dir = path.join(PARQUET_ROOT, CALENDAR_PROFILE);
  if (!fs.existsSync(dir)) {
    console.error(`Calendar profile dir missing: ${dir}. Cannot derive trading days.`);
    process.exit(1);
  }
  const all = fs.readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.parquet$/.test(f))
    .map(f => f.slice(0, 10))
    .sort();
  // ~1yr default ≈ 252 trading days; honor --days for a smaller validation slice.
  if (Number.isFinite(DAYS) && DAYS > 0 && DAYS < all.length) return all.slice(-DAYS);
  const ONE_YEAR = 252;
  return all.length > ONE_YEAR ? all.slice(-ONE_YEAR) : all;
}

// ── Polygon 1m fetch (one trading day) ────────────────────────────────────────
interface PolyBar { o: number; h: number; l: number; c: number; v: number; t: number }

async function fetchDay1m(ticker: string, date: string, retries = 3): Promise<PolyBar[]> {
  const url = `${POLYGON_BASE}/v2/aggs/ticker/${ticker}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${POLYGON_KEY}` },
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json() as any;
      if (data.status === 'NOT_AUTHORIZED') throw new Error(`NOT_AUTHORIZED for ${ticker}`);
      if (data.status === 'ERROR') throw new Error(data.error || 'polygon error');
      return (data.results || []) as PolyBar[];
    } catch (e: any) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  return [];
}

/**
 * Keep only Regular Trading Hours 1m bars (09:30–16:00 ET), matching the rest
 * of the pipeline (the SPX engine treats sessOpen = 09:30 ET, eod = +6.5h). We
 * filter by the bar's ET wall-clock minute-of-day so DST is handled correctly.
 */
function isRTH(tsSec: number): boolean {
  const d = new Date(tsSec * 1000);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const h = +parts.find(p => p.type === 'hour')!.value;
  const m = +parts.find(p => p.type === 'minute')!.value;
  const minOfDay = h * 60 + m;
  return minOfDay >= 570 && minOfDay < 960; // [09:30, 16:00)
}

function toBarRows(ticker: string, bars: PolyBar[]): BarRow[] {
  const rows: BarRow[] = [];
  for (const b of bars) {
    const ts = Math.floor(b.t / 1000);
    if (!isRTH(ts)) continue;
    rows.push({
      symbol: ticker,
      timeframe: '1m',
      ts,
      open: b.o, high: b.h, low: b.l, close: b.c,
      volume: Math.round(b.v),
      synthetic: 0,
      gap_type: null,
      indicators: '{}',
      source: 'polygon',
      spread: null,
    });
  }
  return rows;
}

// ── per-ticker backfill ───────────────────────────────────────────────────────
async function backfillTicker(ticker: string, dates: string[]) {
  const profileId = ticker.toLowerCase();
  const profileDir = path.join(PARQUET_ROOT, profileId);
  fs.mkdirSync(profileDir, { recursive: true });

  let written = 0, skipped = 0, empty = 0, errors = 0;

  // Process days in concurrency-sized batches (Polygon tier is unlimited).
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const batch = dates.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async date => {
      const outFile = path.join(profileDir, `${date}.parquet`);
      if (!FORCE && fs.existsSync(outFile)) { skipped++; return; }
      try {
        const raw = await fetchDay1m(ticker, date);
        const rows = toBarRows(ticker, raw);
        if (rows.length === 0) { empty++; return; }
        await writeDayParquet({ profileId, date, rows, skipVerify: false });
        written++;
      } catch (e: any) {
        errors++;
        console.error(`  [${ticker} ${date}] ${e.message}`);
      }
    }));
    process.stderr.write(`\r  [${ticker}] ${Math.min(i + CONCURRENCY, dates.length)}/${dates.length} (wrote ${written}, skip ${skipped}, empty ${empty}, err ${errors})   `);
  }
  process.stderr.write('\n');
  console.log(`✓ ${ticker}: wrote ${written}, skipped ${skipped}, empty ${empty}, errors ${errors} → ${profileDir}`);
}

// ── main ───────────────────────────────────────────────────────────────────────
(async () => {
  const dates = tradingDates();
  console.log(`[etf-backfill] ${TICKERS.length} tickers × ${dates.length} trading days (${dates[0]} → ${dates[dates.length - 1]}), concurrency=${CONCURRENCY}, force=${FORCE}`);
  for (const ticker of TICKERS) {
    await backfillTicker(ticker, dates);
  }
  console.log('[etf-backfill] done.');
})();
