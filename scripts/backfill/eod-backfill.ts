/**
 * eod-backfill.ts — End-of-day roster backfill, DIRECT to parquet.
 *
 * SPXer is research/backtest only (live trading is OptionX). Each evening this
 * grabs the day's 1m bars for every rostered profile and writes them straight
 * to data/parquet/bars/{profileId}/{date}.parquet (1m only — higher TFs are
 * aggregated on the fly by the replay engine / sweeps). No SQLite.
 *
 * Per roster entry, per date:
 *   1. underlying 1m  ← Polygon aggregates ({I:SPX|I:NDX|SPY|QQQ})
 *   2. strike band    ← last RTH underlying close ± bandHalfWidth
 *   3. option 1m      ← Polygon aggregates (429-aware, no 50k-row cap)
 *                       expiry = trade-date + dte (1DTE = next trading day)
 *   4. writeDayParquet([...underlying, ...options])  (atomic, verified)
 *
 * Idempotent: a profile/date whose parquet already exists is skipped (--force
 * to overwrite). Cron-able:
 *   30 17 * * 1-5  cd /home/ubuntu/SPXer && npx tsx scripts/backfill/eod-backfill.ts
 *
 * Usage:
 *   npx tsx scripts/backfill/eod-backfill.ts                 # last weekday, full roster
 *   npx tsx scripts/backfill/eod-backfill.ts 2026-05-06      # specific date
 *   npx tsx scripts/backfill/eod-backfill.ts 2026-05-01 2026-05-06   # range
 *   npx tsx scripts/backfill/eod-backfill.ts --only=spy-1dte,qqq-1dte
 *   npx tsx scripts/backfill/eod-backfill.ts 2026-05-06 --force
 */
import * as dotenv from 'dotenv';
dotenv.config();
import * as path from 'path';
import * as fs from 'fs';
import { MARKET_HOLIDAYS } from '../../src/config';
import {
  fetchOptionBars, expiryForDate, type PolygonBar,
} from './backfill-replay-options';
import { writeDayParquet, type BarRow } from '../../src/storage/parquet-writer';
import { isTradingDay } from '../../src/instruments/expiry-resolver';

const PARQUET_ROOT = path.resolve(__dirname, '../../data/parquet/bars');

// ── Roster ────────────────────────────────────────────────────────────────────
// Extend by adding entries (e.g. a semis/"chips" name once its grid is set).
// underlyingPolygonTicker: indices use the I: prefix; ETFs use the bare ticker.
interface RosterEntry {
  profileId: string;            // parquet partition dir
  underlyingDbSymbol: string;   // symbol stored for the underlying rows
  underlyingPolygonTicker: string;
  optionPrefix: string;         // OCC root
  strikeInterval: number;
  bandHalfWidthDollars: number;
  dte: number;                  // 0 = same-day expiry, 1 = next trading day
}

// Tradeable horizons only:
//   SPX / NDX — cash-settled indices: 0DTE has no assignment risk → 0DTE.
//   SPY / QQQ — physically-settled ETFs: brokers restrict trading 0DTE so
//     close to expiry (assignment risk) → the tradeable horizon is 1DTE.
// SPY-0DTE / QQQ-0DTE are intentionally NOT rostered — not tradeable, so
// collecting/sweeping them is wasted effort.
const ROSTER: RosterEntry[] = [
  { profileId: 'spx-0dte', underlyingDbSymbol: 'SPX', underlyingPolygonTicker: 'I:SPX', optionPrefix: 'SPXW', strikeInterval: 5,  bandHalfWidthDollars: 100, dte: 0 },
  { profileId: 'ndx-0dte', underlyingDbSymbol: 'NDX', underlyingPolygonTicker: 'I:NDX', optionPrefix: 'NDXP', strikeInterval: 10, bandHalfWidthDollars: 500, dte: 0 },
  { profileId: 'spy-1dte', underlyingDbSymbol: 'SPY', underlyingPolygonTicker: 'SPY',   optionPrefix: 'SPY',  strikeInterval: 1,  bandHalfWidthDollars: 10,  dte: 1 },
  { profileId: 'qqq-1dte', underlyingDbSymbol: 'QQQ', underlyingPolygonTicker: 'QQQ',   optionPrefix: 'QQQ',  strikeInterval: 1,  bandHalfWidthDollars: 10,  dte: 1 },
  // XSP = SPX/10 (verified 2026-09-10: Polygon serves I:XSP and O:XSP… 1m aggs). Band mirrors SPX's ±20 strikes.
  { profileId: 'xsp-0dte', underlyingDbSymbol: 'XSP', underlyingPolygonTicker: 'I:XSP', optionPrefix: 'XSP',  strikeInterval: 1,  bandHalfWidthDollars: 20,  dte: 0 },
];

