/**
 * live-capture.ts — market-hours option-chain capture daemon.
 *
 * Polygon + ThetaData are cancelled; Tradier (live brokerage market data) is
 * the only remaining source. This daemon polls Tradier once per minute during
 * RTH for each configured instrument (SPX/NDX/XSP 0DTE, SPY/QQQ 1DTE), keeps
 * the ATM±10% strike window, and appends to TWO parquet trees:
 *
 *   data/parquet/snapshots/{profile}/{date}.parquet   NEW — bid/ask + greeks +
 *                                                      live BS delta (the thing
 *                                                      we can no longer buy)
 *   data/parquet/bars/{profile}/{date}.parquet         existing OHLCV schema, so
 *                                                      backtests keep getting fed
 *
 * Bars are minute snapshots: open=high=low=close=mid (Tradier is a snapshot
 * API, not a tick feed), so intra-minute range is not captured — close/mid is
 * the field that matters for 0/1DTE strategies.
 *
 * Durability: every poll is written to a per-day SQLite (data/live-capture/
 * {date}.db) keyed by (profile, ts, symbol), so a crash/restart mid-session
 * resumes without losing captured minutes; parquet is a full-file rewrite from
 * SQLite every 5 minutes and once more at the close.
 *
 * Run:  npx tsx scripts/live/live-capture.ts            (loop until close)
 *       npx tsx scripts/live/live-capture.ts --once     (single poll + flush)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

import { fetchBatchQuotes, fetchExpirations, fetchOptionsChain } from '../../src/providers/tradier';
import { getETOffsetMs, nowET, todayET } from '../../src/utils/et-time';
import { CAPTURE_INSTRUMENTS, RTH_START_ET, type CaptureInstrument } from '../../src/live/instruments';
import { bsDelta, impliedVolFromMid } from '../../src/live/bs';
import { writeDaySnapshots, SNAPSHOT_COLUMNS, type SnapshotRow } from '../../src/storage/snapshot-writer';
import { writeDayParquet, type BarRow } from '../../src/storage/parquet-writer';

const POLL_MS = 60_000;
const FLUSH_EVERY_MS = 5 * 60_000;
const DB_DIR = path.resolve(process.cwd(), 'data/live-capture');
const ONCE = process.argv.includes('--once');

// ── SQLite (per-day durability) ─────────────────────────────────────────────

function openDb(date: string): Database.Database {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const db = new Database(path.join(DB_DIR, `${date}.db`));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      profile TEXT NOT NULL,
      ${SNAPSHOT_COLUMNS.map((c) => `${c} ${c === 'symbol' || c === 'underlying' || c === 'expiry' || c === 'right' ? 'TEXT' : 'REAL'}`).join(',\n      ')},
      PRIMARY KEY (profile, ts, symbol)
    );
    CREATE TABLE IF NOT EXISTS underlying (
      profile TEXT NOT NULL,
      ts INTEGER NOT NULL,
      symbol TEXT NOT NULL,
      px REAL,
      volume INTEGER,
      PRIMARY KEY (profile, ts)
    );
  `);
  return db;
}

// ── Expiry resolution ───────────────────────────────────────────────────────

/** Pick the capture expiry for an instrument from Tradier's expiration list. */
async function resolveExpiry(inst: CaptureInstrument, today: string): Promise<string | null> {
  const all = await fetchExpirations(inst.chainSymbol);
  const upcoming = all.filter((d) => d >= today).sort();
  if (upcoming.length === 0) return null;
  if (inst.dte === 0) return upcoming[0];               // nearest (today if listed)
  const after = upcoming.filter((d) => d > today);      // strictly after today = 1DTE
  return after[0] ?? upcoming[upcoming.length - 1];
}

/** Epoch seconds for a YYYY-MM-DD expiry at 16:00 ET (settlement reference). */
function expirySecs(expiry: string): number {
  return Math.floor((Date.parse(`${expiry}T16:00:00Z`) + getETOffsetMs()) / 1000);
}

