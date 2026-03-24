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

const DATA_DB_PATH = path.resolve(process.cwd(), 'data/spxer.db');

// ── Internal types ─────────────────────────────────────────────────────────

interface Bar {
  ts: number; open: number; high: number; low: number; close: number; volume: number;
  indicators: Record<string, number | null>;
}

interface OptionSignal {
  symbol: string; type: 'call' | 'put'; strike: number;
  signalType: 'RSI_CROSS' | 'EMA_CROSS' | 'HMA_CROSS' | 'PRICE_CROSS_HMA' | 'PRICE_CROSS_EMA';
  direction: 'bullish' | 'bearish';
  rsi?: number; ema9?: number; ema21?: number; hma5?: number; hma19?: number;
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
  db: Database.Database, start: number, end: number, symbolFilter: string,
): BarCache {
  // Load all SPX bars
  const spxRows = db.prepare(`
    SELECT ts, open, high, low, close, volume, indicators
    FROM bars WHERE symbol='SPX' AND timeframe='1m'
    AND ts >= ? AND ts <= ? ORDER BY ts
  `).all(start, end) as any[];

  const spxBars = spxRows.map((r: any) => ({
    ts: r.ts, open: r.open, high: r.high, low: r.low,
    close: r.close, volume: r.volume,
    indicators: JSON.parse(r.indicators || '{}'),
  }));

  const timestamps = spxBars.map(b => b.ts);

  // Load all contract bars for the session
  const contractRows = db.prepare(`
    SELECT b.symbol, b.ts, b.open, b.high, b.low, b.close, b.volume, b.indicators, c.strike
    FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE b.symbol LIKE ? AND b.timeframe = '1m'
      AND b.ts >= ? AND b.ts <= ?
    ORDER BY b.symbol, b.ts
  `).all(symbolFilter, start, end) as any[];

  const contractBars = new Map<string, Bar[]>();
  const contractStrikes = new Map<string, number>();
  for (const r of contractRows) {
    if (!contractBars.has(r.symbol)) contractBars.set(r.symbol, []);
    contractBars.get(r.symbol)!.push({
      ts: r.ts, open: r.open, high: r.high, low: r.low,
      close: r.close, volume: r.volume,
      indicators: JSON.parse(r.indicators || '{}'),
    });
    if (!contractStrikes.has(r.symbol)) contractStrikes.set(r.symbol, r.strike);
  }

  return { spxBars, contractBars, contractStrikes, timestamps };
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
  const prefix = side === 'call' ? 'C' : 'P';
  for (const [symbol, bars] of cache.contractBars) {
    const s = cache.contractStrikes.get(symbol)!;
    if (s !== strike) continue;
    if (!symbol.includes(prefix)) continue;

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
  const rows = db.prepare(`
    SELECT b.close FROM bars b
    JOIN contracts c ON b.symbol = c.symbol
    WHERE c.type = ? AND c.strike = ? AND b.symbol LIKE ?
      AND b.timeframe = '1m' AND b.ts <= ?
    ORDER BY b.ts DESC LIMIT 1
  `).all(side, strike, symbolFilter, atTs) as any[];
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

// ── Signal detection (config-driven) ───────────────────────────────────────

function detectOptionSignals(
  contractBars: Map<string, Bar[]>,
  spxPrice: number,
  config: ReplayConfig,
): OptionSignal[] {
  const signals: OptionSignal[] = [];

  for (const [symbol, bars] of contractBars) {
    if (bars.length < 2) continue;

    const curr = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    const ind = curr.indicators;
    const prevInd = prev.indicators;

    const match = symbol.match(/([CP])(\d{4,5})(?:000)?$/);
    if (!match) continue;
    const [, type, strikeStr] = match;
    const strike = parseInt(strikeStr);
    const isCall = type === 'C';

    // RSI crosses (config-driven thresholds on option contracts)
    if (config.signals.enableRsiCrosses && ind.rsi14 && prevInd.rsi14) {
      const osLevel = config.signals.optionRsiOversold;
      const obLevel = config.signals.optionRsiOverbought;
      if (prevInd.rsi14 >= osLevel && ind.rsi14 < osLevel) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'RSI_CROSS', direction: 'bullish', rsi: ind.rsi14 });
      }
      if (prevInd.rsi14 <= obLevel && ind.rsi14 > obLevel) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'RSI_CROSS', direction: 'bearish', rsi: ind.rsi14 });
      }
    }

    // HMA crosses
    if (config.signals.enableHmaCrosses && prevInd.hma5 && prevInd.hma19 && ind.hma5 && ind.hma19) {
      if (prevInd.hma5 < prevInd.hma19 && ind.hma5 >= ind.hma19) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'HMA_CROSS', direction: 'bullish', hma5: ind.hma5, hma19: ind.hma19 });
      }
      if (prevInd.hma5 >= prevInd.hma19 && ind.hma5 < ind.hma19) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'HMA_CROSS', direction: 'bearish', hma5: ind.hma5, hma19: ind.hma19 });
      }
    }

    // EMA crosses
    if (config.signals.enableEmaCrosses && prevInd.ema9 && prevInd.ema21 && ind.ema9 && ind.ema21) {
      if (prevInd.ema9 < prevInd.ema21 && ind.ema9 >= ind.ema21) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'EMA_CROSS', direction: 'bullish', ema9: ind.ema9, ema21: ind.ema21 });
      }
      if (prevInd.ema9 >= prevInd.ema21 && ind.ema9 < ind.ema21) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'EMA_CROSS', direction: 'bearish', ema9: ind.ema9, ema21: ind.ema21 });
      }
    }

    // Price crosses HMA (Session 7)
    if (config.signals.enableHmaCrosses && prevInd.hma5 && ind.hma5) {
      if (prevInd.hma5 >= curr.close && ind.hma5 < curr.close) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'PRICE_CROSS_HMA', direction: 'bullish', hma5: ind.hma5 });
      }
      if (prevInd.hma5 <= curr.close && ind.hma5 > curr.close) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'PRICE_CROSS_HMA', direction: 'bearish', hma5: ind.hma5 });
      }
    }

    // Price crosses EMA (Session 8)
    if (config.signals.enableEmaCrosses && prevInd.ema21 && ind.ema21) {
      if (prevInd.ema21 >= curr.close && ind.ema21 < curr.close) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'PRICE_CROSS_EMA', direction: 'bullish', ema21: ind.ema21 });
      }
      if (prevInd.ema21 <= curr.close && ind.ema21 > curr.close) {
        signals.push({ symbol, type: isCall ? 'call' : 'put', strike, signalType: 'PRICE_CROSS_EMA', direction: 'bearish', ema21: ind.ema21 });
      }
    }
  }

  return signals;
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
  const enabled = allConfigs.filter(c =>
    (c.id === 'kimi' && config.scanners.enableKimi) ||
    (c.id === 'glm' && config.scanners.enableGlm) ||
    (c.id === 'minimax' && config.scanners.enableMinimax) ||
    (c.id === 'haiku' && config.scanners.enableHaiku)
  );

  if (enabled.length === 0) return [];

  // Get the scanner prompt from library (use config.scanners.promptId)
  let libraryPrompt = DEFAULT_SCANNER_SYSTEM;
  try {
    const promptLibEntry = getPromptFromLibrary(config.scanners.promptId);
    libraryPrompt = promptLibEntry.basePrompt;
  } catch {
    // Fall back to default if prompt not found
    if (verbose) console.log(`  Warning: Scanner prompt not found (${config.scanners.promptId}), using default`);
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
  return config.prompts.judgeSystemPrompt || DEFAULT_JUDGE_SYSTEM;
}

