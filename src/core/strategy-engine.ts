/**
 * Strategy Engine — the single deterministic decision function shared by
 * both replay and the live agent.
 *
 * tick() is PURE: no side effects, no mutations, no I/O.
 * Same inputs → same outputs, always.
 *
 * The caller owns state persistence and order execution.
 * Replay applies decisions instantly (perfect fills).
 * Live applies after broker confirmation (real fills, rejections).
 */

import type { Direction, CoreBar, ExitReason, Position } from './types';
import type { Config } from '../config/types';
import { getEntryCooldownSec } from '../config/types';
import type { StrikeCandidate } from './strike-selector';
import { checkExit, type ExitContext } from './position-manager';
import { isRiskBlocked, type RiskState } from './risk-guard';
import { selectStrike } from './strike-selector';
import { computeQty } from './position-sizer';
import { frictionEntry, computeRealisticPnl } from './friction';
import { nowET } from '../utils/et-time';

// ── Exported Types ──────────────────────────────────────────────────────────

/**
 * Core position for the strategy engine. Minimal — no broker-specific fields.
 * The live agent wraps this with broker metadata (orderId, bracketId, etc).
 */
export interface CorePosition {
  id: string;
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  entryTs: number;
  highWaterPrice: number;
}

/**
 * Strategy state — owned and persisted by the caller.
 * Passed into tick() each cycle. tick() does NOT mutate this.
 *
 * Direction and exit HMA crosses are tracked separately because the config
 * may use different timeframes for each (e.g., 3m direction, 5m exit).
 */
export interface StrategyState {
  positions: Map<string, CorePosition>;   // open positions (keyed by symbol)
  // Direction HMA state (entry gating — from directionTimeframe)
  directionCross: Direction | null;       // last direction cross direction
  prevDirectionHmaFast: number | null;
  prevDirectionHmaSlow: number | null;
  lastDirectionBarTs: number | null;      // dedup: only fire once per closed candle
  // Exit HMA state (signal reversal — from exitTimeframe)
  exitCross: Direction | null;            // last exit cross direction
  prevExitHmaFast: number | null;
  prevExitHmaSlow: number | null;
  lastExitBarTs: number | null;
  // Trade state
  lastEntryTs: number;                    // for cooldown enforcement
  dailyPnl: number;                       // running total, updated by caller after fills
  tradesCompleted: number;                // running count, updated by caller after fills
}

/**
 * Market data snapshot for one tick cycle.
 *
 * Two types of price data serve different purposes:
 * - CLOSED CANDLES (spxDirectionBars, spxExitBars, contractBars): for signal detection
 * - LIVE TICK PRICES (positionPrices, spxPrice, candidates): for position monitoring
 */
export interface TickInput {
  ts: number;                              // current unix seconds

  // ── CLOSED CANDLE DATA (for signal detection) ──
  /** SPX bars on the DIRECTION timeframe. CLOSED candles only. */
  spxDirectionBars: CoreBar[];
  /** SPX bars on the EXIT timeframe. CLOSED candles only.
   *  Same array as spxDirectionBars when config uses the same TF for both. */
  spxExitBars: CoreBar[];
  /** Option contract bars on the SIGNAL timeframe. CLOSED candles only. */
  contractBars: Map<string, CoreBar[]>;

  // ── LIVE TICK DATA (for position monitoring + strike selection) ──
  spxPrice: number;                        // current SPX price
  closeCutoffTs: number;                   // EOD cutoff in unix seconds
  candidates: StrikeCandidate[];           // contracts with live tick prices
  positionPrices: Map<string, number>;     // live tick price per open position
  /** Bar high/low for open positions — used for intrabar TP/SL detection in replay.
   *  Key = position symbol. If absent, intrabar pricing is skipped (close-only). */
  positionBars?: Map<string, { high: number; low: number }>;
}

/**
 * tick() output — decisions only, no side effects.
 */
export interface TickResult {
  /** Positions to exit this tick, in priority order. */
  exits: Array<{
    positionId: string;
    symbol: string;
    reason: ExitReason;
    decisionPrice: number;         // price tick() used to make the decision
    pnl: { pnlPct: number; 'pnl$': number };
    flipTo: 'call' | 'put' | null; // non-null if exit.strategy=scannerReverse
  }>;

