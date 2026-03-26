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
import { etLabel, buildSymbolFilter, buildSessionTimestamps, computeMetrics } from './metrics';

// ── Core modules (shared with live agent) ─────────────────────────────────
import { detectSignals } from '../core/signal-detector';
import { checkExit, type ExitContext } from '../core/position-manager';
import { computeQty } from '../core/position-sizer';
import { isRiskBlocked, type RiskState } from '../core/risk-guard';
import { isRegimeBlocked } from '../core/regime-gate';
import type { Signal, CoreBar } from '../core/types';

const DATA_DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

// Configurable data source: 'bars' (live) or 'replay_bars' (sanitized Polygon)
const REPLAY_DATA_SOURCE = process.env.REPLAY_DATA_SOURCE || 'replay_bars';

// Import indicator engine for recomputing indicators on aggregated bars
import { computeIndicators, seedState } from '../pipeline/indicator-engine';

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
}

// ── In-memory bar cache (loaded once per replay) ───────────────────────────

interface BarCache {
  spxBars: Bar[];                       // All SPX 1m bars, sorted by ts
  contractBars: Map<string, Bar[]>;     // symbol → bars, sorted by ts
  contractStrikes: Map<string, number>; // symbol → strike price
  timestamps: number[];                 // SPX timestamps for the session
}

function loadBarCache(
  db: Database.Database, start: number, end: number, symbolFilter: string, timeframe: string = '1m',
): BarCache {
  const tfMinutes = TF_MINUTES[timeframe] || 1;

  // Always load 1m bars from DB — aggregate to target timeframe if needed
  const spxRows = db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM ${REPLAY_DATA_SOURCE} WHERE symbol='SPX' AND timeframe='1m'
    AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(start, end) as any[];

  let spxBars = spxRows.map((r: any) => ({
    ts: r.ts, open: r.open, high: r.high, low: r.low,
    close: r.close, volume: r.volume,
    indicators: JSON.parse(r.indicators || '{}'),
  }));

  // Aggregate SPX bars if timeframe > 1m
  if (tfMinutes > 1) {
    spxBars = aggregateBars(spxBars, tfMinutes, 'SPX', timeframe);
  }

  const timestamps = spxBars.map(b => b.ts);

  // Load all contract 1m bars for the session
  const contractRows = db.prepare(`
    SELECT b.symbol, b.ts, b.open, b.high, b.low, b.close, b.volume, b.indicators,
           CAST(substr(b.symbol, -8) AS INTEGER) / 1000.0 as strike
    FROM ${REPLAY_DATA_SOURCE} b
    WHERE b.symbol LIKE ? AND b.timeframe = '1m'
      AND b.ts >= ? AND b.ts <= ?
    ORDER BY b.symbol, b.ts
  `).all(symbolFilter, start, end) as any[];

  // Group by symbol first, then aggregate each
  const rawContractBars = new Map<string, Bar[]>();
  const contractStrikes = new Map<string, number>();
  for (const r of contractRows) {
    if (!rawContractBars.has(r.symbol)) rawContractBars.set(r.symbol, []);
    rawContractBars.get(r.symbol)!.push({
      ts: r.ts, open: r.open, high: r.high, low: r.low,
      close: r.close, volume: r.volume,
      indicators: JSON.parse(r.indicators || '{}'),
    });
    if (!contractStrikes.has(r.symbol)) contractStrikes.set(r.symbol, r.strike);
  }

  // Aggregate contract bars if timeframe > 1m
  const contractBars = new Map<string, Bar[]>();
  for (const [symbol, bars] of rawContractBars) {
    contractBars.set(symbol, tfMinutes > 1 ? aggregateBars(bars, tfMinutes, symbol, timeframe) : bars);
  }

  return { spxBars, contractBars, contractStrikes, timestamps };
}

// ── Timeframe aggregation ─────────────────────────────────────────────────

const TF_MINUTES: Record<string, number> = {
  '1m': 1, '2m': 2, '3m': 3, '5m': 5, '10m': 10, '15m': 15, '30m': 30, '1h': 60,
};

