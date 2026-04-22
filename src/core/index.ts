/**
 * Core trading logic — shared between replay and live agent.
 *
 * Both systems import from here. Test once, deploy everywhere.
 */

export type {
  Direction, SignalType, ExitReason,
  Signal, Position, ExitCheck, TradeResult, CoreBar, PriceGetter,
} from './types';

export { detectSignals, isBarDataUnhealthy } from './signal-detector';
export { checkExit } from './position-manager';
export { computeQty } from './position-sizer';
export { isRiskBlocked, type RiskState } from './risk-guard';
export { isRegimeBlocked } from './regime-gate';
export { selectStrike, type StrikeCandidate, type StrikeResult } from './strike-selector';
export { computeIndicators, seedIndicatorState, resetVWAP } from './indicator-engine';
export {
  tick,
  createInitialState,
  stripFormingCandle,
  detectSignal,
  createInitialSignalState,
  detectHmaCross,
  isInActiveWindow,
  getFlipDirection,
  type CorePosition,
  type StrategyState,
  type TickInput,
  type TickResult,
  type SignalState,
  type SignalInput,
  type SignalResult,
  type HmaCrossResult,
} from './strategy-engine';
export {
  evaluateEntry,
  evaluateExit,
  type EntryDecision,
  type ExitDecision,
  type EntryContext,
} from './trade-manager';
export {
  evaluateReentry,
  createInitialReentryState,
  type ReentryState,
  type ReentryDecision,
  type ReentryGateContext,
} from './reentry-evaluator';
export {
  checkEntryGates,
  computeCloseCutoffTs,
  type EntryKind,
  type EntryGateInput,
  type EntryGateResult,
} from './entry-gate';
