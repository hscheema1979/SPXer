/**
 * Recalculate the replay scorecard with friction baked in.
 * Uses known trade data from replay-library to show raw vs net P&L.
 */
import { computeRealisticPnl } from '../src/core/friction';

interface TradeData {
  entry: number;
  exit: number;
  qty: number;
  side: string;
}

interface DayData {
  date: string;
  trades: TradeData[];
}

// All trades from the 22-day replay library
const days: DayData[] = [
  { date: '2026-02-20', trades: [] },
  { date: '2026-02-23', trades: [] },
  { date: '2026-02-24', trades: [{ entry: 0.68, exit: 0.91, qty: 3, side: 'call' }] },
  { date: '2026-02-25', trades: [] },
  { date: '2026-02-26', trades: [] },
  { date: '2026-02-27', trades: [] },
  { date: '2026-03-02', trades: [] },
  { date: '2026-03-03', trades: [{ entry: 1.50, exit: 0.02, qty: 3, side: 'put' }] },
  { date: '2026-03-04', trades: [] },
  { date: '2026-03-05', trades: [] },
  { date: '2026-03-06', trades: [] },
  { date: '2026-03-09', trades: [{ entry: 1.00, exit: 0.00, qty: 3, side: 'call' }] },
  { date: '2026-03-10', trades: [] },
  { date: '2026-03-11', trades: [{ entry: 0.77, exit: 1.54, qty: 3, side: 'put' }] },
  { date: '2026-03-12', trades: [] },
  { date: '2026-03-13', trades: [] },
  { date: '2026-03-16', trades: [] },
  { date: '2026-03-17', trades: [] },
  { date: '2026-03-18', trades: [] },
  { date: '2026-03-19', trades: [
    { entry: 1.50, exit: 8.85, qty: 3, side: 'call' },
    { entry: 1.00, exit: 0.00, qty: 3, side: 'put' },
  ]},
  { date: '2026-03-20', trades: [{ entry: 0.92, exit: 0.65, qty: 3, side: 'put' }] },
];

let totalTrades = 0;
let totalWins = 0;
let totalWinsNet = 0;
let totalPnlRaw = 0;
let totalPnlNet = 0;
let worstDayRaw = 0;
let worstDayNet = 0;

console.log('# Replay Scorecard — With Friction');
console.log('');
console.log('Friction model: $0.05/side spread + $0.35/contract/side commission');
console.log('');
console.log('## Per-Day Results');
console.log('');
console.log('| Date | Trades | W/L | Raw P&L | Net P&L | Friction |');
console.log('|------|--------|-----|---------|---------|----------|');

for (const day of days) {
  if (day.trades.length === 0) continue;

  let dayRaw = 0;
  let dayNet = 0;
  let dayWins = 0;
  let dayWinsNet = 0;

  for (const t of day.trades) {
    const rawPnl = (t.exit - t.entry) * t.qty * 100;
    const result = computeRealisticPnl(t.entry, t.exit, t.qty);
    const netPnl = result['pnl$'];
    dayRaw += rawPnl;
    dayNet += netPnl;
    if (rawPnl > 0) dayWins++;
    if (netPnl > 0) dayWinsNet++;
  }

  totalTrades += day.trades.length;
  totalWins += dayWins;
  totalWinsNet += dayWinsNet;
  totalPnlRaw += dayRaw;
  totalPnlNet += dayNet;
  if (dayRaw < worstDayRaw) worstDayRaw = dayRaw;
  if (dayNet < worstDayNet) worstDayNet = dayNet;

  const losses = day.trades.length - dayWins;
  const friction = dayRaw - dayNet;
  console.log(`| ${day.date} | ${day.trades.length} | ${dayWins}/${losses} | $${dayRaw.toFixed(0)} | $${dayNet.toFixed(0)} | $${friction.toFixed(0)} |`);
}

const wrRaw = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;
const wrNet = totalTrades > 0 ? (totalWinsNet / totalTrades * 100) : 0;
const tradingDays = days.filter(d => d.trades.length > 0).length;
const allDays = days.length;
const frictionTotal = totalPnlRaw - totalPnlNet;
const frictionPct = totalPnlRaw !== 0 ? (frictionTotal / Math.abs(totalPnlRaw) * 100) : 0;

console.log('');
console.log('## Summary');
console.log('');
console.log(`**Date range**: 2026-02-20 to 2026-03-20`);
console.log(`**Days tested**: ${allDays} (${tradingDays} with trades)`);
console.log('');
console.log('| Metric | Raw | With Friction | Target | Pass |');
console.log('|--------|-----|---------------|--------|------|');
console.log(`| Win rate | ${wrRaw.toFixed(1)}% | ${wrNet.toFixed(1)}% | >40% | ${wrNet > 40 ? '✅' : '❌'} |`);
console.log(`| Total P&L | $${totalPnlRaw.toFixed(0)} | $${totalPnlNet.toFixed(0)} | >$0 | ${totalPnlNet > 0 ? '✅' : '❌'} |`);
console.log(`| Avg P&L/trading day | $${(totalPnlRaw / tradingDays).toFixed(0)} | $${(totalPnlNet / tradingDays).toFixed(0)} | >$0 | ${totalPnlNet / tradingDays > 0 ? '✅' : '❌'} |`);
console.log(`| Avg P&L/all days | $${(totalPnlRaw / allDays).toFixed(0)} | $${(totalPnlNet / allDays).toFixed(0)} | >$0 | ${totalPnlNet / allDays > 0 ? '✅' : '❌'} |`);
console.log(`| Worst day loss | $${worstDayRaw.toFixed(0)} | $${worstDayNet.toFixed(0)} | >-$500 | ${worstDayNet > -500 ? '✅' : '❌'} |`);
console.log(`| Total friction | - | $${frictionTotal.toFixed(0)} | - | - |`);
console.log(`| Friction % of gross | - | ${frictionPct.toFixed(1)}% | - | - |`);

console.log('');
console.log('## Per-Trade Detail');
console.log('');
console.log('| Date | Side | Entry | Exit | Qty | Raw P&L | Eff Entry | Eff Exit | Net P&L | Drag |');
console.log('|------|------|-------|------|-----|---------|-----------|----------|---------|------|');

for (const day of days) {
  for (const t of day.trades) {
    const rawPnl = (t.exit - t.entry) * t.qty * 100;
    const result = computeRealisticPnl(t.entry, t.exit, t.qty);
    const netPnl = result['pnl$'];
    const drag = rawPnl - netPnl;
    console.log(`| ${day.date} | ${t.side} | $${t.entry.toFixed(2)} | $${t.exit.toFixed(2)} | ${t.qty} | $${rawPnl.toFixed(0)} | $${result.effectiveEntry.toFixed(2)} | $${result.effectiveExit.toFixed(2)} | $${netPnl.toFixed(0)} | $${drag.toFixed(0)} |`);
  }
}
