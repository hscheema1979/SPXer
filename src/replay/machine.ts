/**
 * Replay machine — config-driven execution engine.
 * One instance = one config + one date. Parallelizable.
 *
 * Extracts proven logic from replay-full.ts and wires it to the config/store system.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import Database from 'better-sqlite3';
import * as path from 'path';
import { getJudgeConfigs, getScannerConfigs, askModel } from '../agent/model-clients';
import type { ModelConfig } from '../agent/model-clients';
import { initSession as initRegimeSession, classify, getSignalGate, formatRegimeContext } from '../agent/regime-classifier';
import { getScannerPrompt as getPromptFromLibrary } from './prompt-library';
import type { ReplayConfig, Trade, ReplayResult } from './types';
import { ReplayStore } from './store';
import { etLabel, buildSymbolFilter, buildSymbolRange, buildSessionTimestamps, computeMetrics } from './metrics';

// ── Core modules (shared with live agent) ─────────────────────────────────
import { detectSignals } from '../core/signal-detector';
import { checkExit, type ExitContext } from '../core/position-manager';
import { computeQty } from '../core/position-sizer';
import { isRiskBlocked, type RiskState } from '../core/risk-guard';
import { isRegimeBlocked } from '../core/regime-gate';
import { computeRealisticPnl, frictionEntry } from '../core/friction';
import type { Signal, CoreBar, Direction } from '../core/types';
import { makeHMAState, hmaStep, makeKCState, kcStep } from '../pipeline/indicators/tier1';
import { readBarCacheFile, writeBarCacheFile, hasCacheFile } from './bar-cache-file';

// ── Strategy engine (signal detection + trade decisions) ──────────────────
import { detectSignal, createInitialSignalState, type SignalState, type CorePosition } from '../core/strategy-engine';
import { evaluateExit, evaluateEntry, type ExitDecision } from '../core/trade-manager';
import { selectStrike, type StrikeCandidate } from '../core/strike-selector';

const DATA_DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

// Configurable data source: 'bars' (live) or 'replay_bars' (sanitized Polygon)
const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';


// ── Internal types ─────────────────────────────────────────────────────────

interface Bar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
  indicators: Record<string, number | null>;
}

interface SimPosition {
  id: string;
  symbol: string; side: 'call' | 'put'; strike: number; qty: number;
  entryPrice: number; stopLoss: number; takeProfit: number;
  entryTs: number; entryET: string;
  highWaterPrice: number; // tracks peak price for trailing stop
}

// ── In-memory bar cache (loaded once per replay) ───────────────────────────

interface BarCache {
  spxBars: Bar[];                       // All SPX 1m bars, sorted by ts
  contractBars: Map<string, Bar[]>;     // symbol → bars, sorted by ts
  contractStrikes: Map<string, number>; // symbol → strike price
  timestamps: number[];                 // SPX timestamps for the session
}

// All denormalized indicator columns in replay_bars (order matters for SELECT)
const INDICATOR_COLUMNS = [
  'hma3', 'hma5', 'hma15', 'hma17', 'hma19', 'hma25',
  'ema9', 'ema21', 'rsi14',
  'bbUpper', 'bbMiddle', 'bbLower', 'bbWidth',
  'atr14', 'atrPct', 'vwap',
  'kcUpper', 'kcMiddle', 'kcLower', 'kcWidth', 'kcSlope',
] as const;

const INDICATOR_SELECT = INDICATOR_COLUMNS.join(', ');

/** Build indicators object from denormalized columns (avoids JSON.parse) */
function rowToIndicators(r: any): Record<string, number | null> {
  const ind: Record<string, number | null> = {};
  for (const col of INDICATOR_COLUMNS) {
    if (r[col] != null) ind[col] = r[col];
  }
  return ind;
}

/** Empty indicators singleton — shared by all contract bars in price-only mode */
const EMPTY_INDICATORS: Record<string, number | null> = Object.freeze({});

