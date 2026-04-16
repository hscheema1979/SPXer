/**
 * Trade Manager — stateless entry/exit decision logic.
 *
 * Both live agents and replay call these pure functions.
 * Positions come from the broker (live) or simulated tracker (replay).
 * Signal comes from detectSignal() in strategy-engine.ts.
 *
 * evaluateExit()  — should this position be closed?
 * evaluateEntry() — should we open a new position?
 */

import type { Direction, ExitReason, Position } from './types';
import type { Config } from '../config/types';
import { getEntryCooldownSec } from '../config/types';
import type { StrikeCandidate } from './strike-selector';
import type { CorePosition, SignalResult } from './strategy-engine';
import { isInActiveWindow, getFlipDirection } from './strategy-engine';
import { checkExit, type ExitContext } from './position-manager';
import { isRiskBlocked, type RiskState } from './risk-guard';
import { selectStrike } from './strike-selector';
import { computeQty } from './position-sizer';
import { frictionEntry, computeRealisticPnl } from './friction';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ExitDecision {
  positionId: string;
  symbol: string;
  reason: ExitReason;
  decisionPrice: number;
  pnl: { pnlPct: number; 'pnl$': number };
  flipTo: 'call' | 'put' | null;
}

export interface EntryDecision {
  symbol: string;
  side: 'call' | 'put';
  strike: number;
  price: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  direction: Direction;
  reason: string;
}

export interface EntryContext {
  ts: number;
  spxPrice: number;
  candidates: StrikeCandidate[];
  dailyPnl: number;
  tradesCompleted: number;
  lastEntryTs: number;
  closeCutoffTs: number;
}

// ── Exit Evaluation ─────────────────────────────────────────────────────────

/**
 * Check whether a single position should be exited.
 *
 * Wraps checkExit() with high-water tracking, P&L computation,
 * and flip-on-reversal logic. Returns null if no exit.
 */
export function evaluateExit(
  pos: CorePosition,
  currentPrice: number | null,
  exitCross: Direction | null,
  exitCrossFresh: boolean,
  config: Config,
  ts: number,
  closeCutoffTs: number,
  barHighLow?: { high: number; low: number },
): ExitDecision | null {
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
    entryET: '',
  };

  const highWater = currentPrice !== null
    ? Math.max(pos.highWaterPrice, currentPrice)
    : pos.highWaterPrice;

  const exitCtx: ExitContext = {
    ts,
    closeCutoffTs,
    hmaCrossDirection: exitCross,
    hmaCrossFresh: exitCrossFresh,
    highWaterPrice: highWater,
    barHigh: barHighLow?.high,
    barLow: barHighLow?.low,
  };

  // No price — only check time-based and signal-reversal exits
  if (currentPrice === null) {
    const check = checkExit(corePos, pos.entryPrice, config, exitCtx);
    if (check.shouldExit && (check.reason === 'time_exit' || check.reason === 'signal_reversal')) {
      const pnl = computeRealisticPnl(pos.entryPrice, pos.entryPrice, pos.qty);
      return {
        positionId: pos.id,
        symbol: pos.symbol,
        reason: check.reason,
        decisionPrice: pos.entryPrice,
        pnl: { pnlPct: pnl.pnlPct, 'pnl$': pnl['pnl$'] },
        flipTo: getFlipDirection(check.reason, pos.side, config),
      };
    }
    return null;
  }

  const check = checkExit(corePos, currentPrice, config, exitCtx);
  if (check.shouldExit && check.reason !== null) {
    const fillPrice = check.exitPrice ?? currentPrice;
    const pnl = computeRealisticPnl(pos.entryPrice, fillPrice, pos.qty);
    return {
      positionId: pos.id,
      symbol: pos.symbol,
      reason: check.reason,
      decisionPrice: fillPrice,
      pnl: { pnlPct: pnl.pnlPct, 'pnl$': pnl['pnl$'] },
      flipTo: getFlipDirection(check.reason, pos.side, config),
    };
  }

  return null;
}

// ── Entry Evaluation ────────────────────────────────────────────────────────

/**
 * Check whether a new position should be entered.
 *
 * Composes: risk guard → time window → cooldown → direction logic →
 * allowedSides → strike selection → sizing.
 *
 * @param signal - result from detectSignal()
 * @param exits - exit decisions from evaluateExit() (for flip-on-reversal)
 * @param openPositionCount - total open positions BEFORE exits
 * @param config - trading config
 * @param context - current market state + trade counters
 */
