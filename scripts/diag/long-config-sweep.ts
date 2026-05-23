/**
 * long-config-sweep.ts
 *
 * Long-call sweep: 108,000 variants (36 signals × 750 TP/SL combos × 4 CB configs).
 * Signals: HMA/DEMA with 2+3+5, 2+3, and single timeframes (1m/2m/3m/5m).
 * TP: 10%-500% (by 10%), SL: 20%-90% (by 5%), CB: off/1:1/1:3/3:2.
 * Runs across date range (shardable via sweep-parallel.ts), stores to replay_summary.
 *
 * CRITICAL: NO look-ahead bias. Signal detected at bar CLOSE, entry filled at
 * NEXT bar OPEN (+60s). TP/SL checked only AFTER entry bar.
 *
 * Usage:
 *   Via sweep-parallel: npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine long --shards 8
 *   Standalone:        SWEEP_ALLOW_SERIAL=1 npx tsx scripts/diag/long-config-sweep.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { resolveSymbolTarget, listDatesFor, loadDay, outPath } from './sweep-symbol';
import { shardDates, dumpResults, loadShardsInto, mergeStateFile } from './sweep-shard';

// ── Serial guard ────────────────────────────────────────────────────────────
if (!process.env.SWEEP_SHARD && !process.env.SWEEP_MERGE && !process.env.SWEEP_ALLOW_SERIAL) {
  console.error(`
ERROR: long-config-sweep.ts must NOT be invoked directly.
Use: npx tsx scripts/diag/sweep-parallel.ts --symbol SPX --engine long --shards 8
Or:  SWEEP_ALLOW_SERIAL=1 npx tsx scripts/diag/long-config-sweep.ts (single-date debug)`);
  process.exit(2);
}

const TARGET = resolveSymbolTarget(process.argv);
const DB_PATH = process.env.DB_PATH || './data/spxer.db';

// ── Config ──────────────────────────────────────────────────────────────────
const MIN_ALIGN = 3, CROSS_WIN = 60, MAX_ENTRY = 25, MIN_PRICE = 0.20, MIN_VOL = 100;
const TRADESTART_SEC = 1800, CUTOFF_HHMM = 6 * 3600, SETTLE_HHMM = 6 * 3600 + 15 * 60;
const FAST0 = 3, SLOW0 = 15;

type Signal = 'hma' | 'dema';
interface SignalSpec { label: string; signal: Signal; tfs: { tf: number; fast: number; slow: number }[] }
interface ConfigVariant {
  id: string; name: string; signal: Signal; tfs: { tf: number; fast: number; slow: number }[];
  tp: number; sl: number; cbTrigger: number; cbSkip: number;
}

// ── Variant generator ──────────────────────────────────────────────────────
function generateVariants(): ConfigVariant[] {
  const signals: SignalSpec[] = [
    // Multi-TF: 2+3+5
    { label: 'HMA  2+3+5 3x9',  signal: 'hma', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
    { label: 'HMA  2+3+5 3x12', signal: 'hma', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
    { label: 'HMA  2+3+5 3x21', signal: 'hma', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
    { label: 'DEMA 2+3+5 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9},{tf:5,fast:3,slow:9}] },
    { label: 'DEMA 2+3+5 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12},{tf:5,fast:3,slow:12}] },
    { label: 'DEMA 2+3+5 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21},{tf:5,fast:3,slow:21}] },
    // Multi-TF: 2+3
    { label: 'HMA  2+3 3x9',  signal: 'hma', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
    { label: 'HMA  2+3 3x12', signal: 'hma', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
    { label: 'HMA  2+3 3x21', signal: 'hma', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
    { label: 'DEMA 2+3 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9},{tf:3,fast:3,slow:9}] },
    { label: 'DEMA 2+3 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12},{tf:3,fast:3,slow:12}] },
    { label: 'DEMA 2+3 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21},{tf:3,fast:3,slow:21}] },
    // Single-TF: HMA
    { label: 'HMA  1m 3x9',  signal: 'hma', tfs:[{tf:1,fast:3,slow:9}] },
    { label: 'HMA  2m 3x9',  signal: 'hma', tfs:[{tf:2,fast:3,slow:9}] },
    { label: 'HMA  3m 3x9',  signal: 'hma', tfs:[{tf:3,fast:3,slow:9}] },
    { label: 'HMA  5m 3x9',  signal: 'hma', tfs:[{tf:5,fast:3,slow:9}] },
    { label: 'HMA  1m 3x12', signal: 'hma', tfs:[{tf:1,fast:3,slow:12}] },
    { label: 'HMA  2m 3x12', signal: 'hma', tfs:[{tf:2,fast:3,slow:12}] },
    { label: 'HMA  3m 3x12', signal: 'hma', tfs:[{tf:3,fast:3,slow:12}] },
    { label: 'HMA  5m 3x12', signal: 'hma', tfs:[{tf:5,fast:3,slow:12}] },
    { label: 'HMA  1m 3x21', signal: 'hma', tfs:[{tf:1,fast:3,slow:21}] },
    { label: 'HMA  2m 3x21', signal: 'hma', tfs:[{tf:2,fast:3,slow:21}] },
    { label: 'HMA  3m 3x21', signal: 'hma', tfs:[{tf:3,fast:3,slow:21}] },
    { label: 'HMA  5m 3x21', signal: 'hma', tfs:[{tf:5,fast:3,slow:21}] },
    // Single-TF: DEMA
    { label: 'DEMA 1m 3x9',  signal: 'dema', tfs:[{tf:1,fast:3,slow:9}] },
    { label: 'DEMA 2m 3x9',  signal: 'dema', tfs:[{tf:2,fast:3,slow:9}] },
    { label: 'DEMA 3m 3x9',  signal: 'dema', tfs:[{tf:3,fast:3,slow:9}] },
    { label: 'DEMA 5m 3x9',  signal: 'dema', tfs:[{tf:5,fast:3,slow:9}] },
    { label: 'DEMA 1m 3x12', signal: 'dema', tfs:[{tf:1,fast:3,slow:12}] },
    { label: 'DEMA 2m 3x12', signal: 'dema', tfs:[{tf:2,fast:3,slow:12}] },
    { label: 'DEMA 3m 3x12', signal: 'dema', tfs:[{tf:3,fast:3,slow:12}] },
    { label: 'DEMA 5m 3x12', signal: 'dema', tfs:[{tf:5,fast:3,slow:12}] },
    { label: 'DEMA 1m 3x21', signal: 'dema', tfs:[{tf:1,fast:3,slow:21}] },
    { label: 'DEMA 2m 3x21', signal: 'dema', tfs:[{tf:2,fast:3,slow:21}] },
    { label: 'DEMA 3m 3x21', signal: 'dema', tfs:[{tf:3,fast:3,slow:21}] },
    { label: 'DEMA 5m 3x21', signal: 'dema', tfs:[{tf:5,fast:3,slow:21}] },
  ];
  const tpsl: {tp: number; sl: number}[] = [];
  for (let tp = 10; tp <= 500; tp += 10) {
    for (let sl = 20; sl <= 90; sl += 5) {
      tpsl.push({ tp, sl });
    }
  }
  const cbs = [
    {trigger: 0, skip: 0, label: 'CB-off'},
    {trigger: 1, skip: 1, label: 'CB1:1'},
    {trigger: 1, skip: 3, label: 'CB1:3'},
    {trigger: 3, skip: 2, label: 'CB3:2'},
  ];

  const variants: ConfigVariant[] = [];
  let idx = 0;
  for (const sig of signals) {
    for (const tp of tpsl) {
      for (const cb of cbs) {
        variants.push({
          id: `long-${TARGET.symbol.toLowerCase()}-${idx}`,
          name: `${sig.label} TP${tp.tp / 100}x SL${tp.sl}% ${cb.label}`,
          signal: sig.signal, tfs: sig.tfs, tp: tp.tp, sl: tp.sl,
          cbTrigger: cb.trigger, cbSkip: cb.skip,
        });
        idx++;
      }
    }
  }
  return variants;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sessOpenTs(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const etHour = parseInt(utcNoon.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const offsetH = 12 - etHour;
  return Math.floor(Date.UTC(y, mo - 1, d, 9 + offsetH, 30, 0) / 1000);
}

function prevDate(d: string): string {
  const dt = new Date(d + 'T12:00:00Z');
  dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

// ── Signal engine (from credit-spread-sweep) ────────────────────────────────
interface TFState { closed: any[]; partial: any | null }
function mkSt(): TFState { return { closed: [], partial: null } }
function feed(st: TFState, b: any, tf: number) {
  const bk = Math.floor(b.ts / (tf * 60)) * (tf * 60);
  if (!st.partial || st.partial.ts !== bk) {
    if (st.partial) st.closed.push(st.partial);
    st.partial = { ts: bk, open: b.open, high: b.high, low: b.low, close: b.close };
  } else {
    if (b.high > st.partial.high) st.partial.high = b.high;
    if (b.low < st.partial.low) st.partial.low = b.low;
    st.partial.close = b.close;
  }
}
function wma(arr: number[], end: number, p: number): number | null {
  if (end < p - 1) return null;
  let s = 0, w = 0;
  for (let i = 0; i < p; i++) { s += arr[end - i] * (p - i); w += (p - i) }
  return s / w;
}
function hmaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const hf = Math.floor(fast / 2), sf = Math.floor(Math.sqrt(fast));
  const hs = Math.floor(slow / 2), ss = Math.floor(Math.sqrt(slow));
  const rf: number[] = [], rs: number[] = [];
  let fa: number | null = null, sa: number | null = null;
  for (let i = 0; i < closes.length; i++) {
    const a = wma(closes, i, hf), b = wma(closes, i, fast);
    if (a != null && b != null) { rf.push(2 * a - b); if (rf.length >= sf) fa = wma(rf, rf.length - 1, sf) }
    const c = wma(closes, i, hs), d = wma(closes, i, slow);
    if (c != null && d != null) { rs.push(2 * c - d); if (rs.length >= ss) sa = wma(rs, rs.length - 1, ss) }
  }
  if (fa == null || sa == null) return null;
  return fa > sa ? 'bull' : 'bear';
}
function demaDir(closes: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  function dema(p: number): number | null {
    if (closes.length < p) return null;
    const a = 2 / (p + 1);
    let e1 = 0;
    for (let i = 0; i < p; i++) e1 += closes[i];
    e1 /= p;
    const e1s: number[] = [e1];
    for (let i = p; i < closes.length; i++) { e1 = a * closes[i] + (1 - a) * e1; e1s.push(e1) }
    if (e1s.length < p) return null;
    let e2 = 0;
    for (let i = 0; i < p; i++) e2 += e1s[i];
    e2 /= p;
    for (let i = p; i < e1s.length; i++) { e2 = a * e1s[i] + (1 - a) * e2 }
    return 2 * e1s[e1s.length - 1] - e2;
  }
  const f = dema(fast), s = dema(slow);
  if (f == null || s == null) return null;
  return f > s ? 'bull' : 'bear';
}
function getDir(st: TFState, fast: number, slow: number, signal: Signal): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  const closes = bars.map((b: any) => b.close);
  return signal === 'dema' ? demaDir(closes, fast, slow) : hmaDir(closes, fast, slow);
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function cumVol(bars: any[], from: number, to: number) {
  return bars.filter((b: any) => b.ts >= from && b.ts <= to).reduce((s: number, b: any) => s + (b.volume ?? 0), 0);
}
function findStrike(c1: any, type: 'C' | 'P', targetK: number): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) {
    const sym = s as string;
    if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    const d = Math.abs(k - targetK);
    if (d < bestD) { bestD = d; best = sym }
  }
  return best;
}

// ── Run day (long call logic) ───────────────────────────────────────────────
function runDay(date: string, variant: ConfigVariant, c1: any, p1: any) {
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), eod = sess + 6.5 * 3600, tradeStart = sess + TRADESTART_SEC;
  const gateStartTs = Math.max(tradeStart, tradeStart), gateEndTs = Math.min(eod, SETTLE_HHMM);

  // State machines per timeframe
  const st0 = mkSt();
  const sts = variant.tfs.map(() => mkSt());
  for (const b of (p1?.spxBars ?? [])) {
    feed(st0, b, 1);
    sts.forEach((st, i) => feed(st, b, variant.tfs[i].tf));
  }

  // Signal detection (at bar CLOSE, entry NEXT bar open = +60s)
  const prevDirs: any[] = variant.tfs.map(() => null);
  const bullCross = variant.tfs.map(() => 0), bearCross = variant.tfs.map(() => 0);
  const dirLog = new Map<number, any[]>();
  const entries: any[] = [];
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;

  for (const b of s1) {
    feed(st0, b, 1);
    sts.forEach((st, i) => feed(st, b, variant.tfs[i].tf));
    if (b.ts < tradeStart) continue;

    const dirs = sts.map((st, i) => getDir(st, variant.tfs[i].fast, variant.tfs[i].slow, variant.signal));
    dirLog.set(b.ts, dirs);
    dirs.forEach((d, i) => {
      if (prevDirs[i] !== null && d !== prevDirs[i]) {
        if (d === 'bull') bullCross[i] = b.ts;
        if (d === 'bear') bearCross[i] = b.ts;
      }
      prevDirs[i] = d;
    });

    const allBull = dirs.every(d => d === 'bull'), allBear = dirs.every(d => d === 'bear');
    if (allBull) { bullStreak++; bearStreak = 0; bearFired = false; } else { bullStreak = 0; bullFired = false; }
    if (allBear) { bearStreak++; bullStreak = 0; bullFired = false; } else { bearStreak = 0; bearFired = false; }

    if (allBull && bullStreak >= MIN_ALIGN && !bullFired) {
      const ts = bullCross.filter(t => t > 0);
      if (ts.length === variant.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ ts: b.ts, dir: 'bull', entryTs: b.ts + 60 });
        bullFired = true;
      }
    }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) {
      const ts = bearCross.filter(t => t > 0);
      if (ts.length === variant.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ ts: b.ts, dir: 'bear', entryTs: b.ts + 60 });
        bearFired = true;
      }
    }
  }

  // Execute trades with TP/SL/CB logic
  const raw: any[] = [];
  for (const align of entries) {
    const entryTs = align.entryTs;
    if (entryTs < gateStartTs || entryTs >= gateEndTs) continue;

    const spxEntry = optPx(s1, entryTs - 1);
    if (!spxEntry) continue;

    const otm = spxEntry * 0.01; // Simple OTM: 1% of spot
    const strikeTarget = align.dir === 'bull' ? spxEntry + otm : spxEntry - otm;
    const contractSym = findStrike(c1, align.dir === 'bull' ? 'C' : 'P', strikeTarget);
    if (!contractSym) continue;

    const bars = c1.contractBars.get(contractSym) as any[];
    const entryPx = optPx(bars, entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE || entryPx > MAX_ENTRY) continue;
    if (cumVol(bars, sess, entryTs) < MIN_VOL) continue;

    // TP/SL: entry_px × (1 ± percent/100)
    const tp = entryPx * (1 + variant.tp / 100);
    const sl = variant.sl > 0 ? entryPx * (1 - variant.sl / 100) : 0;

    let exitTs = eod, exitPx = optPx(bars, eod) ?? entryPx, reason = 'EOD';

    // Check TP/SL AFTER entry bar (no look-ahead)
    for (const b of bars) {
      if (b.ts <= entryTs) continue;
      if (b.ts > eod) break;
      if (b.high >= tp) { exitTs = b.ts; exitPx = tp; reason = 'TP'; break; }
      if (sl > 0 && b.low <= sl) { exitTs = b.ts; exitPx = sl; reason = 'SL'; break; }
    }

    const retPct = ((exitPx - entryPx) / entryPx) * 100;
    raw.push({ entryTs, exitTs, dir: align.dir, entryPx, exitPx, retPct, reason });
  }

  // Apply circuit breaker
  const CB = variant.cbTrigger;
  const CBSKIP = variant.cbSkip;
  const taken: boolean[] = [];
  let consec = 0, skipsLeft = 0;
  for (const t of raw) {
    if (skipsLeft > 0) { skipsLeft--; taken.push(false); } else {
      taken.push(true);
      if (CB === 0) { /* disabled */ } else if (t.retPct > 0) { consec = 0; } else {
        consec++;
        if (consec >= CB) { skipsLeft = CBSKIP; consec = 0; }
      }
    }
  }

  const trades = raw.map((t, i) => ({ ...t, active: taken[i] }));
  const active = trades.filter(t => t.active);
  const dayPnl = active.reduce((s: number, t: any) => s + t.retPct, 0);
  const wins = active.filter((t: any) => t.retPct > 0).length;

  return { date, trades: active.length, wins, pnl: dayPnl };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const variants = generateVariants();
  console.log(`[long-config-sweep] Generated ${variants.length} variants`);

  const allDates = listDatesFor(TARGET);
  const myDates = shardDates(allDates);

  if (!myDates.length) {
    console.log(`[long-config-sweep] No dates for this shard`);
    process.exit(0);
  }

  console.log(`[long-config-sweep] Running ${myDates.length} dates for shard ${process.env.SWEEP_SHARD || '0'}`);

  const results = new Map<string, { days: number; trades: number; wins: number; pnl: number }>();

  for (const date of myDates) {
    try {
      const c1 = loadDay(TARGET, date, '1m');
      const p1 = loadDay(TARGET, prevDate(date), '1m');
      if (!c1) { console.log(`[long-config-sweep] ${date}: no data`); continue; }

      for (const variant of variants) {
        const dayResult = runDay(date, variant, c1, p1);
        const key = variant.id;
        const prev = results.get(key) || { days: 0, trades: 0, wins: 0, pnl: 0 };
        results.set(key, {
          days: prev.days + 1,
          trades: prev.trades + dayResult.trades,
          wins: prev.wins + dayResult.wins,
          pnl: prev.pnl + dayResult.pnl,
        });
      }
    } catch (e: any) {
      console.error(`[long-config-sweep] ${date}: ${e.message}`);
    }
  }

  // Store to replay_summary & replay_configs
  const db = new Database(DB_PATH);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS replay_summary (
        configId TEXT PRIMARY KEY,
        days INTEGER, totalTrades INTEGER, totalWins INTEGER,
        totalPnl REAL, worstDay REAL, bestDay REAL, profitDays INTEGER,
        sumWinPct REAL, cntWins INTEGER, sumLossPct REAL, cntLosses INTEGER,
        ev REAL, edge REAL, rMultiple REAL, winRate REAL,
        avgDailyPnl REAL, avgPnlPerTrade REAL
      );
      CREATE TABLE IF NOT EXISTS replay_configs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        config_json TEXT NOT NULL,
        baselineConfigId TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    const now = Math.floor(Date.now() / 1000);
    const summaryStmt = db.prepare(`
      INSERT OR REPLACE INTO replay_summary
      (configId, days, totalTrades, totalWins, totalPnl, avgDailyPnl)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const configStmt = db.prepare(`
      INSERT OR REPLACE INTO replay_configs
      (id, name, description, config_json, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const variant of variants) {
      const res = results.get(variant.id);
      if (!res) continue;

      const avgDailyPnl = res.days > 0 ? res.pnl / res.days : 0;
      summaryStmt.run(variant.id, res.days, res.trades, res.wins, res.pnl, avgDailyPnl);

      const configJson = JSON.stringify({
        signal: variant.signal,
        timeframes: variant.tfs,
        tp: variant.tp,
        sl: variant.sl,
        cbTrigger: variant.cbTrigger,
        cbSkip: variant.cbSkip,
      });
      configStmt.run(
        variant.id,
        variant.name,
        `Long-call sweep: ${variant.name}`,
        configJson,
        now,
        now
      );
    }
  } finally {
    db.close();
  }

  let totalTrades = 0;
  results.forEach(r => { totalTrades += r.trades; });
  console.log(`[long-config-sweep] Completed: ${results.size} configs, ${totalTrades} trades`);

  const outPath = path.join(process.cwd(), 'data', 'results', `long-config-sweep-${TARGET.symbol.toLowerCase()}.json`);
  dumpResults(results, outPath);
}

main().catch(e => {
  console.error('[long-config-sweep] Error:', e);
  process.exit(1);
});