function aggregateBars(bars1m: Bar[], tfMinutes: number, symbol: string, tf: string): Bar[] {
  if (tfMinutes <= 1 || bars1m.length === 0) return bars1m;

  const result: Bar[] = [];
  let bucket: Bar[] = [];
  let bucketStart = 0;

  for (const bar of bars1m) {
    // Bucket by rounding down to tfMinutes boundary
    const barMinute = Math.floor(bar.ts / (tfMinutes * 60)) * (tfMinutes * 60);
    if (bucket.length === 0) {
      bucketStart = barMinute;
    }
    if (barMinute !== bucketStart && bucket.length > 0) {
      // Flush the bucket
      result.push(mergeBucket(bucket, bucketStart));
      bucket = [];
      bucketStart = barMinute;
    }
    bucket.push(bar);
  }
  if (bucket.length > 0) {
    result.push(mergeBucket(bucket, bucketStart));
  }

  // Recompute indicators on the aggregated bars
  // Use seedState to init, then compute incrementally
  const fullBars = result.map(b => ({
    symbol, timeframe: tf, ts: b.ts,
    open: b.open, high: b.high, low: b.low, close: b.close,
    volume: b.volume, synthetic: false, gapType: null as any,
  }));

  // Seed with first few bars then compute
  if (fullBars.length > 0) {
    seedState(symbol, tf as any, []);
    for (const fb of fullBars) {
      const ind = computeIndicators(fb, symbol.startsWith('SPXW') ? 1 : 2);
      // Find the matching aggregated bar and set indicators
      const agg = result.find(r => r.ts === fb.ts);
      if (agg) agg.indicators = ind;
    }
  }

  return result;
}