function loadBarCache(
  db: Database.Database, start: number, end: number,
  symbolRange: { lo: string; hi: string },
  timeframe: string = '1m',
  opts?: { skipContractIndicators?: boolean; date?: string },
): BarCache {
  // Load bars at the requested timeframe directly from DB (pre-computed by build-mtf-bars.ts)
  const tf = timeframe || '1m';
  const skipContractInd = opts?.skipContractIndicators ?? false;
  const date = opts?.date;

  // ── Try binary cache first (avoids SQL entirely) ──
  if (date && hasCacheFile(date, tf, skipContractInd)) {
    const cached = readBarCacheFile(date, tf, skipContractInd);
    if (cached) return cached;
  }

  const spxRows = db.prepare(`
    SELECT ts, open, high, low, close, volume, ${INDICATOR_SELECT}
    FROM ${REPLAY_DATA_SOURCE} WHERE symbol='SPX' AND timeframe=?
    AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(tf, start, end) as any[];

  const spxBars = spxRows.map((r: any) => ({
    ts: r.ts, open: r.open, high: r.high, low: r.low,
    close: r.close, volume: r.volume,
    indicators: rowToIndicators(r),
  }));

  const timestamps = spxBars.map(b => b.ts);

  // Load contract bars using index-friendly range query (100x faster than LIKE)
  // In price-only mode, skip indicator columns entirely (deterministic replay only needs OHLCV)
  const contractSelect = skipContractInd
    ? 'symbol, ts, open, high, low, close, volume'
    : `symbol, ts, open, high, low, close, volume, ${INDICATOR_SELECT}`;

  const contractRows = db.prepare(`
    SELECT ${contractSelect},
           CAST(substr(symbol, -8) AS INTEGER) / 1000.0 as strike
    FROM ${REPLAY_DATA_SOURCE}
    WHERE symbol >= ? AND symbol < ? AND timeframe = ?
      AND ts >= ? AND ts <= ?
    ORDER BY symbol, ts
  `).all(symbolRange.lo, symbolRange.hi, tf, start, end) as any[];

  const contractBars = new Map<string, Bar[]>();
  const contractStrikes = new Map<string, number>();
  for (const r of contractRows) {
    if (!contractBars.has(r.symbol)) contractBars.set(r.symbol, []);
    contractBars.get(r.symbol)!.push({
      ts: r.ts, open: r.open, high: r.high, low: r.low,
      close: r.close, volume: r.volume,
      indicators: skipContractInd ? EMPTY_INDICATORS : rowToIndicators(r),
    });
    if (!contractStrikes.has(r.symbol)) contractStrikes.set(r.symbol, r.strike);
  }

  const cache: BarCache = { spxBars, contractBars, contractStrikes, timestamps };

  // ── Write binary cache for next run ──
  if (date) {
    try {
      writeBarCacheFile(cache, date, tf, skipContractInd);
    } catch {
      // Non-fatal — just skip caching
    }
  }

  return cache;
}


// ── On-the-fly HMA computation & DB caching ────────────────────────────────
// Checks if the required HMA periods exist in the loaded bars. If missing,
// computes them incrementally from close prices and writes back to the DB.
// Next load of the same date+tf will have them pre-cached.

/**
 * Ensure all required HMA periods exist in the bar cache's indicator fields.
 * If missing, computes them on-the-fly from close prices WITH cross-day warmup
 * (loads prior bars from DB to seed the HMA state), then caches back to DB.
 *
 * @param warmupBars - Number of prior bars to load for HMA warmup (3x period)
 */
function ensureHmaPeriods(cache: BarCache, periods: number[], tf: string, verbose: boolean): void {
  if (periods.length === 0) return;

  // Check which periods are missing from SPX bars (spot-check a bar with indicators)
  const sampleBar = cache.spxBars.find(b => Object.keys(b.indicators).length > 0);

  // Check multiple bars — a period may be "present" as null in early bars (warmup)
  // but should have real values in later bars. If ALL bars are null/undefined, it's missing.
  const lateBars = cache.spxBars.slice(-Math.min(10, cache.spxBars.length));
  const missing = periods.filter(p => {
    const key = `hma${p}`;
    // If no bar has any indicators at all (e.g. Polygon-sourced data), all periods are missing
    if (!sampleBar) return true;
    // If the key doesn't exist at all, definitely missing
    if (!(key in sampleBar.indicators)) return true;
    // If all late-session bars have null, the warmup wasn't sufficient — recompute with prior data
    return lateBars.every(b => b.indicators[key] == null);
  });
  if (missing.length === 0) return;

  if (verbose) {
    console.log(`  Computing HMA periods [${missing.join(', ')}] on-the-fly for ${tf}...`);
  }

  // Load prior bars from DB for warmup (need ~3x the max period for a stable HMA)
  const maxPeriod = Math.max(...missing);
  const warmupCount = maxPeriod * 3;
  const earliestTs = cache.spxBars.length > 0 ? cache.spxBars[0].ts : 0;

  let priorCloses = new Map<string, number[]>(); // symbol → prior close prices
  try {
    const warmupDb = new Database(DATA_DB_PATH, { readonly: true });
    // SPX warmup
    const spxWarmup = warmupDb.prepare(`
      SELECT close FROM ${REPLAY_DATA_SOURCE}
      WHERE symbol='SPX' AND timeframe=? AND ts < ?
      ORDER BY ts DESC LIMIT ?
    `).all(tf, earliestTs, warmupCount) as { close: number }[];
    priorCloses.set('SPX', spxWarmup.reverse().map(r => r.close));

    // Contract warmup — batch query for all symbols
    for (const [symbol] of cache.contractBars) {
      const rows = warmupDb.prepare(`
        SELECT close FROM ${REPLAY_DATA_SOURCE}
        WHERE symbol=? AND timeframe=? AND ts < ?
        ORDER BY ts DESC LIMIT ?
      `).all(symbol, tf, earliestTs, warmupCount) as { close: number }[];
      if (rows.length > 0) {
        priorCloses.set(symbol, rows.reverse().map(r => r.close));
      }
    }
    warmupDb.close();
  } catch {
    // If warmup load fails, compute without it (first bars will be null)
  }

  // Compute missing HMAs for SPX bars (with warmup seeding)
  for (const period of missing) {
    const key = `hma${period}`;
    const state = makeHMAState(period);
    // Seed with prior closes
    const prior = priorCloses.get('SPX') || [];
    for (const c of prior) hmaStep(state, c);
    // Now compute on session bars
    for (const bar of cache.spxBars) {
      bar.indicators[key] = hmaStep(state, bar.close);
    }
  }

  // Compute missing HMAs for all contract bars (with warmup seeding)
  // First, unfreeze any frozen EMPTY_INDICATORS objects (used in skipContractIndicators mode)
  for (const [, bars] of cache.contractBars) {
    for (let i = 0; i < bars.length; i++) {
      if (Object.isFrozen(bars[i].indicators)) {
        bars[i].indicators = { ...bars[i].indicators };
      }
    }
  }
  for (const period of missing) {
    const key = `hma${period}`;
    for (const [symbol, bars] of cache.contractBars) {
      const state = makeHMAState(period);
      const prior = priorCloses.get(symbol) || [];
      for (const c of prior) hmaStep(state, c);
      for (const bar of bars) {
        bar.indicators[key] = hmaStep(state, bar.close);
      }
    }
  }

  // Write back to DB so next run loads them instantly
  try {
    const writeDb = new Database(DATA_DB_PATH);
    writeDb.pragma('journal_mode = WAL');
    writeDb.pragma('busy_timeout = 5000');

    // Build dynamic UPDATE for both JSON indicators column and denormalized HMA columns
    const hmaCols = missing.filter(p => INDICATOR_COLUMNS.includes(`hma${p}` as any));
    const colSetClauses = hmaCols.map(p => `hma${p} = json_extract(?, '$.hma${p}')`);
    const setClauses = ['indicators = ?', ...colSetClauses.map(c => c.replace("json_extract(?, ", "").replace(")", ""))];

    // Simpler: update both indicators JSON and individual hma columns
    const hmaColNames = missing.map(p => `hma${p}`);
    const hmaColSets = hmaColNames.map(col => `${col} = ?`).join(', ');
    const updateStmt = writeDb.prepare(`
      UPDATE ${REPLAY_DATA_SOURCE} SET indicators = ?${hmaColSets ? ', ' + hmaColSets : ''}
      WHERE symbol = ? AND timeframe = ? AND ts = ?
    `);

    const writeTxn = writeDb.transaction((allBars: { symbol: string; bars: Bar[] }[]) => {
      for (const { symbol, bars } of allBars) {
        for (const bar of bars) {
          const hmaVals = missing.map(p => bar.indicators[`hma${p}`] ?? null);
          updateStmt.run(JSON.stringify(bar.indicators), ...hmaVals, symbol, tf, bar.ts);
        }
      }
    });

    const allBars: { symbol: string; bars: Bar[] }[] = [
      { symbol: 'SPX', bars: cache.spxBars },
    ];
    for (const [symbol, bars] of cache.contractBars) {
      allBars.push({ symbol, bars });
    }
    writeTxn(allBars);
    writeDb.close();

    if (verbose) {
      const totalBars = allBars.reduce((s, b) => s + b.bars.length, 0);
      console.log(`  Cached HMA [${missing.join(', ')}] → ${totalBars} bars saved to DB`);
    }
  } catch (err: any) {
    if (verbose) console.log(`  Warning: failed to cache HMA to DB: ${err.message}`);
  }
}


// ── On-the-fly KC computation ──────────────────────────────────────────────
// Computes Keltner Channel indicators if missing from bars.

function ensureKcFields(cache: BarCache, tf: string, config: ReplayConfig, verbose: boolean): void {
  if (!config.signals.enableKeltnerGate) {
    if (verbose) console.log(`  KC gate disabled, skipping KC computation`);
    return;
  }

  // Check if KC slope already exists
  const sampleBar = cache.spxBars.find(b => Object.keys(b.indicators).length > 0);
  if (sampleBar && sampleBar.indicators.kcSlope != null) {
    if (verbose) console.log(`  KC slope already computed, skipping`);
    return;
  }

  if (verbose) {
    console.log(`  Computing KC indicators on-the-fly for ${tf}... (enableKeltnerGate=${config.signals.enableKeltnerGate})`);
  }

  const { kcEmaPeriod = 20, kcAtrPeriod = 14, kcMultiplier = 2.5, kcSlopeLookback = 5 } = config.signals;

  // Load prior bars for warmup
  const warmupCount = Math.max(kcEmaPeriod, kcAtrPeriod, kcSlopeLookback + 1) * 2;
  const earliestTs = cache.spxBars.length > 0 ? cache.spxBars[0].ts : 0;

  let priorCloses: number[] = [];
  let priorHighs: number[] = [];
  let priorLows: number[] = [];

  try {
    const warmupDb = new Database(DATA_DB_PATH, { readonly: true });
    const rows = warmupDb.prepare(`
      SELECT close, high, low FROM ${REPLAY_DATA_SOURCE}
      WHERE symbol='SPX' AND timeframe=? AND ts < ?
      ORDER BY ts DESC LIMIT ?
    `).all(tf, earliestTs, warmupCount) as { close: number; high: number; low: number }[];
    priorCloses = rows.reverse().map(r => r.close);
    priorHighs = rows.map(r => r.high);
    priorLows = rows.map(r => r.low);
    warmupDb.close();
  } catch {
    // Warmup failed, proceed without it
  }

  // Compute KC for SPX bars
  const kcState = makeKCState(kcEmaPeriod, kcAtrPeriod, kcMultiplier, kcSlopeLookback);

  // Seed with prior data
  for (let i = 0; i < priorCloses.length; i++) {
    const prevClose = i > 0 ? priorCloses[i - 1] : null;
    kcStep(kcState, priorCloses[i], priorHighs[i], priorLows[i], prevClose);
  }

  // Compute on session bars
  let prevClose = priorCloses.length > 0 ? priorCloses[priorCloses.length - 1] : null;
  for (const bar of cache.spxBars) {
    const kc = kcStep(kcState, bar.close, bar.high, bar.low, prevClose);
    if (kc) {
      bar.indicators.kcUpper = kc.upper;
      bar.indicators.kcMiddle = kc.middle;
      bar.indicators.kcLower = kc.lower;
      bar.indicators.kcWidth = kc.width;
      bar.indicators.kcSlope = kc.slope;
    }
    prevClose = bar.close;
  }

  // Cache to DB (update both JSON and denormalized KC columns)
  try {
    const writeDb = new Database(DATA_DB_PATH);
    writeDb.pragma('journal_mode = WAL');
    writeDb.pragma('busy_timeout = 5000');
    const updateStmt = writeDb.prepare(`
      UPDATE ${REPLAY_DATA_SOURCE}
      SET indicators = ?, kcUpper = ?, kcMiddle = ?, kcLower = ?, kcWidth = ?, kcSlope = ?
      WHERE symbol = ? AND timeframe = ? AND ts = ?
    `);

    const writeTxn = writeDb.transaction((bars: Bar[]) => {
      for (const bar of bars) {
        updateStmt.run(
          JSON.stringify(bar.indicators),
          bar.indicators.kcUpper ?? null,
          bar.indicators.kcMiddle ?? null,
          bar.indicators.kcLower ?? null,
          bar.indicators.kcWidth ?? null,
          bar.indicators.kcSlope ?? null,
          'SPX', tf, bar.ts,
        );
      }
    });

    writeTxn(cache.spxBars);
    writeDb.close();

    if (verbose) {
      console.log(`  Cached KC indicators → ${cache.spxBars.length} SPX bars saved to DB`);
    }
  } catch (err: any) {
    if (verbose) console.log(`  Warning: failed to cache KC to DB: ${err.message}`);
  }
}


// ── In-memory lookups (no SQL per tick) ────────────────────────────────────

function getSpxBarsAt(cache: BarCache, atTs: number, n = 25): Bar[] {
  // Binary search for the position
  let hi = cache.spxBars.length - 1;
  let lo = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (cache.spxBars[mid].ts <= atTs) lo = mid + 1;
    else hi = mid - 1;
  }
  // hi is the last bar with ts <= atTs
  const end = hi + 1;
  const start = Math.max(0, end - n);
  return cache.spxBars.slice(start, end);
}

function getContractBarsAt(
  cache: BarCache, spxPrice: number, strikeRange: number, atTs: number, n = 3,
): Map<string, Bar[]> {
  const result = new Map<string, Bar[]>();
  const lo = spxPrice - strikeRange;
  const hi = spxPrice + strikeRange;

  for (const [symbol, bars] of cache.contractBars) {
    const strike = cache.contractStrikes.get(symbol)!;
    if (strike < lo || strike > hi) continue;

    // Find bars up to atTs using binary search
    let right = bars.length - 1;
    let left = 0;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (bars[mid].ts <= atTs) left = mid + 1;
      else right = mid - 1;
    }
    // right is the last bar with ts <= atTs
    if (right < 0) continue;
    const end = right + 1;
    const start = Math.max(0, end - n);
    result.set(symbol, bars.slice(start, end));
  }
  return result;
}

function getPosPriceAt(
  cache: BarCache, side: string, strike: number, symbolFilter: string, atTs: number,
): number | null {
  const cpPattern = side === 'call' ? /C\d/ : /P\d/;
  for (const [symbol, bars] of cache.contractBars) {
    const s = cache.contractStrikes.get(symbol)!;
    if (s !== strike) continue;
    if (!cpPattern.test(symbol)) continue;

    // Binary search for bar at atTs
    let right = bars.length - 1;
    let left = 0;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (bars[mid].ts <= atTs) left = mid + 1;
      else right = mid - 1;
    }
    if (right >= 0) return bars[right].close;
  }
  return null;
}

/** Get full bar (OHLC) for a position's contract at a given timestamp. */
function getPosBarAt(
  cache: BarCache, side: string, strike: number, symbolFilter: string, atTs: number,
): { close: number; high: number; low: number } | null {
  const cpPattern = side === 'call' ? /C\d/ : /P\d/;
  for (const [symbol, bars] of cache.contractBars) {
    const s = cache.contractStrikes.get(symbol)!;
    if (s !== strike) continue;
    if (!cpPattern.test(symbol)) continue;

    let right = bars.length - 1;
    let left = 0;
    while (left <= right) {
      const mid = (left + right) >>> 1;
      if (bars[mid].ts <= atTs) left = mid + 1;
      else right = mid - 1;
    }
    if (right >= 0) {
      const b = bars[right];
      return { close: b.close, high: b.high, low: b.low };
    }
  }
  return null;
}

// Legacy DB function kept for position price fallback
function getPosPrice(
  db: Database.Database, side: string, strike: number, symbolFilter: string, atTs: number,
): number | null {
  // Use replay_bars for sanitized data
  const rows = db.prepare(`
    SELECT close FROM replay_bars
    WHERE symbol LIKE ? AND timeframe = '1m' AND ts <= ?
    ORDER BY ts DESC LIMIT 1
  `).all(symbolFilter.replace('%', side === 'call' ? '%C' : '%P') + String(strike).padStart(8, '0'), atTs) as any[];
  return rows.length ? rows[0].close : null;
}

function parseOptionSymbol(sym: string): { isCall: boolean; strike: number } | null {
  const m = sym.replace(/\s+/g, '').match(/([CP])(\d{4,5})(?:000)?$/i);
  if (!m) return null;
  return { isCall: m[1].toUpperCase() === 'C', strike: parseInt(m[2]) };
}

function extractJSON(text: string): string {
  return text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
}

// ── Scanner integration ───────────────────────────────────────────────────

const DEFAULT_SCANNER_SYSTEM = `You are an expert 0DTE SPX options day-trader scanning for setups.

You are reviewing historical replay data for a specific bar timestamp.
Your job: assess whether ANY setup is present at this moment. A senior trader reviews your flags.

Different days call for different signals. Adapt to current conditions:
- Trend days: momentum entries (RSI break of 40-50, EMA crossovers)
- Range days: mean-reversion at extremes (RSI <25 or >75, Bollinger touches)
- Time matters: 9:30-10:30 chaotic, 11-1 PM cleanest, after 3 PM fast but risky
- RSI EXTREMES are special: RSI <20 = extreme oversold (high-probability call entry),
  RSI >80 = extreme overbought (high-probability put entry). RSI <15 is an emergency.

Respond ONLY with valid JSON — no markdown, no text outside the JSON.
{
  "market_read": "<1-2 sentences on current conditions>",
  "setups": [
    {
      "symbol": "<option symbol>",
      "setup_type": "<what you see forming>",
      "confidence": <0.0-1.0>,
      "urgency": "now" | "building" | "watch",
      "notes": "<what to watch for confirmation>"
    }
  ]
}

If nothing is happening, return empty setups array.`;

interface ScannerSetup {
  symbol: string;
  setupType: string;
  confidence: number;
  urgency: 'now' | 'building' | 'watch';
  notes: string;
}

interface ReplayScannerResult {
  scannerId: string;
  marketRead: string;
  setups: ScannerSetup[];
  error?: string;
}

function buildReplayScannerPrompt(
  ts: number, sessionEnd: number, spxBars: Bar[],
  contractBars: Map<string, Bar[]>, regimeContext: string,
): string {
  const spx = spxBars[spxBars.length - 1];
  const minutesToClose = Math.max(0, Math.floor((sessionEnd - ts) / 60));

  // Format top contracts by RSI (most interesting first)
  const contractLines: string[] = [];
  for (const [symbol, bars] of contractBars) {
    if (bars.length === 0) continue;
    const curr = bars[bars.length - 1];
    const ind = curr.indicators;
    contractLines.push(
      `  ${symbol}: close=$${curr.close.toFixed(2)} rsi=${ind.rsi14?.toFixed(1) ?? '-'} ema9=${ind.ema9?.toFixed(2) ?? '-'} hma5=${ind.hma5?.toFixed(2) ?? '-'}`
    );
  }
  // Limit to top 20 contracts to keep prompt reasonable
  const contractBlock = contractLines.slice(0, 20).join('\n') || '  No contracts tracked';

  return `TIME: ${etLabel(ts)} ET | ${minutesToClose}m to close
${regimeContext}

SPX UNDERLYING:
  Price: ${spx.close.toFixed(2)} | RSI=${spx.indicators.rsi14?.toFixed(1) ?? '?'} | EMA9=${spx.indicators.ema9?.toFixed(2) ?? '-'} EMA21=${spx.indicators.ema21?.toFixed(2) ?? '-'}

TRACKED CONTRACTS (${contractBars.size}):
${contractBlock}`;
}

async function runReplayScanners(
  config: ReplayConfig,
  scannerPrompt: string,
  verbose: boolean,
): Promise<ReplayScannerResult[]> {
  const allConfigs = getScannerConfigs();
  // Filter by config flags
  const enabledSet = new Set(config.scanners.models);
  const enabled = allConfigs.filter(c => enabledSet.has(c.id));

  if (enabled.length === 0) return [];

  // Get the scanner prompt from library (use config.scanners.promptId)
  let libraryPrompt = DEFAULT_SCANNER_SYSTEM;
  try {
    const promptLibEntry = getPromptFromLibrary(config.scanners.defaultPromptId);
    libraryPrompt = promptLibEntry.basePrompt;
  } catch {
    // Fall back to default if prompt not found
    if (verbose) console.log(`  Warning: Scanner prompt not found (${config.scanners.defaultPromptId}), using default`);
  }

  // Run all scanners in PARALLEL with separate Agent SDK instances
  const results = await Promise.allSettled(
    enabled.map(async (scannerCfg: ModelConfig) => {
      const systemPrompt = getScannerPrompt(config, scannerCfg.id) || libraryPrompt;
      const text = await askModel(scannerCfg, systemPrompt, scannerPrompt, 60000);
      const clean = extractJSON(text);
      const parsed = JSON.parse(clean);

      return {
        scannerId: scannerCfg.id,
        marketRead: String(parsed.market_read || ''),
        setups: (Array.isArray(parsed.setups) ? parsed.setups : []).map((s: any) => ({
          symbol: String(s.symbol || ''),
          setupType: String(s.setup_type || ''),
          confidence: Math.max(0, Math.min(1, parseFloat(s.confidence) || 0)),
          urgency: ['now', 'building', 'watch'].includes(s.urgency) ? s.urgency : 'watch',
          notes: String(s.notes || ''),
        })) as ScannerSetup[],
      };
    })
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') {
      if (verbose && r.value.setups.length > 0) {
        console.log(`  [${r.value.scannerId}] ${r.value.marketRead.slice(0, 80)}`);
        for (const s of r.value.setups) {
          console.log(`    ${s.symbol}: ${s.setupType} conf=${s.confidence.toFixed(2)} urgency=${s.urgency}`);
        }
      }
      return r.value;
    }
    const id = enabled[i].id;
    if (verbose) console.log(`  [${id}] SCANNER ERROR: ${r.reason}`);
    return { scannerId: id, marketRead: '', setups: [], error: String(r.reason) };
  });
}

// ── Judge prompt builder ───────────────────────────────────────────────────

const DEFAULT_JUDGE_SYSTEM = `You are a senior 0DTE SPX trader. Option contract signals (HMA/EMA crosses on P6525, C6500, etc.) are PRIMARY.
Judge whether to enter based on:
- Option contract momentum (which direction is the option itself trending?)
- SPX regime (does it support that direction?)
- Time to expiry + leverage potential

Be AGGRESSIVE on option momentum signals — they fire infrequently and are high-probability.
Respond ONLY with JSON: {"action": "buy"|"wait", "target_symbol": "...", "confidence": 0-1, "stop_loss": null|price, "take_profit": null|price, "reasoning": "..."}`;

function buildJudgeSystem(config: ReplayConfig): string {
  // Judge prompt is now referenced by ID; for replay we use the default inline prompt
  return DEFAULT_JUDGE_SYSTEM;
}

function getScannerPrompt(config: ReplayConfig, scannerId: string): string | null {
  const promptId = config.scanners.promptAssignments[scannerId];
  if (!promptId) return null;
  try {
    return getPromptFromLibrary(promptId).basePrompt;
  } catch {
    return null;
  }
}

function buildPrompt(
  config: ReplayConfig,
  ts: number, sessionEnd: number, spxBars: Bar[],
  optionSignals: Signal[], regime: string, regimeContext: string,
): string {
  const spx = spxBars[spxBars.length - 1];
  const signalDesc = optionSignals.map(s =>
    `${s.symbol}: ${s.signalType} ${s.direction.toUpperCase()} (RSI=${s.indicators.rsi14?.toFixed(1) ?? '?'})`
  ).join('\n  ');

  return `${regimeContext}

OPTION CONTRACT SIGNALS DETECTED:
${signalDesc || '  (none)'}

SPX: ${spx.close.toFixed(2)} RSI=${spx.indicators.rsi14?.toFixed(1) ?? '?'}

TIME: ${etLabel(ts)} ET | ${Math.max(0, Math.floor((sessionEnd - ts) / 60))}m to close

---
Option contract signals are primary escalation triggers.
Determine which signal to trade based on regime fit.
In ${regime}: calls ${getSignalGate(regime as any, null, config.regime).allowOversoldFade ? 'ALLOWED' : 'BLOCKED'}, puts ${getSignalGate(regime as any, null, config.regime).allowOverboughtFade ? 'ALLOWED' : 'BLOCKED'}.`;
}

// ── Select judges from config ──────────────────────────────────────────────

function selectJudges(config: ReplayConfig) {
  const all = getJudgeConfigs();
  const enabledModels = new Set(config.judges.models);
  return all.filter(j => enabledModels.has(j.id));
}

// ── Deterministic replay via detectSignal() + trade-manager ─────────────────

/**
 * Run a deterministic replay using signal detection + trade manager.
 *
 * Three clean layers:
 *   1. detectSignal() → HMA cross detection (pure signal)
 *   2. evaluateExit() → per-position exit decisions
 *   3. evaluateEntry() → entry decision from signal + exits
 *
 * Positions are tracked locally (simulated — no broker).
 */
function runDeterministicReplay(
  config: ReplayConfig,
  tfCacheMap: Map<string, BarCache>,
  cache1m: BarCache,
  timestamps: number[],
  closeCutoffTs: number,
  symbolFilter: string,
  verbose: boolean,
): { trades: Trade[] } {
  const trades: Trade[] = [];
  const signalState: SignalState = createInitialSignalState();
  const positions = new Map<string, CorePosition>();  // simulated position tracker
  let lastEntryTs = 0;
  let dailyPnl = 0;
  let tradesCompleted = 0;

  const strikeRange = config.strikeSelector.strikeSearchRange;

  // Resolve timeframes from config
  const dirTf = config.signals.directionTimeframe || '1m';
  const exitTf = config.signals.exitTimeframe || dirTf;

  const dirCache = tfCacheMap.get(dirTf) ?? cache1m;
  const exitCache = (exitTf === dirTf) ? dirCache : (tfCacheMap.get(exitTf) ?? cache1m);

  // MTF confirmation cache (if enabled, resolve the higher-TF cache)
  const mtfCfg = config.signals.mtfConfirmation;
  const mtfCache = mtfCfg?.enabled ? (tfCacheMap.get(mtfCfg.timeframe) ?? null) : null;

  for (const ts of timestamps) {
    // ── Resolve bars at each config timeframe ──
    const spxDirBars = getSpxBarsAt(dirCache, ts);
    if (spxDirBars.length < 5) continue;
    const spxExitBars = (exitTf === dirTf) ? spxDirBars : getSpxBarsAt(exitCache, ts);

    // ── Step 1: Detect signal (HMA crosses only) ──
    const signal = detectSignal(signalState, {
      spxDirectionBars: spxDirBars as CoreBar[],
      spxExitBars: spxExitBars as CoreBar[],
    }, config);

    // Update signal state
    signalState.directionCross = signal.directionState.cross;
    signalState.prevDirectionHmaFast = signal.directionState.prevFast;
    signalState.prevDirectionHmaSlow = signal.directionState.prevSlow;
    signalState.lastDirectionBarTs = signal.directionState.lastBarTs;
    signalState.exitCross = signal.exitState.cross;
    signalState.prevExitHmaFast = signal.exitState.prevFast;
    signalState.prevExitHmaSlow = signal.exitState.prevSlow;
    signalState.lastExitBarTs = signal.exitState.lastBarTs;

    // ── Step 2: Check exits for all open positions ──
    const exits: ExitDecision[] = [];
    for (const [, pos] of positions) {
      const bar = getPosBarAt(cache1m, pos.side, pos.strike, symbolFilter, ts);
      const currentPrice = bar?.close ?? null;
      const barHighLow = bar ? { high: bar.high, low: bar.low } : undefined;

      const exitDecision = evaluateExit(
        pos, currentPrice, signal.exitState.cross, signal.exitState.freshCross,
        config, ts, closeCutoffTs, barHighLow,
      );
      if (exitDecision) exits.push(exitDecision);
    }

    // Apply exits (instant fill at decision price)
    for (const exit of exits) {
      const pos = positions.get(exit.positionId);
      if (!pos) continue;

      trades.push({
        symbol: pos.symbol, side: pos.side, strike: pos.strike, qty: pos.qty,
        entryTs: pos.entryTs, entryET: etLabel(pos.entryTs), entryPrice: pos.entryPrice,
        exitTs: ts, exitET: etLabel(ts), exitPrice: exit.decisionPrice,
        reason: exit.reason, pnlPct: exit.pnl.pnlPct, pnl$: exit.pnl['pnl$'],
        signalType: '',
      });

      if (verbose) {
        const emoji = exit.pnl.pnlPct >= 0 ? '+' : '';
        console.log(`  CLOSE [${etLabel(ts)}] ${pos.symbol} ${exit.reason}: ${emoji}${exit.pnl.pnlPct.toFixed(0)}%`);
      }

      positions.delete(exit.positionId);
      dailyPnl += exit.pnl['pnl$'];
      tradesCompleted++;
    }

    // ── Step 3: Check entry ──
    // SPX price from 1m cache (finest granularity)
    const spx1m = getSpxBarsAt(cache1m, ts);
    const spxPrice = spx1m.length > 0 ? spx1m[spx1m.length - 1].close : spxDirBars[spxDirBars.length - 1].close;

    // Strike candidates from 1m cache
    const candidates: StrikeCandidate[] = [];
    const candidateContracts = getContractBarsAt(cache1m, spxPrice, strikeRange, ts);
    for (const [sym, bars] of candidateContracts) {
      if (bars.length === 0) continue;
      const strike = cache1m.contractStrikes.get(sym);
      if (strike == null) continue;
      const parsed = parseOptionSymbol(sym);
      if (!parsed) continue;
      candidates.push({
        symbol: sym,
        side: parsed.isCall ? 'call' : 'put',
        strike,
        price: bars[bars.length - 1].close,
        volume: bars[bars.length - 1].volume,
      });
    }

    // MTF confirmation: resolve higher-TF HMA direction if enabled
    let mtfDirection: 'bullish' | 'bearish' | null = null;
    if (mtfCache && mtfCfg?.enabled) {
      const mtfBars = getSpxBarsAt(mtfCache, ts);
      if (mtfBars.length >= 2) {
        const hmaFastKey = `hma${config.signals.hmaCrossFast ?? 5}`;
        const hmaSlowKey = `hma${config.signals.hmaCrossSlow ?? 19}`;
        const last = mtfBars[mtfBars.length - 1] as any;
        const fv = last[hmaFastKey] ?? last.indicators?.[hmaFastKey] ?? null;
        const sv = last[hmaSlowKey] ?? last.indicators?.[hmaSlowKey] ?? null;
        if (fv != null && sv != null) {
          mtfDirection = fv > sv ? 'bullish' : 'bearish';
        }
      }
    }

    const { entry } = evaluateEntry(signal, exits, positions.size + exits.length, config, {
      ts,
      spxPrice,
      candidates,
      dailyPnl,
      tradesCompleted,
      lastEntryTs,
      closeCutoffTs,
      mtfDirection,
    });

    if (entry) {
      const effEntry = frictionEntry(entry.price);
      const corePos: CorePosition = {
        id: entry.symbol,
        symbol: entry.symbol,
        side: entry.side,
        strike: entry.strike,
        qty: entry.qty,
        entryPrice: entry.price,
        stopLoss: entry.stopLoss,
        takeProfit: entry.takeProfit,
        entryTs: ts,
        highWaterPrice: entry.price,
      };
      positions.set(corePos.id, corePos);
      lastEntryTs = ts;

      if (verbose) {
        console.log(`  ENTER ${entry.symbol} x${entry.qty} @ $${entry.price.toFixed(2)} (eff $${effEntry.toFixed(2)}) | stop=$${entry.stopLoss.toFixed(2)} tp=$${entry.takeProfit.toFixed(2)} | ${entry.reason}`);
      }
    }
  }

  // ── EOD: force-close any remaining positions ──
  const finalTs = timestamps[timestamps.length - 1];
  for (const [, pos] of positions) {
    const curPrice = getPosPriceAt(cache1m, pos.side, pos.strike, symbolFilter, finalTs) ?? pos.entryPrice;
    const { pnlPct, 'pnl$': pnl$ } = computeRealisticPnl(pos.entryPrice, curPrice, pos.qty);
    trades.push({
      symbol: pos.symbol, side: pos.side, strike: pos.strike, qty: pos.qty,
      entryTs: pos.entryTs, entryET: etLabel(pos.entryTs), entryPrice: pos.entryPrice,
      exitTs: finalTs, exitET: etLabel(finalTs), exitPrice: curPrice,
      reason: 'time_exit', pnlPct, pnl$, signalType: '',
    });
    if (verbose) console.log(`  EOD CLOSE ${pos.symbol} @ $${curPrice.toFixed(2)} -> ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`);
  }

  return { trades };
}

// ── Main engine ────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Path to data DB (defaults to data/spxer.db) */
  dataDbPath?: string;
  /** Path to replay store DB (defaults to data/spxer.db) */
  storeDbPath?: string;
  /** Verbose console output */
  verbose?: boolean;
  /** Skip judge API calls (deterministic signals only) */
  noJudge?: boolean;
  /** Prior day close for regime init (auto-detected if omitted) */
  priorClose?: number;
}

export async function runReplay(
  config: ReplayConfig,
  targetDate: string,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const verbose = opts.verbose ?? true;
  const dataDb = new Database(opts.dataDbPath || DATA_DB_PATH, { readonly: true });
  const store = new ReplayStore(opts.storeDbPath);
  const runId = store.createRun(config.id, targetDate);

  try {
    const { start: SESSION_START, end: SESSION_END, closeCutoff: CLOSE_CUTOFF } = buildSessionTimestamps(targetDate);
    const SYMBOL_RANGE = buildSymbolRange(targetDate);
    // Legacy LIKE filter still needed for getPosPrice fallback
    const SYMBOL_FILTER = buildSymbolFilter(targetDate);

    // Determine mode early so we can optimize loading
    const judges = opts.noJudge ? [] : selectJudges(config);
    const isDeterministic = !config.scanners.enabled && judges.length === 0;

    // Pre-load bars into memory — multiple timeframes from DB
    // In deterministic mode, skip contract indicator columns (only need OHLCV for price lookups)
    const cacheOpts = isDeterministic
      ? { skipContractIndicators: true, date: targetDate }
      : { date: targetDate };
    const cache1m = loadBarCache(dataDb, SESSION_START, SESSION_END, SYMBOL_RANGE, '1m', cacheOpts);

    // ── MTF cache loader — deduplicates so each TF is loaded at most once ──
    const tfCacheMap = new Map<string, BarCache>();
    tfCacheMap.set('1m', cache1m);

    function getTfCache(tf: string): BarCache {
      if (!tf || tf === '1m') return cache1m;
      if (tfCacheMap.has(tf)) return tfCacheMap.get(tf)!;
      const c = loadBarCache(dataDb, SESSION_START, SESSION_END, SYMBOL_RANGE, tf, cacheOpts);
      tfCacheMap.set(tf, c);
      return c;
    }

    // Resolve all timeframes from config
    const signalTf = config.signals.signalTimeframe || '1m';
    const directionTf = config.signals.directionTimeframe || '1m';
    const exitTf = config.signals.exitTimeframe || directionTf;  // default: same as direction

    // Per-signal-type TF overrides (null = use signalTimeframe)
    const hmaCrossTf = config.signals.hmaCrossTimeframe || signalTf;
    const rsiCrossTf = config.signals.rsiCrossTimeframe || signalTf;
    const emaCrossTf = config.signals.emaCrossTimeframe || signalTf;
    const priceCrossHmaTf = config.signals.priceCrossHmaTimeframe || signalTf;

    // Collect all unique TFs we need and pre-load them
    const allTfs = new Set([signalTf, directionTf, exitTf, hmaCrossTf, rsiCrossTf, emaCrossTf, priceCrossHmaTf]);
    for (const tf of allTfs) getTfCache(tf);

    // Ensure all configured HMA periods exist in every loaded cache.
    // Pre-baked periods in DB: [5, 19, 25]. Anything else gets computed on-the-fly
    // from close prices and cached back to the DB for next run.
    const neededHmaPeriods = new Set<number>();
    neededHmaPeriods.add(config.signals.hmaCrossFast ?? 5);
    neededHmaPeriods.add(config.signals.hmaCrossSlow ?? 19);
    const hmaPeriods = [...neededHmaPeriods];
    for (const tf of allTfs) {
      ensureHmaPeriods(getTfCache(tf), hmaPeriods, tf, verbose);
    }
    // Also ensure 1m cache has them (used for price lookups / position management)
    ensureHmaPeriods(cache1m, hmaPeriods, '1m', verbose);

    const signalCache = getTfCache(signalTf);
    const directionCache = getTfCache(directionTf);
    const exitCache = getTfCache(exitTf);

    // Ensure KC indicators are computed for the direction timeframe (used by KC trend gate)
    ensureKcFields(directionCache, directionTf, config, verbose);

    // Per-signal-type caches for MTF signal detection
    const hmaCrossCache = getTfCache(hmaCrossTf);
    const rsiCrossCache = getTfCache(rsiCrossTf);
    const emaCrossCache = getTfCache(emaCrossTf);
    const priceCrossHmaCache = getTfCache(priceCrossHmaTf);

    // Primary iteration on 1m timestamps (finest granularity for price tracking)
    const cache = cache1m;
    const { timestamps } = cache;

    if (timestamps.length === 0) {
      throw new Error(`No SPX bars found for ${targetDate}`);
    }

    if (verbose) {
      console.log(`\n${'='.repeat(72)}`);
      console.log(`  Replay: ${config.name} | ${targetDate}`);
      console.log(`  Config: ${config.id} | Bars: ${timestamps.length} | Contracts: ${cache.contractBars.size}`);
      const tfParts = [`Signal: ${signalTf}`, `Direction: ${directionTf}`, `Exit: ${exitTf}`];
      if (hmaCrossTf !== signalTf) tfParts.push(`HMA: ${hmaCrossTf}`);
      if (rsiCrossTf !== signalTf) tfParts.push(`RSI: ${rsiCrossTf}`);
      if (emaCrossTf !== signalTf) tfParts.push(`EMA: ${emaCrossTf}`);
      if (priceCrossHmaTf !== signalTf) tfParts.push(`PxHMA: ${priceCrossHmaTf}`);
      console.log(`  TF: ${tfParts.join(' | ')}`);
      console.log('='.repeat(72));
    }

    // Init regime with prior close (auto-detect from first bar if not provided)
    const firstBars = getSpxBarsAt(cache, timestamps[0], 2);
    const priorClose = opts.priorClose || firstBars[0]?.close || 6606.49;
    initRegimeSession(priorClose);

    if (verbose) {
      if (judges.length > 0) console.log(`  Judges: ${judges.map(j => j.label).join(', ')}`);
      if (config.scanners.enabled) {
        const scannerNames = config.scanners.models.join(', ');
        console.log(`  Scanners: ${scannerNames} (cycle=${config.scanners.cycleIntervalSec}s, threshold=${config.scanners.minConfidenceToEscalate})`);
      }
      console.log('');
    }

    // ── Branch point: deterministic configs use tick()-based loop ──────
    if (isDeterministic) {
      if (verbose) console.log(`  [deterministic mode] Using tick() strategy engine\n`);
      const { trades: deterministicTrades } = runDeterministicReplay(
        config, tfCacheMap, cache1m, timestamps, CLOSE_CUTOFF, SYMBOL_FILTER, verbose,
      );

      // ── Compute and store results ──────────────────────────────────
      const metrics = computeMetrics(deterministicTrades);
      const result: ReplayResult = {
        runId,
        configId: config.id,
        date: targetDate,
        ...metrics,
        trades_json: JSON.stringify(deterministicTrades),
      };

      store.saveResult(result);
      store.completeRun(runId);

      if (verbose) {
        console.log(`\n${'='.repeat(72)}`);
        console.log(`  RESULTS: ${targetDate} | ${config.id}`);
        console.log('='.repeat(72));
        for (const t of deterministicTrades) {
          const emoji = t.pnlPct >= 0 ? '+' : '';
          console.log(`  ${t.side.toUpperCase()} ${t.strike} | ${t.entryET}@$${t.entryPrice.toFixed(2)} -> ${t.exitET}@$${t.exitPrice.toFixed(2)} | ${emoji}${t.pnlPct.toFixed(0)}% ($${t.pnl$.toFixed(0)})`);
        }
        console.log(`\n  Trades: ${metrics.trades} | Win rate: ${(metrics.winRate * 100).toFixed(0)}% | P&L: $${metrics.totalPnl.toFixed(0)}`);
      }

      dataDb.close();
      store.close();
      return result;
    }

    // ── Legacy pipeline (non-deterministic: scanners/judges enabled) ──
    const trades: Trade[] = [];
    const openPositions = new Map<string, SimPosition>();
    let lastEscalationTs = 0;
    let lastScannerTs = 0;
    const strikeRange = config.strikeSelector.strikeSearchRange;
    let prevSpxHmaFast: number | null = null;
    let prevSpxHmaSlow: number | null = null;
    let spxDirectionCross: 'bullish' | 'bearish' | null = null;  // entry gating (directionTf)
    let spxExitCross: 'bullish' | 'bearish' | null = null;       // exit reversal (exitTf)
    const spxHmaFastKey = `hma${config.signals.hmaCrossFast ?? 5}`;
    const spxHmaSlowKey = `hma${config.signals.hmaCrossSlow ?? 19}`;

    for (const ts of timestamps) {
      const spxBars = getSpxBarsAt(cache, ts);
      if (spxBars.length < 5) continue;
      const spx = spxBars[spxBars.length - 1];

      // ── Helper: detect HMA cross on a given TF cache ──
      function detectHmaCross(tfCache: BarCache): 'bullish' | 'bearish' | null {
        const bars = getSpxBarsAt(tfCache, ts);
        if (bars.length < 2) return null;
        const curr = bars[bars.length - 1];
        const prev = bars[bars.length - 2];
        const cF = curr.indicators[spxHmaFastKey] ?? null;
        const cS = curr.indicators[spxHmaSlowKey] ?? null;
        const pF = prev.indicators[spxHmaFastKey] ?? null;
        const pS = prev.indicators[spxHmaSlowKey] ?? null;
        if (pF == null || pS == null || cF == null || cS == null) return null;
        if (pF < pS && cF >= cS) return 'bullish';
        if (pF >= pS && cF < cS) return 'bearish';
        return null;
      }

      // ── Direction cross (for entry gating) — uses directionTimeframe ──
      // Update only when a NEW cross fires — persist last known direction otherwise
      // (matches live agent behavior where getHmaCrossDirection() holds last direction)
      const newDirectionCross = detectHmaCross(directionCache);
      if (newDirectionCross !== null) spxDirectionCross = newDirectionCross;
      // Track current direction values for logging/filtering
      const dirSpxBars = getSpxBarsAt(directionCache, ts);
      if (dirSpxBars.length >= 1) {
        const dirSpx = dirSpxBars[dirSpxBars.length - 1];
        const f = dirSpx.indicators[spxHmaFastKey] ?? null;
        const s = dirSpx.indicators[spxHmaSlowKey] ?? null;
        if (f != null && s != null) { prevSpxHmaFast = f; prevSpxHmaSlow = s; }
      }

      // ── Exit cross (for position reversal exit) — uses exitTimeframe ──
      // If exitTf === directionTf, reuse the same result to avoid double-computing
      spxExitCross = (exitTf === directionTf) ? spxDirectionCross : detectHmaCross(exitCache);

      // ── Position monitoring ────────────────────────────────────────────
      const reversalFlips: { side: 'call' | 'put'; ts: number }[] = [];
      for (const [posId, openPos] of openPositions.entries()) {
        const curPrice = getPosPriceAt(cache, openPos.side, openPos.strike, SYMBOL_FILTER, ts);
        if (curPrice === null) continue;

        // Track high-water mark for trailing stop
        if (curPrice > openPos.highWaterPrice) {
          openPos.highWaterPrice = curPrice;
        }

        const exitCtx: ExitContext = {
          ts, closeCutoffTs: CLOSE_CUTOFF, hmaCrossDirection: spxExitCross,
          highWaterPrice: openPos.highWaterPrice,
        };
        const exitResult = checkExit(openPos, curPrice, config, exitCtx);
        const closeReason = exitResult.reason;

        if (exitResult.shouldExit && closeReason) {
          const { pnlPct, 'pnl$': pnl$ } = computeRealisticPnl(openPos.entryPrice, curPrice, openPos.qty);
          trades.push({
            symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
            entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
            exitTs: ts, exitET: etLabel(ts), exitPrice: curPrice,
            reason: closeReason, pnlPct, pnl$, signalType: '',
          });
          if (verbose) {
            const emoji = pnlPct >= 0 ? '+' : '';
            console.log(`  CLOSE [${etLabel(ts)}] ${openPos.symbol} ${closeReason}: ${emoji}${pnlPct.toFixed(0)}%`);
          }

          // Track reversal exits for flip-to-opposite logic
          if (closeReason === 'signal_reversal') {
            const flipSide: 'call' | 'put' = openPos.side === 'call' ? 'put' : 'call';
            reversalFlips.push({ side: flipSide, ts });
          }

          openPositions.delete(posId);
        }
      }
      // ── Flip-on-reversal: when exit.strategy='scannerReverse', enter opposite side ──
      // Dedupe: only flip once per side per bar (multiple positions may reverse at same time)
      const uniqueFlips = new Map<string, { side: 'call' | 'put'; ts: number }>();
      for (const flip of reversalFlips) {
        uniqueFlips.set(flip.side, flip);
      }

      if (uniqueFlips.size > 0 && config.exit?.strategy === 'scannerReverse') {
        for (const [, flip] of uniqueFlips) {
          // Check risk limits before flipping (cooldown bypassed — flip is a new signal)
          const flipRiskState: RiskState = {
            openPositions: openPositions.size,
            tradesCompleted: trades.length,
            dailyPnl: trades.reduce((sum, t) => sum + t.pnl$, 0),
            currentTs: ts,
            closeCutoffTs: CLOSE_CUTOFF,
            lastEscalationTs,
          };
          if (isRiskBlocked(flipRiskState, config).blocked) continue;

          // Use selectStrike() for parity with live agent and runStrategy()
          const flipContracts = getContractBarsAt(cache1m, spx.close, strikeRange, ts);
          const flipDirection: Direction = flip.side === 'call' ? 'bullish' : 'bearish';
          const flipCandidates: StrikeCandidate[] = [];
          for (const [sym, bars] of flipContracts) {
            if (bars.length === 0) continue;
            const strike = cache.contractStrikes.get(sym) ?? cache1m.contractStrikes.get(sym);
            if (strike == null) continue;
            const parsed = parseOptionSymbol(sym);
            if (!parsed) continue;
            flipCandidates.push({
              symbol: sym,
              side: parsed.isCall ? 'call' : 'put',
              strike: parsed.strike,
              price: bars[bars.length - 1].close,
              volume: bars[bars.length - 1].volume,
            });
          }

          const flipStrike = selectStrike(flipCandidates, flipDirection, spx.close, config);
          if (flipStrike) {
            const bestPrice = flipStrike.candidate.price;
            const effEntry = frictionEntry(bestPrice);
            const stopLoss = config.position.stopLossPercent > 0
              ? effEntry * (1 - config.position.stopLossPercent / 100)
              : 0;
            const takeProfit = effEntry * config.position.takeProfitMultiplier;
            const qty = computeQty(effEntry, config);

            openPositions.set(`${flipStrike.candidate.symbol}_${ts}`, {
              id: `${flipStrike.candidate.symbol}_${ts}`,
              symbol: flipStrike.candidate.symbol,
              side: flip.side,
              strike: flipStrike.candidate.strike,
              qty, entryPrice: bestPrice, stopLoss, takeProfit,
              entryTs: ts, entryET: etLabel(ts),
              highWaterPrice: bestPrice,
            });
            lastEscalationTs = ts; // Update for cooldown tracking
            if (verbose) {
              console.log(`  FLIP → ${flip.side.toUpperCase()} ${flipStrike.candidate.symbol} x${qty} @ $${bestPrice.toFixed(2)} (eff $${effEntry.toFixed(2)}) | stop=$${stopLoss.toFixed(2)} tp=$${takeProfit.toFixed(2)} | ${flipStrike.reason}`);
            }
          }
        }
      }

      // ── Signal detection — MTF-aware ──────────────────────────────────
      // If all signal types use the same TF, one call suffices.
      // If per-signal TF overrides are set, run detectSignals per TF with only
      // the relevant signal types enabled, then merge results.
      const allSameTf = (hmaCrossTf === signalTf && rsiCrossTf === signalTf &&
                          emaCrossTf === signalTf && priceCrossHmaTf === signalTf);

      let optionSignals: Signal[];
      // contractBars from the default signal TF — also used for price filtering below
      const contractBars = getContractBarsAt(signalCache, spx.close, strikeRange, ts);

      if (allSameTf) {
        // Fast path: all signal types use the same timeframe
        optionSignals = detectSignals(contractBars as Map<string, CoreBar[]>, spx.close, config);
      } else {
        // MTF path: run each signal type against its own TF cache
        optionSignals = [];
        const signalTypes: { tf: string; cache: BarCache; overrides: Partial<typeof config.signals> }[] = [];

        // Group by TF to minimize detectSignals calls
        const tfGroups = new Map<string, { enableHma: boolean; enableRsi: boolean; enableEma: boolean; enablePxHma: boolean }>();
        function getGroup(tf: string) {
          if (!tfGroups.has(tf)) tfGroups.set(tf, { enableHma: false, enableRsi: false, enableEma: false, enablePxHma: false });
          return tfGroups.get(tf)!;
        }
        if (config.signals.enableHmaCrosses) getGroup(hmaCrossTf).enableHma = true;
        if (config.signals.enableRsiCrosses) getGroup(rsiCrossTf).enableRsi = true;
        if (config.signals.enableEmaCrosses) getGroup(emaCrossTf).enableEma = true;
        if (config.signals.enablePriceCrossHma) getGroup(priceCrossHmaTf).enablePxHma = true;

        for (const [tf, group] of tfGroups) {
          const tfBars = getContractBarsAt(getTfCache(tf), spx.close, strikeRange, ts);
          const subConfig = {
            ...config,
            signals: {
              ...config.signals,
              enableHmaCrosses: group.enableHma,
              enableRsiCrosses: group.enableRsi,
              enableEmaCrosses: group.enableEma,
              enablePriceCrossHma: group.enablePxHma,
            },
          };
          const sigs = detectSignals(tfBars as Map<string, CoreBar[]>, spx.close, subConfig);
          optionSignals.push(...sigs);
        }

        // Dedupe: same symbol + signal type from different TF groups shouldn't appear twice
        const seen = new Set<string>();
        optionSignals = optionSignals.filter(s => {
          const key = `${s.symbol}:${s.signalType}:${s.direction}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      // ── Target OTM distance filter ─────────────────────────────────────
      // When set, only keep signals on the strike closest to the target OTM distance
      if (config.signals.targetOtmDistance != null && optionSignals.length > 0) {
        const targetDist = config.signals.targetOtmDistance;
        const spxRounded = Math.round(spx.close / 5) * 5; // SPX rounds to $5 strikes
        const targetCallStrike = spxRounded + targetDist;
        const targetPutStrike = spxRounded - targetDist;

        optionSignals = optionSignals.filter(sig => {
          if (sig.side === 'call') return Math.abs(sig.strike - targetCallStrike) <= 5;
          if (sig.side === 'put') return Math.abs(sig.strike - targetPutStrike) <= 5;
          return false;
        });
      }

      // ── Target contract price filter ────────────────────────────────────
      // When set, among remaining signals keep only the one whose current price
      // is closest to the target. E.g. targetContractPrice=3.00 → prefer ~$3 contracts.
      if (config.signals.targetContractPrice != null && optionSignals.length > 1) {
        const targetPrice = config.signals.targetContractPrice;
        let bestSig = optionSignals[0];
        let bestDist = Infinity;
        for (const sig of optionSignals) {
          const bars = contractBars.get(sig.symbol);
          if (!bars || bars.length === 0) continue;
          const price = bars[bars.length - 1].close;
          const dist = Math.abs(price - targetPrice);
          if (dist < bestDist) { bestDist = dist; bestSig = sig; }
        }
        optionSignals = [bestSig];
      }

      // ── Underlying HMA cross requirement ───────────────────────────────
      // SPX direction determines call vs put:
      //   SPX bullish → buy calls (call prices rise)
      //   SPX bearish → buy puts (put prices rise when SPX drops)
      // Option signal direction should be bullish (contract price going up = buy opportunity)
      if (config.signals.requireUnderlyingHmaCross && optionSignals.length > 0) {
        if (spxDirectionCross == null) {
          optionSignals = [];
        } else {
          const wantSide = spxDirectionCross === 'bullish' ? 'call' : 'put';
          optionSignals = optionSignals.filter(sig =>
            sig.side === wantSide && sig.direction === 'bullish'
          );
        }
      }

      // ── Keltner Channel trend gate ───────────────────────────────────────
      // Macro trend filter using KC midline slope:
      //   kcSlope < -threshold → DOWNTREND → block calls, allow puts only
      //   kcSlope > +threshold → UPTREND   → block puts, allow calls only
      //   |kcSlope| < threshold → RANGE    → allow both (no filter)
      if (config.signals.enableKeltnerGate && optionSignals.length > 0) {
        // Read kcSlope from the direction timeframe (where KC was computed)
        const dirBars = getSpxBarsAt(directionCache, ts);
        const dirSpx = dirBars.length > 0 ? dirBars[dirBars.length - 1] : null;
        const kcSlope = dirSpx?.indicators?.kcSlope;
        if (kcSlope != null) {
          const threshold = config.signals.kcSlopeThreshold ?? 0.3;
          if (kcSlope < -threshold) {
            // DOWNTREND: block calls, keep puts only
            optionSignals = optionSignals.filter(s => s.side === 'put');
          } else if (kcSlope > threshold) {
            // UPTREND: block puts, keep calls only
            optionSignals = optionSignals.filter(s => s.side === 'call');
          }
          // RANGE: no filter
        }
      }

      // ── Regime classification ──────────────────────────────────────────
      const regimeState = classify({ close: spx.close, high: spx.high, low: spx.low, ts }, config.regime);
      const regimeContext = formatRegimeContext(regimeState, config.regime);

      // ── Risk guard (core module — max positions, trades, loss, cutoff, cooldown) ──
      const riskState: RiskState = {
        openPositions: openPositions.size,
        tradesCompleted: trades.length,
        dailyPnl: trades.reduce((sum, t) => sum + t.pnl$, 0),
        currentTs: ts,
        closeCutoffTs: CLOSE_CUTOFF,
        lastEscalationTs,
      };
      const riskCheck = isRiskBlocked(riskState, config);
      if (riskCheck.blocked) continue;

      // ── Time window gate ──────────────────────────────────────────────
      if (config.timeWindows?.activeStart || config.timeWindows?.activeEnd) {
        const etHHMM = etLabel(ts).slice(0, 5); // 'HH:MM'
        if (config.timeWindows.activeStart && etHHMM < config.timeWindows.activeStart) continue;
        if (config.timeWindows.activeEnd && etHHMM >= config.timeWindows.activeEnd) continue;
      }

      // ── SPX RSI gate — skip if RSI is in the neutral zone (skipped when regime disabled) ──
      if (config.regime.enabled) {
        const spxRsi = spx.indicators.rsi14;
        if (spxRsi != null) {
          const { rsiOversold, rsiOverbought } = config.signals;
          if (spxRsi > rsiOversold && spxRsi < rsiOverbought) continue;
        }
      }

      // Need either deterministic signals or scanners enabled to proceed
      if (optionSignals.length === 0 && !config.scanners.enabled) continue;

      if (verbose) {
        console.log(`\n  [${etLabel(ts)}] ${optionSignals.length} SIGNALS | regime=${regimeState.regime}`);
        for (const sig of optionSignals) {
          console.log(`   ${sig.symbol}: ${sig.signalType} ${sig.direction.toUpperCase()}`);
        }
      }

      // ── Scanner tier (optional, config-gated) ──────────────────────────
      let scannerResults: ReplayScannerResult[] = [];
      let scannerHotSetups: ScannerSetup[] = [];

      if (config.scanners.enabled && ts - lastScannerTs >= config.scanners.cycleIntervalSec) {
        const scannerPrompt = buildReplayScannerPrompt(ts, SESSION_END, spxBars, contractBars, regimeContext);
        scannerResults = await runReplayScanners(config, scannerPrompt, verbose);
        lastScannerTs = ts;

        // Collect setups above escalation threshold
        scannerHotSetups = scannerResults
          .flatMap(sr => sr.setups)
          .filter(s => s.confidence >= config.scanners.minConfidenceToEscalate);

        if (verbose && scannerHotSetups.length > 0) {
          console.log(`  SCANNERS: ${scannerHotSetups.length} hot setups above ${config.scanners.minConfidenceToEscalate} threshold`);
        }
      }

      // ── Judge escalation ───────────────────────────────────────────────
      // Determine whether to escalate based on config.escalation logic
      const hasSignals = optionSignals.length > 0;
      const hasScannerSetups = scannerHotSetups.length > 0;

      // Check escalation rules
      const signalCanEscalate = hasSignals && config.escalation.signalTriggersJudge;
      const scannerCanEscalate = hasScannerSetups && config.escalation.scannerTriggersJudge;

      // Apply agreement requirements if both exist
      let shouldEscalate = false;
      if (hasSignals && hasScannerSetups) {
        // Both signals and scanners flagged
        if (config.escalation.requireScannerAgreement && signalCanEscalate) {
          // Signal requires scanner agreement
          shouldEscalate = scannerCanEscalate;
        } else if (config.escalation.requireSignalAgreement && scannerCanEscalate) {
          // Scanner requires signal agreement
          shouldEscalate = signalCanEscalate;
        } else {
          // No agreement required, use either/or
          shouldEscalate = signalCanEscalate || scannerCanEscalate;
        }
      } else {
        // Only one type flagged
        shouldEscalate = signalCanEscalate || scannerCanEscalate;
      }

      if (!shouldEscalate) continue;

      let judgeAction: 'buy' | 'wait' = 'wait';
      let judgeConf = 0;
      let judgeTarget: string | null = null;
      let judgeStop: number | null = null;
      let judgeTp: number | null = null;

      if (judges.length === 0) {
        // No judge mode: auto-buy the strongest signal — but respect maxPositionsOpen
        if (openPositions.size >= (config.position.maxPositionsOpen ?? 100)) {
          // Already at max — skip entry
        } else {
          const best = optionSignals[0] ?? (scannerHotSetups.length > 0 ? { symbol: scannerHotSetups[0].symbol } : null);
          if (best) {
            judgeAction = 'buy';
            judgeConf = 0.6;
            judgeTarget = best.symbol;
          }
        }
      } else {
        const judgeSystem = buildJudgeSystem(config);
        let prompt = buildPrompt(config, ts, SESSION_END, spxBars, optionSignals, regimeState.regime, regimeContext);

        // Append scanner context to judge prompt if scanners ran
        if (scannerResults.length > 0) {
          const scannerBlock = scannerResults.map(sr => {
            const setupLines = sr.setups.length === 0
              ? '    No setups flagged'
              : sr.setups.map(s =>
                  `    - ${s.symbol}: ${s.setupType} (conf=${s.confidence.toFixed(2)}, urgency=${s.urgency}) — ${s.notes}`
                ).join('\n');
            return `  ${sr.scannerId.toUpperCase()} says: "${sr.marketRead}"\n${setupLines}`;
          }).join('\n\n');

          prompt += `\n\nSCANNER ASSESSMENTS:\n${scannerBlock}\n\n---\nReview the scanner flags alongside the deterministic signals. Make the call.`;
        }

        // Run all judges IN PARALLEL with separate Agent SDK instances
        const judgeResults = await Promise.allSettled(
          judges.map(cfg => askModel(cfg, judgeSystem, prompt, 90000))
        );

        judges.forEach((cfg, i) => {
          const result = judgeResults[i];
          if (result.status === 'fulfilled') {
            try {
              const parsed = JSON.parse(extractJSON(result.value));
              if (verbose) {
                console.log(`  [${cfg.id}] ${(parsed.action || 'wait').toUpperCase()} conf=${((parsed.confidence || 0) * 100).toFixed(0)}% ${parsed.target_symbol ?? ''}`);
              }
              if (parsed.action === 'buy' && (parsed.confidence || 0) > judgeConf && (parsed.confidence || 0) >= config.judges.confidenceThreshold) {
                judgeAction = 'buy';
                judgeConf = parseFloat(parsed.confidence) || 0;
                judgeTarget = parsed.target_symbol || null;
                judgeStop = parsed.stop_loss;
                judgeTp = parsed.take_profit;
              }
            } catch {
              if (verbose) console.log(`  [${cfg.id}] PARSE ERROR`);
            }
          } else {
            if (verbose) console.log(`  [${cfg.id}] ERROR: ${result.reason}`);
          }
        });
      }

      lastEscalationTs = ts;

      // ── Regime gate (core module — skipped when regime disabled) ──────
      if (judgeAction === 'buy' && judgeTarget) {
        const isCall = /C\d/.test(judgeTarget);
        const side: 'call' | 'put' = isCall ? 'call' : 'put';
        const direction = isCall ? 'bullish' as const : 'bearish' as const;
        const spxRsi = spx.indicators.rsi14 ?? null;

        if (isRegimeBlocked(regimeState.regime, direction, side, spxRsi, config)) {
          if (verbose) console.log(`  REGIME BLOCKED (${regimeState.regime})`);
          judgeAction = 'wait';
        }
      }

      // ── Open position ──────────────────────────────────────────────────
      // Use symbol as key (not symbol+ts) so we don't double-enter the same contract
      const posKey = judgeTarget ?? '';
      if (judgeAction === 'buy' && judgeTarget && !openPositions.has(posKey) && openPositions.size < (config.position.maxPositionsOpen ?? 100)) {
        const parsed = parseOptionSymbol(judgeTarget);
        if (parsed) {
          const bars = contractBars.get(judgeTarget);
          const entryPrice = bars?.[bars.length - 1]?.close ?? null;

          if (entryPrice && entryPrice > 0) {
            const effEntry = frictionEntry(entryPrice);
            const stopLoss = judgeStop && judgeStop > 0 && judgeStop < effEntry
              ? judgeStop
              : effEntry * (1 - config.position.stopLossPercent / 100);
            const takeProfit = judgeTp && judgeTp > effEntry
              ? judgeTp
              : effEntry * config.position.takeProfitMultiplier;
            const qty = computeQty(effEntry, config);

            openPositions.set(posKey, {
              id: posKey,
              symbol: judgeTarget,
              side: parsed.isCall ? 'call' : 'put',
              strike: parsed.strike,
              qty, entryPrice, stopLoss, takeProfit,
              entryTs: ts, entryET: etLabel(ts),
              highWaterPrice: entryPrice,
            });
            if (verbose) {
              console.log(`  ENTER ${judgeTarget} x${qty} @ $${entryPrice.toFixed(2)} (eff $${effEntry.toFixed(2)}) | stop=$${stopLoss.toFixed(2)} tp=$${takeProfit.toFixed(2)}`);
            }
          }
        }
      }
    }

    // ── EOD close remaining ──────────────────────────────────────────────
    const finalTs = timestamps[timestamps.length - 1];
    for (const [, openPos] of openPositions.entries()) {
      const curPrice = getPosPriceAt(cache, openPos.side, openPos.strike, SYMBOL_FILTER, finalTs) ?? openPos.entryPrice;
      const { pnlPct, 'pnl$': pnl$ } = computeRealisticPnl(openPos.entryPrice, curPrice, openPos.qty);
      trades.push({
        symbol: openPos.symbol, side: openPos.side, strike: openPos.strike, qty: openPos.qty,
        entryTs: openPos.entryTs, entryET: openPos.entryET, entryPrice: openPos.entryPrice,
        exitTs: finalTs, exitET: etLabel(finalTs), exitPrice: curPrice,
        reason: 'time_exit', pnlPct, pnl$, signalType: '',
      });
      if (verbose) console.log(`  EOD CLOSE ${openPos.symbol} @ $${curPrice.toFixed(2)} -> ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(0)}%`);
    }

    // ── Compute and store results ────────────────────────────────────────
    const metrics = computeMetrics(trades);
    const result: ReplayResult = {
      runId,
      configId: config.id,
      date: targetDate,
      promptId: config.scanners.enabled ? config.scanners.defaultPromptId : undefined,
      ...metrics,
      trades_json: JSON.stringify(trades),
    };

    store.saveResult(result);
    store.completeRun(runId);

    if (verbose) {
      console.log(`\n${'='.repeat(72)}`);
      console.log(`  RESULTS: ${targetDate} | ${config.id}`);
      console.log('='.repeat(72));
      for (const t of trades) {
        const emoji = t.pnlPct >= 0 ? '+' : '';
        console.log(`  ${t.side.toUpperCase()} ${t.strike} | ${t.entryET}@$${t.entryPrice.toFixed(2)} -> ${t.exitET}@$${t.exitPrice.toFixed(2)} | ${emoji}${t.pnlPct.toFixed(0)}% ($${t.pnl$.toFixed(0)})`);
      }
      console.log(`\n  Trades: ${metrics.trades} | Win rate: ${(metrics.winRate * 100).toFixed(0)}% | P&L: $${metrics.totalPnl.toFixed(0)}`);
    }

    dataDb.close();
    store.close();
    return result;

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    store.failRun(runId, msg);
    store.close();
    dataDb.close();
    throw error;
  }
}
