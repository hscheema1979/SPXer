/**
 * long-config-sweep.ts
 *
 * Long-call sweep (v1): 27,000 variants (36 signals × 750 TP/SL combos, CB-off).
 * Signals: HMA/DEMA with 2+3+5, 2+3, and single timeframes (1m/2m/3m/5m).
 * TP: 10%-500% (by 10%), SL: 20%-90% (by 5%). Circuit breakers dropped for v1.
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
  id: string; name: string; sigLabel: string; signal: Signal;
  tfs: { tf: number; fast: number; slow: number }[];
  tp: number; sl: number; cbTrigger: number; cbSkip: number;
}

// ── Signal specs (module-level: shared by generator + main detect loop) ──────
const SIGNALS: SignalSpec[] = [
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
const SIG_BY_LABEL = new Map<string, SignalSpec>(SIGNALS.map(s => [s.label, s]));

// ── Variant generator ──────────────────────────────────────────────────────
function generateVariants(): ConfigVariant[] {
  const signals = SIGNALS;
  const tpsl: {tp: number; sl: number}[] = [];
  for (let tp = 10; tp <= 500; tp += 10) {
    for (let sl = 20; sl <= 90; sl += 5) {
      tpsl.push({ tp, sl });
    }
  }
  // v1: circuit breakers dropped (CB-off only) → 36 × 750 × 1 = 27,000 variants.
  // Re-add {1:1, 1:3, 3:2} here once the baseline TP/SL surface is validated.
  const cbs = [
    {trigger: 0, skip: 0, label: 'CB-off'},
  ];

  const variants: ConfigVariant[] = [];
  let idx = 0;
  for (const sig of signals) {
    for (const tp of tpsl) {
      for (const cb of cbs) {
        variants.push({
          id: `long-${TARGET.symbol.toLowerCase()}-${idx}`,
          name: cb.trigger === 0
            ? `${sig.label} TP${tp.tp}% SL${tp.sl}%`
            : `${sig.label} TP${tp.tp}% SL${tp.sl}% ${cb.label}`,
          sigLabel: sig.label,
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

// ── Per-entry trade context (signal-spec dependent, TP/SL independent) ───────
// Built ONCE per (date, signalSpec). The contract entry price, the post-entry
// bar trajectory, and entry filters do NOT depend on TP/SL — only the exit
// scan does. So we cache these and let the TP/SL sweep replay exits cheaply.
interface TradeCtx {
  dir: 'bull' | 'bear';
  entryTs: number;
  entryPx: number;
  bars: any[];   // contract bars (post-entry trajectory scanned at exit time)
  eod: number;
}

// Detect entries + build per-entry trade contexts for ONE signal spec.
function buildTradeContexts(date: string, sig: SignalSpec, c1: any, p1: any): TradeCtx[] {
  const s1: any[] = c1.spxBars;
  const sess = sessOpenTs(date), eod = sess + 6.5 * 3600, tradeStart = sess + TRADESTART_SEC;
  const gateStartTs = tradeStart, gateEndTs = Math.min(eod, sess + SETTLE_HHMM);

  const st0 = mkSt();
  const sts = sig.tfs.map(() => mkSt());
  for (const b of (p1?.spxBars ?? [])) {
    feed(st0, b, 1);
    sts.forEach((st, i) => feed(st, b, sig.tfs[i].tf));
  }

  const prevDirs: any[] = sig.tfs.map(() => null);
  const bullCross = sig.tfs.map(() => 0), bearCross = sig.tfs.map(() => 0);
  const entries: { dir: 'bull' | 'bear'; entryTs: number }[] = [];
  let bullStreak = 0, bearStreak = 0, bullFired = false, bearFired = false;

  for (const b of s1) {
    feed(st0, b, 1);
    sts.forEach((st, i) => feed(st, b, sig.tfs[i].tf));
    if (b.ts < tradeStart) continue;

    const dirs = sts.map((st, i) => getDir(st, sig.tfs[i].fast, sig.tfs[i].slow, sig.signal));
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
      if (ts.length === sig.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ dir: 'bull', entryTs: b.ts + 60 });
        bullFired = true;
      }
    }
    if (allBear && bearStreak >= MIN_ALIGN && !bearFired) {
      const ts = bearCross.filter(t => t > 0);
      if (ts.length === sig.tfs.length && (Math.max(...ts) - Math.min(...ts)) / 60 <= CROSS_WIN) {
        entries.push({ dir: 'bear', entryTs: b.ts + 60 });
        bearFired = true;
      }
    }
  }

  // Resolve contract + entry price + entry filters ONCE per entry.
  const ctxs: TradeCtx[] = [];
  for (const e of entries) {
    if (e.entryTs < gateStartTs || e.entryTs >= gateEndTs) continue;
    const spxEntry = optPx(s1, e.entryTs - 1);
    if (!spxEntry) continue;

    const otm = spxEntry * 0.01; // Simple OTM: 1% of spot
    const strikeTarget = e.dir === 'bull' ? spxEntry + otm : spxEntry - otm;
    const contractSym = findStrike(c1, e.dir === 'bull' ? 'C' : 'P', strikeTarget);
    if (!contractSym) continue;

    const bars = c1.contractBars.get(contractSym) as any[];
    const entryPx = optPx(bars, e.entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE || entryPx > MAX_ENTRY) continue;
    if (cumVol(bars, sess, e.entryTs) < MIN_VOL) continue;

    ctxs.push({ dir: e.dir, entryTs: e.entryTs, entryPx, bars, eod });
  }
  return ctxs;
}

// Sweep a single TP/SL over the pre-built trade contexts. Cheap — just the
// exit scan, no signal recomputation. CB-off for v1 (every entry taken).
function simulateExits(ctxs: TradeCtx[], tpPct: number, slPct: number) {
  let trades = 0, wins = 0, pnl = 0;
  for (const ctx of ctxs) {
    const tp = ctx.entryPx * (1 + tpPct / 100);
    const sl = slPct > 0 ? ctx.entryPx * (1 - slPct / 100) : 0;

    let exitPx = optPx(ctx.bars, ctx.eod) ?? ctx.entryPx;
    for (const b of ctx.bars) {
      if (b.ts <= ctx.entryTs) continue;
      if (b.ts > ctx.eod) break;
      if (b.high >= tp) { exitPx = tp; break; }
      if (sl > 0 && b.low <= sl) { exitPx = sl; break; }
    }
    const retPct = ((exitPx - ctx.entryPx) / ctx.entryPx) * 100;
    trades++;
    if (retPct > 0) wins++;
    pnl += retPct;
  }
  return { trades, wins, pnl };
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

  // Group variants by signal label so we detect each signal ONCE per date,
  // then replay the cheap TP/SL exit scan over the cached entries. This is the
  // performance fix: 36 signal detections per date instead of 27,000.
  const bySig = new Map<string, ConfigVariant[]>();
  for (const v of variants) {
    const arr = bySig.get(v.sigLabel) || [];
    arr.push(v);
    bySig.set(v.sigLabel, arr);
  }
  const sigLabels = Array.from(bySig.keys());

  const results = new Map<string, { days: number; trades: number; wins: number; pnl: number }>();

  for (let di = 0; di < myDates.length; di++) {
    const date = myDates[di];
    if (di % 10 === 0) console.log(`[long-config-sweep] ${di}/${myDates.length} ${date}`);
    try {
      const c1 = loadDay(TARGET, date, '1m');
      const p1 = loadDay(TARGET, prevDate(date), '1m');
      if (!c1) { console.log(`[long-config-sweep] ${date}: no data`); continue; }

      for (const sigLabel of sigLabels) {
        const sigVariants = bySig.get(sigLabel)!;
        const sig = SIG_BY_LABEL.get(sigLabel)!;
        const ctxs = buildTradeContexts(date, sig, c1, p1);

        for (const variant of sigVariants) {
          const r = simulateExits(ctxs, variant.tp, variant.sl);
          const prev = results.get(variant.id) || { days: 0, trades: 0, wins: 0, pnl: 0 };
          results.set(variant.id, {
            days: prev.days + 1,
            trades: prev.trades + r.trades,
            wins: prev.wins + r.wins,
            pnl: prev.pnl + r.pnl,
          });
        }
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
