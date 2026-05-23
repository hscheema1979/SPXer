/**
 * today-walkthrough.ts — Walk through 2026-05-20 trade-by-trade under three
 * different position-management policies, showing exactly what each entered
 * and what the resulting P&L would have been.
 *
 * Policies:
 *   A. Backtest "infinite account" — take every signal (29 trades)
 *   B. Leg-conflict gate — skip if any leg's symbol is already net-open with
 *      opposite sign in the portfolio
 *   C. One-position-at-a-time — skip if any position is currently open
 *   D. Bull-only — skip all bear signals
 *
 * Usage: npx tsx scripts/diag/today-walkthrough.ts
 */
import * as fs from 'fs';

const d = JSON.parse(fs.readFileSync('/tmp/today-trades/HMA_1m_3x12__IB±25_w10__TP10_only/2026-05-20.json', 'utf8'));
const trades = d.trades as any[];
trades.sort((a, b) => a.entryTs - b.entryTs);

function et(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour12: false }).slice(0, 5);
}

// Each trade has 4 legs, each with a sign:
//   +1 = short (we sold) → net account position −1 at that symbol (if size 1)
//   −1 = long (we bought) → net account position +1
// Iron fly legs from emitted record:
//   shortPutSymbol  : sign +1 (short)
//   longPutSymbol   : sign −1 (long)
//   shortCallSymbol : sign +1 (short)
//   longCallSymbol  : sign −1 (long)
// "Sign" here is from the V-formula perspective. Account position is the
// inverse — we credit short positions to the account as negative size.
// For conflict detection: a new SHORT into a symbol where we hold LONG
// (or vice versa) causes broker netting.

interface AcctPos {
  // Per-symbol net account position. Positive = we're net long N. Negative = net short N.
  netSize: Map<string, number>;
}
function applyLegs(acct: AcctPos, t: any, dir: 1 | -1) {
  // dir = +1 when opening trade, −1 when closing
  const update = (sym: string, sign: 'long' | 'short') => {
    const delta = (sign === 'long' ? +1 : -1) * dir;
    acct.netSize.set(sym, (acct.netSize.get(sym) || 0) + delta);
    if (acct.netSize.get(sym) === 0) acct.netSize.delete(sym);
  };
  update(t.shortPutSymbol, 'short');
  update(t.longPutSymbol, 'long');
  update(t.shortCallSymbol, 'short');
  update(t.longCallSymbol, 'long');
}

function wouldConflict(acct: AcctPos, t: any): string | null {
  // Trade wants to add: short shortPutSymbol, long longPutSymbol, short shortCallSymbol, long longCallSymbol
  // Conflict if any of these flips the sign of existing position.
  const pairs: [string, 'long' | 'short'][] = [
    [t.shortPutSymbol, 'short'],
    [t.longPutSymbol, 'long'],
    [t.shortCallSymbol, 'short'],
    [t.longCallSymbol, 'long'],
  ];
  for (const [sym, sign] of pairs) {
    const cur = acct.netSize.get(sym) || 0;
    const wantDelta = sign === 'long' ? +1 : -1;
    // Conflict if cur and wantDelta have opposite signs (would net through zero)
    if (cur !== 0 && Math.sign(cur) !== Math.sign(wantDelta)) {
      return `${sym}: have ${cur > 0 ? 'long' : 'short'} ${Math.abs(cur)}, want to ${sign}`;
    }
  }
  return null;
}

// Build event timeline: each trade is one "open" event at entryTs and one
// "close" event at exitTs. Process in order, applying each policy.
interface Event { ts: number; kind: 'open' | 'close'; trade: any; }
const events: Event[] = [];
for (const t of trades) {
  events.push({ ts: t.entryTs, kind: 'open', trade: t });
  events.push({ ts: t.exitTs, kind: 'close', trade: t });
}
events.sort((a, b) => a.ts === b.ts ? (a.kind === 'close' ? -1 : 1) : a.ts - b.ts);

let openCount = 0;
function simulate(policy: 'A' | 'B' | 'C' | 'D' | 'E', slotLimit = 5): { entries: any[]; totalPnl: number; details: string[] } {
  const acct: AcctPos = { netSize: new Map() };
  const taken = new Set<string>();   // entry ids we accepted
  const details: string[] = [];
  let totalPnl = 0;
  let openSlots = 0;

  for (const ev of events) {
    if (ev.kind === 'open') {
      const t = ev.trade;
      let allow = true;
      let reason = '';
      if (policy === 'D' && t.dir === 'bear') { allow = false; reason = 'bull-only'; }
      if (policy === 'C' && acct.netSize.size > 0) { allow = false; reason = 'position open'; }
      if (policy === 'B') {
        const c = wouldConflict(acct, t);
        if (c) { allow = false; reason = `leg conflict: ${c}`; }
      }
      if (policy === 'E') {
        if (openSlots >= slotLimit) { allow = false; reason = `slot limit (${slotLimit}) full`; }
        else {
          const c = wouldConflict(acct, t);
          if (c) { allow = false; reason = `leg conflict: ${c}`; }
        }
      }
      if (allow) {
        taken.add(t.entryTs + '|' + t.dir);
        applyLegs(acct, t, +1);
        totalPnl += t.pnlNet;
        details.push(`  ${et(t.entryTs)} ${t.dir.padEnd(4)} body ${t.center.toFixed(0)} → ENTER (pnl ${t.pnlNet >= 0 ? '+' : ''}${t.pnlNet.toFixed(0)})`);
      } else {
        details.push(`  ${et(t.entryTs)} ${t.dir.padEnd(4)} body ${t.center.toFixed(0)} → SKIP (${reason})`);
      }
    } else {
      const t = ev.trade;
      if (taken.has(t.entryTs + '|' + t.dir)) {
        applyLegs(acct, t, -1);
      }
    }
  }
  return { entries: [...taken], totalPnl, details };
}

const policies = [
  { code: 'A', label: 'Infinite account (current backtest)' },
  { code: 'B', label: 'Leg-conflict gate (broker netting realistic)' },
  { code: 'C', label: 'One position at a time' },
  { code: 'D', label: 'Bull-only' },
] as const;

console.log('='.repeat(90));
console.log('TODAY (2026-05-20) — IB±25 w10 TP10, walked through 29 signals under each policy');
console.log(`SPX open ${d.spxOpen?.toFixed(2)} → close ${d.spxClose?.toFixed(2)} (+${(d.spxClose - d.spxOpen).toFixed(0)}pts)`);
console.log('='.repeat(90));

for (const p of policies) {
  const r = simulate(p.code);
  console.log(`\n--- Policy ${p.code}: ${p.label} ---`);
  console.log(`Total trades entered: ${r.entries.length}`);
  console.log(`Net P&L per contract: $${r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(0)}`);
  if (p.code !== 'A') {
    console.log(`(${r.details.filter(d => d.includes('SKIP')).length} skips, ${r.details.filter(d => d.includes('ENTER')).length} enters)`);
  }
}

// Detailed log for policy B (the realistic one)
console.log('\n' + '='.repeat(90));
console.log('DETAILED LOG — Policy B (leg-conflict gate)');
console.log('='.repeat(90));
const detB = simulate('B');
for (const line of detB.details) console.log(line);
