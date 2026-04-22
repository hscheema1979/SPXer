/**
 * build-mtf-bars.ts — CLI for building multi-timeframe bars from 1m data.
 *
 * Thin wrapper around `src/pipeline/mtf-builder.ts`. Symbol-agnostic:
 * accepts a profile id (--profile=spx-0dte|ndx-0dte|…) to determine the
 * trading-day calendar anchor and indicator tier. When no profile is
 * supplied we default to the SPX profile so legacy invocations keep
 * working exactly as before.
 *
 * Usage:
 *   npx tsx scripts/backfill/build-mtf-bars.ts                              # SPX, all dates
 *   npx tsx scripts/backfill/build-mtf-bars.ts --profile=ndx-0dte           # NDX, all NDX trading dates
 *   npx tsx scripts/backfill/build-mtf-bars.ts 2026-02-20                   # single date
 *   npx tsx scripts/backfill/build-mtf-bars.ts 2026-02-20 2026-03-24        # date range
 *   npx tsx scripts/backfill/build-mtf-bars.ts --tf=3m,5m                   # specific timeframes
 *   npx tsx scripts/backfill/build-mtf-bars.ts --recompute-1m               # also recompute 1m indicators
 *   npx tsx scripts/backfill/build-mtf-bars.ts --symbol=SPX                 # force single symbol
 */
import * as dotenv from 'dotenv';
dotenv.config({ quiet: true });

import Database from 'better-sqlite3';
import * as path from 'path';
import {
  SUPPORTED_TIMEFRAMES,
  buildMtfForSymbol,
  listTradingDatesForSymbol,
  listSymbolsForDate,
} from '../../src/pipeline/mtf-builder';
import { loadProfile } from '../../src/instruments/profile-store';
import { getDb } from '../../src/storage/db';
import type { Timeframe } from '../../src/types';
import type { StoredInstrumentProfile } from '../../src/instruments/profile-store';

const LIVE_DB_PATH = path.resolve(__dirname, '../../data/spxer.db');
const DB_PATH = path.resolve(process.env.DB_PATH || path.resolve(__dirname, '../../data/spxer.db'));

// ── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagArgs = args.filter(a => a.startsWith('--'));
const dateArgs = args.filter(a => !a.startsWith('--'));

function getFlag(name: string): string | undefined {
  const a = flagArgs.find(f => f.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : undefined;
}

const profileId = getFlag('profile') ?? 'spx-0dte';
const tfFlag = getFlag('tf');
const selectedTfs: Timeframe[] = tfFlag
  ? tfFlag.split(',') as Timeframe[]
  : SUPPORTED_TIMEFRAMES;
const recompute1m = flagArgs.includes('--recompute-1m');
const symbolOverride = getFlag('symbol');

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  // Live DB for instrument_profiles lookup
  const liveDb = new Database(LIVE_DB_PATH, { readonly: true });
  // Replay DB for replay_bars read/write
  const replayDb = new Database(DB_PATH);
  replayDb.pragma('journal_mode = WAL');
  replayDb.pragma('busy_timeout = 10000');
  const db = replayDb;
  try {
    const profile = loadProfile(liveDb as unknown as ReturnType<typeof getDb>, profileId);
    if (!profile) {
      console.error(`[build-mtf-bars] Profile '${profileId}' not found in instrument_profiles`);
      process.exit(1);
    }

    const tier = profile.tier;
    const anchor = profile.underlyingSymbol;

    // Trading-day calendar is anchored on the profile's underlying symbol —
    // SPX for SPX family, NDX for NDX family, etc. If the profile's symbol
    // has no 1m coverage yet (brand-new ticker), fall back to SPX dates so
    // the orchestrator can still decide what to backfill.
    let allDates = listTradingDatesForSymbol(db as unknown as Database.Database, anchor);
    if (allDates.length === 0 && anchor !== 'SPX') {
      console.warn(`[build-mtf-bars] ${anchor} has no 1m bars yet — falling back to SPX calendar`);
      allDates = listTradingDatesForSymbol(db as unknown as Database.Database, 'SPX');
    }

    const dates = resolveDateRange(allDates, dateArgs);

    console.log(`\nBuilding MTF bars: profile=${profile.id}, ${dates.length} dates × ${[...(recompute1m ? ['1m'] : []), ...selectedTfs].join(', ')}`);
    console.log(`Cross-day continuity: enabled (prior day seeds indicator state)\n`);

    let totalBars = 0;
    for (let di = 0; di < dates.length; di++) {
      const date = dates[di];
      const priorDate = di > 0
        ? dates[di - 1]
        : (allDates[allDates.indexOf(date) - 1] || null);

      const symbolsToProcess = symbolOverride
        ? [symbolOverride]
        : filterSymbolsForProfile(db as unknown as Database.Database, date, profile);
      let dateBars = 0;

      for (const symbol of symbolsToProcess) {
        const effectiveTier: 1 | 2 = symbol === anchor ? tier : 1;
        const result = buildMtfForSymbol({
          db: db as unknown as Database.Database,
          symbol,
          tier: effectiveTier,
          date,
          priorDate,
          timeframes: selectedTfs,
          recompute1m,
        });
        dateBars += result.barsWritten;
      }

      totalBars += dateBars;
      console.log(`  ${date}: ${symbolsToProcess.length} symbols, ${dateBars} bars written`);
    }

    console.log(`\n  TOTAL: ${totalBars} bars written`);

    // Summary
    const summary = (db as unknown as Database.Database).prepare(`
      SELECT timeframe, COUNT(*) as cnt, COUNT(DISTINCT symbol) as syms
      FROM replay_bars GROUP BY timeframe ORDER BY timeframe
    `).all() as any[];
    console.log('\n  DB Summary:');
    for (const s of summary) {
      console.log(`    ${s.timeframe}: ${s.cnt} bars (${s.syms} symbols)`);
    }
  } finally {
    replayDb.close();
    liveDb.close();
  }
  console.log('\nDone.');
}

/**
 * Pick the dates to process from positional CLI args:
 *   - none: all known trading dates
 *   - one: just that date
 *   - two: inclusive range (start, end)
 */
function resolveDateRange(allDates: string[], positional: string[]): string[] {
  if (positional.length === 0) return allDates;
  if (positional.length === 1) return [positional[0]];
  const startIdx = allDates.indexOf(positional[0]);
  const endIdx = allDates.indexOf(positional[1]);
  return allDates.slice(Math.max(0, startIdx), endIdx + 1);
}

/**
 * Of all symbols with 1m bars on a date, pick the ones that belong to
 * this profile — the underlying itself plus any option symbols whose
 * OCC root matches the profile's prefix. This keeps NDX runs from
 * wandering into SPX option contracts and vice versa.
 */
function filterSymbolsForProfile(
  db: Database.Database,
  date: string,
  profile: StoredInstrumentProfile,
): string[] {
  const all = listSymbolsForDate(db, date);
  const prefix = profile.optionPrefix;
  const underlying = profile.underlyingSymbol;
  return all.filter(s => s === underlying || s.startsWith(prefix));
}

main();