  /** Position to enter this tick, or null. */
  entry: {
    symbol: string;
    side: 'call' | 'put';
    strike: number;
    price: number;                 // decision price (replay fills here; live fills at broker price)
    qty: number;
    stopLoss: number;
    takeProfit: number;
    direction: Direction;
    reason: string;
  } | null;

  /** Updated direction HMA state (caller must persist). */
  directionState: {
    directionCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
    freshCross: boolean;           // true if a new cross fired this tick
  };

  /** Updated exit HMA state (caller must persist). */
  exitState: {
    exitCross: Direction | null;
    prevHmaFast: number | null;
    prevHmaSlow: number | null;
    lastBarTs: number | null;
  };

  /** Why no entry was made (for logging/debugging). */
  skipReason: string | null;
}

// ── HMA Cross Detection (internal) ─────────────────────────────────────────

interface HmaCrossResult {
  cross: Direction | null;
  prevFast: number | null;
  prevSlow: number | null;
  lastBarTs: number | null;
  freshCross: boolean;
}

/**
 * Detect HMA crossover from closed candle bars.
 * Compares the last bar's HMA fast/slow to the previous state.
 * Only fires once per closed candle (dedup via lastBarTs).
 */
function detectHmaCross(
  bars: CoreBar[],
  fastPeriod: number,
  slowPeriod: number,
  prevFast: number | null,
  prevSlow: number | null,
  lastBarTs: number | null,
): HmaCrossResult {
  if (bars.length === 0) {
    return { cross: null, prevFast, prevSlow, lastBarTs, freshCross: false };
  }

  const lastBar = bars[bars.length - 1];

  // Dedup: already processed this candle
  if (lastBarTs !== null && lastBar.ts <= lastBarTs) {
    // Return the current cross direction (unchanged) and no fresh cross
    // We need to derive the current cross from prevFast/prevSlow
    let currentCross: Direction | null = null;
    if (prevFast !== null && prevSlow !== null) {
      currentCross = prevFast > prevSlow ? 'bullish' : prevFast < prevSlow ? 'bearish' : null;
    }
    return { cross: currentCross, prevFast, prevSlow, lastBarTs, freshCross: false };
  }

  // Read HMA values from the bar's indicators
  const hmaFastKey = `hma${fastPeriod}`;
  const hmaSlowKey = `hma${slowPeriod}`;
  const currentFast = lastBar.indicators[hmaFastKey] ?? null;
  const currentSlow = lastBar.indicators[hmaSlowKey] ?? null;

  // Can't detect cross without both values
  if (currentFast === null || currentSlow === null) {
    return {
      cross: null,
      prevFast: currentFast,
      prevSlow: currentSlow,
      lastBarTs: lastBar.ts,
      freshCross: false,
    };
  }

  // Can't detect cross without previous values (first bar)
  if (prevFast === null || prevSlow === null) {
    // Determine current relationship (no cross yet, just set state)
    const cross = currentFast > currentSlow ? 'bullish' : currentFast < currentSlow ? 'bearish' : null;
    return {
      cross,
      prevFast: currentFast,
      prevSlow: currentSlow,
      lastBarTs: lastBar.ts,
      freshCross: false,
    };
  }

  // Detect crossover: previous fast was below/at slow, now fast is above (bullish)
  //                    previous fast was above/at slow, now fast is below (bearish)
  const prevDiff = prevFast - prevSlow;
  const currDiff = currentFast - currentSlow;
  let freshCross = false;
  let cross: Direction | null = null;

  if (prevDiff <= 0 && currDiff > 0) {
    // Bullish cross: fast crossed above slow
    cross = 'bullish';
    freshCross = true;
  } else if (prevDiff >= 0 && currDiff < 0) {
    // Bearish cross: fast crossed below slow
    cross = 'bearish';
    freshCross = true;
  } else {
    // No cross — maintain the current relationship as the cross direction
    cross = currDiff > 0 ? 'bullish' : currDiff < 0 ? 'bearish' : null;
  }

  return {
    cross,
    prevFast: currentFast,
    prevSlow: currentSlow,
    lastBarTs: lastBar.ts,
    freshCross,
  };
}

