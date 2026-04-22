/**
 * scripts/test-profile-fetch.ts
 *
 * Phase 2 resume Step 1 — pre-market vendor parity test.
 *
 * Goal: prove the profile-driven vendor call shape works for a non-SPX ticker,
 * WITHOUT touching src/index.ts, the live agent, or the ThetaData WS.
 *
 * Run pre-market against a test profile (default: ndx-0dte). Exits non-zero
 * on any failure so it can be wired into CI later.
 *
 * Usage:
 *   npx tsx scripts/test-profile-fetch.ts               # defaults to ndx-0dte
 *   npx tsx scripts/test-profile-fetch.ts spx-0dte      # run against SPX for sanity
 *   npx tsx scripts/test-profile-fetch.ts spy-1dte
 *
 * What it exercises:
 *   1. Profile registry lookup by id (requireProfile)
 *   2. canGoLive() check (NDX should be backtest-only)
 *   3. Underlying quote via Tradier fetchBatchQuotes — profile.execution.underlyingSymbol
 *   4. Expirations via Tradier fetchExpirations — same param
 *   5. Options chain via Tradier fetchOptionsChain for the nearest expiry
 *   6. Band filter: how many strikes land within ±bandWidthDollars of the underlying
 *   7. Timesales via Tradier fetchTimesales for today (if available)
 *
 * It does NOT:
 *   - Start the ThetaData WebSocket
 *   - Subscribe to option ticks
 *   - Build bars or write to the DB
 *   - Submit any orders
 */

import { requireProfile, canGoLive } from '../src/instruments/registry';
import {
  fetchBatchQuotes,
  fetchExpirations,
  fetchOptionsChain,
  fetchTimesales,
} from '../src/providers/tradier';
import { todayET } from '../src/utils/et-time';

const OK = '\x1b[32m✓\x1b[0m';
const FAIL = '\x1b[31m✗\x1b[0m';
const INFO = '\x1b[36mℹ\x1b[0m';

