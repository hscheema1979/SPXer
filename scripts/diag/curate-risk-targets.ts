/**
 * curate-risk-targets.ts — pick the top sweep rows for a profile and emit a
 * /tmp/risk_targets.json that concurrent-distribution.ts consumes for its
 * bulk pre-compute (so the Studio maxPos-cap filter has data ready without
 * the user having to click each variant for an on-demand compute).
 *
 *   npx tsx scripts/diag/curate-risk-targets.ts --symbol SPY --dte 1 [--top 60]
 *   npx tsx scripts/diag/curate-risk-targets.ts --symbol NDX --25k [--top 200]
 *
 * --25k mode: selects all rows viable for a 25k account (peakRiskCapacity<=25k,
 *   dd>=500, wr 55-90%, n>=200), includes DEMA signals, sorts by avg daily P&L.
 *   concurrent-distribution.ts cannot simulate flip exits, so those are excluded.
 *
 * Default mode: TP-only, HMA-only, rank by win-rate then total P&L.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, outPath } from './sweep-symbol';

const TARGET = resolveSymbolTarget(process.argv);
const topFlag = process.argv.find(a => a.startsWith('--top='));
const TOP = topFlag ? parseInt(topFlag.split('=')[1], 10)
  : (() => { const i = process.argv.indexOf('--top'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 60; })();
const mode25k = process.argv.includes('--25k');

const sweepFile = outPath(path.join(process.cwd(), 'scripts', 'autoresearch', 'output', 'spread-sweep.json'), TARGET);
if (!fs.existsSync(sweepFile)) {
  console.error(`No sweep file for ${TARGET.symbol}-${TARGET.dte}dte: ${sweepFile}`);
  process.exit(0); // soft-exit so the chain continues
}
const rows: any[] = JSON.parse(fs.readFileSync(sweepFile, 'utf8'));

// Same grammar as backtest-server.parseRowSpec — keep in lockstep.
// allowDema: also accept DEMA signals (concurrent-distribution supports them).
function parseRowSpec(signal: string, spread: string, exit: string, allowDema = false): any | null {
  const sm = /^(HMA|DEMA)\s+([0-9+m]+)\s+(\d+)x(\d+)$/.exec(signal);
  if (!sm || (sm[1] === 'DEMA' && !allowDema)) return null;
  const timeframes = sm[2].replace(/m/g, '').split('+').map(Number);
  const hmaFast = +sm[3], hmaSlow = +sm[4];
  let kind: 'iron' | 'spread' | null = null;
  let centerOffset = 0, shortOffset = 0, wingWidth = 0, width = 0, m;
  if ((m = /^IB(?:±(\d+))?\s+w(\d+)$/.exec(spread))) {
    kind = 'iron'; centerOffset = m[1] ? +m[1] : 0; wingWidth = +m[2];
  } else if ((m = /^IC\s+(\d+)w(\d+)$/.exec(spread))) {
    kind = 'iron'; shortOffset = +m[1]; wingWidth = +m[2];
  } else if ((m = /^(?:(\d+)(ITM|OTM)|ATM)\s+w(\d+)$/.exec(spread))) {
    kind = 'spread';
    shortOffset = m[1] ? +m[1] * (m[2] === 'ITM' ? -1 : 1) : 0;
    width = +m[3];
  } else { return null; }
  if (exit === 'hold-to-settle' || exit === 'flip only') return null;
  const em = /^TP(\d+)\s*(only|\+flip|SL(\d+(?:\.\d+)?)x)?$/.exec(exit);
  if (!em || (em[2] || '').includes('flip')) return null;
  return {
    label: `${signal}|${spread}|${exit}`, hmaFast, hmaSlow, timeframes, kind,
    centerOffset, shortOffset, wingWidth, width,
    tpFrac: +em[1] / 100, slMult: em[3] ? +em[3] : 0,
  };
}

// Trade-count floor scales with grid density (ETF $1 strikes → more variants,
// fewer trades each). Keep it modest so we don't starve the list.
const MIN_N = 200;

let candidates: any[];
if (mode25k) {
  // 25k account filter: fits in 25k capital, survivable drawdown, real win rate range.
  // Excludes flip/hold-to-settle exits since concurrent-distribution can't simulate them.
  candidates = rows
    .filter(r => Number(r.n) >= MIN_N && Number(r.numActiveDays) >= 100 && Number(r.pnl) > 0)
    .filter(r => Number(r.peakRiskCapacity) <= 25000)
    .filter(r => Number(r.dd) >= 500)
    .filter(r => Number(r.wr) >= 55 && Number(r.wr) <= 90)
    .map(r => ({ r, t: parseRowSpec(r.signal, r.spread, r.exit, true) }))
    .filter(x => x.t)
    .sort((a, b) => {
      const dpnlA = Number(a.r.pnl) / Math.max(1, Number(a.r.numActiveDays));
      const dpnlB = Number(b.r.pnl) / Math.max(1, Number(b.r.numActiveDays));
      return dpnlB - dpnlA;
    })
    .slice(0, TOP)
    .map(x => x.t);
  console.log(`[curate] ${TARGET.symbol}-${TARGET.dte}dte 25k-mode: ${candidates.length} targets (peakCap<=25k, dd>=500, wr 55-90%, n>=${MIN_N}) → /tmp/risk_targets.json`);
} else {
  candidates = rows
    .filter(r => Number(r.n) >= MIN_N)
    .map(r => ({ r, t: parseRowSpec(r.signal, r.spread, r.exit) }))
    .filter(x => x.t)
    .sort((a, b) => (Number(b.r.wr) - Number(a.r.wr)) || (Number(b.r.pnl) - Number(a.r.pnl)))
    .slice(0, TOP)
    .map(x => x.t);
  console.log(`[curate] ${TARGET.symbol}-${TARGET.dte}dte: ${candidates.length} targets (of ${rows.length} rows, n>=${MIN_N}) → /tmp/risk_targets.json`);
}

fs.writeFileSync('/tmp/risk_targets.json', JSON.stringify(candidates, null, 2));
console.log(`Written ${candidates.length} targets.`);
