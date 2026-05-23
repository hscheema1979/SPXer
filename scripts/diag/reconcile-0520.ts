/**
 * reconcile-0520.ts — For 2026-05-20, compare backtest signals to live trades.
 * For each backtest signal NOT taken live, check whether a live position with
 * overlapping legs (same symbol, opposite sign) was open at that entry time.
 */
import * as fs from 'fs';

const ET = (ts: number) => new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);

// Backtest trades (already emitted)
const bt = JSON.parse(fs.readFileSync('/tmp/today-trades/HMA_1m_3x12__IB±25_w10__TP10_only/2026-05-20.json', 'utf8')).trades as any[];
bt.sort((a, b) => a.entryTs - b.entryTs);

// Live positions
const liveLines = fs.readFileSync('/tmp/live_0520.txt', 'utf8').trim().split('\n');
interface Live { ts: number; side: string; legs: string[]; reason: string; }
const live: Live[] = liveLines.map(l => {
  const [ts, side, sp, lp, sc, lc, reason] = l.split('\t');
  return { ts: +ts, side, legs: [sp, lp, sc, lc], reason };
});

// Build live "open intervals" per leg symbol with sign.
// Live position legs: short_put(+short), long_put(+long), short_call(+short), long_call(+long)
// We approximate open interval as [open_ts, open_ts + 4h] since most rode to cutoff.
// For overlap detection we just need "was a position holding this symbol open at time T".
interface Hold { sym: string; sign: 'long' | 'short'; from: number; to: number; }
const holds: Hold[] = [];
for (const p of live) {
  const to = p.ts + 4 * 3600; // approx hold until session end
  holds.push({ sym: p.legs[0], sign: 'short', from: p.ts, to }); // short put
  holds.push({ sym: p.legs[1], sign: 'long', from: p.ts, to });  // long put
  holds.push({ sym: p.legs[2], sign: 'short', from: p.ts, to }); // short call
  holds.push({ sym: p.legs[3], sign: 'long', from: p.ts, to });  // long call
}

function liveTookAt(ts: number): Live | undefined {
  return live.find(p => Math.abs(p.ts - ts) <= 120); // within 2 min
}
function conflictAt(t: any): string | null {
  // CONFLICT-ONLY rule: block only if a leg nets against an OPPOSITE-side open
  // position (true broker netting). Same-side overlap is allowed (stacks size).
  const want: [string, 'long' | 'short'][] = [
    [t.shortPutSymbol, 'short'], [t.longPutSymbol, 'long'],
    [t.shortCallSymbol, 'short'], [t.longCallSymbol, 'long'],
  ];
  for (const [sym, sign] of want) {
    const opp = sign === 'long' ? 'short' : 'long';
    const h = holds.find(h => h.sym === sym && h.sign === opp && h.from <= t.entryTs && h.to >= t.entryTs);
    if (h) return `${sym}: live holds ${opp}, wants ${sign}`;
  }
  return null;
}

console.log('2026-05-20 — Backtest signals vs Live execution (IB±25 w10 TP10)\n');
console.log('Time   Dir   Body   BacktestPnL  LiveStatus');
console.log('─'.repeat(72));
let taken = 0, conflictBlocked = 0, otherMissed = 0;
for (const t of bt) {
  const l = liveTookAt(t.entryTs);
  let status: string;
  if (l) { status = `TOOK (${l.reason})`; taken++; }
  else {
    const c = conflictAt(t);
    if (c) { status = `BLOCKED — ${c}`; conflictBlocked++; }
    else { status = 'missed (no conflict — other gate/cooldown/slot)'; otherMissed++; }
  }
  console.log(`${ET(t.entryTs)}  ${t.dir.padEnd(4)}  ${t.center.toFixed(0)}   $${((t.pnlNet>=0?'+':'')+Math.round(t.pnlNet)).padStart(5)}      ${status}`);
}
console.log('\n─'.repeat(1));
console.log(`Backtest signals: ${bt.length}`);
console.log(`  Taken live:           ${taken}`);
console.log(`  Blocked by leg overlap: ${conflictBlocked}`);
console.log(`  Missed (other reason):  ${otherMissed}`);
const blockedPnl = bt.filter(t => !liveTookAt(t.entryTs) && conflictAt(t)).reduce((s, t) => s + t.pnlNet, 0);
const missedPnl = bt.filter(t => !liveTookAt(t.entryTs) && !conflictAt(t)).reduce((s, t) => s + t.pnlNet, 0);
console.log(`\nBacktest PnL of leg-overlap-blocked signals: $${Math.round(blockedPnl)}`);
console.log(`Backtest PnL of other-missed signals:        $${Math.round(missedPnl)}`);