export function evaluateEntry(
  signal: SignalResult,
  exits: ExitDecision[],
  openPositionCount: number,
  config: Config,
  context: EntryContext,
): { entry: EntryDecision | null; skipReason: string | null } {
  const { hmaCrossFast, hmaCrossSlow } = config.signals;

  // Positions remaining after pending exits
  const positionsAfterExits = openPositionCount - exits.length;

  // Risk guard
  const riskState: RiskState = {
    openPositions: positionsAfterExits,
    tradesCompleted: context.tradesCompleted,
    dailyPnl: context.dailyPnl,
    currentTs: context.ts,
    closeCutoffTs: context.closeCutoffTs,
    lastEscalationTs: context.lastEntryTs,
  };

  const riskCheck = isRiskBlocked(riskState, config);
  if (riskCheck.blocked) {
    return { entry: null, skipReason: riskCheck.reason };
  }

  // Time window gate
  if (!isInActiveWindow(context.ts, config)) {
    return { entry: null, skipReason: 'outside active window' };
  }

  // Cooldown gate
  const cooldownSec = getEntryCooldownSec(config);
  const elapsed = context.ts - context.lastEntryTs;
  if (context.lastEntryTs > 0 && elapsed < cooldownSec) {
    const remaining = cooldownSec - elapsed;
    return { entry: null, skipReason: `cooldown (${remaining}s remaining)` };
  }

  // ── Entry direction ───────────────────────────────────────────────────

  let entryDirection: Direction | null = null;
  let entryReason = '';

  // Flip-on-reversal: exit with signal_reversal triggers opposite entry
  const flipExits = exits.filter(e => e.flipTo !== null);
  if (flipExits.length > 0) {
    const flipSide = flipExits[0].flipTo!;
    entryDirection = flipSide === 'call' ? 'bullish' : 'bearish';
    entryReason = `flip-on-reversal from ${flipExits[0].symbol}`;
  }

  // Fresh direction cross — only if no flip and no remaining positions
  if (entryDirection === null && signal.directionState.freshCross && positionsAfterExits === 0) {
    entryDirection = signal.directionState.cross;
    entryReason = `fresh HMA(${hmaCrossFast}x${hmaCrossSlow}) ${signal.directionState.cross} cross`;
  }

  if (entryDirection === null) {
    return { entry: null, skipReason: 'no entry trigger' };
  }

  // requireUnderlyingHmaCross gate
  if (config.signals.requireUnderlyingHmaCross && signal.directionState.cross === null) {
    return { entry: null, skipReason: 'requireUnderlyingHmaCross — no direction cross' };
  }

  const side: 'call' | 'put' = entryDirection === 'bullish' ? 'call' : 'put';

  // allowedSides gate
  const allowedSides = config.signals.allowedSides ?? 'both';
  if (allowedSides === 'calls' && side !== 'call') {
    return { entry: null, skipReason: 'allowedSides=calls — bearish signal blocked' };
  }
  if (allowedSides === 'puts' && side !== 'put') {
    return { entry: null, skipReason: 'allowedSides=puts — bullish signal blocked' };
  }

  // Select strike
  const strikeResult = selectStrike(context.candidates, entryDirection, context.spxPrice, config);
  if (strikeResult === null) {
    return { entry: null, skipReason: 'no qualifying contract' };
  }

  const candidate = strikeResult.candidate;

  // maxEntryPrice filter
  if (config.signals.maxEntryPrice !== null && candidate.price > config.signals.maxEntryPrice) {
    return {
      entry: null,
      skipReason: `entry price $${candidate.price.toFixed(2)} exceeds maxEntryPrice $${config.signals.maxEntryPrice}`,
    };
  }

  // Compute effective entry with friction
  const effectiveEntry = frictionEntry(candidate.price);
  const stopLoss = effectiveEntry * (1 - config.position.stopLossPercent / 100);
  const takeProfit = effectiveEntry * config.position.takeProfitMultiplier;
  const qty = computeQty(effectiveEntry, config);

  return {
    entry: {
      symbol: candidate.symbol,
      side,
      strike: candidate.strike,
      price: candidate.price,
      qty,
      stopLoss,
      takeProfit,
      direction: entryDirection,
      reason: `${entryReason} → ${strikeResult.reason}`,
    },
    skipReason: null,
  };
}