function getScannerPrompt(config: ReplayConfig, scannerId: string): string | null {
  return config.prompts.scannerPrompts?.[scannerId] ?? null;
}

function buildPrompt(
  config: ReplayConfig,
  ts: number, sessionEnd: number, spxBars: Bar[],
  optionSignals: OptionSignal[], regime: string, regimeContext: string,
): string {
  const spx = spxBars[spxBars.length - 1];
  const signalDesc = optionSignals.map(s =>
    `${s.symbol}: ${s.signalType} ${s.direction.toUpperCase()} (RSI=${s.rsi?.toFixed(1) ?? '?'})`
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
  const enabledModels = new Set(config.judge.models);
  return all.filter(j => enabledModels.has(j.id as 'haiku' | 'sonnet' | 'opus'));
}

// ── Main engine ────────────────────────────────────────────────────────────

export interface ReplayOptions {
  /** Path to data DB (defaults to data/spxer.db) */
  dataDbPath?: string;
  /** Path to replay store DB (defaults to data/replay.db) */
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
    const cache = loadBarCache(dataDb, SESSION_START, SESSION_END, SYMBOL_FILTER);
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
        const scannerNames = [
          config.scanners.enableKimi && 'Kimi',
          config.scanners.enableGlm && 'GLM',
          config.scanners.enableMinimax && 'MiniMax',
        ].filter(Boolean).join(', ');
        console.log(`  Scanners: ${scannerNames} (cycle=${config.scanners.cycleIntervalSec}s, threshold=${config.scanners.minConfidenceToEscalate})`);
      }
      console.log('');
    }

    const trades: Trade[] = [];
    const openPositions = new Map<string, SimPosition>();
    let lastEscalationTs = 0;
    let lastScannerTs = 0;
    const strikeRange = config.strikeSelector.strikeSearchRange;

    for (const ts of timestamps) {
      const spxBars = getSpxBarsAt(cache, ts);
      if (spxBars.length < 5) continue;
      const spx = spxBars[spxBars.length - 1];

      // ── Position monitoring ────────────────────────────────────────────
      for (const [posId, openPos] of openPositions.entries()) {
        const curPrice = getPosPriceAt(cache, openPos.side, openPos.strike, SYMBOL_FILTER, ts);
        if (curPrice === null) continue;

        let closeReason: Trade['reason'] | null = null;
        if (curPrice <= openPos.stopLoss) closeReason = 'stop_loss';
        else if (curPrice >= openPos.takeProfit) closeReason = 'take_profit';
        else if (ts >= CLOSE_CUTOFF) closeReason = 'time_exit';

        if (closeReason) {
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

      // ── Signal detection ───────────────────────────────────────────────
      const contractBars = getContractBarsAt(cache, spx.close, strikeRange, ts);
      const optionSignals = detectOptionSignals(contractBars, spx.close, config);

      // ── Regime classification ──────────────────────────────────────────
      const regimeState = classify({ close: spx.close, high: spx.high, low: spx.low, ts }, config.regime);
      const regimeContext = formatRegimeContext(regimeState, config.regime);

      // ── Escalation checks ─────────────────────────────────────────────
      if (ts >= CLOSE_CUTOFF) continue;
      if (ts - lastEscalationTs < config.judge.escalationCooldownSec) continue;
      if (openPositions.size >= config.position.maxPositionsOpen) continue;
      if (trades.length >= config.risk.maxTradesPerDay) continue;

      // ── Time window gate (optional) ────────────────────────────────────
      if (config.timeWindows?.activeStart || config.timeWindows?.activeEnd) {
        const etHHMM = etLabel(ts).slice(0, 5); // 'HH:MM'
        if (config.timeWindows.activeStart && etHHMM < config.timeWindows.activeStart) continue;
        if (config.timeWindows.activeEnd && etHHMM >= config.timeWindows.activeEnd) continue;
      }

      // ── SPX RSI gate (opt-in via config.rsi.enableSpxGate) ────────────
      if (config.rsi.enableSpxGate) {
        const spxRsi = spx.indicators.rsi14;
        if (spxRsi != null) {
          const { oversoldThreshold, overboughtThreshold } = config.rsi;
          if (spxRsi > oversoldThreshold && spxRsi < overboughtThreshold) continue;
        }
      }

      // Check daily loss limit
      const currentDayPnl = trades.reduce((sum, t) => sum + t.pnl$, 0);
      if (currentDayPnl <= -config.risk.maxDailyLoss) continue;

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
              if (parsed.action === 'buy' && (parsed.confidence || 0) > judgeConf && (parsed.confidence || 0) >= config.judge.confidenceThreshold) {
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

      // ── Regime gate ────────────────────────────────────────────────────
      if (judgeAction === 'buy' && judgeTarget) {
        const isCall = judgeTarget.includes('C');
        const spxRsi = spx.indicators.rsi14 ?? null;
        const gate = getSignalGate(regimeState.regime, spxRsi, config.regime);
        const allowed = isCall ? gate.allowOversoldFade : gate.allowOverboughtFade;

        if (!allowed) {
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
            const rawQty = Math.floor((config.sizing.baseDollarsPerTrade * config.sizing.sizeMultiplier) / (entryPrice * 100)) || 1;
            const qty = Math.max(config.sizing.minContracts, Math.min(config.sizing.maxContracts, rawQty));

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
      promptId: config.scanners.enabled ? config.scanners.promptId : undefined,
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