// ── Time Window Check (internal) ────────────────────────────────────────────

/**
 * Check if a unix timestamp falls within the active trading window.
 * Uses ET timezone conversion.
 */
function isInActiveWindow(ts: number, config: Config): boolean {
  const now = new Date(ts * 1000);
  const et = nowET(now);
  const currentMinutes = et.h * 60 + et.m;

  const [startH, startM] = config.timeWindows.activeStart.split(':').map(Number);
  const [endH, endM] = config.timeWindows.activeEnd.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a fresh initial state with no positions and no HMA history.
 */
export function createInitialState(): StrategyState {
  return {
    positions: new Map(),
    directionCross: null,
    prevDirectionHmaFast: null,
    prevDirectionHmaSlow: null,
    lastDirectionBarTs: null,
    exitCross: null,
    prevExitHmaFast: null,
    prevExitHmaSlow: null,
    lastExitBarTs: null,
    lastEntryTs: 0,
    dailyPnl: 0,
    tradesCompleted: 0,
  };
}

/**
 * Strip the forming (incomplete) candle from a bar array.
 *
 * The data service may include a bar for the currently-forming period.
 * This bar has unstable indicator values that change every poll cycle.
 * Passing it to tick() would cause phantom crosses on partial data.
 *
 * Removes the last bar if its timestamp falls within the current period.
 *
 * @param bars - array of bars (ascending by ts)
 * @param periodSec - candle period in seconds (60 for 1m, 180 for 3m, etc.)
 * @returns bars with the forming candle removed (or unchanged if all closed)
 */
export function stripFormingCandle(bars: CoreBar[], periodSec: number = 60): CoreBar[] {
  if (bars.length === 0) return bars;
  const now = Math.floor(Date.now() / 1000);
  const currentPeriodStart = now - (now % periodSec);
  const lastBar = bars[bars.length - 1];
  if (lastBar.ts >= currentPeriodStart) {
    return bars.slice(0, -1);
  }
  return bars;
}

// ── The Core Decision Function ──────────────────────────────────────────────

/**
 * tick() — the single deterministic decision function.
 *
 * Steps:
 *   1a. Detect direction HMA cross (from spxDirectionBars)
 *   1b. Detect exit HMA cross (from spxExitBars)
 *   2.  Check exits for all open positions
 *   3.  Risk guard
 *   4.  Time window gate
 *   5.  Cooldown gate
 *   6.  Entry decision (flip-on-reversal or fresh direction cross)
 *   7.  Return result
 *
 * tick() is PURE — no side effects, no mutations, no I/O.
 */
export function tick(
  state: StrategyState,
  input: TickInput,
  config: Config,
): TickResult {
  const { hmaCrossFast, hmaCrossSlow } = config.signals;

  // ── Step 1a: Direction cross (entry gating) ───────────────────────────
  const dirResult = detectHmaCross(
    input.spxDirectionBars,
    hmaCrossFast,
    hmaCrossSlow,
    state.prevDirectionHmaFast,
    state.prevDirectionHmaSlow,
    state.lastDirectionBarTs,
  );

  const directionState: TickResult['directionState'] = {
    directionCross: dirResult.cross,
    prevHmaFast: dirResult.prevFast,
    prevHmaSlow: dirResult.prevSlow,
    lastBarTs: dirResult.lastBarTs,
    freshCross: dirResult.freshCross,
  };

  // ── Step 1b: Exit cross (signal reversal) ─────────────────────────────
  const exitResult = detectHmaCross(
    input.spxExitBars,
    hmaCrossFast,
    hmaCrossSlow,
    state.prevExitHmaFast,
    state.prevExitHmaSlow,
    state.lastExitBarTs,
  );

  const exitState: TickResult['exitState'] = {
    exitCross: exitResult.cross,
    prevHmaFast: exitResult.prevFast,
    prevHmaSlow: exitResult.prevSlow,
    lastBarTs: exitResult.lastBarTs,
  };

  // ── Step 2: Check exits for all open positions ────────────────────────
  const exits: TickResult['exits'] = [];
  const exitingPositionIds = new Set<string>();

  for (const [posId, pos] of state.positions) {
    const currentPrice = input.positionPrices.get(pos.symbol) ?? null;

    // Build a Position for checkExit() (it expects the Position type)
    const corePos: Position = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      strike: pos.strike,
      qty: pos.qty,
      entryPrice: pos.entryPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      entryTs: pos.entryTs,
      entryET: '', // not used by checkExit()
    };

    // Update high-water mark for trailing stop
    const highWater = currentPrice !== null
      ? Math.max(pos.highWaterPrice, currentPrice)
      : pos.highWaterPrice;

    // Get bar high/low for intrabar pricing (if available)
    const posBar = input.positionBars?.get(pos.symbol);

    const exitCtx: ExitContext = {
      ts: input.ts,
      closeCutoffTs: input.closeCutoffTs,
      hmaCrossDirection: exitResult.cross,
      highWaterPrice: highWater,
      barHigh: posBar?.high,
      barLow: posBar?.low,
    };

    // If no price, only check time-based and signal-reversal exits
    if (currentPrice === null) {
      // Check with entry price as fallback (only time/reversal can fire)
      const check = checkExit(corePos, pos.entryPrice, config, exitCtx);
      if (check.shouldExit && (check.reason === 'time_exit' || check.reason === 'signal_reversal')) {
        const pnl = computeRealisticPnl(pos.entryPrice, pos.entryPrice, pos.qty);
        const flipTo = getFlipDirection(check.reason, pos.side, config);
        exits.push({
          positionId: posId,
          symbol: pos.symbol,
          reason: check.reason,
          decisionPrice: pos.entryPrice,
          pnl: { pnlPct: pnl.pnlPct, 'pnl$': pnl['pnl$'] },
          flipTo,
        });
        exitingPositionIds.add(posId);
      }
      continue;
    }

    const check = checkExit(corePos, currentPrice, config, exitCtx);
    if (check.shouldExit && check.reason !== null) {
      // Use intrabar exitPrice when available (exact TP/SL fill), otherwise bar close
      const fillPrice = check.exitPrice ?? currentPrice;
      const pnl = computeRealisticPnl(pos.entryPrice, fillPrice, pos.qty);
      const flipTo = getFlipDirection(check.reason, pos.side, config);
      exits.push({
        positionId: posId,
        symbol: pos.symbol,
        reason: check.reason,
        decisionPrice: fillPrice,
        pnl: { pnlPct: pnl.pnlPct, 'pnl$': pnl['pnl$'] },
        flipTo,
      });
      exitingPositionIds.add(posId);
    }
  }

  // ── Entry gating: Steps 3-5 ──────────────────────────────────────────

  // Count open positions AFTER pending exits
  const positionsAfterExits = state.positions.size - exitingPositionIds.size;

  // ── Step 3: Risk guard ────────────────────────────────────────────────
  const riskState: RiskState = {
    openPositions: positionsAfterExits,
    tradesCompleted: state.tradesCompleted,
    dailyPnl: state.dailyPnl,
    currentTs: input.ts,
    closeCutoffTs: input.closeCutoffTs,
    lastEscalationTs: state.lastEntryTs,
  };

  const riskCheck = isRiskBlocked(riskState, config);
  if (riskCheck.blocked) {
    return { exits, entry: null, directionState, exitState, skipReason: riskCheck.reason };
  }

  // ── Step 4: Time window gate ──────────────────────────────────────────
  if (!isInActiveWindow(input.ts, config)) {
    return { exits, entry: null, directionState, exitState, skipReason: 'outside active window' };
  }

  // ── Step 5: Cooldown gate ─────────────────────────────────────────────
  const cooldownSec = getEntryCooldownSec(config);
  const elapsed = input.ts - state.lastEntryTs;
  if (state.lastEntryTs > 0 && elapsed < cooldownSec) {
    const remaining = cooldownSec - elapsed;
    return {
      exits,
      entry: null,
      directionState,
      exitState,
      skipReason: `cooldown (${remaining}s remaining)`,
    };
  }

  // ── Step 6: Entry decision ────────────────────────────────────────────

  let entryDirection: Direction | null = null;
  let entryReason = '';

  // 6a: Flip-on-reversal — exit with signal_reversal triggers opposite entry
  const flipExits = exits.filter(e => e.flipTo !== null);
  if (flipExits.length > 0) {
    // Use the first flip exit's direction
    const flipSide = flipExits[0].flipTo!;
    entryDirection = flipSide === 'call' ? 'bullish' : 'bearish';
    entryReason = `flip-on-reversal from ${flipExits[0].symbol}`;
  }

  // 6b: Fresh direction cross — only if no flip and no remaining positions
  if (entryDirection === null && dirResult.freshCross && positionsAfterExits === 0) {
    entryDirection = dirResult.cross;
    entryReason = `fresh HMA(${hmaCrossFast}x${hmaCrossSlow}) ${dirResult.cross} cross`;
  }

  // No entry trigger
  if (entryDirection === null) {
    return { exits, entry: null, directionState, exitState, skipReason: 'no entry trigger' };
  }

  // requireUnderlyingHmaCross gate: direction cross must exist
  if (config.signals.requireUnderlyingHmaCross && dirResult.cross === null) {
    return {
      exits,
      entry: null,
      directionState,
      exitState,
      skipReason: 'requireUnderlyingHmaCross — no direction cross',
    };
  }

  // Determine side
  const side: 'call' | 'put' = entryDirection === 'bullish' ? 'call' : 'put';

  // allowedSides gate: skip if this side isn't allowed
  const allowedSides = config.signals.allowedSides ?? 'both';
  if (allowedSides === 'calls' && side !== 'call') {
    return { exits, entry: null, directionState, exitState, skipReason: 'allowedSides=calls — bearish signal blocked' };
  }
  if (allowedSides === 'puts' && side !== 'put') {
    return { exits, entry: null, directionState, exitState, skipReason: 'allowedSides=puts — bullish signal blocked' };
  }

  // Select strike from candidates
  const strikeResult = selectStrike(input.candidates, entryDirection, input.spxPrice, config);
  if (strikeResult === null) {
    return {
      exits,
      entry: null,
      directionState,
      exitState,
      skipReason: 'no qualifying contract',
    };
  }

  const candidate = strikeResult.candidate;

  // maxEntryPrice filter
  if (config.signals.maxEntryPrice !== null && candidate.price > config.signals.maxEntryPrice) {
    return {
      exits,
      entry: null,
      directionState,
      exitState,
      skipReason: `entry price $${candidate.price.toFixed(2)} exceeds maxEntryPrice $${config.signals.maxEntryPrice}`,
    };
  }

  // Compute effective entry with friction
  const effectiveEntry = frictionEntry(candidate.price);

  // Compute SL and TP
  const stopLoss = effectiveEntry * (1 - config.position.stopLossPercent / 100);
  const takeProfit = effectiveEntry * config.position.takeProfitMultiplier;

  // Compute quantity
  const qty = computeQty(effectiveEntry, config);

  const entry: TickResult['entry'] = {
    symbol: candidate.symbol,
    side,
    strike: candidate.strike,
    price: candidate.price,
    qty,
    stopLoss,
    takeProfit,
    direction: entryDirection,
    reason: `${entryReason} → ${strikeResult.reason}`,
  };

  return { exits, entry, directionState, exitState, skipReason: null };
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Determine the flip direction for an exit. Returns the opposite side
 * if the exit strategy is scannerReverse and the reason is signal_reversal.
 */
function getFlipDirection(
  reason: ExitReason,
  currentSide: 'call' | 'put',
  config: Config,
): 'call' | 'put' | null {
  if (config.exit.strategy !== 'scannerReverse') return null;
  if (reason !== 'signal_reversal') return null;
  return currentSide === 'call' ? 'put' : 'call';
}