function mergeBucket(bucket: Bar[], ts: number): Bar {
  return {
    ts,
    open: bucket[0].open,
    high: Math.max(...bucket.map(b => b.high)),
    low: Math.min(...bucket.map(b => b.low)),
    close: bucket[bucket.length - 1].close,
    volume: bucket.reduce((sum, b) => sum + b.volume, 0),
    indicators: {}, // will be recomputed
  };
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
      const text = await askModel(scannerCfg, systemPrompt, scannerPrompt, 60000, true);
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
    const SYMBOL_FILTER = buildSymbolFilter(targetDate);

    // Pre-load ALL bars into memory once — no SQL per tick
    const timeframe = config.pipeline?.timeframe || '1m';
    const cache = loadBarCache(dataDb, SESSION_START, SESSION_END, SYMBOL_FILTER, timeframe);
    const { timestamps } = cache;

    if (timestamps.length === 0) {
      throw new Error(`No SPX bars found for ${targetDate}`);
    }

    if (verbose) {
      console.log(`\n${'='.repeat(72)}`);
      console.log(`  Replay: ${config.name} | ${targetDate}`);
      console.log(`  Config: ${config.id} | Bars: ${timestamps.length} | Contracts: ${cache.contractBars.size}`);
      console.log('='.repeat(72));
    }

    // Init regime with prior close (auto-detect from first bar if not provided)
    const firstBars = getSpxBarsAt(cache, timestamps[0], 2);
    const priorClose = opts.priorClose || firstBars[0]?.close || 6606.49;
    initRegimeSession(priorClose);

    const judges = opts.noJudge ? [] : selectJudges(config);
    if (verbose) {
      if (judges.length > 0) console.log(`  Judges: ${judges.map(j => j.label).join(', ')}`);
      if (config.scanners.enabled) {
        const scannerNames = config.scanners.models.join(', ');
        console.log(`  Scanners: ${scannerNames} (cycle=${config.scanners.cycleIntervalSec}s, threshold=${config.scanners.minConfidenceToEscalate})`);
      }
      console.log('');
    }

    const trades: Trade[] = [];
    const openPositions = new Map<string, SimPosition>();
    let lastEscalationTs = 0;
    let lastScannerTs = 0;
    const strikeRange = config.strikeSelector.strikeSearchRange;
    let prevSpxHmaFast: number | null = null;
    let prevSpxHmaSlow: number | null = null;
    let spxHmaCrossDirection: 'bullish' | 'bearish' | null = null;
    const spxHmaFastKey = `hma${config.signals.hmaCrossFast ?? 5}`;
    const spxHmaSlowKey = `hma${config.signals.hmaCrossSlow ?? 19}`;

    for (const ts of timestamps) {
      const spxBars = getSpxBarsAt(cache, ts);
      if (spxBars.length < 5) continue;
      const spx = spxBars[spxBars.length - 1];

      // ── Underlying HMA cross detection (uses same configurable periods) ──
      spxHmaCrossDirection = null;
      const currSpxHmaFast = spx.indicators[spxHmaFastKey] ?? null;
      const currSpxHmaSlow = spx.indicators[spxHmaSlowKey] ?? null;
      if (prevSpxHmaFast != null && prevSpxHmaSlow != null && currSpxHmaFast != null && currSpxHmaSlow != null) {
        if (prevSpxHmaFast < prevSpxHmaSlow && currSpxHmaFast >= currSpxHmaSlow) spxHmaCrossDirection = 'bullish';
        if (prevSpxHmaFast >= prevSpxHmaSlow && currSpxHmaFast < currSpxHmaSlow) spxHmaCrossDirection = 'bearish';
      }
      prevSpxHmaFast = currSpxHmaFast;

      // ── Position monitoring ────────────────────────────────────────────
      for (const [posId, openPos] of openPositions.entries()) {
        const curPrice = getPosPriceAt(cache, openPos.side, openPos.strike, SYMBOL_FILTER, ts);
        if (curPrice === null) continue;

        const exitCtx: ExitContext = { ts, closeCutoffTs: CLOSE_CUTOFF, hmaCrossDirection: spxHmaCrossDirection };
        const exitResult = checkExit(openPos, curPrice, config, exitCtx);
        const closeReason = exitResult.reason;

        if (exitResult.shouldExit && closeReason) {
          const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
          const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
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
          openPositions.delete(posId);
        }
      }
      prevSpxHmaSlow = currSpxHmaSlow;

      // ── Signal detection (core module — OTM + price band filtering built in) ──
      const contractBars = getContractBarsAt(cache, spx.close, strikeRange, ts);
      let optionSignals: Signal[] = detectSignals(contractBars as Map<string, CoreBar[]>, spx.close, config);

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
        if (spxHmaCrossDirection == null) {
          optionSignals = [];
        } else {
          const wantSide = spxHmaCrossDirection === 'bullish' ? 'call' : 'put';
          optionSignals = optionSignals.filter(sig =>
            sig.side === wantSide && sig.direction === 'bullish'
          );
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
        // No judge mode: auto-buy the strongest signal
        const best = optionSignals[0] ?? (scannerHotSetups.length > 0 ? { symbol: scannerHotSetups[0].symbol } : null);
        if (best) {
          judgeAction = 'buy';
          judgeConf = 0.6;
          judgeTarget = best.symbol;
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
          judges.map(cfg => askModel(cfg, judgeSystem, prompt, 90000, true))
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
      if (judgeAction === 'buy' && judgeTarget && !openPositions.has(judgeTarget)) {
        const parsed = parseOptionSymbol(judgeTarget);
        if (parsed) {
          const bars = contractBars.get(judgeTarget);
          const entryPrice = bars?.[bars.length - 1]?.close ?? null;

          if (entryPrice && entryPrice > 0) {
            const stopLoss = judgeStop && judgeStop > 0 && judgeStop < entryPrice
              ? judgeStop
              : entryPrice * (1 - config.position.stopLossPercent / 100);
            const takeProfit = judgeTp && judgeTp > entryPrice
              ? judgeTp
              : entryPrice * config.position.takeProfitMultiplier;
            const qty = computeQty(entryPrice, config);

            openPositions.set(`${judgeTarget}_${ts}`, {
              id: `${judgeTarget}_${ts}`,
              symbol: judgeTarget,
              side: parsed.isCall ? 'call' : 'put',
              strike: parsed.strike,
              qty, entryPrice, stopLoss, takeProfit,
              entryTs: ts, entryET: etLabel(ts),
            });
            if (verbose) {
              console.log(`  ENTER ${judgeTarget} x${qty} @ $${entryPrice.toFixed(2)} | stop=$${stopLoss.toFixed(2)} tp=$${takeProfit.toFixed(2)}`);
            }
          }
        }
      }
    }

    // ── EOD close remaining ──────────────────────────────────────────────
    const finalTs = timestamps[timestamps.length - 1];
    for (const [, openPos] of openPositions.entries()) {
      const curPrice = getPosPriceAt(cache, openPos.side, openPos.strike, SYMBOL_FILTER, finalTs) ?? openPos.entryPrice;
      const pnlPct = ((curPrice - openPos.entryPrice) / openPos.entryPrice) * 100;
      const pnl$ = (curPrice - openPos.entryPrice) * openPos.qty * 100;
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
