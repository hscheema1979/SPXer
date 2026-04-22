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
import type { StrikeCandidate } from './strike-selector';
import type { CorePosition, SignalResult } from './strategy-engine';
import { getFlipDirection } from './strategy-engine';
import { checkExit, type ExitContext } from './position-manager';
import { checkEntryGates } from './entry-gate';
import { selectStrike } from './strike-selector';
import { computeQty } from './position-sizer';
import { frictionEntry, computeRealisticPnl, resolveSpreadModel, type ExitKind, type SpreadModel } from './friction';
import { resolveSlippage, slipBuyPrice } from './fill-model';
import { roundToOptionTick } from './option-tick';

/**
 * Map an ExitReason to the friction ExitKind.
 *   take_profit   → 'tp'     (limit sell, no half-spread)
 *   stop_loss     → 'sl'     (stop→market, full half-spread + slippage)
 *   anything else → 'market' (signal_reversal, time_exit, scannerReverse)
 */
function exitKindFor(reason: ExitReason): ExitKind {
  if (reason === 'take_profit') return 'tp';
  if (reason === 'stop_loss') return 'sl';
  return 'market';
}

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
  /** Higher-timeframe HMA direction for MTF confirmation gate.
   *  Only checked when config.signals.mtfConfirmation.enabled is true.
   *  null = no data available (gate passes — fail-open). */
  mtfDirection?: Direction | null;
  /** Current account value for percentage-based sizing.
   *  Live: buying power from Tradier. Replay: simulated account.
   *  Null = fall back to baseDollarsPerTrade. */
  accountValue?: number | null;
  /** Total HMA cross signals detected this session (for circuit breaker). */
  sessionSignalCount?: number;
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
  barHighLow?: { high: number; low: number; open?: number; spread?: number },
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
    barOpen: barHighLow?.open,
    barSpread: barHighLow?.spread,
  };

  const sm = resolveSpreadModel(config);

  // No price — only check time-based and signal-reversal exits
  if (currentPrice === null) {
    const check = checkExit(corePos, pos.entryPrice, config, exitCtx);
    if (check.shouldExit && (check.reason === 'time_exit' || check.reason === 'signal_reversal')) {
      const pnl = computeRealisticPnl(pos.entryPrice, pos.entryPrice, pos.qty, exitKindFor(check.reason), sm);
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
    const pnl = computeRealisticPnl(pos.entryPrice, fillPrice, pos.qty, exitKindFor(check.reason), sm);
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

  // ── Determine entry direction FIRST (needed to decide cooldown bypass) ──

  let entryDirection: Direction | null = null;
  let entryReason = '';
  let isFlip = false;

  // Flip-on-reversal: exit with signal_reversal triggers opposite entry
  const flipExits = exits.filter(e => e.flipTo !== null);
  if (flipExits.length > 0) {
    const flipSide = flipExits[0].flipTo!;
    entryDirection = flipSide === 'call' ? 'bullish' : 'bearish';
    entryReason = `flip-on-reversal from ${flipExits[0].symbol}`;
    isFlip = true;
  }

  // Fresh direction cross — only if no flip and no remaining positions
  if (entryDirection === null && signal.directionState.freshCross && positionsAfterExits === 0) {
    entryDirection = signal.directionState.cross;
    entryReason = `fresh HMA(${hmaCrossFast}x${hmaCrossSlow}) ${signal.directionState.cross} cross`;
  }

  // ── Shared entry gate: risk + time-window + cooldown ────────────────────
  // The gate enforces flip-bypasses-cooldown internally via EntryKind.
  const gate = checkEntryGates({
    ts: context.ts,
    kind: isFlip ? 'flip_on_reversal' : 'fresh_cross',
    openPositionsAfterExits: positionsAfterExits,
    tradesCompleted: context.tradesCompleted,
    dailyPnl: context.dailyPnl,
    closeCutoffTs: context.closeCutoffTs,
    lastEntryTs: context.lastEntryTs,
    sessionSignalCount: context.sessionSignalCount,
  }, config);
  if (!gate.allowed) {
    return { entry: null, skipReason: (gate as { allowed: false; reason: string }).reason };
  }

  if (entryDirection === null) {
    return { entry: null, skipReason: 'no entry trigger' };
  }

  // requireUnderlyingHmaCross gate
  if (config.signals.requireUnderlyingHmaCross && signal.directionState.cross === null) {
    return { entry: null, skipReason: 'requireUnderlyingHmaCross — no direction cross' };
  }

  // Reverse signals (chop mode): flip direction so bullish→bearish, bearish→bullish
  // This makes the system buy puts when HMA says long, and calls when HMA says short.
  if (config.signals.reverseSignals) {
    entryDirection = entryDirection === 'bullish' ? 'bearish' : 'bullish';
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

  // MTF confirmation gate — require higher timeframe HMA direction to agree
  const mtf = config.signals.mtfConfirmation;
  if (mtf?.enabled && mtf.requireAgreement) {
    const mtfDir = context.mtfDirection;
    if (mtfDir != null && mtfDir !== entryDirection) {
      return {
        entry: null,
        skipReason: `MTF gate: ${mtf.timeframe} HMA is ${mtfDir}, signal is ${entryDirection} — blocked`,
      };
    }
    // mtfDir === null → no data, fail-open (don't block)
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

  // Compute effective entry with friction (raw price + half-spread).
  // Size qty off the pre-slippage effective entry so slippage and sizing
  // don't feed back on each other in a loop.
  const smEntry = resolveSpreadModel(config);
  const unslippedEffective = frictionEntry(candidate.price, smEntry);
  let qty = computeQty(unslippedEffective, config, context.accountValue);

  // Phase 4: participation-rate liquidity gate.
  // Cap qty to participationRate × signal-bar volume. If capped qty falls
  // below minContracts, skip the trade entirely.
  const participationRate = config.fill?.participationRate;
  if (participationRate != null && participationRate > 0 && candidate.volume > 0) {
    const maxFill = Math.floor(candidate.volume * participationRate);
    qty = Math.min(qty, maxFill);
    if (qty < (config.fill?.minContracts ?? 1)) {
      return {
        entry: null,
        skipReason: `liquidity gate: barVol=${candidate.volume} → maxFill=${maxFill} < minContracts=${config.fill?.minContracts ?? 1}`,
      };
    }
  }

  // Apply Phase 3 entry slippage (size-based book walking on market buy).
  // Default ResolvedSlippage is all-zero, so this is a no-op for configs
  // without fill.slippage.entrySlipPerContract.
  const slip = resolveSlippage(config);
  const slippedRawPrice = slipBuyPrice(candidate.price, qty, slip);
  const effectiveEntry = frictionEntry(slippedRawPrice, smEntry);
  const stopLoss = roundToOptionTick(effectiveEntry * (1 - config.position.stopLossPercent / 100));
  const takeProfit = roundToOptionTick(effectiveEntry * config.position.takeProfitMultiplier);

  return {
    entry: {
      symbol: candidate.symbol,
      side,
      strike: candidate.strike,
      price: slippedRawPrice, // raw (unfricted) fill; friction layered downstream in P&L
      qty,
      stopLoss,
      takeProfit,
      direction: entryDirection,
      reason: `${entryReason} → ${strikeResult.reason}`,
    },
    skipReason: null,
  };
}