// ── Date helpers ──────────────────────────────────────────────────────────────

function isDST(date: string): boolean {
  const d = new Date(date + 'T12:00:00Z');
  const m = d.getMonth(), day = d.getDate();
  if (m < 2 || m > 10) return false;
  if (m > 2 && m < 10) return true;
  if (m === 2) return day >= 8;
  return day < 1;
}

function lastWeekday(): string {
  const d = new Date();
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * Trading days in [from, to] — weekends AND market holidays excluded. Before
 * 2026-09-10 this skipped weekends only, so on a holiday the run asked Polygon
 * for a day that does not exist, got a soft "no underlying — skip", and still
 * reported Done. Holidays come from src/config MARKET_HOLIDAYS (injectable
 * for tests).
 */
export function tradingDays(from: string, to: string, holidays?: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const s = new Date(from + 'T12:00:00Z'), e = new Date(to + 'T12:00:00Z');
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    if (isTradingDay(day, holidays)) out.push(day);
  }
  return out;
}

function sleepMs(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Underlying fetch (Polygon 1m, RTH-filtered, 429-aware) ────────────────────

async function fetchPolygonUnderlying(ticker: string, dbSymbol: string, date: string): Promise<BarRow[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY not set');
  const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000`;

  let res: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) });
    if (res.status !== 429) break;
    const ra = parseInt(res.headers.get('retry-after') || '', 10);
    await sleepMs(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(60000, 2000 * 2 ** attempt));
  }
  if (!res || res.status === 429) throw new Error(`Polygon underlying ${ticker}: 429/no-response`);
  const data: any = await res.json();
  if (data.status === 'NOT_AUTHORIZED') throw new Error(`Polygon not authorized for ${ticker}`);
  if (data.status === 'ERROR') throw new Error(data.error || 'Polygon error');
  const rows: any[] = data.results || [];
  if (!rows.length) return [];

  const edt = isDST(date);
  const off = edt ? 4 : 5;
  const dayStartMs = new Date(date + 'T00:00:00Z').getTime();
  const rthStart = Math.floor((dayStartMs + (9.5 + off) * 3600_000) / 1000);
  const rthEnd = Math.floor((dayStartMs + (16 + off) * 3600_000) / 1000);

  return rows
    .map(b => ({ t: Math.floor(b.t / 1000), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }))
    .filter(b => b.t >= rthStart && b.t <= rthEnd)
    .map(b => ({
      symbol: dbSymbol, timeframe: '1m', ts: b.t,
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      synthetic: 0, gap_type: null, indicators: '{}', source: 'polygon',
    }));
}

function optionRow(sym: string, b: PolygonBar, src: string): BarRow {
  return {
    symbol: sym, timeframe: '1m', ts: b.t,
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
    synthetic: 0, gap_type: null, indicators: '{}', source: src,
  };
}

function occSymbol(prefix: string, expiry: string, side: 'C' | 'P', strike: number): string {
  const yy = expiry.slice(2, 4), mm = expiry.slice(5, 7), dd = expiry.slice(8, 10);
  return `${prefix}${yy}${mm}${dd}${side}${(strike * 1000).toString().padStart(8, '0')}`;
}

// ── Per profile/date ──────────────────────────────────────────────────────────

async function backfillOne(entry: RosterEntry, date: string, force: boolean): Promise<string> {
  const outFp = path.join(PARQUET_ROOT, entry.profileId, `${date}.parquet`);
  if (!force && fs.existsSync(outFp)) return `${entry.profileId} ${date}: skip (exists)`;

  const under = await fetchPolygonUnderlying(entry.underlyingPolygonTicker, entry.underlyingDbSymbol, date);
  // `date` is a trading day by construction (tradingDays() is holiday-aware),
  // so an empty underlying series is a feed problem, not a closed market.
  if (!under.length) throw new Error(`no underlying bars from Polygon on a trading day`);

  // Strike band from last RTH underlying close.
  const close = Number(under[under.length - 1].close);
  const base = Math.round(close / entry.strikeInterval) * entry.strikeInterval;
  const lo = base - entry.bandHalfWidthDollars;
  const hi = base + entry.bandHalfWidthDollars;
  // Pass the holiday set. Without it nextTradingDay only skips weekends, so a
  // Friday before a Monday holiday resolved its 1DTE expiry TO the holiday —
  // a date with no listed options — and the day was dropped with
  // "underlying only, no option data". 14 such entry dates exist between
  // 2025-04 and 2026-09 (every pre-holiday session), e.g. 2026-09-04 -> Labor Day.
  const expiry = expiryForDate(date, entry.dte, MARKET_HOLIDAYS);

  const rows: BarRow[] = [...under];
  let withData = 0, optBars = 0;
  for (const side of ['C', 'P'] as const) {
    for (let k = lo; k <= hi; k += entry.strikeInterval) {
      const sym = occSymbol(entry.optionPrefix, expiry, side, k);
      try {
        const { bars, src } = await fetchOptionBars(sym, date);
        if (!bars.length) continue;
        withData++;
        for (const b of bars) rows.push(optionRow(sym, b, src));
        optBars += bars.length;
      } catch { /* skip illiquid/missing contract */ }
    }
  }

  if (optBars === 0) return `${entry.profileId} ${date}: ⚠ underlying only, no option data — skip`;
  await writeDayParquet({ profileId: entry.profileId, date, rows });
  return `${entry.profileId} ${date}: ✓ ${under.length} underlying + ${withData} contracts / ${optBars} opt bars`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const pos = args.filter(a => !a.startsWith('--'));
  const force = flags.includes('--force');
  const onlyFlag = flags.find(f => f.startsWith('--only='))?.slice('--only='.length);
  const only = onlyFlag ? new Set(onlyFlag.split(',')) : null;

  const startDate = pos[0] || lastWeekday();
  const endDate = pos[1] || startDate;
  const dates = tradingDays(startDate, endDate);
  const roster = only ? ROSTER.filter(r => only.has(r.profileId)) : ROSTER;

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  EOD parquet backfill — ${roster.map(r => r.profileId).join(', ')}`);
  console.log(`  ${dates.length} day(s): ${startDate} → ${endDate}${force ? '  [--force]' : ''}`);
  console.log(`${'═'.repeat(64)}\n`);

  // Failures are COUNTED, not just printed. Before this, a profile that threw
  // (e.g. "Polygon not authorized for I:SPX") was logged with a ✗ and main()
  // still resolved, so the process exited 0 and eod-pipeline.sh's
  // `if npx tsx ... ; then log "backfill OK"` branch fired. That combination
  // reported "candlesticks downloaded ✓" every weekday from 2026-07-15 while
  // writing nothing — the only SPX data landing was live-capture's flat mids.
  // A backfill that wrote no day for a requested profile is a FAILURE.
  const failures: string[] = [];

  // An empty roster or date list means the request selected nothing — e.g. a
  // typo'd --only=. Silently "succeeding" on zero work is the same class of
  // bug as swallowing the throw, so refuse it.
  if (!roster.length) {
    console.error(`  REFUSED — --only=${onlyFlag ?? ''} matched no profile. Known: ${ROSTER.map(r => r.profileId).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (endDate < startDate) {
    console.error(`  REFUSED — end ${endDate} is before start ${startDate}`);
    process.exitCode = 1;
    return;
  }
  if (!dates.length) {
    // A valid range that contains only weekends/holidays is a legitimate
    // no-op (the nightly cron fires on holidays too), not a failure.
    console.log(`  SKIP — no trading days in ${startDate} → ${endDate} (weekend/holiday)`);
    return;
  }

  for (const date of dates) {
    for (const entry of roster) {
      try {
        console.log('  ' + await backfillOne(entry, date, force));
      } catch (e: any) {
        console.log(`  ${entry.profileId} ${date}: ✗ ${e?.message || e}`);
        failures.push(`${entry.profileId} ${date}: ${e?.message || e}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(64)}`);
  if (failures.length) {
    console.log(`  FAILED — ${failures.length}/${dates.length * roster.length} profile-days wrote nothing:`);
    for (const f of failures.slice(0, 20)) console.log(`    ✗ ${f}`);
    if (failures.length > 20) console.log(`    … and ${failures.length - 20} more`);
    console.log(`${'═'.repeat(64)}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  Done — ${dates.length * roster.length} profile-day(s) OK.\n${'═'.repeat(64)}\n`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
