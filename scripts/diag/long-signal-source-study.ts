/**
 * long-signal-source-study.ts
 *
 * Small study (20 days) to decide which SIGNAL SOURCE is most effective for the
 * long-call sweep, before committing to the full grid. Three sources:
 *
 *   spx       — MA cross on SPX underlying drives BOTH direction and entry/exit
 *               timing (the current long-config-sweep behavior).
 *   contract  — SPX cross gives DIRECTION only (call vs put + which strike);
 *               the MA cross is then run on the TARGET CONTRACT's own bars for
 *               entry timing AND the reversal exit.
 *   both      — require the SPX cross AND the contract cross to agree (bull/bear)
 *               at entry; reversal exit fires when EITHER flips against us.
 *
 * Common to all: strike offset swept ITM→OTM (−25..+25 in $5 strikes), and
 * flip-on-reversal always on (bull call closes on bear flip; bear put on bull).
 *
 * Run: npx tsx scripts/diag/long-signal-source-study.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true } as any);
import { resolveSymbolTarget, listDatesFor, loadDay } from './sweep-symbol';

const TARGET = resolveSymbolTarget(['n', 'x', '--symbol', 'SPX']);
const SI = TARGET.strikeInterval; // $5 for SPX

const MIN_ALIGN = 3, CROSS_WIN = 60, MIN_PRICE = 0.20, MAX_ENTRY = 25, MIN_VOL = 100;
const TRADESTART_SEC = 1800, SETTLE_HHMM = 6 * 3600 + 15 * 60;
const FIXED_TP = 100, FIXED_SL = 50; // hold TP/SL constant so we isolate signal source

// Representative single-TF signal for the study (mid-of-the-road).
const STUDY_SIG = { signal: 'hma' as const, tf: 3, fast: 3, slow: 12 };
// Strike offsets in STRIKES (× SI = $). Negative = ITM, positive = OTM.
const OFFSETS = [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5].map(n => n); // −25..+25 in $5

// ── signal engine (shared) ──────────────────────────────────────────────────
interface TFState { closed: any[]; partial: any | null }
const mkSt = (): TFState => ({ closed: [], partial: null });
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
function wma(a: number[], e: number, p: number): number | null {
  if (e < p - 1) return null;
  let s = 0, w = 0;
  for (let i = 0; i < p; i++) { s += a[e - i] * (p - i); w += (p - i); }
  return s / w;
}
function hmaDir(c: number[], fast: number, slow: number): 'bull' | 'bear' | null {
  const hf = Math.floor(fast / 2), sf = Math.floor(Math.sqrt(fast));
  const hs = Math.floor(slow / 2), ss = Math.floor(Math.sqrt(slow));
  const rf: number[] = [], rs: number[] = [];
  let fa: number | null = null, sa: number | null = null;
  for (let i = 0; i < c.length; i++) {
    const a = wma(c, i, hf), b = wma(c, i, fast);
    if (a != null && b != null) { rf.push(2 * a - b); if (rf.length >= sf) fa = wma(rf, rf.length - 1, sf); }
    const cc = wma(c, i, hs), d = wma(c, i, slow);
    if (cc != null && d != null) { rs.push(2 * cc - d); if (rs.length >= ss) sa = wma(rs, rs.length - 1, ss); }
  }
  if (fa == null || sa == null) return null;
  return fa > sa ? 'bull' : 'bear';
}
function dirOf(st: TFState): 'bull' | 'bear' | null {
  const bars = st.partial ? [...st.closed, st.partial] : st.closed;
  if (!bars.length) return null;
  return hmaDir(bars.map((b: any) => b.close), STUDY_SIG.fast, STUDY_SIG.slow);
}
function optPx(bars: any[], ts: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].ts <= ts) return bars[i].close;
  return null;
}
function cumVol(bars: any[], from: number, to: number) {
  return bars.filter((b: any) => b.ts >= from && b.ts <= to).reduce((s: number, b: any) => s + (b.volume ?? 0), 0);
}
function sessOpenTs(d: string): number {
  const [y, mo, dd] = d.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, dd, 12, 0, 0));
  const eh = parseInt(n.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return Math.floor(Date.UTC(y, mo - 1, dd, 9 + (12 - eh), 30, 0) / 1000);
}
function prevDate(d: string): string {
  const dt = new Date(d + 'T12:00:00Z'); dt.setUTCDate(dt.getUTCDate() - 1);
  if (dt.getUTCDay() === 0) dt.setUTCDate(dt.getUTCDate() - 2);
  if (dt.getUTCDay() === 6) dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
// Pick the contract whose strike = round(spx)+offsetStrikes*SI for the given type.
function findStrikeAtOffset(c1: any, type: 'C' | 'P', spx: number, offStrikes: number): string | null {
  const target = Math.round(spx / SI) * SI + offStrikes * SI;
  let best: string | null = null, bestD = Infinity;
  for (const [s] of c1.contractBars) {
    const sym = s as string;
    if (sym[sym.length - 9] !== type) continue;
    const k = c1.contractStrikes.get(sym);
    const d = Math.abs(k - target);
    if (d < bestD) { bestD = d; best = sym; }
  }
  return best;
}

// Detect SPX direction at every minute (for direction + spx-source timing/flip).
function spxDirLog(date: string, c1: any, p1: any): { entries: { dir: 'bull' | 'bear'; ts: number }[]; dirAt: Map<number, 'bull' | 'bear' | null> } {
  const s1 = c1.spxBars, sess = sessOpenTs(date), tradeStart = sess + TRADESTART_SEC;
  const st = mkSt();
  for (const b of (p1?.spxBars ?? [])) feed(st, b, STUDY_SIG.tf);
  const dirAt = new Map<number, 'bull' | 'bear' | null>();
  const entries: { dir: 'bull' | 'bear'; ts: number }[] = [];
  let prev: 'bull' | 'bear' | null = null, bull = 0, bear = 0, bf = false, brf = false;
  for (const b of s1) {
    feed(st, b, STUDY_SIG.tf);
    if (b.ts < tradeStart) { dirAt.set(b.ts, dirOf(st)); continue; }
    const d = dirOf(st); dirAt.set(b.ts, d); prev = d;
    if (d === 'bull') { bull++; bear = 0; brf = false; } else { bull = 0; bf = false; }
    if (d === 'bear') { bear++; bull = 0; bf = false; } else { bear = 0; brf = false; }
    if (d === 'bull' && bull >= MIN_ALIGN && !bf) { entries.push({ dir: 'bull', ts: b.ts }); bf = true; }
    if (d === 'bear' && bear >= MIN_ALIGN && !brf) { entries.push({ dir: 'bear', ts: b.ts }); brf = true; }
  }
  return { entries, dirAt };
}

// Run one (source, offset) over one day. Returns aggregate stats.
function runDay(date: string, source: 'spx' | 'contract' | 'both', offStrikes: number, c1: any, p1: any) {
  const s1 = c1.spxBars, sess = sessOpenTs(date), eod = sess + 6.5 * 3600;
  const tradeStart = sess + TRADESTART_SEC, gateEnd = Math.min(eod, sess + SETTLE_HHMM);
  const { entries: spxEntries, dirAt: spxDir } = spxDirLog(date, c1, p1);

  let trades = 0, wins = 0, pnl = 0;

  for (const e of spxEntries) {
    const entryTs = e.ts + 60;
    if (entryTs < tradeStart || entryTs >= gateEnd) continue;
    const spxAtEntry = optPx(s1, entryTs - 1);
    if (!spxAtEntry) continue;

    // Direction always from SPX; strike from offset (ITM<0 / OTM>0).
    const type: 'C' | 'P' = e.dir === 'bull' ? 'C' : 'P';
    // For a CALL: OTM = strike above spot (+offset); ITM = below (−offset). For a
    // PUT: OTM = strike below spot. signedOff aligns "+offset = more OTM".
    const signedOff = e.dir === 'bull' ? offStrikes : -offStrikes;
    const sym = findStrikeAtOffset(c1, type, spxAtEntry, signedOff);
    if (!sym) continue;
    const bars = c1.contractBars.get(sym) as any[];
    if (!bars?.length) continue;

    // Build the contract's own MA-dir series if needed (contract/both sources).
    let contractDirAt: Map<number, 'bull' | 'bear' | null> | null = null;
    if (source !== 'spx') {
      contractDirAt = new Map();
      const cst = mkSt();
      for (const b of bars) { feed(cst, b, STUDY_SIG.tf); contractDirAt.set(b.ts, dirOf(cst)); }
    }

    // Entry gating: 'both' requires the contract dir to be bull at/just-before
    // entry (contract rising = good for a long). 'contract' uses the contract's
    // own cross for timing — approximate by requiring contract dir bull at entry.
    if (source !== 'spx') {
      const cd = lastDirAtOrBefore(contractDirAt!, entryTs - 1);
      if (cd !== 'bull') continue; // long wants the contract trending up
    }

    const entryPx = optPx(bars, entryTs - 1);
    if (!entryPx || entryPx < MIN_PRICE || entryPx > MAX_ENTRY) continue;
    if (cumVol(bars, sess, entryTs) < MIN_VOL) continue;

    const tp = entryPx * (1 + FIXED_TP / 100), sl = entryPx * (1 - FIXED_SL / 100);

    // Reversal timestamp depends on source.
    let reverseTs = Infinity;
    for (let t = entryTs; t <= eod; t += 60) {
      const spxd = lastDirAtOrBefore(spxDir, t);
      const flipSpx = e.dir === 'bull' ? spxd === 'bear' : spxd === 'bull';
      let flip = false;
      if (source === 'spx') flip = flipSpx;
      else {
        const cd = lastDirAtOrBefore(contractDirAt!, t);
        const flipC = cd === 'bear'; // long contract turning down
        if (source === 'contract') flip = flipC;
        else flip = flipSpx || flipC; // 'both': either flips
      }
      if (flip) { reverseTs = t + 60; break; }
    }

    // Exit scan: TP/SL up to reversal, else exit at reversal/EOD.
    const stopTs = Math.min(reverseTs, eod);
    let exitPx = optPx(bars, stopTs) ?? entryPx;
    for (const b of bars) {
      if (b.ts <= entryTs) continue;
      if (b.ts > stopTs) break;
      if (b.high >= tp) { exitPx = tp; break; }
      if (b.low <= sl) { exitPx = sl; break; }
    }
    const retPct = ((exitPx - entryPx) / entryPx) * 100;
    trades++;
    if (retPct > 0) wins++;
    pnl += (exitPx - entryPx) * 100;
  }
  return { trades, wins, pnl };
}

// Contract bars are irregularly spaced (illiquid minutes missing), so we can't
// assume a 60s grid. Find the entry with the largest ts <= probe.
function lastDirAtOrBefore(m: Map<number, 'bull' | 'bear' | null>, ts: number): 'bull' | 'bear' | null {
  let bestTs = -Infinity, bestVal: 'bull' | 'bear' | null = null;
  for (const [t, v] of m) { if (t <= ts && t > bestTs) { bestTs = t; bestVal = v; } }
  return bestVal;
}

async function main() {
  const all = listDatesFor(TARGET);
  const step = Math.floor(all.length / 20);
  const dates = Array.from({ length: 20 }, (_, i) => all[i * step]).filter(Boolean);
  console.log(`Study: ${dates.length} dates, signal HMA 3m 3x12, TP${FIXED_TP}/SL${FIXED_SL}, flip-on-reversal ON`);
  console.log(`Sources: spx | contract | both    Offsets (strikes, neg=ITM): ${OFFSETS.join(',')}\n`);

  const sources: ('spx' | 'contract' | 'both')[] = ['spx', 'contract', 'both'];
  // agg[source] = {trades,wins,pnl}; also per-offset breakdown
  const agg: Record<string, { trades: number; wins: number; pnl: number }> = {};
  const byOff: Record<string, Record<number, { trades: number; wins: number; pnl: number }>> = {};
  for (const s of sources) { agg[s] = { trades: 0, wins: 0, pnl: 0 }; byOff[s] = {}; for (const o of OFFSETS) byOff[s][o] = { trades: 0, wins: 0, pnl: 0 }; }

  for (const date of dates) {
    const c1 = loadDay(TARGET, date, '1m');
    const p1 = loadDay(TARGET, prevDate(date), '1m');
    if (!c1?.spxBars?.length) { console.log(`  ${date}: no data`); continue; }
    for (const source of sources) {
      for (const off of OFFSETS) {
        const r = runDay(date, source, off, c1, p1);
        agg[source].trades += r.trades; agg[source].wins += r.wins; agg[source].pnl += r.pnl;
        byOff[source][off].trades += r.trades; byOff[source][off].wins += r.wins; byOff[source][off].pnl += r.pnl;
      }
    }
    process.stdout.write('.');
  }
  console.log('\n');

  console.log('=== SIGNAL SOURCE SUMMARY (all offsets combined) ===');
  console.log('source     trades   WR%     totalPnl$     $/trade');
  for (const s of sources) {
    const a = agg[s];
    const wr = a.trades ? (100 * a.wins / a.trades).toFixed(1) : '0';
    const pt = a.trades ? (a.pnl / a.trades).toFixed(0) : '0';
    console.log(`${s.padEnd(10)} ${String(a.trades).padStart(6)}  ${wr.padStart(5)}  ${a.pnl.toFixed(0).padStart(11)}  ${pt.padStart(8)}`);
  }

  console.log('\n=== BEST OFFSET PER SOURCE (by $/trade, min 50 trades) ===');
  for (const s of sources) {
    let best = { off: 0, pnl: -Infinity, wr: 0, n: 0, pt: -Infinity };
    for (const o of OFFSETS) {
      const b = byOff[s][o];
      if (b.trades < 50) continue;
      const pt = b.pnl / b.trades;
      if (pt > best.pt) best = { off: o, pnl: b.pnl, wr: 100 * b.wins / b.trades, n: b.trades, pt };
    }
    const moneyness = best.off < 0 ? `${Math.abs(best.off) * SI}ITM` : best.off > 0 ? `${best.off * SI}OTM` : 'ATM';
    console.log(`${s.padEnd(10)} best offset = ${moneyness.padEnd(7)} ($/trade ${best.pt.toFixed(0)}, WR ${best.wr.toFixed(1)}%, n=${best.n}, total $${best.pnl.toFixed(0)})`);
  }

  console.log('\n=== PER-OFFSET $/trade GRID (rows=source, cols=offset in $) ===');
  const hdr = OFFSETS.map(o => (o < 0 ? `-${Math.abs(o) * SI}` : o > 0 ? `+${o * SI}` : '0').padStart(7)).join('');
  console.log('source    ' + hdr);
  for (const s of sources) {
    const cells = OFFSETS.map(o => {
      const b = byOff[s][o];
      return (b.trades >= 20 ? (b.pnl / b.trades).toFixed(0) : '·').padStart(7);
    }).join('');
    console.log(s.padEnd(10) + cells);
  }
}
main();