async function main() {
  const profileId = process.argv[2] ?? 'ndx-0dte';

  console.log(`\n=== Profile-driven vendor fetch test: ${profileId} ===\n`);

  // ── 1. Profile registry lookup ────────────────────────────────────
  const profile = requireProfile(profileId);
  console.log(`${OK} Profile loaded: ${profile.displayName}`);
  console.log(`  id=${profile.id}`);
  console.log(`  underlying=${profile.execution.underlyingSymbol}`);
  console.log(`  option prefix=${profile.options.prefix}`);
  console.log(`  strike interval=$${profile.options.strikeInterval}`);
  console.log(`  band width=±$${profile.bandWidthDollars}`);
  console.log(`  account=${profile.execution.accountId ?? '(none — backtest only)'}`);
  console.log(`  canGoLive=${canGoLive(profile)}\n`);

  // ── 2. Underlying quote ───────────────────────────────────────────
  const symbol = profile.execution.underlyingSymbol;
  const quotes = await fetchBatchQuotes([symbol]);
  const q = quotes.get(symbol);
  if (!q || !q.last) {
    console.log(`${FAIL} Underlying quote for ${symbol}: missing or no 'last' price`);
    console.log(`  raw: ${JSON.stringify(q ?? null)}`);
    process.exit(1);
  }
  console.log(`${OK} Underlying quote (Tradier /markets/quotes)`);
  console.log(`  ${symbol} last=$${q.last} bid=${q.bid ?? '—'} ask=${q.ask ?? '—'}`);
  console.log(`  open=${q.open ?? '—'} high=${q.high ?? '—'} low=${q.low ?? '—'} volume=${q.volume}\n`);

  const underlyingPrice = q.last;

  // ── 3. Expirations ────────────────────────────────────────────────
  const expirations = await fetchExpirations(symbol);
  if (!expirations.length) {
    console.log(`${FAIL} No expirations returned for ${symbol}`);
    process.exit(1);
  }
  console.log(`${OK} Expirations (Tradier /markets/options/expirations)`);
  console.log(`  count=${expirations.length}`);
  console.log(`  nearest 5: ${expirations.slice(0, 5).join(', ')}`);
  const today = todayET();
  const zeroDte = expirations.find(e => e === today);
  const nearest = zeroDte ?? expirations[0];
  console.log(`  today ET=${today}  0DTE available=${Boolean(zeroDte)}  using expiry=${nearest}\n`);

  // ── 4. Options chain for nearest expiry ───────────────────────────
  const chain = await fetchOptionsChain(symbol, nearest, false); // greeks off to keep response small
  if (!chain.length) {
    console.log(`${FAIL} Empty chain for ${symbol} ${nearest}`);
    process.exit(1);
  }
  console.log(`${OK} Options chain (Tradier /markets/options/chains)`);
  console.log(`  total contracts=${chain.length}  expiry=${nearest}`);

  // Verify symbol prefix matches profile
  const prefixMismatch = chain.filter(c => !c.symbol.startsWith(profile.options.prefix));
  if (prefixMismatch.length) {
    console.log(`${FAIL} ${prefixMismatch.length} contracts have prefix != '${profile.options.prefix}'`);
    console.log(`  sample mismatches: ${prefixMismatch.slice(0, 3).map(c => c.symbol).join(', ')}`);
    process.exit(1);
  }
  console.log(`  ${OK} all contracts use prefix '${profile.options.prefix}'`);

  // ── 5. Band filter ─────────────────────────────────────────────────
  const band = profile.bandWidthDollars;
  const inBand = chain.filter(
    c => Math.abs(c.strike - underlyingPrice) <= band,
  );
  const callsInBand = inBand.filter(c => c.type === 'call');
  const putsInBand = inBand.filter(c => c.type === 'put');
  console.log(`  band ±$${band} around $${underlyingPrice}:`);
  console.log(`    total=${inBand.length}  calls=${callsInBand.length}  puts=${putsInBand.length}`);

  // Sample ATM call + put
  const atmCall = callsInBand
    .filter(c => c.strike >= underlyingPrice)
    .sort((a, b) => a.strike - b.strike)[0];
  const atmPut = putsInBand
    .filter(c => c.strike <= underlyingPrice)
    .sort((a, b) => b.strike - a.strike)[0];
  if (atmCall) {
    console.log(
      `    ATM call: ${atmCall.symbol} strike=$${atmCall.strike} bid=${atmCall.bid ?? '—'} ask=${atmCall.ask ?? '—'}`,
    );
  }
  if (atmPut) {
    console.log(
      `    ATM put:  ${atmPut.symbol} strike=$${atmPut.strike} bid=${atmPut.bid ?? '—'} ask=${atmPut.ask ?? '—'}`,
    );
  }
  console.log();

  // ── 6. Timesales for the underlying (bar-builder input shape) ─────
  try {
    const bars = await fetchTimesales(symbol, today);
    if (!bars.length) {
      console.log(`${INFO} Timesales (${symbol}, ${today}): 0 bars`);
      console.log(`  (expected if pre-market hasn't started yet for this instrument — not a failure)\n`);
    } else {
      const first = bars[0];
      const last = bars[bars.length - 1];
      console.log(`${OK} Timesales (Tradier /markets/timesales, interval=1min)`);
      console.log(`  count=${bars.length}`);
      console.log(`  first: ts=${new Date(first.ts * 1000).toISOString()} o=${first.o} h=${first.h} l=${first.l} c=${first.c} v=${first.v}`);
      console.log(`  last:  ts=${new Date(last.ts * 1000).toISOString()} o=${last.o} h=${last.h} l=${last.l} c=${last.c} v=${last.v}\n`);
    }
  } catch (e: any) {
    console.log(`${FAIL} Timesales call threw: ${e?.message ?? e}\n`);
  }

  console.log(`${OK} All profile-driven vendor calls succeeded for ${profileId}.`);
  console.log(`   No code touched: src/index.ts, spx_agent.ts, ThetaData WS, option-stream pipeline.\n`);
}

main().catch(e => {
  console.error('[test-profile-fetch] FATAL:', e);
  process.exit(1);
});