function calDaysBetween(today: string, expiry: string): number {
  return Math.round((Date.parse(expiry + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
}

// ── One poll of one instrument ──────────────────────────────────────────────

async function pollInstrument(
  db: Database.Database,
  inst: CaptureInstrument,
  expiry: string,
  today: string,
  barTs: number,
  capturedAt: number,
): Promise<{ contracts: number }> {
  // 1) underlying quote
  const quotes = await fetchBatchQuotes([inst.underlyingSymbol]);
  const uq = quotes.get(inst.underlyingSymbol);
  const spot =
    uq?.last ??
    (uq && uq.bid != null && uq.ask != null ? (uq.bid + uq.ask) / 2 : null);
  if (spot == null || !(spot > 0)) {
    console.warn(`[capture] ${inst.profileId}: no underlying quote for ${inst.underlyingSymbol}`);
    return { contracts: 0 };
  }

  db.prepare(
    `INSERT OR REPLACE INTO underlying (profile, ts, symbol, px, volume) VALUES (?,?,?,?,?)`
  ).run(inst.profileId, barTs, inst.underlyingSymbol, spot, uq?.volume ?? 0);

  // 2) option chain with greeks, filtered to the ATM window
  const chain = await fetchOptionsChain(inst.chainSymbol, expiry, true);
  const lo = spot * (1 - inst.windowPct);
  const hi = spot * (1 + inst.windowPct);
  const expSecs = expirySecs(expiry);
  const dte = calDaysBetween(today, expiry);
  const secsToExp = expSecs - capturedAt;

  const insert = db.prepare(
    `INSERT OR REPLACE INTO snapshots (profile, ${SNAPSHOT_COLUMNS.join(', ')})
     VALUES (@profile, ${SNAPSHOT_COLUMNS.map((c) => '@' + c).join(', ')})`
  );

  let n = 0;
  const tx = db.transaction((rows: SnapshotRow[]) => {
    for (const r of rows) insert.run({ profile: inst.profileId, ...r });
  });

  const rows: SnapshotRow[] = [];
  for (const c of chain) {
    if (c.strike < lo || c.strike > hi) continue;
    const isCall = c.type === 'call';
    const mid =
      c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0 ? (c.bid + c.ask) / 2 : c.last;
    const iv = c.impliedVolatility;
    // Prefer Tradier's ORATS IV; fall back to solving IV from the mid so
    // bs_delta stays populated on contracts Tradier didn't price.
    const effIv =
      iv != null && iv > 0
        ? iv
        : mid != null && mid > 0
          ? impliedVolFromMid(spot, c.strike, secsToExp, mid, isCall)
          : null;
    const bs = effIv != null && effIv > 0 ? bsDelta(spot, c.strike, secsToExp, effIv, isCall) : null;
    rows.push({
      ts: barTs,
      captured_at: capturedAt,
      symbol: c.symbol,
      underlying: inst.underlyingSymbol,
      underlying_px: spot,
      expiry,
      dte,
      strike: c.strike,
      right: isCall ? 'C' : 'P',
      bid: c.bid,
      ask: c.ask,
      mid: mid ?? null,
      last: c.last,
      volume: c.volume,
      open_interest: c.openInterest,
      iv,
      delta: c.delta,
      gamma: c.gamma,
      theta: c.theta,
      vega: c.vega,
      bs_delta: bs,
    });
    n++;
  }
  tx(rows);
  return { contracts: n };
}

// ── Flush SQLite → parquet (both trees) for one profile ─────────────────────

async function flushProfile(db: Database.Database, profileId: string, date: string): Promise<void> {
  const snapRows = db
    .prepare(`SELECT ${SNAPSHOT_COLUMNS.join(', ')} FROM snapshots WHERE profile = ? ORDER BY ts, symbol`)
    .all(profileId) as SnapshotRow[];
  if (snapRows.length === 0) return;

  // snapshots tree (greeks)
  const snapRes = await writeDaySnapshots({ profileId, date, rows: snapRows });

  // bars tree (OHLCV) — option minute-snapshot bars (o=h=l=c=mid) …
  const bars: BarRow[] = [];
  for (const r of snapRows) {
    const px = r.mid ?? r.last;
    if (px == null) continue;
    bars.push({
      symbol: r.symbol,
      timeframe: '1m',
      ts: r.ts,
      open: px, high: px, low: px, close: px,
      volume: r.volume ?? 0,
      source: 'tradier-live',
      spread: r.bid != null && r.ask != null ? r.ask - r.bid : null,
    });
  }
  // … plus underlying minute bars
  const uRows = db
    .prepare(`SELECT ts, symbol, px, volume FROM underlying WHERE profile = ? ORDER BY ts`)
    .all(profileId) as Array<{ ts: number; symbol: string; px: number; volume: number }>;
  for (const u of uRows) {
    if (u.px == null) continue;
    bars.push({
      symbol: u.symbol,
      timeframe: '1m',
      ts: u.ts,
      open: u.px, high: u.px, low: u.px, close: u.px,
      volume: u.volume ?? 0,
      source: 'tradier-live',
    });
  }

  let barRes = { rowCount: 0 };
  if (bars.length > 0) {
    barRes = await writeDayParquet({ profileId, date, rows: bars });
  }
  console.log(
    `[flush] ${profileId}: snapshots=${snapRes.rowCount} (${(snapRes.fileSize / 1024).toFixed(0)}KB), bars=${barRes.rowCount}`
  );
}

// ── Main loop ───────────────────────────────────────────────────────────────

function minutesET(t: { h: number; m: number }): number {
  return t.h * 60 + t.m;
}
function parseET(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

async function flushAll(db: Database.Database, date: string): Promise<void> {
  for (const inst of CAPTURE_INSTRUMENTS) {
    try {
      await flushProfile(db, inst.profileId, date);
    } catch (e: any) {
      console.error(`[flush] ${inst.profileId} FAILED: ${e.message}`);
    }
  }
}

async function main() {
  const startMin = parseET(RTH_START_ET);
  const endMin = Math.max(...CAPTURE_INSTRUMENTS.map((i) => parseET(i.rthEndET)));

  const date = todayET();
  const db = openDb(date);
  console.log(`[capture] start ${date}  instruments=${CAPTURE_INSTRUMENTS.map((i) => i.profileId).join(',')}  once=${ONCE}`);

  // Resolve each instrument's target expiry once.
  const expiries = new Map<string, string>();
  for (const inst of CAPTURE_INSTRUMENTS) {
    const exp = await resolveExpiry(inst, date);
    if (exp) {
      expiries.set(inst.profileId, exp);
      console.log(`[capture] ${inst.profileId} → expiry ${exp} (dte=${inst.dte})`);
    } else {
      console.warn(`[capture] ${inst.profileId}: no expiry available — skipping`);
    }
  }

  let lastFlush = 0;

  const tick = async (): Promise<boolean> => {
    const nowSec = Math.floor(Date.now() / 1000);
    const barTs = Math.floor(nowSec / 60) * 60;
    const et = nowET();
    const curMin = minutesET(et);

    if (!ONCE && curMin < startMin) {
      console.log(`[capture] pre-open (${et.h}:${String(et.m).padStart(2, '0')} ET) — waiting`);
      return true; // keep waiting
    }

    for (const inst of CAPTURE_INSTRUMENTS) {
      const exp = expiries.get(inst.profileId);
      if (!exp) continue;
      if (!ONCE && curMin > parseET(inst.rthEndET)) continue; // this instrument done for the day
      try {
        const { contracts } = await pollInstrument(db, inst, exp, date, barTs, nowSec);
        console.log(`[capture] ${inst.profileId}: ${contracts} contracts @ ${et.h}:${String(et.m).padStart(2, '0')} ET`);
      } catch (e: any) {
        console.error(`[capture] ${inst.profileId} poll error: ${e.message}`);
      }
    }

    if (Date.now() - lastFlush >= FLUSH_EVERY_MS) {
      await flushAll(db, date);
      lastFlush = Date.now();
    }

    // Signal completion once every instrument's window has closed.
    return ONCE ? false : curMin <= endMin;
  };

  if (ONCE) {
    await tick();
    await flushAll(db, date);
    db.close();
    console.log('[capture] --once complete');
    return;
  }

  // Poll loop, aligned roughly to the minute.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const keepGoing = await tick();
    if (!keepGoing) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  await flushAll(db, date);
  db.close();
  console.log('[capture] session complete — final flush written');
}

main().catch((e) => {
  console.error('[capture] fatal:', e);
  process.exit(1);
});
