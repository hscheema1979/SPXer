/**
 * curate-risk-targets.ts — pick the top sweep rows for a profile and emit a
 * /tmp/risk_targets.json that concurrent-distribution.ts consumes for its
 * bulk pre-compute (so the Studio maxPos-cap filter has data ready without
 * the user having to click each variant for an on-demand compute).
 *
 *   npx tsx scripts/diag/curate-risk-targets.ts --symbol SPY --dte 1 [--top 60]
 *
 * Selection: TP-only exits only (no flip / hold-to-settle — credit & iron are
 * TP-only by design), require a meaningful trade count, rank by win-rate then
 * total P&L. Parses the row's signal/spread/exit text into the TargetVariant
 * shape using the SAME regex grammar as backtest-server.parseRowSpec.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolveSymbolTarget, outPath } from './sweep-symbol';

const TARGET = resolveSymbolTarget(process.argv);
const topFlag = process.argv.find(a => a.startsWith('--top='));
const TOP = topFlag ? parseInt(topFlag.split('=')[1], 10)
  : (() => { const i = process.argv.indexOf('--top'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : 60; })();

const sweepFile = outPath(path.join(process.cwd(), 'scripts', 'autoresearch', 'output', 'spread-sweep.json'), TARGET);
if (!fs.existsSync(sweepFile)) {
  console.error(`No sweep file for ${TARGET.symbol}-${TARGET.dte}dte: ${sweepFile}`);
  process.exit(0); // soft-exit so the chain continues
}
const rows: any[] = JSON.parse(fs.readFileSync(sweepFile, 'utf8'));

// Same grammar as backtest-server.parseRowSpec — keep in lockstep.
function parseRowSpec(signal: string, spread: string, exit: string): any | null {
  const sm = /^(HMA|DEMA)\s+([0-9+m]+)\s+(\d+)x(\d+)$/.exec(signal);
  if (!sm || sm[1] === 'DEMA') return null;
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
const candidates = rows
  .filter(r => Number(r.n) >= MIN_N)
  .map(r => ({ r, t: parseRowSpec(r.signal, r.spread, r.exit) }))
  .filter(x => x.t)
  .sort((a, b) => (Number(b.r.wr) - Number(a.r.wr)) || (Number(b.r.pnl) - Number(a.r.pnl)))
  .slice(0, TOP)
  .map(x => x.t);

fs.writeFileSync('/tmp/risk_targets.json', JSON.stringify(candidates, null, 2));
console.log(`[curate] ${TARGET.symbol}-${TARGET.dte}dte: ${candidates.length} targets (of ${rows.length} rows, n>=${MIN_N}) → /tmp/risk_targets.json`);
